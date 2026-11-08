import path from "node:path";
import type { z } from "zod";
import type { Config } from "./config.js";
import type {
  Agent,
  AgentResult,
  Forge,
  Host,
  Reviewer,
  UsageMeter,
  UsageWindows,
} from "./ports.js";
import {
  finalizeResult,
  type ImplementResult,
  implementResult,
  type StepResult,
  stepResult,
  toJsonSchema,
} from "./schemas.js";
import type { ItemState, Phase, RunState, StateStore } from "./state.js";
import { render, type TemplateName, type Templates } from "./templates.js";
import {
  account,
  describeUsage,
  formatTime,
  type LimitHit,
  limitHit,
  limitsEnabled,
  missingWindows,
  sameWindow,
  type UsageLimits,
  usageLimits,
  WINDOW_LABEL,
} from "./usage.js";

/** Below this many USD left, a Claude step is not worth starting. */
export const MIN_STEP_BUDGET_USD = 0.5;
const MERGEABILITY_RETRIES = 6;
const MERGEABILITY_WAIT_MS = 5_000;
/** Re-read usage this long after a window's reset time, so the reset has surely happened. */
const USAGE_RESET_GRACE_MS = 60_000;
/** While waiting for a reset, wake up this often to notice `nightshift stop` and Ctrl-C. */
const USAGE_WAIT_SLICE_MS = 60_000;
const USAGE_READ_ATTEMPTS = 3;
const USAGE_RETRY_MS = 5_000;

export interface PipelineDeps {
  config: Config;
  templates: Templates;
  agent: Agent;
  forge: Forge;
  reviewer: Reviewer;
  host: Host;
  store: StateStore;
  /** Required when `[usage]` limits are configured. */
  usage?: UsageMeter;
}

export interface InvocationOptions {
  /** Stop after this many completed items in this invocation (0 = config / unlimited). */
  maxItems?: number;
  /** Answer to the question the run halted on. */
  answer?: string;
  signal: AbortSignal;
}

export type ExitKind =
  /** Nothing left to do. */
  | "done"
  /** A planned stop (item limit, STOP file); `resume` continues. */
  | "paused"
  /** A human must answer a question; `resume --answer` continues. */
  | "blocked"
  /** Something went wrong (budget, CI, merge, agent error); fix it, then `resume`. */
  | "halted";

export interface Exit {
  kind: ExitKind;
  reason: string;
  state: RunState;
}

class Aborted extends Error {}

/** `exit: undefined` means "run this phase again" (the usage limit stopped the step part-way). */
type StepOutcome<T> = { ok: true; value: T } | { ok: false; exit: Exit | undefined };

/** What a usage check before a step decided. */
type UsageGate = { ok: true; before: UsageWindows | undefined } | { ok: false; exit: Exit };

interface AgentCall {
  result: AgentResult;
  /** Set when the usage limit stopped the step. */
  cut: LimitHit | undefined;
}

export function newItem(index: number, repo: string, handoff: string): ItemState {
  return {
    index,
    repo,
    handoff,
    phase: "implement",
    reviewRound: 0,
    fixRound: 0,
    conflictRound: 0,
    costUsd: 0,
  };
}

export function newRunState(runId: string, now: Date, repo: string, prompt: string): RunState {
  return {
    version: 1,
    runId,
    startedAt: now.toISOString(),
    status: "running",
    itemsCompleted: 0,
    costUsd: 0,
    item: newItem(1, repo, prompt),
  };
}

/**
 * Drives one item at a time through
 * implement → review ⇄ address → checks ⇄ fix_checks → merge (⇄ resolve_conflicts) → finalize,
 * persisting state after every transition so a crash or Ctrl-C resumes where it stopped.
 */
export class Pipeline {
  private invocationCostUsd = 0;
  private itemsThisInvocation = 0;
  private signal: AbortSignal = new AbortController().signal;

  constructor(
    private readonly deps: PipelineDeps,
    private readonly state: RunState,
  ) {}

  async run(options: InvocationOptions): Promise<Exit> {
    this.signal = options.signal;
    const item = this.state.item;
    if (this.state.status === "done" || item === undefined) {
      return {
        kind: "done",
        reason: this.state.haltReason ?? "run already finished",
        state: this.state,
      };
    }
    if (options.answer !== undefined) {
      if (item.pendingQuestion === undefined) {
        throw new Error("the run is not waiting for an answer (no open question)");
      }
      item.pendingAnswer = options.answer;
    } else if (item.pendingQuestion !== undefined && item.pendingAnswer === undefined) {
      throw new Error(`the run is waiting for an answer: ${item.pendingQuestion}\nuse --answer`);
    }
    const maxItems = options.maxItems ?? this.deps.config.limits.max_items;
    this.state.status = "running";
    delete this.state.haltReason;
    this.deps.host.clearStop();
    await this.save();
    await this.event({ type: "invocation_start", item: item.index, phase: item.phase });

    try {
      for (;;) {
        if (this.signal.aborted) throw new Aborted();
        if (this.deps.host.stopRequested()) {
          this.deps.host.clearStop();
          return await this.pause("stop requested (STOP file)");
        }
        const current = this.state.item;
        if (current === undefined) return await this.finish("no task left");
        const exit = await this.step(current);
        if (exit) return exit;
        if (current !== this.state.item && maxItems > 0 && this.itemsThisInvocation >= maxItems) {
          return await this.pause(`item limit reached (${maxItems} this invocation)`);
        }
      }
    } catch (error) {
      if (error instanceof Aborted || this.signal.aborted) {
        return await this.halt("interrupted", "halted");
      }
      return await this.halt(`error: ${(error as Error).message}`, "halted");
    }
  }

  private async step(item: ItemState): Promise<Exit | undefined> {
    const restarted = item.inFlight === item.phase || item.interruptedPhase === item.phase;
    item.inFlight = item.phase;
    await this.save();
    const exit = await this.runPhase(item, restarted);
    delete item.inFlight;
    await this.save();
    return exit;
  }

  private runPhase(item: ItemState, restarted: boolean): Promise<Exit | undefined> {
    switch (item.phase) {
      case "implement":
        return this.implement(item, restarted);
      case "review":
        return this.review(item);
      case "address":
        return this.address(item, restarted);
      case "checks":
        return this.checks(item);
      case "fix_checks":
        return this.fixChecks(item, restarted);
      case "merge":
        return this.merge(item);
      case "resolve_conflicts":
        return this.resolveConflicts(item, restarted);
      case "finalize":
        return this.finalize(item, restarted);
    }
  }

  // ── phases ──────────────────────────────────────────────────────────────

  private async implement(item: ItemState, restarted: boolean): Promise<Exit | undefined> {
    const result = await this.agentStep(item, "implement", implementResult, restarted, {
      handoff: item.handoff,
    });
    if (!result.ok) return result.exit;
    const r: ImplementResult = result.value;
    item.label = r.item;
    switch (r.status) {
      case "blocked":
        return this.blocked(item, r.question ?? r.summary);
      case "all_done":
        delete this.state.item;
        return this.finish(`no task left: ${r.summary}`);
      case "failed":
        return this.halt(`implement failed: ${r.summary}`, "halted");
      case "pr_opened": {
        if (r.pr_number === undefined) {
          return this.halt("implement reported pr_opened without pr_number", "halted");
        }
        const repoSlug = await this.deps.forge.repoSlug(this.repoPath(item));
        const pr = await this.deps.forge.pullRequest(repoSlug, r.pr_number);
        if (pr.state !== "OPEN") return this.halt(`PR #${pr.number} is ${pr.state}`, "halted");
        if (pr.isDraft) return this.halt(`PR #${pr.number} is a draft`, "halted");
        item.pr = { number: pr.number, url: pr.url, repoSlug, branch: pr.headRefName };
        item.reviewRound = 1;
        this.log(item, `opened ${pr.url}`);
        await this.event({ type: "pr_opened", item: item.index, label: item.label, pr: pr.url });
        if (this.deps.config.review.command.trim() === "") this.enterChecks(item);
        else item.phase = "review";
        return undefined;
      }
    }
  }

  private async review(item: ItemState): Promise<Exit | undefined> {
    const pr = this.requirePr(item);
    const { review } = this.deps.config;
    const disk = await this.diskExit();
    if (disk) return disk;
    // A review command may well use Claude too (`claude -p "/code-review …"`): it is held to the
    // same limits, and what it uses counts as nightshift's.
    const gate = await this.usageGate();
    if (!gate.ok) return gate.exit;
    this.log(item, `review round ${item.reviewRound}/${review.max_rounds}`);
    const result = await this.deps.reviewer.run({
      command: review.command,
      cwd: this.repoPath(item),
      repoSlug: pr.repoSlug,
      pr: pr.number,
      prUrl: pr.url,
      branch: pr.branch,
      timeoutMs: review.timeout_minutes * 60_000,
      logPath: this.artifact(item, `review-${item.reviewRound}.log`),
      signal: this.signal,
    });
    if (this.signal.aborted) throw new Aborted();
    if (gate.before !== undefined) await this.accountSince(item, "review", gate.before);
    await this.event({
      type: "review",
      item: item.index,
      round: item.reviewRound,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    });
    if (result.timedOut || result.exitCode !== 0) {
      const why = result.timedOut ? "timed out" : `exited ${String(result.exitCode)}`;
      if (review.on_failure === "skip") {
        this.log(item, `review command ${why}; skipping review (on_failure = "skip")`);
        this.enterChecks(item);
        return undefined;
      }
      return this.halt(
        `review command ${why} (log: ${this.artifact(item, `review-${item.reviewRound}.log`)})`,
        "halted",
      );
    }
    item.reviewOutput = result.output;
    item.phase = "address";
    return undefined;
  }

  private async address(item: ItemState, restarted: boolean): Promise<Exit | undefined> {
    const pr = this.requirePr(item);
    const result = await this.agentStep(item, "address", stepResult, restarted, {
      ...this.prVars(pr),
      round: item.reviewRound,
      max_rounds: this.deps.config.review.max_rounds,
      review_output: item.reviewOutput ?? "(no output captured)",
    });
    if (!result.ok) return result.exit;
    const r: StepResult = result.value;
    if (r.status !== "ready") return this.stepNotReady(item, "address review", r);
    delete item.reviewOutput;
    if (r.pushed_changes && item.reviewRound < this.deps.config.review.max_rounds) {
      item.reviewRound += 1;
      item.phase = "review";
    } else {
      this.enterChecks(item);
    }
    return undefined;
  }

  private async checks(item: ItemState): Promise<Exit | undefined> {
    const pr = this.requirePr(item);
    const { checks } = this.deps.config;
    for (;;) {
      if (this.signal.aborted) throw new Aborted();
      if (this.deps.host.stopRequested()) {
        this.deps.host.clearStop();
        return this.pause("stop requested (STOP file)");
      }
      const current = await this.deps.forge.pullRequest(pr.repoSlug, pr.number);
      if (current.state === "MERGED") {
        item.mergeSha = current.mergeCommitSha;
        item.phase = "finalize";
        return undefined;
      }
      if (current.state === "CLOSED") return this.halt(`PR #${pr.number} was closed`, "halted");
      if (!checks.wait) {
        item.checkedSha = current.headSha;
        item.phase = "merge";
        return undefined;
      }
      const now = this.deps.host.now();
      const summary = current.checks;
      if (summary.state === "passed") {
        this.log(item, "checks passed");
        item.checkedSha = current.headSha;
        item.phase = "merge";
        return undefined;
      }
      if (summary.state === "failed") {
        if (item.fixRound >= checks.max_fix_rounds) {
          return this.halt(
            `checks failed after ${item.fixRound} fix round(s): ${summary.failed.join(", ")}`,
            "halted",
          );
        }
        item.fixRound += 1;
        item.failedChecks = summary.failed;
        item.phase = "fix_checks";
        this.log(item, `checks failed (${summary.failed.join(", ")}); fix round ${item.fixRound}`);
        return undefined;
      }
      if (summary.state === "none" && !checks.require_checks) {
        item.noChecksSince ??= now.toISOString();
        if (elapsedMs(item.noChecksSince, now) >= checks.settle_seconds * 1000) {
          this.log(item, "no checks reported; merging without CI");
          item.checkedSha = current.headSha;
          item.phase = "merge";
          return undefined;
        }
      } else if (summary.state === "pending") {
        delete item.noChecksSince;
      }
      item.checksSince ??= now.toISOString();
      if (elapsedMs(item.checksSince, now) >= checks.timeout_minutes * 60_000) {
        const what =
          summary.state === "none"
            ? "no checks were reported"
            : `still pending: ${summary.pending.join(", ")}`;
        return this.halt(
          `checks timed out after ${checks.timeout_minutes} min (${what})`,
          "halted",
        );
      }
      await this.save();
      await this.deps.host.sleep(checks.poll_seconds * 1000, this.signal);
    }
  }

  private async fixChecks(item: ItemState, restarted: boolean): Promise<Exit | undefined> {
    const pr = this.requirePr(item);
    const result = await this.agentStep(item, "fix-checks", stepResult, restarted, {
      ...this.prVars(pr),
      failed_checks: (item.failedChecks ?? []).join(", ") || "(unknown)",
      round: item.fixRound,
      max_rounds: this.deps.config.checks.max_fix_rounds,
    });
    if (!result.ok) return result.exit;
    if (result.value.status !== "ready") return this.stepNotReady(item, "fix checks", result.value);
    delete item.failedChecks;
    this.enterChecks(item);
    return undefined;
  }

  private async merge(item: ItemState): Promise<Exit | undefined> {
    const pr = this.requirePr(item);
    const { forge } = this.deps;
    const { merge } = this.deps.config;
    let current = await forge.pullRequest(pr.repoSlug, pr.number);
    for (
      let i = 0;
      current.state === "OPEN" && current.mergeable === "UNKNOWN" && i < MERGEABILITY_RETRIES;
      i++
    ) {
      // GitHub computes mergeability lazily after a push.
      await this.deps.host.sleep(MERGEABILITY_WAIT_MS, this.signal);
      current = await forge.pullRequest(pr.repoSlug, pr.number);
    }
    if (current.state === "MERGED") {
      item.mergeSha = current.mergeCommitSha;
      item.phase = "finalize";
      return undefined;
    }
    if (current.state === "CLOSED") return this.halt(`PR #${pr.number} was closed`, "halted");
    if (current.isDraft) return this.halt(`PR #${pr.number} was turned into a draft`, "halted");
    if (current.headSha !== item.checkedSha) {
      this.log(item, "the PR head moved since checks passed; re-checking");
      this.enterChecks(item);
      return undefined;
    }
    if (current.mergeable === "CONFLICTING") {
      if (item.conflictRound >= merge.max_conflict_rounds) {
        return this.halt(`PR #${pr.number} still conflicts with ${current.baseRefName}`, "halted");
      }
      item.conflictRound += 1;
      item.phase = "resolve_conflicts";
      return undefined;
    }
    try {
      await forge.merge(pr.repoSlug, pr.number, merge.method, current.headSha);
    } catch (error) {
      return this.halt(`merge of PR #${pr.number} failed: ${(error as Error).message}`, "halted");
    }
    const merged = await forge.pullRequest(pr.repoSlug, pr.number);
    item.mergeSha = merged.mergeCommitSha;
    this.log(item, `merged (${merge.method}) as ${merged.mergeCommitSha ?? "?"}`);
    await this.event({ type: "merged", item: item.index, pr: pr.url, sha: item.mergeSha });
    if (merge.delete_branch) {
      try {
        await forge.deleteBranch(pr.repoSlug, pr.branch);
      } catch (error) {
        this.log(item, `could not delete branch ${pr.branch}: ${(error as Error).message}`);
      }
    }
    item.phase = "finalize";
    return undefined;
  }

  private async resolveConflicts(item: ItemState, restarted: boolean): Promise<Exit | undefined> {
    const pr = this.requirePr(item);
    const result = await this.agentStep(item, "resolve-conflicts", stepResult, restarted, {
      ...this.prVars(pr),
      round: item.conflictRound,
    });
    if (!result.ok) return result.exit;
    if (result.value.status !== "ready") {
      return this.stepNotReady(item, "resolve conflicts", result.value);
    }
    this.enterChecks(item);
    return undefined;
  }

  private async finalize(item: ItemState, restarted: boolean): Promise<Exit | undefined> {
    const pr = this.requirePr(item);
    const aliases = Object.keys(this.deps.config.repos) as [string, ...string[]];
    const schema = finalizeResult(aliases);
    const result = await this.agentStep(item, "finalize", schema, restarted, {
      ...this.prVars(pr),
      merge_sha: item.mergeSha ?? "(unknown)",
      repos: Object.entries(this.deps.config.repos)
        .map(([alias, dir]) => `- ${alias}: ${dir}`)
        .join("\n"),
    });
    if (!result.ok) return result.exit;
    const r = result.value;
    if (r.status === "all_done") {
      await this.completeItem(item);
      delete this.state.item;
      return this.finish(`no task left: ${r.summary}`);
    }
    const next =
      r.next_repo !== undefined && r.next_prompt !== undefined && r.next_prompt.trim() !== ""
        ? newItem(item.index + 1, r.next_repo, r.next_prompt)
        : undefined;
    if (r.status === "continue") {
      if (next === undefined) {
        return this.halt("finalize reported continue without next_repo and next_prompt", "halted");
      }
      await this.completeItem(item);
      this.state.item = next;
      return undefined;
    }
    // blocked: if the next prompt is known, hand it over and let the answer travel with it.
    if (next !== undefined) {
      await this.completeItem(item);
      this.state.item = next;
      return this.blocked(next, r.question ?? r.summary);
    }
    return this.blocked(item, r.question ?? r.summary);
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private async agentStep<S extends z.ZodType>(
    item: ItemState,
    template: TemplateName,
    schema: S,
    restarted: boolean,
    vars: Record<string, string | number>,
  ): Promise<StepOutcome<z.infer<S>>> {
    const disk = await this.diskExit();
    if (disk) return { ok: false, exit: disk };
    const { budget } = this.deps.config;
    const left = Math.min(
      budget.item_usd - item.costUsd,
      budget.invocation_usd - this.invocationCostUsd,
    );
    if (left < MIN_STEP_BUDGET_USD) {
      return {
        ok: false,
        exit: await this.halt(
          `budget exhausted (item $${item.costUsd.toFixed(2)} of $${budget.item_usd}, this invocation $${this.invocationCostUsd.toFixed(2)} of $${budget.invocation_usd})`,
          "halted",
        ),
      };
    }

    const gate = await this.usageGate();
    if (!gate.ok) return gate;
    // Cleared only once the step really starts again, so a pause before then keeps the restart.
    delete item.interruptedPhase;

    const allVars = {
      repo: item.repo,
      repo_path: this.repoPath(item),
      item_index: item.index,
      item_label: item.label ?? `item ${item.index}`,
      ...vars,
    };
    let prompt = render(this.deps.templates[template], allVars);
    if (restarted) prompt = render(this.deps.templates.restarted, { step_prompt: prompt });
    if (item.pendingAnswer !== undefined) {
      prompt = render(this.deps.templates.answer, {
        question: item.pendingQuestion ?? "(not recorded)",
        answer: item.pendingAnswer,
        step_prompt: prompt,
      });
    }

    // A fresh session is only for a first implement attempt; every later step resumes the item's
    // session so Claude keeps the context of this item (and only this item).
    const resume = item.sessionId;
    this.log(item, `${template}${resume ? "" : " (fresh session)"} · budget $${left.toFixed(2)}`);
    let call = await this.callAgent(item, template, prompt, schema, left, resume, gate.before);
    if (
      call.cut === undefined &&
      call.result.outcome === "error" &&
      resume !== undefined &&
      restarted
    ) {
      // The interrupted session may never have been persisted; start over in a fresh one.
      this.log(
        item,
        `could not resume session (${call.result.detail}); retrying in a fresh session`,
      );
      delete item.sessionId;
      const again = await this.usageGate();
      if (!again.ok) return again;
      call = await this.callAgent(
        item,
        template,
        prompt,
        schema,
        left - call.result.costUsd,
        undefined,
        again.before,
      );
    }
    const { result, cut } = call;
    if (cut !== undefined && result.outcome === "aborted" && !this.signal.aborted) {
      // Stopped by the usage limit: keep any answer for the restart, and run the phase again once
      // the usage gate lets it (after the window resets, or on `resume` with on_limit = "halt").
      item.interruptedPhase = item.phase;
      await this.save();
      await this.event({ type: "usage_cut", item: item.index, step: template, reason: cut.reason });
      return { ok: false, exit: undefined };
    }
    delete item.pendingAnswer;
    delete item.pendingQuestion;
    await this.save();

    switch (result.outcome) {
      case "aborted":
        throw new Aborted();
      case "success": {
        const parsed = schema.safeParse(result.structured);
        if (parsed.success) return { ok: true, value: parsed.data };
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        return {
          ok: false,
          exit: await this.halt(`${template}: invalid structured result (${issues})`, "halted"),
        };
      }
      case "max_budget":
        return {
          ok: false,
          exit: await this.halt(`${template}: Claude hit the budget ceiling`, "halted"),
        };
      case "max_turns":
        return { ok: false, exit: await this.halt(`${template}: Claude hit max_turns`, "halted") };
      case "no_structured_output":
        return {
          ok: false,
          exit: await this.halt(`${template}: no structured result returned`, "halted"),
        };
      case "error":
        return {
          ok: false,
          exit: await this.halt(`${template}: agent error: ${result.detail}`, "halted"),
        };
    }
  }

  private async callAgent(
    item: ItemState,
    template: TemplateName,
    prompt: string,
    schema: z.ZodType,
    maxBudgetUsd: number,
    resumeSessionId: string | undefined,
    usageBefore: UsageWindows | undefined,
  ): Promise<AgentCall> {
    const attempt = Date.now();
    const guard = new AbortController();
    const running = this.deps.agent.run({
      cwd: this.repoPath(item),
      prompt,
      schema: toJsonSchema(schema),
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      maxBudgetUsd,
      artifactPath: this.artifact(item, `${template}-${attempt}.json`),
      signal:
        usageBefore === undefined ? this.signal : AbortSignal.any([this.signal, guard.signal]),
    });
    let cut: LimitHit | undefined;
    let result: AgentResult;
    if (usageBefore === undefined) {
      result = await running;
    } else {
      const watched = await this.watchUsage(item, template, running, usageBefore, guard);
      result = watched.result;
      cut = watched.cut;
    }
    item.costUsd += result.costUsd;
    this.state.costUsd += result.costUsd;
    this.invocationCostUsd += result.costUsd;
    if (result.sessionId !== undefined) item.sessionId = result.sessionId;
    await this.event({
      type: "agent",
      item: item.index,
      step: template,
      outcome: result.outcome,
      costUsd: result.costUsd,
      sessionId: result.sessionId,
    });
    return { result, cut };
  }

  // ── plan usage ──────────────────────────────────────────────────────────

  private usageLimits(): UsageLimits {
    return usageLimits(this.deps.config.usage, this.state.usageShare);
  }

  /**
   * Before a step that uses Claude: reads plan usage and, while a limit is reached, waits for the
   * window to reset (on_limit = "wait") or pauses the run (on_limit = "halt"). Returns the reading
   * the step's own usage is measured from; undefined when no limits are configured.
   */
  private async usageGate(): Promise<UsageGate> {
    const limits = this.usageLimits();
    if (!limitsEnabled(limits)) return { ok: true, before: undefined };
    const { usage } = this.deps.config;
    for (;;) {
      const reading = await this.readUsage(USAGE_READ_ATTEMPTS);
      if (!reading.ok) {
        return {
          ok: false,
          exit: await this.halt(
            `cannot read Claude plan usage, so the [usage] limits cannot be kept: ${reading.detail}`,
            "halted",
          ),
        };
      }
      const missing = missingWindows(limits, reading.windows);
      if (missing.length > 0) {
        return {
          ok: false,
          exit: await this.halt(
            `Claude reported no ${missing.map((w) => WINDOW_LABEL[w]).join(" or ")} usage window, so its [usage] limit cannot be kept`,
            "halted",
          ),
        };
      }
      const usageState = this.usageState();
      const hit = limitHit(limits, usageState.tally, reading.windows);
      if (hit === undefined) return { ok: true, before: reading.windows };

      const now = this.deps.host.now();
      const resetsAt = hit.resetsAt === undefined ? Number.NaN : Date.parse(hit.resetsAt);
      const until = Math.max(
        Number.isNaN(resetsAt) ? 0 : resetsAt + USAGE_RESET_GRACE_MS,
        now.getTime() + usage.check_seconds * 1000,
      );
      if (usage.on_limit === "halt") {
        return {
          ok: false,
          exit: await this.pause(
            `usage limit: ${hit.reason}; the ${WINDOW_LABEL[hit.window]} window resets ${formatTime(hit.resetsAt, now)}`,
          ),
        };
      }
      const untilIso = new Date(until).toISOString();
      this.deps.host.log(
        `usage limit: ${hit.reason}; waiting until ${formatTime(untilIso, now)} for the ${WINDOW_LABEL[hit.window]} window to reset`,
      );
      usageState.waitingUntil = untilIso;
      usageState.waitingFor = hit.reason;
      await this.save();
      await this.event({ type: "usage_wait", reason: hit.reason, until: untilIso });
      const stopped = await this.waitUntil(until);
      delete usageState.waitingUntil;
      delete usageState.waitingFor;
      await this.save();
      if (stopped) return { ok: false, exit: stopped };
    }
  }

  /** Sleeps until `until` (epoch ms) in slices; returns an exit if a stop was requested. */
  private async waitUntil(until: number): Promise<Exit | undefined> {
    for (;;) {
      if (this.signal.aborted) throw new Aborted();
      if (this.deps.host.stopRequested()) {
        this.deps.host.clearStop();
        return this.pause("stop requested (STOP file)");
      }
      const left = until - this.deps.host.now().getTime();
      if (left <= 0) return undefined;
      await this.deps.host.sleep(Math.min(left, USAGE_WAIT_SLICE_MS), this.signal);
    }
  }

  /**
   * Runs alongside a Claude step: re-reads usage every `check_seconds`, adds what the step used to
   * nightshift's tally, and stops the step as soon as a limit is reached. Takes a last reading when
   * the step ends, so short steps are counted too.
   */
  private async watchUsage(
    item: ItemState,
    template: TemplateName,
    running: Promise<AgentResult>,
    before: UsageWindows,
    guard: AbortController,
  ): Promise<{ result: AgentResult; cut: LimitHit | undefined }> {
    const limits = this.usageLimits();
    const usageState = this.usageState();
    const finished = new AbortController();
    const settled = running.finally(() => finished.abort());
    settled.catch(() => {}); // the rejection is handled by awaiting `running` below
    const stepSignal = AbortSignal.any([finished.signal, this.signal]);
    const startUsed = { ...usageState.tally };
    let previous = before;
    let cut: LimitHit | undefined;

    const take = async (signal: AbortSignal | undefined): Promise<void> => {
      const reading = await this.deps.usage?.read(signal);
      if (reading === undefined || !reading.ok) return; // transient; the next reading catches up
      account(usageState.tally, previous, reading.windows);
      previous = reading.windows;
      usageState.last = { at: this.deps.host.now().toISOString(), windows: reading.windows };
    };

    while (!stepSignal.aborted) {
      await this.deps.host.sleep(this.deps.config.usage.check_seconds * 1000, stepSignal);
      if (stepSignal.aborted) break;
      await take(stepSignal);
      if (stepSignal.aborted) break;
      await this.save();
      const hit = limitHit(limits, usageState.tally, previous);
      if (hit !== undefined) {
        cut = hit;
        this.log(item, `usage limit reached during ${template}: ${hit.reason}; stopping the step`);
        guard.abort();
        break;
      }
    }
    const result = await running;
    if (!this.signal.aborted) await take(undefined);
    const used: Record<string, number> = {};
    for (const [window, entry] of Object.entries(usageState.tally)) {
      const start = startUsed[window as keyof typeof startUsed];
      const base =
        start !== undefined && sameWindow(start.resetsAt, entry.resetsAt) ? start.used : 0;
      used[window] = entry.used - base;
    }
    await this.event({ type: "usage", item: item.index, step: template, points: used });
    if (usageState.last !== undefined) {
      this.log(
        item,
        `usage: ${describeUsage(usageState.last.windows, usageState.tally, limits, this.deps.host.now())}`,
      );
    }
    return { result, cut };
  }

  /** Adds what was used since `before` (one reading, no watching) to nightshift's tally. */
  private async accountSince(item: ItemState, step: string, before: UsageWindows): Promise<void> {
    const reading = await this.readUsage(1);
    if (!reading.ok) return;
    const points = account(this.usageState().tally, before, reading.windows);
    await this.save();
    await this.event({ type: "usage", item: item.index, step, points });
  }

  private async readUsage(attempts: number): Promise<Awaited<ReturnType<UsageMeter["read"]>>> {
    const meter = this.deps.usage;
    if (meter === undefined) {
      return { ok: false, detail: "no usage meter is available" };
    }
    let reading = await meter.read(this.signal);
    for (let i = 1; i < attempts && !reading.ok && !this.signal.aborted; i++) {
      await this.deps.host.sleep(USAGE_RETRY_MS, this.signal);
      reading = await meter.read(this.signal);
    }
    if (this.signal.aborted) throw new Aborted();
    if (reading.ok) {
      this.usageState().last = { at: this.deps.host.now().toISOString(), windows: reading.windows };
    }
    return reading;
  }

  private usageState(): NonNullable<RunState["usage"]> {
    this.state.usage ??= { tally: {} };
    return this.state.usage;
  }

  private stepNotReady(item: ItemState, what: string, r: StepResult): Promise<Exit> {
    if (r.status === "blocked") return this.blocked(item, r.question ?? r.summary);
    return this.halt(`${what} failed: ${r.summary}`, "halted");
  }

  private enterChecks(item: ItemState): void {
    item.phase = "checks";
    delete item.checksSince;
    delete item.noChecksSince;
    delete item.checkedSha;
  }

  private async completeItem(item: ItemState): Promise<void> {
    this.state.itemsCompleted += 1;
    this.itemsThisInvocation += 1;
    this.log(item, `done ($${item.costUsd.toFixed(2)})`);
    await this.event({
      type: "item_done",
      item: item.index,
      label: item.label,
      pr: item.pr?.url,
      mergeSha: item.mergeSha,
      costUsd: item.costUsd,
    });
  }

  private async diskExit(): Promise<Exit | undefined> {
    const min = this.deps.config.limits.min_free_disk_gb;
    if (min <= 0) return undefined;
    const free = await this.deps.host.freeDiskGb(this.deps.config.home);
    if (free >= min) return undefined;
    return this.halt(
      `only ${free.toFixed(1)} GB of disk free (min_free_disk_gb = ${min})`,
      "halted",
    );
  }

  private blocked(item: ItemState, question: string): Promise<Exit> {
    item.pendingQuestion = question;
    return this.halt(`needs a human: ${question}`, "blocked");
  }

  private pause(reason: string): Promise<Exit> {
    return this.halt(reason, "paused");
  }

  private async halt(reason: string, kind: "halted" | "blocked" | "paused"): Promise<Exit> {
    this.state.status = "halted";
    this.state.haltReason = reason;
    await this.save();
    await this.event({
      type: kind,
      reason,
      item: this.state.item?.index,
      phase: this.state.item?.phase,
    });
    this.deps.host.log(`${kind}: ${reason}`);
    await this.deps.host.notify("halted", this.notifyFields(kind, reason));
    return { kind, reason, state: this.state };
  }

  private async finish(reason: string): Promise<Exit> {
    this.state.status = "done";
    this.state.haltReason = reason;
    await this.save();
    await this.event({ type: "done", reason, itemsCompleted: this.state.itemsCompleted });
    this.deps.host.log(`done: ${reason}`);
    await this.deps.host.notify("done", this.notifyFields("done", reason));
    return { kind: "done", reason, state: this.state };
  }

  private notifyFields(kind: string, reason: string): Record<string, string> {
    const item = this.state.item;
    return {
      kind,
      reason,
      run: this.state.runId,
      item: item ? (item.label ?? String(item.index)) : "",
      pr: item?.pr?.url ?? "",
      cost: this.state.costUsd.toFixed(2),
    };
  }

  private requirePr(item: ItemState): NonNullable<ItemState["pr"]> {
    if (item.pr === undefined)
      throw new Error(`phase ${item.phase} needs a PR, but none is recorded`);
    return item.pr;
  }

  private prVars(pr: NonNullable<ItemState["pr"]>): Record<string, string | number> {
    return { pr_number: pr.number, pr_url: pr.url, repo_slug: pr.repoSlug, branch: pr.branch };
  }

  private repoPath(item: ItemState): string {
    const dir = this.deps.config.repos[item.repo];
    if (dir === undefined) throw new Error(`unknown repo alias "${item.repo}"`);
    return dir;
  }

  private artifact(item: ItemState, name: string): string {
    return path.join(this.deps.store.runDir(this.state.runId), `item-${item.index}`, name);
  }

  private log(item: ItemState, message: string): void {
    this.deps.host.log(`[${item.label ?? `item ${item.index}`}] ${message}`);
  }

  private save(): Promise<void> {
    return this.deps.store.save(this.state);
  }

  private event(event: Record<string, unknown>): Promise<void> {
    return this.deps.store.event(this.state.runId, event);
  }
}

function elapsedMs(sinceIso: string, now: Date): number {
  return now.getTime() - new Date(sinceIso).getTime();
}

export type { Phase };
