import path from "node:path";
import type { z } from "zod";
import type { Config } from "./config.js";
import { decideStart, estimateItem, readHistory } from "./forecast.js";
import type {
  Agent,
  AgentResult,
  Forge,
  Host,
  Reviewer,
  UsageMeter,
  UsageWindows,
} from "./ports.js";
import { isActive, nextStart } from "./schedule.js";
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
  USAGE_WINDOWS,
  type UsageLimits,
  type UsageWindow,
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
/** While a step runs, progress is written to state.json at most this often. */
const PROGRESS_SAVE_MS = 10_000;

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
  /** Stop after this many completed items in this invocation; 0 = no limit. Overrides the config. */
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
  /** Time spent in usage, schedule and forecast waits, so item time can leave it out. */
  private waitedMs = 0;
  /** When the running step started, and `waitedMs` then. */
  private stepClock: { at: number; waited: number } | undefined;

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
    this.freshStart(item);
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

  /**
   * A `resume` is a human saying "try again": bounded loops that halted the run get their rounds
   * back, and timeouts restart, instead of halting again at once on the same cap or deadline.
   */
  private freshStart(item: ItemState): void {
    if (item.capHit === "fix_checks") {
      this.log(
        item,
        `resuming after the CI fix cap: ${this.deps.config.checks.max_fix_rounds} more fix round(s)`,
      );
      item.fixRound = 0;
    } else if (item.capHit === "resolve_conflicts") {
      this.log(
        item,
        `resuming after the conflict cap: ${this.deps.config.merge.max_conflict_rounds} more round(s)`,
      );
      item.conflictRound = 0;
    }
    delete item.capHit;
    if (item.phase === "checks") {
      delete item.checksSince;
      delete item.noChecksSince;
    }
  }

  private async step(item: ItemState): Promise<Exit | undefined> {
    const restarted = item.inFlight === item.phase || item.interruptedPhase === item.phase;
    item.inFlight = item.phase;
    await this.save();
    this.stepClock = { at: this.deps.host.now().getTime(), waited: this.waitedMs };
    let exit: Exit | undefined;
    try {
      exit = await this.runPhase(item, restarted);
    } finally {
      // A finished item already counted its time (completeItem); only a current one adds it.
      if (this.state.item === item) item.activeMs = this.activeMs(item);
      this.stepClock = undefined;
    }
    delete item.inFlight;
    await this.save();
    return exit;
  }

  /** The item's active time, including the running step so far (without its waits). */
  private activeMs(item: ItemState): number {
    const clock = this.stepClock;
    const step =
      clock === undefined
        ? 0
        : this.deps.host.now().getTime() - clock.at - (this.waitedMs - clock.waited);
    return Math.max(0, Math.round((item.activeMs ?? 0) + step));
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
    const gate = await this.gates();
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
          item.capHit = "fix_checks";
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
      if (item.autoMergeSha !== undefined) {
        delete item.autoMergeSha;
        return this.merged(item, pr, current.mergeCommitSha, "auto-merge");
      }
      item.mergeSha = current.mergeCommitSha;
      item.phase = "finalize";
      return undefined;
    }
    if (current.state === "CLOSED") return this.halt(`PR #${pr.number} was closed`, "halted");
    if (current.isDraft) return this.halt(`PR #${pr.number} was turned into a draft`, "halted");
    if (current.headSha !== item.checkedSha) {
      this.log(item, "the PR head moved since checks passed; re-checking");
      delete item.autoMergeSha;
      this.enterChecks(item);
      return undefined;
    }
    if (item.autoMergeSha !== undefined) {
      // Auto-merge is on: GitHub merges once the branch protection is satisfied (an approval).
      await this.deps.host.sleep(this.deps.config.checks.poll_seconds * 1000, this.signal);
      return undefined;
    }
    if (current.mergeable === "CONFLICTING") {
      if (item.conflictRound >= merge.max_conflict_rounds) {
        item.capHit = "resolve_conflicts";
        return this.halt(
          `PR #${pr.number} still conflicts with ${current.baseRefName} after ${item.conflictRound} round(s)`,
          "halted",
        );
      }
      item.conflictRound += 1;
      item.phase = "resolve_conflicts";
      return undefined;
    }
    if (current.mergeStateStatus === "BLOCKED") {
      const why =
        current.reviewDecision === "REVIEW_REQUIRED"
          ? "needs an approving review"
          : current.reviewDecision === "CHANGES_REQUESTED"
            ? "has changes requested by a reviewer"
            : "is blocked by a branch protection rule";
      if (merge.when_blocked === "auto") {
        try {
          await forge.merge(pr.repoSlug, pr.number, merge.method, current.headSha, { auto: true });
        } catch (error) {
          return this.halt(
            `PR #${pr.number} ${why}, and enabling auto-merge failed (is "Allow auto-merge" on in the repo settings?): ${(error as Error).message}`,
            "halted",
          );
        }
        item.autoMergeSha = current.headSha;
        this.log(item, `PR ${why}; auto-merge is on, waiting for GitHub to merge it`);
        await this.event({ type: "auto_merge", item: item.index, pr: pr.url, reason: why });
        return undefined;
      }
      return this.halt(
        `PR #${pr.number} ${why} before it can merge: ${pr.url} (merge it yourself, or approve it and run \`nightshift resume\`; merge.when_blocked = "auto" waits instead)`,
        "halted",
      );
    }
    try {
      await forge.merge(pr.repoSlug, pr.number, merge.method, current.headSha);
    } catch (error) {
      return this.halt(`merge of PR #${pr.number} failed: ${(error as Error).message}`, "halted");
    }
    const after = await forge.pullRequest(pr.repoSlug, pr.number);
    return this.merged(item, pr, after.mergeCommitSha, merge.method);
  }

  private async merged(
    item: ItemState,
    pr: NonNullable<ItemState["pr"]>,
    sha: string | undefined,
    how: string,
  ): Promise<Exit | undefined> {
    const { forge } = this.deps;
    const { merge } = this.deps.config;
    item.mergeSha = sha;
    this.log(item, `merged (${how}) as ${sha ?? "?"}`);
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

    // A new item (not a restart or resume of one already under way) starts only if the forecast
    // says it fits in what is left of the usage limits and the active hours.
    const fresh = template === "implement" && !restarted && item.startedAt === undefined;
    const gate = await this.gates(fresh ? item : undefined);
    if (!gate.ok) return gate;
    if (fresh) item.startedAt = this.deps.host.now().toISOString();
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
      const again = await this.gates();
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
    await this.save();

    switch (result.outcome) {
      case "aborted":
        throw new Aborted();
      case "success": {
        const parsed = schema.safeParse(result.structured);
        if (parsed.success) {
          // The answer has been acted on. Until a step succeeds, it stays, so a failed or
          // interrupted step that is resumed gets it again instead of losing it.
          delete item.pendingAnswer;
          delete item.pendingQuestion;
          await this.save();
          return { ok: true, value: parsed.data };
        }
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
    const watch =
      usageBefore === undefined ? undefined : this.watchUsage(item, template, usageBefore, guard);
    const activity = this.trackActivity(item, template);
    let result: AgentResult;
    try {
      const running = this.deps.agent.run({
        cwd: this.repoPath(item),
        prompt,
        schema: toJsonSchema(schema),
        ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
        maxBudgetUsd,
        artifactPath: this.artifact(item, `${template}-${attempt}.jsonl`),
        signal: watch === undefined ? this.signal : AbortSignal.any([this.signal, guard.signal]),
        onEvent: (event) => {
          if (event.type === "tool") activity.tool(event.name, event.detail);
          else watch?.streamed(event.windows);
        },
      });
      result = watch === undefined ? await running : await watch.until(running);
    } finally {
      activity.end();
    }
    const cut = watch?.cut();
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
      const stopped = await this.sleepUntil(
        until,
        `usage limit: ${hit.reason}`,
        `for the ${WINDOW_LABEL[hit.window]} window to reset`,
        "usage_wait",
      );
      if (stopped) return { ok: false, exit: stopped };
    }
  }

  /**
   * Everything that must hold before Claude work starts: inside active hours and within the usage
   * limits. A long usage wait can end outside active hours, so both are checked until both hold.
   */
  private async gates(newItem?: ItemState): Promise<UsageGate> {
    for (;;) {
      const outside = await this.scheduleGate();
      if (outside) return { ok: false, exit: outside };
      const gate = await this.usageGate();
      if (!gate.ok) return gate;
      if (!isActive(this.deps.config.schedule.active_hours, this.deps.host.now())) continue;
      if (newItem === undefined) return gate;
      const fit = await this.forecastGate(newItem, gate.before);
      if (fit === undefined) return gate;
      if (fit !== "waited") return { ok: false, exit: fit };
    }
  }

  /** `[usage] start_item_only_if_it_fits`, which defaults to on when limits or hours are set. */
  private forecastEnabled(): boolean {
    const { usage, schedule } = this.deps.config;
    return (
      usage.start_item_only_if_it_fits ??
      (limitsEnabled(this.usageLimits()) || schedule.active_hours.length > 0)
    );
  }

  /**
   * Before a new item: estimates a typical item from history and, when it would not fit in what is
   * left of the usage limits or the active hours, waits for the window reset or the next active
   * range (or pauses, following on_limit / outside_hours) instead of starting an item that would
   * be cut half-way. Returns undefined to start, "waited" to check everything again, or an exit.
   */
  private async forecastGate(
    item: ItemState,
    windows: UsageWindows | undefined,
  ): Promise<Exit | "waited" | undefined> {
    if (!this.forecastEnabled()) return undefined;
    const { usage, schedule, dir } = this.deps.config;
    const now = this.deps.host.now();
    const estimate = estimateItem(await readHistory(dir), usage.forecast_percentile);
    const decision = decideStart({
      estimate,
      limits: this.usageLimits(),
      tally: this.state.usage?.tally ?? {},
      windows,
      ranges: schedule.active_hours,
      now,
    });
    this.log(item, `forecast: ${decision.reason}`);
    await this.event({
      type: "forecast",
      item: item.index,
      start: decision.start,
      reason: decision.reason,
    });
    if (decision.start) return undefined;

    let stopped: Exit | undefined;
    if (decision.kind === "usage") {
      const label = WINDOW_LABEL[decision.window];
      if (usage.on_limit === "halt") {
        return this.pause(
          `forecast: ${decision.reason}; not starting a new item before the ${label} window resets ${formatTime(decision.until, now)}`,
        );
      }
      const resetsAt = decision.until === undefined ? Number.NaN : Date.parse(decision.until);
      const until = Math.max(
        Number.isNaN(resetsAt) ? 0 : resetsAt + USAGE_RESET_GRACE_MS,
        now.getTime() + usage.check_seconds * 1000,
      );
      stopped = await this.sleepUntil(
        until,
        `forecast: ${decision.reason}`,
        `for the ${label} window to reset before starting a new item`,
        "forecast_wait",
      );
    } else {
      if (schedule.outside_hours === "halt") {
        return this.pause(
          `forecast: ${decision.reason}; not starting a new item before active hours start again ${formatTime(decision.until.toISOString(), now)}`,
        );
      }
      stopped = await this.sleepUntil(
        decision.until.getTime(),
        `forecast: ${decision.reason}`,
        "for the next active hours before starting a new item",
        "forecast_wait",
      );
    }
    return stopped ?? "waited";
  }

  /**
   * Before Claude work: outside the configured active hours, waits for the next start (or pauses,
   * with outside_hours = "halt"). A step already running is never cut by the schedule.
   */
  private async scheduleGate(): Promise<Exit | undefined> {
    const { active_hours: ranges, outside_hours } = this.deps.config.schedule;
    if (ranges.length === 0) return undefined;
    const now = this.deps.host.now();
    if (isActive(ranges, now)) return undefined;
    const start = nextStart(ranges, now);
    const hours = ranges.map((r) => r.text).join(", ");
    if (outside_hours === "halt") {
      return this.pause(
        `outside active hours (${hours}); they start again ${formatTime(start.toISOString(), now)}`,
      );
    }
    return this.sleepUntil(start.getTime(), `outside active hours (${hours})`, "", "schedule_wait");
  }

  /** Logs, records and performs a wait; returns an exit if a stop was requested meanwhile. */
  private async sleepUntil(
    until: number,
    reason: string,
    purpose: string,
    eventType: string,
  ): Promise<Exit | undefined> {
    const untilIso = new Date(until).toISOString();
    this.deps.host.log(
      `${reason}; waiting until ${formatTime(untilIso, this.deps.host.now())}${purpose ? ` ${purpose}` : ""}`,
    );
    this.state.waiting = { until: untilIso, reason };
    await this.save();
    await this.event({ type: eventType, reason, until: untilIso });
    const started = this.deps.host.now().getTime();
    try {
      return await this.waitUntil(until);
    } finally {
      this.waitedMs += Math.max(0, this.deps.host.now().getTime() - started);
      delete this.state.waiting;
      await this.save();
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
   * Runs alongside a Claude step and stops it as soon as a usage limit is reached. Usage comes from
   * the `rate_limit_event`s Claude streams and, when none arrived for `check_seconds`, from a usage
   * check. What changed counts toward nightshift's tally, and a last check when the step ends makes
   * sure short steps are counted too.
   */
  private watchUsage(
    item: ItemState,
    template: TemplateName,
    before: UsageWindows,
    guard: AbortController,
  ): {
    streamed: (windows: UsageWindows) => void;
    until: (running: Promise<AgentResult>) => Promise<AgentResult>;
    cut: () => LimitHit | undefined;
  } {
    const limits = this.usageLimits();
    const usageState = this.usageState();
    const checkMs = this.deps.config.usage.check_seconds * 1000;
    const startTally = structuredClone(usageState.tally);
    let previous = before;
    let lastReadingAt = this.deps.host.now().getTime();
    let cut: LimitHit | undefined;

    const apply = (windows: UsageWindows): void => {
      account(usageState.tally, previous, windows);
      previous = windows;
      lastReadingAt = this.deps.host.now().getTime();
      usageState.last = { at: this.deps.host.now().toISOString(), windows };
      if (cut !== undefined) return;
      const hit = limitHit(limits, usageState.tally, previous);
      if (hit === undefined) return;
      cut = hit;
      this.log(item, `usage limit reached during ${template}: ${hit.reason}; stopping the step`);
      guard.abort();
    };
    const take = async (signal: AbortSignal | undefined): Promise<void> => {
      const reading = await this.deps.usage?.read(signal);
      if (reading === undefined || !reading.ok) return; // transient; the next reading catches up
      apply(reading.windows);
    };

    const until = async (running: Promise<AgentResult>): Promise<AgentResult> => {
      const finished = new AbortController();
      running.then(
        () => finished.abort(),
        () => finished.abort(),
      );
      const stepSignal = AbortSignal.any([finished.signal, this.signal]);
      while (!stepSignal.aborted && cut === undefined) {
        await this.deps.host.sleep(checkMs, stepSignal);
        if (stepSignal.aborted) break;
        if (this.deps.host.now().getTime() - lastReadingAt < checkMs) continue; // streamed
        await take(stepSignal);
        if (!stepSignal.aborted) await this.save();
      }
      const result = await running;
      if (!this.signal.aborted) await take(undefined);
      const points: Partial<Record<UsageWindow, number>> = {};
      for (const window of USAGE_WINDOWS) {
        const entry = usageState.tally[window];
        if (entry === undefined) continue;
        const start = startTally[window];
        const base =
          start !== undefined && sameWindow(start.resetsAt, entry.resetsAt) ? start.used : 0;
        points[window] = entry.used - base;
      }
      this.addUsagePoints(item, points);
      await this.event({ type: "usage", item: item.index, step: template, points });
      if (usageState.last !== undefined) {
        this.log(
          item,
          `usage: ${describeUsage(usageState.last.windows, usageState.tally, limits, this.deps.host.now())}`,
        );
      }
      return result;
    };

    return { streamed: apply, until, cut: () => cut };
  }

  private addUsagePoints(item: ItemState, points: Partial<Record<UsageWindow, number>>): void {
    const usageState = this.usageState();
    for (const window of USAGE_WINDOWS) {
      const p = points[window];
      if (p === undefined || p <= 0) continue;
      item.usagePoints ??= {};
      item.usagePoints[window] = round2((item.usagePoints[window] ?? 0) + p);
      usageState.points ??= {};
      usageState.points[window] = round2((usageState.points[window] ?? 0) + p);
    }
  }

  /**
   * Live progress of a Claude step: every tool call is logged, and `status` sees the step, its
   * tool count and the latest call (state is saved at most every PROGRESS_SAVE_MS while it runs).
   */
  private trackActivity(
    item: ItemState,
    template: TemplateName,
  ): { tool: (name: string, detail: string) => void; end: () => void } {
    const now = () => this.deps.host.now();
    item.activity = { step: template, since: now().toISOString(), tools: 0 };
    let lastSave = now().getTime();
    this.save().catch(() => {}); // so `status` shows the step from its start
    return {
      tool: (name, detail) => {
        const activity = item.activity;
        if (activity === undefined) return;
        activity.tools += 1;
        activity.last = detail === "" ? name : `${name} ${detail}`;
        activity.lastAt = now().toISOString();
        this.log(item, `${template} · ${activity.last}`);
        if (now().getTime() - lastSave >= PROGRESS_SAVE_MS) {
          lastSave = now().getTime();
          this.save().catch(() => {});
        }
      },
      end: () => {
        delete item.activity;
      },
    };
  }

  /** Adds what was used since `before` (one reading, no watching) to nightshift's tally. */
  private async accountSince(item: ItemState, step: string, before: UsageWindows): Promise<void> {
    const reading = await this.readUsage(1);
    if (!reading.ok) return;
    const points = account(this.usageState().tally, before, reading.windows);
    this.addUsagePoints(item, points);
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
      // For forecasts: what the item used of each window (when usage is measured), and its time.
      ...(limitsEnabled(this.usageLimits())
        ? {
            usagePoints: Object.fromEntries(
              USAGE_WINDOWS.map((w) => [w, item.usagePoints?.[w] ?? 0]),
            ),
          }
        : {}),
      activeMs: this.activeMs(item),
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
