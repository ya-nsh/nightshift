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
  Worktrees,
} from "./ports.js";
import { isActive, nextStart } from "./schedule.js";
import {
  finalizeLanesResult,
  finalizeResult,
  type ImplementResult,
  implementResult,
  type StepResult,
  stepResult,
  toJsonSchema,
} from "./schemas.js";
import {
  AGENT_PHASES,
  type ItemState,
  type Phase,
  type RunState,
  STATE_VERSION,
  type StateStore,
} from "./state.js";
import { render, type TemplateName, type Templates } from "./templates.js";
import {
  account,
  describeUsage,
  formatTime,
  type LimitHit,
  limitHit,
  limitsEnabled,
  missingWindows,
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
  /** Required when `[limits] lanes` is above 1. */
  worktrees?: Worktrees;
}

export interface InvocationOptions {
  /** Stop after this many completed items in this invocation; 0 = no limit. Overrides the config. */
  maxItems?: number;
  /** Answer to the question the run halted on. */
  answer?: string;
  /** With several items waiting for an answer: the index of the item `answer` is for. */
  answerItem?: number;
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

/** One step (or review) whose usage is being measured; see `watchUsage`. */
interface UsageShare {
  item: ItemState;
  step: string;
  /** Aborts the step when a limit is reached; undefined for a review, which is not cut. */
  guard: AbortController | undefined;
  points: Partial<Record<UsageWindow, number>>;
  cut: LimitHit | undefined;
}

/** How bad an exit is: the exit of a run with several lanes is its worst lane's. */
const SEVERITY: Record<ExitKind, number> = { done: 0, paused: 1, blocked: 2, halted: 3 };

/** Runs async sections one at a time, in call order. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(body: () => Promise<T>): Promise<T> {
    const result = this.tail.then(body);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
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
    version: STATE_VERSION,
    runId,
    startedAt: now.toISOString(),
    status: "running",
    itemsCompleted: 0,
    costUsd: 0,
    items: [newItem(1, repo, prompt)],
    nextIndex: 2,
  };
}

/**
 * Drives items through
 * implement → review ⇄ address → checks ⇄ fix_checks → merge (⇄ resolve_conflicts) → finalize,
 * persisting state after every transition so a crash or Ctrl-C resumes where it stopped.
 *
 * With `[limits] lanes = 1` one item runs at a time in the repository's own checkout. With more
 * lanes, up to that many items run at once, each in a git worktree nightshift creates; merges are
 * serialized, and budget, usage limits, active hours and STOP apply to all lanes together.
 */
export class Pipeline {
  private invocationCostUsd = 0;
  private itemsThisInvocation = 0;
  private signal: AbortSignal = new AbortController().signal;
  /** More than one lane: item-level stops park their lane instead of ending the run. */
  private readonly parallel: boolean;
  /** With lanes: the run-wide stop (STOP, usage, schedule, disk, budget) every lane obeys. */
  private runStop: Exit | undefined;
  /** With lanes: a lane stopped, so the others finish their current item and no new item starts. */
  private draining = false;
  /** With lanes: why the last item to end found nothing left, for the final "done". */
  private doneReason: string | undefined;
  /** USD promised to Claude steps that are running right now (the invocation budget is shared). */
  private reservedUsd = 0;
  private budgetFreed: Array<() => void> = [];
  private readonly mergeLock = new Mutex();
  /** Merges done in this invocation, and how many each item had seen when it last checked. */
  private mergeCount = 0;
  private readonly mergesSeen = new Map<number, number>();
  /** Steps whose usage is being measured; readings are shared, so nothing is counted twice. */
  private readonly usageShares = new Set<UsageShare>();
  private usageBaseline: UsageWindows | undefined;
  private lastUsageReadingAt = 0;
  /** Lanes sleeping in `sleepUntil` right now (they share `state.waiting`). */
  private sleepers = 0;

  constructor(
    private readonly deps: PipelineDeps,
    private readonly state: RunState,
  ) {
    this.parallel = deps.config.limits.lanes > 1;
  }

  async run(options: InvocationOptions): Promise<Exit> {
    this.signal = options.signal;
    if (this.state.status === "done" || this.state.items.length === 0) {
      return {
        kind: "done",
        reason: this.state.haltReason ?? "run already finished",
        state: this.state,
      };
    }
    if (this.parallel && this.deps.worktrees === undefined) {
      throw new Error("parallel lanes need git worktrees, but none were provided");
    }
    this.takeAnswer(options.answer, options.answerItem);
    for (const item of this.state.items) this.freshStart(item);
    const maxItems = options.maxItems ?? this.deps.config.limits.max_items;
    this.state.status = "running";
    delete this.state.haltReason;
    this.deps.host.clearStop();
    await this.save();
    const first = this.state.items[0];
    await this.event({
      type: "invocation_start",
      item: first?.index,
      phase: first?.phase,
      ...(this.parallel
        ? { lanes: this.deps.config.limits.lanes, items: this.state.items.map((i) => i.index) }
        : {}),
    });
    return this.parallel ? this.runLanes(maxItems) : this.runSingle(maxItems);
  }

  /** Attaches `answer` to the item waiting for it; refuses to run when every item is waiting. */
  private takeAnswer(answer: string | undefined, answerItem: number | undefined): void {
    const waiting = this.state.items.filter((i) => i.pendingQuestion !== undefined);
    if (answer !== undefined) {
      let target: ItemState | undefined;
      if (answerItem !== undefined) {
        target = this.state.items.find((i) => i.index === answerItem);
        if (target === undefined) throw new Error(`there is no item ${answerItem} in this run`);
        if (target.pendingQuestion === undefined) {
          throw new Error(`item ${answerItem} is not waiting for an answer (no open question)`);
        }
      } else {
        const unanswered = waiting.filter((i) => i.pendingAnswer === undefined);
        target =
          waiting.length === 1 ? waiting[0] : unanswered.length === 1 ? unanswered[0] : undefined;
        if (waiting.length === 0) {
          throw new Error("the run is not waiting for an answer (no open question)");
        }
        if (target === undefined) {
          throw new Error(
            `several items are waiting for an answer; pick one with --item:\n${waiting.map((i) => `  item ${i.index}: ${i.pendingQuestion}`).join("\n")}`,
          );
        }
      }
      target.pendingAnswer = answer;
      return;
    }
    const runnable = this.state.items.some((i) => !this.awaitingAnswer(i));
    const open = waiting.find((i) => i.pendingAnswer === undefined);
    if (!runnable && open !== undefined) {
      throw new Error(`the run is waiting for an answer: ${open.pendingQuestion}\nuse --answer`);
    }
  }

  private awaitingAnswer(item: ItemState): boolean {
    return item.pendingQuestion !== undefined && item.pendingAnswer === undefined;
  }

  /** One lane: the item runs in the repository's own checkout, and any stop ends the run. */
  private async runSingle(maxItems: number): Promise<Exit> {
    try {
      for (;;) {
        if (this.signal.aborted) throw new Aborted();
        const stop = await this.stopRequest();
        if (stop) return stop;
        const current = this.state.items[0];
        if (current === undefined) return await this.finish("no task left");
        const exit = await this.step(current);
        if (exit) return exit;
        if (
          current !== this.state.items[0] &&
          maxItems > 0 &&
          this.itemsThisInvocation >= maxItems
        ) {
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
   * Several lanes: starts a lane for every runnable item, up to `[limits] lanes` (and no more than
   * `maxItems` allows), and starts new lanes as items finish and hand over next items. Ends when no
   * lane is running and none can start.
   */
  private async runLanes(maxItems: number): Promise<Exit> {
    const running = new Map<ItemState, Promise<void>>();
    for (;;) {
      if (this.runStop === undefined && !this.draining && !this.signal.aborted) {
        for (const item of this.state.items) {
          if (running.size >= this.laneLimit(maxItems)) break;
          if (running.has(item) || item.stopped !== undefined || this.awaitingAnswer(item)) {
            continue;
          }
          const lane = this.lane(item).finally(() => running.delete(item));
          running.set(item, lane);
        }
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
    }
    return this.concludeLanes(maxItems);
  }

  /** How many lanes may run: `[limits] lanes`, but not more items than the item limit has left. */
  private laneLimit(maxItems: number): number {
    const { lanes } = this.deps.config.limits;
    return maxItems > 0 ? Math.min(lanes, maxItems - this.itemsThisInvocation) : lanes;
  }

  /** Drives one item until it is done (and leaves the list), its lane stops, or the run stops. */
  private async lane(item: ItemState): Promise<void> {
    this.log(item, `lane started (phase ${item.phase})`);
    try {
      while (this.state.items.includes(item)) {
        if (this.signal.aborted) return;
        const stop = await this.stopRequest();
        if (stop) return;
        const exit = await this.step(item);
        if (exit) return;
      }
    } catch (error) {
      if (error instanceof Aborted || this.signal.aborted) return;
      const reason = `error: ${(error as Error).message}`;
      try {
        await this.stopLane(item, reason, "halted");
      } catch {
        // Recording the stop failed too (e.g. the state file cannot be written): stop in memory.
        item.stopped = { kind: "halted", reason };
        this.draining = true;
      }
    } finally {
      this.laneEnded(item);
    }
  }

  /**
   * A lane ends when its item left the list or something stopped it. Should one ever end without
   * either, its item is parked rather than restarted at once, so the scheduler cannot spin.
   */
  private laneEnded(item: ItemState): void {
    const accounted =
      !this.state.items.includes(item) ||
      item.stopped !== undefined ||
      this.awaitingAnswer(item) ||
      this.runStop !== undefined ||
      this.signal.aborted;
    if (accounted) return;
    item.stopped = { kind: "halted", reason: `lane ended in phase ${item.phase} without a result` };
    this.draining = true;
  }

  /** The exit of a run with lanes, once no lane is running: its worst stop, or done. */
  private async concludeLanes(maxItems: number): Promise<Exit> {
    if (this.signal.aborted) return this.conclude("halted", "interrupted");
    const stops: Array<{ kind: Exclude<ExitKind, "done">; reason: string }> = [];
    if (this.runStop !== undefined && this.runStop.kind !== "done") {
      stops.push({ kind: this.runStop.kind, reason: this.runStop.reason });
    }
    for (const item of this.state.items) {
      if (item.stopped !== undefined) {
        stops.push({
          kind: item.stopped.kind,
          reason: `[${this.name(item)}] ${item.stopped.reason}`,
        });
      } else if (this.awaitingAnswer(item)) {
        stops.push({
          kind: "blocked",
          reason: `[${this.name(item)}] needs a human: ${item.pendingQuestion}`,
        });
      }
    }
    if (stops.length > 0) {
      const worst = stops.reduce((a, b) => (SEVERITY[b.kind] > SEVERITY[a.kind] ? b : a));
      const reason =
        stops.length === 1 ? worst.reason : stops.map((stop) => stop.reason).join("; ");
      return this.conclude(worst.kind, reason);
    }
    if (this.state.items.length === 0) return this.finish(this.doneReason ?? "no task left");
    if (maxItems > 0 && this.itemsThisInvocation >= maxItems) {
      return this.pause(`item limit reached (${maxItems} this invocation)`);
    }
    // Items remain that no lane could start (laneEnded parks the ones that would spin).
    return this.conclude("halted", "no lane could make progress");
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
    delete item.stopped;
    if (item.phase === "checks") {
      delete item.checksSince;
      delete item.noChecksSince;
    }
  }

  private async step(item: ItemState): Promise<Exit | undefined> {
    const restarted = item.inFlight === item.phase || item.interruptedPhase === item.phase;
    if (this.parallel && (AGENT_PHASES.has(item.phase) || item.phase === "review")) {
      const failed = await this.ensureWorktree(item);
      if (failed) return failed;
    }
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
        // One merge at a time: each merge changes the base every other PR merges into.
        return this.parallel ? this.mergeLock.run(() => this.merge(item)) : this.merge(item);
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
        await this.removeItem(item);
        return this.nothingLeft(`no task left: ${r.summary}`);
      case "failed":
        return this.stopLane(item, `implement failed: ${r.summary}`, "halted");
      case "pr_opened": {
        if (r.pr_number === undefined) {
          return this.stopLane(item, "implement reported pr_opened without pr_number", "halted");
        }
        const repoSlug = await this.deps.forge.repoSlug(this.repoPath(item));
        const pr = await this.deps.forge.pullRequest(repoSlug, r.pr_number);
        if (pr.state !== "OPEN") {
          return this.stopLane(item, `PR #${pr.number} is ${pr.state}`, "halted");
        }
        if (pr.isDraft) return this.stopLane(item, `PR #${pr.number} is a draft`, "halted");
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
    const running = this.deps.reviewer.run({
      command: review.command,
      cwd: this.workDir(item),
      repoSlug: pr.repoSlug,
      pr: pr.number,
      prUrl: pr.url,
      branch: pr.branch,
      timeoutMs: review.timeout_minutes * 60_000,
      logPath: this.artifact(item, `review-${item.reviewRound}.log`),
      signal: this.signal,
    });
    // Alone, the usage the review caused is what changed while it ran. With lanes, other steps run
    // meanwhile, so the review joins their shared measurement instead (and is not cut by it).
    const result =
      gate.before !== undefined && this.parallel
        ? await this.watchUsage(item, "review", gate.before, undefined).until(running)
        : await running;
    if (this.signal.aborted) throw new Aborted();
    if (gate.before !== undefined && !this.parallel) {
      await this.accountSince(item, "review", gate.before);
    }
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
      return this.stopLane(
        item,
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
      const stop = await this.stopRequest();
      if (stop) return stop;
      const current = await this.deps.forge.pullRequest(pr.repoSlug, pr.number);
      if (current.state === "MERGED") {
        item.mergeSha = current.mergeCommitSha;
        item.phase = "finalize";
        return undefined;
      }
      if (current.state === "CLOSED") {
        return this.stopLane(item, `PR #${pr.number} was closed`, "halted");
      }
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
          return this.stopLane(
            item,
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
        return this.stopLane(
          item,
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
    if (this.parallel && (this.mergesSeen.get(item.index) ?? 0) < this.mergeCount) {
      // A sibling PR merged since this one was last looked at: give GitHub time to recompute
      // whether this one still merges cleanly, instead of trusting a stale answer.
      this.log(item, "another lane merged; re-checking mergeability");
      await this.deps.host.sleep(MERGEABILITY_WAIT_MS, this.signal);
    }
    this.mergesSeen.set(item.index, this.mergeCount);
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
    if (current.state === "CLOSED") {
      return this.stopLane(item, `PR #${pr.number} was closed`, "halted");
    }
    if (current.isDraft) {
      return this.stopLane(item, `PR #${pr.number} was turned into a draft`, "halted");
    }
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
    // With lanes, a sibling's merge can also leave this PR behind a base that branch protection
    // requires it to be up to date with; bringing it up to date is the same step as a conflict.
    const behind = this.parallel && current.mergeStateStatus === "BEHIND";
    if (current.mergeable === "CONFLICTING" || behind) {
      if (item.conflictRound >= merge.max_conflict_rounds) {
        item.capHit = "resolve_conflicts";
        return this.stopLane(
          item,
          `PR #${pr.number} still ${behind ? "is behind" : "conflicts with"} ${current.baseRefName} after ${item.conflictRound} round(s)`,
          "halted",
        );
      }
      if (behind) this.log(item, `PR is behind ${current.baseRefName}; bringing it up to date`);
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
          return this.stopLane(
            item,
            `PR #${pr.number} ${why}, and enabling auto-merge failed (is "Allow auto-merge" on in the repo settings?): ${(error as Error).message}`,
            "halted",
          );
        }
        item.autoMergeSha = current.headSha;
        this.log(item, `PR ${why}; auto-merge is on, waiting for GitHub to merge it`);
        await this.event({ type: "auto_merge", item: item.index, pr: pr.url, reason: why });
        return undefined;
      }
      return this.stopLane(
        item,
        `PR #${pr.number} ${why} before it can merge: ${pr.url} (merge it yourself, or approve it and run \`nightshift resume\`; merge.when_blocked = "auto" waits instead)`,
        "halted",
      );
    }
    try {
      await forge.merge(pr.repoSlug, pr.number, merge.method, current.headSha);
    } catch (error) {
      return this.stopLane(
        item,
        `merge of PR #${pr.number} failed: ${(error as Error).message}`,
        "halted",
      );
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
    this.mergeCount += 1;
    this.mergesSeen.set(item.index, this.mergeCount);
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
    if (this.parallel) return this.finalizeLane(item, restarted);
    const pr = this.requirePr(item);
    const aliases = Object.keys(this.deps.config.repos) as [string, ...string[]];
    const schema = finalizeResult(aliases);
    const result = await this.agentStep(item, "finalize", schema, restarted, {
      ...this.prVars(pr),
      merge_sha: item.mergeSha ?? "(unknown)",
      repos: this.repoList(),
    });
    if (!result.ok) return result.exit;
    const r = result.value;
    if (r.status === "all_done") {
      await this.completeItem(item);
      return this.nothingLeft(`no task left: ${r.summary}`);
    }
    const next =
      r.next_repo !== undefined && r.next_prompt !== undefined && r.next_prompt.trim() !== ""
        ? [{ repo: r.next_repo, prompt: r.next_prompt }]
        : [];
    return this.handOver(item, r.status, next, r.question ?? r.summary);
  }

  /**
   * Finalize with lanes: Claude is told which items are in progress and may hand over as many next
   * items as lanes are free once this one is done, each independent of those in progress.
   */
  private async finalizeLane(item: ItemState, restarted: boolean): Promise<Exit | undefined> {
    const pr = this.requirePr(item);
    const aliases = Object.keys(this.deps.config.repos) as [string, ...string[]];
    const others = this.state.items.filter((other) => other !== item);
    const maxNext = Math.max(1, this.deps.config.limits.lanes - others.length);
    const schema = finalizeLanesResult(aliases, maxNext);
    const result = await this.agentStep(item, "finalize-lanes", schema, restarted, {
      ...this.prVars(pr),
      merge_sha: item.mergeSha ?? "(unknown)",
      repos: this.repoList(),
      lanes: this.deps.config.limits.lanes,
      max_next: maxNext,
      running: others.length === 0 ? "(none)" : others.map((o) => this.describe(o)).join("\n"),
    });
    if (!result.ok) return result.exit;
    const r = result.value;
    if (r.status === "all_done") {
      await this.completeItem(item);
      return this.nothingLeft(`no task left: ${r.summary}`);
    }
    const next = (r.next ?? []).filter((n) => n.prompt.trim() !== "");
    if (r.status === "continue" && next.length === 0 && others.length > 0) {
      // Everything left waits on items in progress; their finalize steps pick it up.
      await this.completeItem(item);
      this.log(item, "nothing can start in parallel right now");
      return undefined;
    }
    return this.handOver(item, r.status, next, r.question ?? r.summary);
  }

  /** Completes `item` and queues the next items finalize handed over. */
  private async handOver(
    item: ItemState,
    status: "continue" | "blocked",
    next: ReadonlyArray<{ repo: string; prompt: string }>,
    question: string,
  ): Promise<Exit | undefined> {
    if (status === "continue") {
      if (next.length === 0) {
        return this.stopLane(
          item,
          this.parallel
            ? "finalize reported continue without next items"
            : "finalize reported continue without next_repo and next_prompt",
          "halted",
        );
      }
      await this.completeItem(item);
      this.queue(next);
      return undefined;
    }
    // blocked: if the next prompt is known, hand it over and let the answer travel with it.
    if (next.length > 0) {
      await this.completeItem(item);
      const [first] = this.queue(next);
      if (first !== undefined) return this.blocked(first, question);
    }
    return this.blocked(item, question);
  }

  /** Adds handed-over items to the run, with fresh indexes. */
  private queue(next: ReadonlyArray<{ repo: string; prompt: string }>): ItemState[] {
    const added = next.map(({ repo, prompt }) => newItem(this.state.nextIndex++, repo, prompt));
    this.state.items.push(...added);
    for (const item of added) this.log(item, `handed over (repo ${item.repo})`);
    return added;
  }

  /** An item ended with "no task left": with lanes, the run goes on while other items remain. */
  private nothingLeft(reason: string): Promise<Exit> | undefined {
    if (!this.parallel) return this.finish(reason);
    this.doneReason = reason;
    return undefined;
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
    const budget = await this.reserveBudget(item);
    if (!budget.ok) return budget;
    try {
      return await this.reservedStep(item, template, schema, restarted, vars, budget.left);
    } finally {
      this.releaseBudget(budget.left);
    }
  }

  /**
   * The USD the next step of `item` may spend: what is left of the item's budget and of the
   * invocation's, less what running steps of other lanes were promised. Reserved until the step
   * ends, so lanes together never exceed the invocation budget.
   */
  private async reserveBudget(
    item: ItemState,
  ): Promise<{ ok: true; left: number } | { ok: false; exit: Exit }> {
    const { budget } = this.deps.config;
    for (;;) {
      const itemLeft = budget.item_usd - item.costUsd;
      const runLeft = budget.invocation_usd - this.invocationCostUsd - this.reservedUsd;
      const left = Math.min(itemLeft, runLeft);
      if (left >= MIN_STEP_BUDGET_USD) {
        this.reservedUsd += left;
        return { ok: true, left };
      }
      if (itemLeft >= MIN_STEP_BUDGET_USD && this.reservedUsd > 0) {
        // Other lanes' running steps hold the rest; see what they leave.
        this.log(item, "waiting for other lanes' steps to finish (invocation budget is reserved)");
        await new Promise<void>((resolve) => this.budgetFreed.push(resolve));
        if (this.signal.aborted) throw new Aborted();
        continue;
      }
      const reason = `budget exhausted (item $${item.costUsd.toFixed(2)} of $${budget.item_usd}, this invocation $${this.invocationCostUsd.toFixed(2)} of $${budget.invocation_usd})`;
      // The invocation's budget is every lane's; an item's own is only its lane's.
      const exit =
        itemLeft < MIN_STEP_BUDGET_USD
          ? await this.stopLane(item, reason, "halted")
          : await this.halt(reason, "halted");
      return { ok: false, exit };
    }
  }

  private releaseBudget(amount: number): void {
    this.reservedUsd = Math.max(0, this.reservedUsd - amount);
    const waiting = this.budgetFreed;
    this.budgetFreed = [];
    for (const resolve of waiting) resolve();
  }

  private async reservedStep<S extends z.ZodType>(
    item: ItemState,
    template: TemplateName,
    schema: S,
    restarted: boolean,
    vars: Record<string, string | number>,
    left: number,
  ): Promise<StepOutcome<z.infer<S>>> {
    const gate = await this.gates();
    if (!gate.ok) return gate;
    // Cleared only once the step really starts again, so a pause before then keeps the restart.
    delete item.interruptedPhase;

    const allVars = {
      repo: item.repo,
      repo_path: this.repoPath(item),
      work_path: this.workDir(item),
      item_index: item.index,
      item_label: this.name(item),
      ...vars,
    };
    let prompt = render(this.deps.templates[template], allVars);
    if (this.parallel) {
      prompt = render(this.deps.templates.lane, {
        ...allVars,
        base_branch: item.worktree?.base ?? "the default branch",
        step_prompt: prompt,
      });
    }
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
          exit: await this.stopLane(
            item,
            `${template}: invalid structured result (${issues})`,
            "halted",
          ),
        };
      }
      case "max_budget":
        return {
          ok: false,
          exit: await this.stopLane(item, `${template}: Claude hit the budget ceiling`, "halted"),
        };
      case "max_turns":
        return {
          ok: false,
          exit: await this.stopLane(item, `${template}: Claude hit max_turns`, "halted"),
        };
      case "no_structured_output":
        return {
          ok: false,
          exit: await this.stopLane(item, `${template}: no structured result returned`, "halted"),
        };
      case "error":
        return {
          ok: false,
          exit: await this.stopLane(item, `${template}: agent error: ${result.detail}`, "halted"),
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
      let running: Promise<AgentResult>;
      try {
        running = this.deps.agent.run({
          cwd: this.workDir(item),
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
      } catch (error) {
        watch?.cancel();
        throw error;
      }
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
    this.sleepers += 1;
    await this.save();
    await this.event({ type: eventType, reason, until: untilIso });
    try {
      return await this.waitUntil(until);
    } finally {
      this.sleepers -= 1;
      if (this.sleepers === 0) delete this.state.waiting;
      await this.save();
    }
  }

  /** Sleeps until `until` (epoch ms) in slices; returns an exit if a stop was requested. */
  private async waitUntil(until: number): Promise<Exit | undefined> {
    for (;;) {
      if (this.signal.aborted) throw new Aborted();
      const stop = await this.stopRequest();
      if (stop) return stop;
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
   *
   * Steps of parallel lanes share one measurement: every reading is counted once, split evenly
   * between the steps running at the time, and a limit reached stops all of them. `guard` is
   * undefined for a review, which is measured but never cut.
   */
  private watchUsage(
    item: ItemState,
    step: string,
    before: UsageWindows,
    guard: AbortController | undefined,
  ): {
    streamed: (windows: UsageWindows) => void;
    until: <T>(running: Promise<T>) => Promise<T>;
    cut: () => LimitHit | undefined;
    /** For a step that never started: stop measuring for it. */
    cancel: () => void;
  } {
    const checkMs = this.deps.config.usage.check_seconds * 1000;
    const share: UsageShare = { item, step, guard, points: {}, cut: undefined };
    if (this.usageShares.size === 0) {
      // Nothing of nightshift's ran since the last reading: only what changes from now on counts.
      this.usageBaseline = before;
      this.lastUsageReadingAt = this.deps.host.now().getTime();
    }
    this.usageShares.add(share);

    const take = async (signal: AbortSignal | undefined): Promise<void> => {
      const reading = await this.deps.usage?.read(signal);
      if (reading === undefined || !reading.ok) return; // transient; the next reading catches up
      this.applyUsage(reading.windows);
    };

    const until = async <T>(running: Promise<T>): Promise<T> => {
      try {
        const finished = new AbortController();
        running.then(
          () => finished.abort(),
          () => finished.abort(),
        );
        const stepSignal = AbortSignal.any([finished.signal, this.signal]);
        while (!stepSignal.aborted && share.cut === undefined) {
          await this.deps.host.sleep(checkMs, stepSignal);
          if (stepSignal.aborted) break;
          // Streamed, or read for another lane's step, recently enough.
          if (this.deps.host.now().getTime() - this.lastUsageReadingAt < checkMs) continue;
          await take(stepSignal);
          if (!stepSignal.aborted) await this.save();
        }
        const result = await running;
        if (!this.signal.aborted) await take(undefined);
        return result;
      } finally {
        this.usageShares.delete(share);
        this.addUsagePoints(item, share.points);
        await this.event({ type: "usage", item: item.index, step, points: share.points });
        const last = this.state.usage?.last;
        if (last !== undefined) {
          this.log(
            item,
            `usage: ${describeUsage(last.windows, this.usageState().tally, this.usageLimits(), this.deps.host.now())}`,
          );
        }
      }
    };

    return {
      streamed: (windows) => this.applyUsage(windows),
      until,
      cut: () => share.cut,
      cancel: () => {
        this.usageShares.delete(share);
      },
    };
  }

  /** Counts a reading taken while steps run, and stops them all if it reaches a limit. */
  private applyUsage(windows: UsageWindows): void {
    const usageState = this.usageState();
    const now = this.deps.host.now();
    const added = account(usageState.tally, this.usageBaseline ?? windows, windows);
    this.usageBaseline = windows;
    this.lastUsageReadingAt = now.getTime();
    usageState.last = { at: now.toISOString(), windows };
    const shares = [...this.usageShares];
    for (const share of shares) {
      for (const window of USAGE_WINDOWS) {
        const points = added[window];
        if (points === undefined) continue;
        share.points[window] = (share.points[window] ?? 0) + points / shares.length;
      }
    }
    const hit = limitHit(this.usageLimits(), usageState.tally, windows);
    if (hit === undefined) return;
    for (const share of shares) {
      if (share.cut !== undefined || share.guard === undefined) continue;
      share.cut = hit;
      this.log(
        share.item,
        `usage limit reached during ${share.step}: ${hit.reason}; stopping the step`,
      );
      share.guard.abort();
    }
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
    return this.stopLane(item, `${what} failed: ${r.summary}`, "halted");
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
    await this.removeItem(item);
  }

  /** Takes an item that ended off the list, and removes the worktree it had. */
  private async removeItem(item: ItemState): Promise<void> {
    this.state.items = this.state.items.filter((other) => other !== item);
    this.mergesSeen.delete(item.index);
    await this.save();
    const worktree = item.worktree;
    if (worktree === undefined || this.deps.worktrees === undefined) return;
    // The local branch goes too once its PR is merged; an unmerged one is kept for a human to see.
    const branch = item.mergeSha !== undefined ? item.pr?.branch : undefined;
    try {
      await this.deps.worktrees.remove(this.repoPath(item), worktree.path, branch);
      this.log(item, `removed worktree ${worktree.path}`);
    } catch (error) {
      this.log(item, `could not remove worktree ${worktree.path}: ${(error as Error).message}`);
    }
  }

  /** With lanes: makes sure the item has its worktree; a failure stops its lane. */
  private async ensureWorktree(item: ItemState): Promise<Exit | undefined> {
    const worktrees = this.deps.worktrees;
    if (worktrees === undefined) throw new Error("parallel lanes need git worktrees");
    const dir =
      item.worktree?.path ??
      path.join(this.deps.config.limits.worktree_dir, this.state.runId, `item-${item.index}`);
    try {
      const { base } = await worktrees.create(this.repoPath(item), dir, this.signal);
      if (item.worktree === undefined) {
        item.worktree = { path: dir, base };
        this.log(item, `worktree ${dir} (from ${base})`);
        await this.event({ type: "worktree", item: item.index, path: dir, base });
        await this.save();
      }
      return undefined;
    } catch (error) {
      if (this.signal.aborted) throw new Aborted();
      return this.stopLane(item, `cannot create a worktree: ${(error as Error).message}`, "halted");
    }
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

  /** A STOP file (or, with lanes, a stop another lane hit) ends the run at the next step. */
  private async stopRequest(): Promise<Exit | undefined> {
    if (this.runStop !== undefined) return this.runStop;
    if (!this.deps.host.stopRequested()) return undefined;
    this.deps.host.clearStop();
    return this.pause("stop requested (STOP file)");
  }

  private blocked(item: ItemState, question: string): Promise<Exit> {
    item.pendingQuestion = question;
    return this.stopLane(item, `needs a human: ${question}`, "blocked");
  }

  private pause(reason: string): Promise<Exit> {
    return this.halt(reason, "paused");
  }

  /**
   * Stops the run. With one lane it ends at once; with several, every lane stops at its next step
   * (a running step finishes) and the run ends when the last one has.
   */
  private async halt(reason: string, kind: "halted" | "blocked" | "paused"): Promise<Exit> {
    if (!this.parallel) return this.conclude(kind, reason);
    const exit: Exit = { kind, reason, state: this.state };
    if (this.runStop === undefined || SEVERITY[kind] > SEVERITY[this.runStop.kind]) {
      this.runStop = exit;
      this.deps.host.log(`stopping all lanes (${kind}): ${reason}`);
      await this.event({ type: "run_stop", kind, reason });
    }
    return exit;
  }

  /**
   * Stops what one item hit (a question, a failure). With one lane that stops the run; with several,
   * only this item's lane stops, and the others finish their current item before the run ends.
   */
  private async stopLane(
    item: ItemState,
    reason: string,
    kind: "halted" | "blocked" | "paused",
  ): Promise<Exit> {
    if (!this.parallel) return this.halt(reason, kind);
    item.stopped = { kind, reason };
    if (!this.draining) {
      this.draining = true;
      this.deps.host.log(
        "a lane stopped: the other lanes finish their current item, then the run stops",
      );
    }
    await this.save();
    await this.event({ type: "lane_stop", kind, reason, item: item.index, phase: item.phase });
    this.log(item, `${kind}: ${reason}`);
    return { kind, reason, state: this.state };
  }

  /** Ends the invocation: records why, and notifies. */
  private async conclude(kind: "halted" | "blocked" | "paused", reason: string): Promise<Exit> {
    this.state.status = "halted";
    this.state.haltReason = reason;
    await this.save();
    const item = this.focus();
    await this.event({ type: kind, reason, item: item?.index, phase: item?.phase });
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

  /** The item an exit is mostly about: the first that stopped or waits for a human. */
  private focus(): ItemState | undefined {
    const items = this.state.items;
    return (
      items.find((i) => i.stopped !== undefined) ??
      items.find((i) => i.pendingQuestion !== undefined) ??
      items[0]
    );
  }

  private notifyFields(kind: string, reason: string): Record<string, string> {
    const item = this.focus();
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

  private repoList(): string {
    return Object.entries(this.deps.config.repos)
      .map(([alias, dir]) => `- ${alias}: ${dir}`)
      .join("\n");
  }

  /** One line about an item in progress, for the prompt that picks items to run alongside it. */
  private describe(item: ItemState): string {
    const handoff = item.handoff.replace(/\s+/g, " ").trim();
    const brief = handoff.length > 300 ? `${handoff.slice(0, 300)}…` : handoff;
    const status =
      item.pendingQuestion !== undefined
        ? "waiting for a human"
        : item.stopped !== undefined
          ? `stopped: ${item.stopped.reason}`
          : `phase ${item.phase}`;
    return `- item ${item.index}${item.label ? ` (${item.label})` : ""}, repo ${item.repo}, ${status}${item.pr ? `, ${item.pr.url}` : ""}: ${brief}`;
  }

  /** Where the item's work happens: its worktree with lanes, else the repository's checkout. */
  private workDir(item: ItemState): string {
    return item.worktree?.path ?? this.repoPath(item);
  }

  private name(item: ItemState): string {
    return item.label ?? `item ${item.index}`;
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
    this.deps.host.log(`[${this.name(item)}] ${message}`);
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
