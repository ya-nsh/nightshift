import path from "node:path";
import type { z } from "zod";
import type { Config } from "./config.js";
import {
  BLOCKED_COLOR,
  BLOCKED_DESCRIPTION,
  hasLabel,
  IN_PROGRESS_COLOR,
  IN_PROGRESS_DESCRIPTION,
  ineligible,
  quote,
  rankIssues,
  releaseClaim,
} from "./issues.js";
import type {
  Agent,
  AgentResult,
  Forge,
  Host,
  Issue,
  Reviewer,
  UsageMeter,
  UsageWindows,
} from "./ports.js";
import { isActive, nextStart } from "./schedule.js";
import {
  finalizeIssueResult,
  finalizeResult,
  type ImplementResult,
  implementResult,
  type StepResult,
  stepResult,
  toJsonSchema,
} from "./schemas.js";
import type { ItemIssue, ItemState, Phase, RunState, StateStore } from "./state.js";
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
 * A run whose tasks come from GitHub issues (`[tasks] source = "github_issues"`): it starts without
 * an item and picks the first issue itself. `instructions` (from `--prompt`) go with every issue.
 */
export function newIssuesRunState(
  runId: string,
  now: Date,
  instructions: string | undefined,
): RunState {
  return {
    version: 1,
    runId,
    startedAt: now.toISOString(),
    status: "running",
    itemsCompleted: 0,
    costUsd: 0,
    issues: instructions === undefined || instructions.trim() === "" ? {} : { instructions },
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
    // A run on GitHub issues may sit between items: it picks the next issue itself.
    if (this.state.status === "done" || (item === undefined && !this.fromIssues())) {
      return {
        kind: "done",
        reason: this.state.haltReason ?? "run already finished",
        state: this.state,
      };
    }
    if (options.answer !== undefined) {
      if (item?.pendingQuestion === undefined) {
        throw new Error("the run is not waiting for an answer (no open question)");
      }
      item.pendingAnswer = options.answer;
    } else if (item?.pendingQuestion !== undefined && item.pendingAnswer === undefined) {
      throw new Error(`the run is waiting for an answer: ${item.pendingQuestion}\nuse --answer`);
    }
    if (item !== undefined) this.freshStart(item);
    const maxItems = options.maxItems ?? this.deps.config.limits.max_items;
    this.state.status = "running";
    delete this.state.haltReason;
    this.deps.host.clearStop();
    await this.save();
    await this.event({ type: "invocation_start", item: item?.index, phase: item?.phase });
    if (item?.issue !== undefined) await this.unflagIssue(item, item.issue);

    try {
      for (;;) {
        if (this.signal.aborted) throw new Aborted();
        if (this.deps.host.stopRequested()) {
          this.deps.host.clearStop();
          return await this.pause("stop requested (STOP file)");
        }
        let current = this.state.item;
        if (current === undefined) {
          if (!this.fromIssues()) return await this.finish("no task left");
          const picked = await this.pickIssue();
          if (typeof picked === "string") return await this.finish(picked);
          current = picked;
        }
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
    if (item.issue !== undefined && item.issue.claimed !== true) {
      // nightshift stopped between picking the issue and claiming it.
      const lost = await this.claim(item, item.issue);
      if (lost !== undefined) {
        return this.halt(`issue #${item.issue.number} was claimed elsewhere: ${lost}`, "halted");
      }
    }
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
        if (item.issue !== undefined) return this.setIssueAside(item, item.issue, r.summary);
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
    if (item.issue !== undefined) return this.finalizeIssue(item, item.issue, pr, restarted);
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

  /** Post-merge work for an issue item; the next item comes from the issues, not from Claude. */
  private async finalizeIssue(
    item: ItemState,
    issue: ItemIssue,
    pr: NonNullable<ItemState["pr"]>,
    restarted: boolean,
  ): Promise<Exit | undefined> {
    if (issue.finalized !== true) {
      const result = await this.agentStep(item, "finalize-issue", finalizeIssueResult, restarted, {
        ...this.prVars(pr),
        merge_sha: item.mergeSha ?? "(unknown)",
        issue_number: issue.number,
        issue_url: issue.url,
        label: this.deps.config.tasks.label,
      });
      if (!result.ok) return result.exit;
      if (result.value.status === "blocked") {
        return this.blocked(item, result.value.question ?? result.value.summary);
      }
      issue.finalized = true;
      await this.save();
    }
    await this.ensureIssueClosed(item, issue, pr);
    await this.completeItem(item);
    delete this.state.item;
    return undefined;
  }

  // ── GitHub issues as the task source ───────────────────────────────────

  private fromIssues(): boolean {
    return this.deps.config.tasks.source === "github_issues";
  }

  /**
   * Picks the next open issue, makes it the current item and claims it. Returns why there is none
   * when no issue is left.
   */
  private async pickIssue(): Promise<ItemState | string> {
    const { forge, config } = this.deps;
    const { tasks } = config;
    const slug = await forge.repoSlug(this.repoDir(tasks.repo));
    const me = await forge.currentUser();
    this.state.issues ??= {};
    const runIssues = this.state.issues;
    const exclude = new Set(runIssues.skipped ?? []);
    const { queue } = rankIssues(await forge.listIssues(slug, tasks.label), tasks, me, exclude);
    for (const candidate of queue) {
      // The listing has no bodies, and the issue may have changed since: read it again.
      const issue = await forge.issue(slug, candidate.number);
      const why = ineligible(issue, tasks, me, exclude);
      if (why !== undefined) {
        this.deps.host.log(`skipping issue #${issue.number}: ${why}`);
        continue;
      }
      const index = (runIssues.picked ?? this.state.itemsCompleted) + 1;
      const instructions = runIssues.instructions?.trim() ?? "";
      const handoff = render(this.deps.templates.issue, {
        issue_number: issue.number,
        issue_title: issue.title,
        issue_url: issue.url,
        issue_author: issue.author || "unknown",
        issue_body: issue.body.trim() === "" ? "(no description)" : issue.body.trim(),
        repo_slug: slug,
        label: tasks.label,
        instructions:
          instructions === "" ? "" : `\n## Instructions for this run\n\n${instructions}\n`,
      });
      const item = newItem(index, tasks.repo, handoff);
      item.label = `#${issue.number} ${issue.title}`;
      item.issue = { number: issue.number, title: issue.title, url: issue.url, repoSlug: slug };
      runIssues.picked = index;
      this.state.item = item;
      await this.save();
      await this.event({ type: "issue_picked", item: index, issue: issue.url });
      this.log(item, `picked issue ${issue.url}`);
      const lost = await this.claim(item, item.issue, issue);
      if (lost === undefined) return item;
      this.log(item, `lost issue #${issue.number} to another claim (${lost}); trying the next one`);
      const lostIssue = item.issue;
      await this.github(item, `release issue #${issue.number}`, () =>
        releaseClaim(forge, lostIssue),
      );
      exclude.add(issue.number);
      delete this.state.item;
      await this.save();
    }
    return `no open issue labelled "${tasks.label}" is left to do in ${slug}`;
  }

  /**
   * Claims the issue for this run: the in-progress label and/or an assignment to nightshift's
   * account. What it adds is recorded before it is added, so a crash in between still releases it.
   * Returns why the claim was lost to someone else, or undefined.
   */
  private async claim(
    item: ItemState,
    issue: ItemIssue,
    current?: Issue,
  ): Promise<string | undefined> {
    const { forge } = this.deps;
    const { tasks } = this.deps.config;
    const me = await forge.currentUser();
    const before = current ?? (await forge.issue(issue.repoSlug, issue.number));
    if (tasks.in_progress_label !== "") issue.claimLabel ??= tasks.in_progress_label;
    if (tasks.assign && issue.assignee === undefined && !before.assignees.includes(me)) {
      issue.assignee = me;
    }
    await this.save();
    if (issue.claimLabel !== undefined) {
      await forge.ensureLabel(
        issue.repoSlug,
        issue.claimLabel,
        IN_PROGRESS_COLOR,
        IN_PROGRESS_DESCRIPTION,
      );
    }
    await forge.editIssue(issue.repoSlug, issue.number, {
      addLabels:
        issue.claimLabel !== undefined && !hasLabel(before, issue.claimLabel)
          ? [issue.claimLabel]
          : [],
      addAssignees:
        issue.assignee !== undefined && !before.assignees.includes(issue.assignee)
          ? [issue.assignee]
          : [],
    });
    const after = await forge.issue(issue.repoSlug, issue.number);
    const others = after.assignees.filter((login) => login.toLowerCase() !== me.toLowerCase());
    if (others.length > 0) return `assigned to ${others.join(", ")}`;
    issue.claimed = true;
    await this.save();
    await this.event({ type: "issue_claimed", item: item.index, issue: issue.url });
    return undefined;
  }

  /**
   * Claude found nothing to change for this issue: say so on the issue, label it for a human, let
   * go of it and go on with the next issue. GitHub errors here are logged, not fatal: the run has
   * already decided, and `skipped` keeps it from picking the issue again.
   */
  private async setIssueAside(
    item: ItemState,
    issue: ItemIssue,
    summary: string,
  ): Promise<undefined> {
    const { forge } = this.deps;
    const blocked = this.deps.config.tasks.blocked_label;
    this.log(item, `no change needed for issue #${issue.number}; setting it aside`);
    await this.github(item, `set issue #${issue.number} aside`, async () => {
      const relabel =
        blocked === ""
          ? ""
          : ` It is labelled \`${blocked}\` so nightshift does not pick it again; remove the label to queue it again, or close the issue.`;
      await forge.commentIssue(
        issue.repoSlug,
        issue.number,
        `**nightshift** looked at this issue and opened no pull request:\n\n${quote(summary)}\n\n${relabel.trim()}`.trim(),
      );
      if (blocked !== "") {
        await forge.ensureLabel(issue.repoSlug, blocked, BLOCKED_COLOR, BLOCKED_DESCRIPTION);
        await forge.editIssue(issue.repoSlug, issue.number, { addLabels: [blocked] });
      }
      await releaseClaim(forge, issue);
    });
    this.state.issues ??= {};
    this.state.issues.skipped = [...(this.state.issues.skipped ?? []), issue.number];
    await this.event({ type: "issue_set_aside", item: item.index, issue: issue.url, summary });
    delete this.state.item;
    await this.save();
    return undefined;
  }

  /**
   * After the merge: the PR's `Closes #N` normally closed the issue already; if not, close it with a
   * comment linking the PR. The in-progress label comes off; the assignee stays as a record.
   */
  private async ensureIssueClosed(
    item: ItemState,
    issue: ItemIssue,
    pr: NonNullable<ItemState["pr"]>,
  ): Promise<void> {
    const { forge } = this.deps;
    let current = await forge.issue(issue.repoSlug, issue.number);
    if (current.state === "OPEN") {
      await forge.closeIssue(
        issue.repoSlug,
        issue.number,
        `Fixed by ${pr.url}${item.mergeSha === undefined ? "" : ` (merged as ${item.mergeSha})`}. Closed by nightshift.`,
      );
      current = await forge.issue(issue.repoSlug, issue.number);
      if (current.state !== "CLOSED") {
        throw new Error(`issue #${issue.number} is still open after closing it`);
      }
      this.log(item, `closed issue ${issue.url}`);
      await this.event({
        type: "issue_closed",
        item: item.index,
        issue: issue.url,
        by: "nightshift",
      });
    } else {
      this.log(item, `issue ${issue.url} is closed`);
      await this.event({ type: "issue_closed", item: item.index, issue: issue.url, by: "github" });
    }
    const label = issue.claimLabel;
    if (label !== undefined && hasLabel(current, label)) {
      await this.github(item, `remove label "${label}"`, () =>
        forge.editIssue(issue.repoSlug, issue.number, { removeLabels: [label] }),
      );
    }
  }

  /**
   * The run stopped on an issue item and needs a human: label the issue and say why on it (once
   * per distinct reason, across resumes). Best effort: a GitHub failure here must not hide the stop.
   */
  private async noteIssue(reason: string, kind: "halted" | "blocked"): Promise<void> {
    const item = this.state.item;
    const issue = item?.issue;
    if (item === undefined || issue === undefined) return;
    const { forge } = this.deps;
    const blocked = this.deps.config.tasks.blocked_label;
    if (issue.noted !== reason) {
      await this.github(item, `comment on issue #${issue.number}`, async () => {
        const next =
          kind === "blocked"
            ? 'It needs an answer: whoever runs nightshift continues with `nightshift resume --answer "…"`.'
            : "Once the cause is fixed, `nightshift resume` continues; `nightshift run --force` abandons the run and releases this issue.";
        const pr = item.pr === undefined ? "" : `\n\nPull request: ${item.pr.url}`;
        await forge.commentIssue(
          issue.repoSlug,
          issue.number,
          `**nightshift stopped** on this issue (run \`${this.state.runId}\`, step \`${item.phase}\`):\n\n${quote(reason)}${pr}\n\n${next}`,
        );
        issue.noted = reason;
      });
    }
    if (blocked !== "" && issue.flagged === undefined) {
      await this.github(item, `label issue #${issue.number} "${blocked}"`, async () => {
        await forge.ensureLabel(issue.repoSlug, blocked, BLOCKED_COLOR, BLOCKED_DESCRIPTION);
        await forge.editIssue(issue.repoSlug, issue.number, { addLabels: [blocked] });
        issue.flagged = blocked;
      });
    }
  }

  /** On `resume`: a human has looked at it, so the blocked label comes off again. */
  private async unflagIssue(item: ItemState, issue: ItemIssue): Promise<void> {
    const label = issue.flagged;
    if (label === undefined) return;
    await this.github(item, `remove label "${label}"`, async () => {
      await this.deps.forge.editIssue(issue.repoSlug, issue.number, { removeLabels: [label] });
      delete issue.flagged;
    });
    await this.save();
  }

  /** Runs a GitHub update whose failure should be logged and recorded, not stop the run. */
  private async github(item: ItemState, what: string, body: () => Promise<void>): Promise<void> {
    try {
      await body();
    } catch (error) {
      const message = (error as Error).message;
      this.log(item, `could not ${what}: ${message}`);
      await this.event({ type: "issue_update_failed", item: item.index, what, error: message });
    }
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

    const gate = await this.gates();
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
  private async gates(): Promise<UsageGate> {
    for (;;) {
      const outside = await this.scheduleGate();
      if (outside) return { ok: false, exit: outside };
      const gate = await this.usageGate();
      if (!gate.ok) return gate;
      if (isActive(this.deps.config.schedule.active_hours, this.deps.host.now())) return gate;
    }
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
    try {
      return await this.waitUntil(until);
    } finally {
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
    // A planned pause or Ctrl-C is no news for the issue; everything else needs a human.
    if (kind !== "paused" && !this.signal.aborted) await this.noteIssue(reason, kind);
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
    return this.repoDir(item.repo);
  }

  private repoDir(alias: string): string {
    const dir = this.deps.config.repos[alias];
    if (dir === undefined) throw new Error(`unknown repo alias "${alias}"`);
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
