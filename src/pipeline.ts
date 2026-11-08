import path from "node:path";
import type { z } from "zod";
import { acknowledge, allowedUsers, findAnswer, postQuestion } from "./answers.js";
import { type AgentStep, type Config, type StepSettings, stepSettings } from "./config.js";
import { decideStart, estimateItem, readHistory } from "./forecast.js";
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
  Worktrees,
} from "./ports.js";
import { writeReport } from "./report.js";
import { isActive, nextStart } from "./schedule.js";
import {
  finalizeIssueResult,
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
  type ItemIssue,
  type ItemState,
  type Phase,
  type RunState,
  runItems,
  type StateStore,
  type StopCause,
  setRunItems,
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
/** The `[agent.steps.<step>]` table each step template runs with. */
const STEP_OF_TEMPLATE: Partial<Record<TemplateName, AgentStep>> = {
  implement: "implement",
  address: "address",
  "fix-checks": "fix_checks",
  "resolve-conflicts": "resolve_conflicts",
  finalize: "finalize",
  "finalize-lanes": "finalize",
};

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
  /** With parallel lanes and several open questions: the index of the item `answer` is for. */
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

/** With parallel lanes: a stop that applies to every lane. */
interface RunStop {
  exit: Exit & { kind: Exclude<ExitKind, "done"> };
  cause: StopCause;
  resumeAt: Date | undefined;
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
 * Drives items through
 * implement → review ⇄ address → checks ⇄ fix_checks → merge (⇄ resolve_conflicts) → finalize,
 * persisting state after every transition so a crash or Ctrl-C resumes where it stopped.
 *
 * With `[limits] lanes = 1` one item runs at a time in the repository's own checkout. With more
 * lanes, up to that many items run at once, each in a git worktree nightshift creates; merges are
 * serialized, and budget, usage limits, forecasts, active hours and STOP apply to all lanes together.
 */
export class Pipeline {
  private invocationCostUsd = 0;
  private itemsThisInvocation = 0;
  private signal: AbortSignal = new AbortController().signal;
  /** The phase each item runs now (by index), so a stop can record its time before the report. */
  private readonly openPhases = new Map<number, { phase: Phase; startedAt: number }>();
  /** Time each item spent in usage, schedule and forecast waits, so its time can leave it out. */
  private readonly waitedMs = new Map<number, number>();
  /** When each item's running step started, and its `waitedMs` then. */
  private readonly stepClocks = new Map<number, { at: number; waited: number }>();
  /** More than one lane: item-level stops park their lane instead of ending the run. */
  private readonly parallel: boolean;
  /** With lanes: the run-wide stop (STOP, usage, schedule, forecast, disk, budget) every lane obeys. */
  private runStop: RunStop | undefined;
  /** With lanes: a lane stopped, so the others finish their current item and no new item starts. */
  private draining = false;
  /** With lanes: why the last item to end found nothing left, for the final "done". */
  private doneReason: string | undefined;
  /** With lanes on GitHub issues: the queue was empty at the last look. */
  private issuesExhausted = false;
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
    if (this.parallel) return this.runParallel(options);
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
      await this.answeredLocally(item);
    } else if (item?.pendingQuestion !== undefined && item.pendingAnswer === undefined) {
      if (!(await this.answerFromGitHub(item))) {
        await this.save();
        const where =
          item.questionPost === undefined
            ? "use --answer"
            : `reply on ${item.questionPost.url}, or use --answer`;
        throw new Error(`the run is waiting for an answer: ${item.pendingQuestion}\n${where}`);
      }
    }
    if (item !== undefined) this.freshStart(item);
    const maxItems = options.maxItems ?? this.deps.config.limits.max_items;
    this.state.status = "running";
    delete this.state.haltReason;
    delete this.state.stop;
    this.deps.host.clearStop();
    await this.save();
    await this.event({ type: "invocation_start", item: item?.index, phase: item?.phase });
    if (item?.issue !== undefined) await this.unflagIssue(item, item.issue);

    try {
      for (;;) {
        if (this.signal.aborted) throw new Aborted();
        if (this.deps.host.stopRequested()) {
          this.deps.host.clearStop();
          return await this.pause("stop requested (STOP file)", "stop_requested");
        }
        let current = this.state.item;
        if (current === undefined) {
          if (!this.fromIssues()) return await this.finish("no task left");
          const picked = await this.startNextIssue();
          if (typeof picked === "string") return await this.finish(picked);
          if (!("index" in picked)) return picked.exit;
          current = picked;
        }
        const exit = await this.step(current);
        if (exit) return exit;
        if (current !== this.state.item && maxItems > 0 && this.itemsThisInvocation >= maxItems) {
          return await this.pause(`item limit reached (${maxItems} this invocation)`, "item_limit");
        }
      }
    } catch (error) {
      if (error instanceof Aborted || this.signal.aborted) {
        // SIGTERM is a shutdown or a service stop, not a person choosing to stop the run.
        return this.signal.reason === "SIGTERM"
          ? await this.halt("terminated (SIGTERM)", "halted", "terminated")
          : await this.halt("interrupted", "halted", "interrupted");
      }
      return await this.halt(`error: ${(error as Error).message}`, "halted");
    }
  }

  // ── parallel lanes ──────────────────────────────────────────────────────

  /** `run` with more than one lane: every item in progress gets a lane, up to `[limits] lanes`. */
  private async runParallel(options: InvocationOptions): Promise<Exit> {
    if (this.deps.worktrees === undefined) {
      throw new Error("parallel lanes need git worktrees, but none were provided");
    }
    if (this.state.status === "done" || (runItems(this.state).length === 0 && !this.fromIssues())) {
      return {
        kind: "done",
        reason: this.state.haltReason ?? "run already finished",
        state: this.state,
      };
    }
    await this.takeAnswers(options.answer, options.answerItem);
    const items = runItems(this.state);
    for (const item of items) this.freshStart(item);
    const maxItems = options.maxItems ?? this.deps.config.limits.max_items;
    this.state.status = "running";
    delete this.state.haltReason;
    delete this.state.stop;
    this.state.nextIndex ??= this.usedIndex() + 1;
    this.deps.host.clearStop();
    await this.save();
    await this.event({
      type: "invocation_start",
      item: items[0]?.index,
      phase: items[0]?.phase,
      lanes: this.deps.config.limits.lanes,
      items: items.map((i) => i.index),
    });
    for (const item of items) {
      if (item.issue !== undefined) await this.unflagIssue(item, item.issue);
    }
    return this.runLanes(maxItems);
  }

  /**
   * Attaches an answer given with `--answer` to the item waiting for it, and looks on GitHub for
   * answers to the others. Refuses to run only when nothing could start: every item waits for an
   * answer and no free lane can take a new issue.
   */
  private async takeAnswers(
    answer: string | undefined,
    answerItem: number | undefined,
  ): Promise<void> {
    const items = runItems(this.state);
    const waiting = items.filter((i) => i.pendingQuestion !== undefined);
    if (answer !== undefined) {
      let target: ItemState | undefined;
      if (answerItem !== undefined) {
        target = items.find((i) => i.index === answerItem);
        if (target === undefined) throw new Error(`there is no item ${answerItem} in this run`);
        if (target.pendingQuestion === undefined) {
          throw new Error(`item ${answerItem} is not waiting for an answer (no open question)`);
        }
      } else {
        if (waiting.length === 0) {
          throw new Error("the run is not waiting for an answer (no open question)");
        }
        const unanswered = waiting.filter((i) => i.pendingAnswer === undefined);
        target =
          waiting.length === 1 ? waiting[0] : unanswered.length === 1 ? unanswered[0] : undefined;
        if (target === undefined) {
          throw new Error(
            `several items are waiting for an answer; pick one with --item:\n${waiting.map((i) => `  item ${i.index}: ${i.pendingQuestion}`).join("\n")}`,
          );
        }
      }
      target.pendingAnswer = answer;
      await this.answeredLocally(target);
    }
    for (const item of items) {
      if (this.awaitingAnswer(item)) await this.answerFromGitHub(item);
    }
    const open = items.filter((i) => this.awaitingAnswer(i));
    const canStart =
      items.some((i) => !this.awaitingAnswer(i)) ||
      (this.fromIssues() && items.length < this.deps.config.limits.lanes);
    if (!canStart && open.length > 0) {
      await this.save();
      const lines = open.map((i) => {
        const where = i.questionPost === undefined ? "" : ` (reply on ${i.questionPost.url})`;
        return `  item ${i.index}: ${i.pendingQuestion}${where}`;
      });
      const how =
        open.length === 1 ? "use --answer" : 'use --answer "…" --item N, or reply on GitHub';
      throw new Error(
        open.length === 1
          ? `the run is waiting for an answer: ${open[0]?.pendingQuestion}\n${open[0]?.questionPost === undefined ? "use --answer" : `reply on ${open[0].questionPost.url}, or use --answer`}`
          : `the run is waiting for answers:\n${lines.join("\n")}\n${how}`,
      );
    }
  }

  private awaitingAnswer(item: ItemState): boolean {
    return item.pendingQuestion !== undefined && item.pendingAnswer === undefined;
  }

  /**
   * Starts a lane for every runnable item, up to `[limits] lanes` (and no more than `maxItems`
   * allows), takes new issues for free lanes, and starts new lanes as items finish and hand over
   * next items. Ends when no lane is running and none can start.
   */
  private async runLanes(maxItems: number): Promise<Exit> {
    const running = new Map<ItemState, Promise<void>>();
    let picker: Promise<void> | undefined;
    for (;;) {
      if (this.runStop === undefined && !this.draining && !this.signal.aborted) {
        for (const item of runItems(this.state)) {
          if (running.size >= this.laneLimit(maxItems)) break;
          if (running.has(item) || item.stopped !== undefined || this.awaitingAnswer(item)) {
            continue;
          }
          running.set(
            item,
            this.lane(item).finally(() => running.delete(item)),
          );
        }
        // With GitHub issues, a free lane takes the next issue (one pick at a time).
        if (
          picker === undefined &&
          this.fromIssues() &&
          !this.issuesExhausted &&
          running.size < this.laneLimit(maxItems) &&
          runItems(this.state).length < this.deps.config.limits.lanes
        ) {
          picker = this.pickForLane().finally(() => {
            picker = undefined;
          });
        }
      }
      if (running.size === 0 && picker === undefined) break;
      await Promise.race(picker === undefined ? running.values() : [...running.values(), picker]);
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
      while (runItems(this.state).includes(item)) {
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
        item.stopped = { kind: "halted", reason, cause: "failure" };
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
    // An item left: the issue queue may have changed meanwhile, so look at it again.
    if (!runItems(this.state).includes(item)) this.issuesExhausted = false;
    const accounted =
      !runItems(this.state).includes(item) ||
      item.stopped !== undefined ||
      this.awaitingAnswer(item) ||
      this.runStop !== undefined ||
      this.signal.aborted;
    if (accounted) return;
    item.stopped = {
      kind: "halted",
      reason: `lane ended in phase ${item.phase} without a result`,
      cause: "failure",
    };
    this.draining = true;
  }

  /**
   * With lanes on GitHub issues: takes the next issue for a free lane, after the same gates as a
   * single lane (active hours, usage limits and the forecast, which counts the items in progress).
   */
  private async pickForLane(): Promise<void> {
    try {
      const ready = await this.issueQueue();
      if (ready.queue.length === 0) {
        this.issuesExhausted = true;
        this.doneReason = ready.none;
        return;
      }
      const upcoming = newItem(this.peekIndex(), this.deps.config.tasks.repo, "");
      upcoming.label = "next issue";
      const gate = await this.gates(upcoming);
      if (!gate.ok) return; // a run-wide stop, recorded by the gate
      // The gate may have waited for hours: don't claim an issue the run will not work on.
      if (this.runStop !== undefined || this.draining || this.signal.aborted) return;
      const picked = await this.pickIssue();
      if (typeof picked === "string") {
        this.issuesExhausted = true;
        this.doneReason = picked;
        return;
      }
      picked.startedAt = this.deps.host.now().toISOString();
      await this.save();
    } catch (error) {
      if (error instanceof Aborted || this.signal.aborted) return;
      await this.halt(`error: ${(error as Error).message}`, "halted");
    }
  }

  /** The exit of a run with lanes, once no lane is running: its worst stop, or done. */
  private async concludeLanes(maxItems: number): Promise<Exit> {
    if (this.signal.aborted) {
      return this.signal.reason === "SIGTERM"
        ? this.conclude("terminated (SIGTERM)", "halted", "terminated")
        : this.conclude("interrupted", "halted", "interrupted");
    }
    const stops: Array<{
      kind: Exclude<ExitKind, "done">;
      reason: string;
      cause: StopCause;
      resumeAt?: Date;
    }> = [];
    const runStop = this.runStop;
    if (runStop !== undefined) {
      stops.push({
        kind: runStop.exit.kind,
        reason: runStop.exit.reason,
        cause: runStop.cause,
        ...(runStop.resumeAt === undefined ? {} : { resumeAt: runStop.resumeAt }),
      });
    }
    for (const item of runItems(this.state)) {
      if (item.stopped !== undefined) {
        stops.push({
          kind: item.stopped.kind,
          reason: `[${this.name(item)}] ${item.stopped.reason}`,
          cause: item.stopped.cause,
        });
      } else if (this.awaitingAnswer(item)) {
        stops.push({
          kind: "blocked",
          reason: `[${this.name(item)}] needs a human: ${item.pendingQuestion}`,
          cause: "question",
        });
      }
    }
    if (stops.length > 0) {
      const worst = stops.reduce((a, b) => (SEVERITY[b.kind] > SEVERITY[a.kind] ? b : a));
      const reason =
        stops.length === 1 ? worst.reason : stops.map((stop) => stop.reason).join("; ");
      // A run-wide failure leaves every issue in progress waiting for a human, too.
      if (runStop !== undefined && runStop.exit.kind !== "paused") {
        for (const item of runItems(this.state)) {
          if (item.stopped === undefined) {
            await this.noteIssue(item, runStop.exit.reason, runStop.exit.kind);
          }
        }
      }
      return this.conclude(reason, worst.kind, worst.cause, worst.resumeAt);
    }
    const items = runItems(this.state);
    if (items.length === 0 && (!this.fromIssues() || this.issuesExhausted)) {
      return this.finish(this.doneReason ?? "no task left");
    }
    if (maxItems > 0 && this.itemsThisInvocation >= maxItems) {
      return this.conclude(
        `item limit reached (${maxItems} this invocation)`,
        "paused",
        "item_limit",
      );
    }
    // Items remain that no lane could start (laneEnded parks the ones that would spin).
    return this.conclude("no lane could make progress", "halted", "failure");
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
    this.openPhases.set(item.index, {
      phase: item.phase,
      startedAt: this.deps.host.now().getTime(),
    });
    this.stepClocks.set(item.index, {
      at: this.deps.host.now().getTime(),
      waited: this.waited(item),
    });
    let exit: Exit | undefined;
    try {
      exit = await this.runPhase(item, restarted);
    } finally {
      // A finished item already counted its time (completeItem); only a current one adds it.
      if (runItems(this.state).includes(item)) item.activeMs = this.activeMs(item);
      this.stepClocks.delete(item.index);
    }
    delete item.inFlight;
    await this.save();
    await this.closePhase(item.index);
    return exit;
  }

  /** Records how long an open phase ran (for the report's time per step); all of them without `index`. */
  private async closePhase(index?: number): Promise<void> {
    const indexes =
      index === undefined ? [...this.openPhases.keys()].sort((a, b) => a - b) : [index];
    for (const at of indexes) {
      const open = this.openPhases.get(at);
      if (open === undefined) continue;
      this.openPhases.delete(at);
      const durationMs = this.deps.host.now().getTime() - open.startedAt;
      await this.event({ type: "phase", item: at, phase: open.phase, durationMs });
    }
  }

  /** The item's active time, including the running step so far (without its waits). */
  private activeMs(item: ItemState): number {
    const clock = this.stepClocks.get(item.index);
    const step =
      clock === undefined
        ? 0
        : this.deps.host.now().getTime() - clock.at - (this.waited(item) - clock.waited);
    return Math.max(0, Math.round((item.activeMs ?? 0) + step));
  }

  /** Time the item has spent in waits during this invocation. */
  private waited(item: ItemState): number {
    return this.waitedMs.get(item.index) ?? 0;
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
    if (item.issue !== undefined && item.issue.claimed !== true) {
      // nightshift stopped between picking the issue and claiming it.
      const lost = await this.claim(item, item.issue);
      if (lost !== undefined) {
        return this.stopLane(
          item,
          `issue #${item.issue.number} was claimed elsewhere: ${lost}`,
          "halted",
        );
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
        if (this.parallel) {
          // With lanes, the run goes on while other items remain.
          await this.removeItem(item);
          this.doneReason = `no task left: ${r.summary}`;
          return undefined;
        }
        delete this.state.item;
        return this.finish(`no task left: ${r.summary}`);
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
    const gate = await this.gates(undefined, item);
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
    const pr = this.requirePr(item);
    if (item.issue !== undefined) return this.finalizeIssue(item, item.issue, pr, restarted);
    if (this.parallel) return this.finalizeLane(item, pr, restarted);
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
        return this.stopLane(
          item,
          "finalize reported continue without next_repo and next_prompt",
          "halted",
        );
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
    await this.removeItem(item);
    return undefined;
  }

  /**
   * Finalize with lanes: Claude is told which items are in progress and may hand over as many next
   * items as lanes are free once this one is done, each independent of those in progress.
   */
  private async finalizeLane(
    item: ItemState,
    pr: NonNullable<ItemState["pr"]>,
    restarted: boolean,
  ): Promise<Exit | undefined> {
    const aliases = Object.keys(this.deps.config.repos) as [string, ...string[]];
    const others = runItems(this.state).filter((other) => other !== item);
    const maxNext = Math.max(1, this.deps.config.limits.lanes - others.length);
    const schema = finalizeLanesResult(aliases, maxNext);
    const result = await this.agentStep(item, "finalize-lanes", schema, restarted, {
      ...this.prVars(pr),
      merge_sha: item.mergeSha ?? "(unknown)",
      repos: Object.entries(this.deps.config.repos)
        .map(([alias, dir]) => `- ${alias}: ${dir}`)
        .join("\n"),
      lanes: this.deps.config.limits.lanes,
      max_next: maxNext,
      running: others.length === 0 ? "(none)" : others.map((o) => this.describe(o)).join("\n"),
    });
    if (!result.ok) return result.exit;
    const r = result.value;
    const question = r.question ?? r.summary;
    if (r.status === "all_done") {
      await this.completeItem(item);
      await this.removeItem(item);
      this.doneReason = `no task left: ${r.summary}`;
      return undefined;
    }
    const next = (r.next ?? []).filter((n) => n.prompt.trim() !== "");
    if (r.status === "continue") {
      if (next.length === 0 && others.length === 0) {
        return this.stopLane(item, "finalize reported continue without next items", "halted");
      }
      // With none: everything left waits on items in progress, whose finalize picks it up.
      await this.completeItem(item);
      await this.removeItem(item);
      if (next.length === 0) this.log(item, "nothing can start in parallel right now");
      this.queue(next);
      return undefined;
    }
    // blocked: if the next prompt is known, hand it over and let the answer travel with it.
    if (next.length > 0) {
      await this.completeItem(item);
      await this.removeItem(item);
      const [first] = this.queue(next);
      if (first !== undefined) return this.blocked(first, question);
    }
    return this.blocked(item, question);
  }

  /** With lanes: adds handed-over items to the run, with fresh indexes. */
  private queue(next: ReadonlyArray<{ repo: string; prompt: string }>): ItemState[] {
    const added = next.map(({ repo, prompt }) => newItem(this.takeIndex(), repo, prompt));
    setRunItems(this.state, [...runItems(this.state), ...added]);
    for (const item of added) this.log(item, `handed over (repo ${item.repo})`);
    return added;
  }

  /** The highest item index this run has used. */
  private usedIndex(): number {
    return Math.max(
      0,
      this.state.itemsCompleted,
      this.state.issues?.picked ?? 0,
      ...runItems(this.state).map((i) => i.index),
    );
  }

  /** With lanes: the index the next item gets. */
  private peekIndex(): number {
    return Math.max(this.state.nextIndex ?? 1, this.usedIndex() + 1);
  }

  private takeIndex(): number {
    const index = this.peekIndex();
    this.state.nextIndex = index + 1;
    return index;
  }

  // ── GitHub issues as the task source ───────────────────────────────────

  /** Issues not to pick: those this run set aside, and those other lanes are working on. */
  private excludedIssues(): Set<number> {
    const exclude = new Set(this.state.issues?.skipped ?? []);
    for (const item of runItems(this.state)) {
      if (item.issue !== undefined) exclude.add(item.issue.number);
    }
    return exclude;
  }

  private fromIssues(): boolean {
    return this.deps.config.tasks.source === "github_issues";
  }

  /**
   * Starts the next issue item, but only once a new item may start: inside active hours, within
   * the usage limits and, with forecasts, when a typical item fits. Those gates run before the
   * issue is claimed, so a wait or pause never holds a claim; implement then does not repeat the
   * forecast. Returns why there is no issue left, or the exit a gate took.
   */
  private async startNextIssue(): Promise<ItemState | string | { exit: Exit }> {
    const ready = await this.issueQueue();
    if (ready.queue.length === 0) return ready.none;
    const index = (this.state.issues?.picked ?? this.state.itemsCompleted) + 1;
    const upcoming = newItem(index, this.deps.config.tasks.repo, "");
    upcoming.label = "next issue";
    const gate = await this.gates(upcoming);
    if (!gate.ok) return { exit: gate.exit };
    const picked = await this.pickIssue();
    if (typeof picked !== "string") picked.startedAt = this.deps.host.now().toISOString();
    return picked;
  }

  /** The issues nightshift may pick now, best first, and what to say when there are none. */
  private async issueQueue(): Promise<{ slug: string; me: string; queue: Issue[]; none: string }> {
    const { forge, config } = this.deps;
    const { tasks } = config;
    const slug = await forge.repoSlug(this.repoDir(tasks.repo));
    const me = await forge.currentUser();
    const exclude = this.excludedIssues();
    const { queue } = rankIssues(await forge.listIssues(slug, tasks.label), tasks, me, exclude);
    return {
      slug,
      me,
      queue,
      none: `no open issue labelled "${tasks.label}" is left to do in ${slug}`,
    };
  }

  /**
   * Picks the next open issue, makes it the current item and claims it. Returns why there is none
   * when no issue is left.
   */
  private async pickIssue(): Promise<ItemState | string> {
    const { forge, config } = this.deps;
    const { tasks } = config;
    // Listed again: a gate before this may have waited for hours.
    const { slug, me, queue, none } = await this.issueQueue();
    this.state.issues ??= {};
    const runIssues = this.state.issues;
    const exclude = this.excludedIssues();
    for (const candidate of queue) {
      // The listing has no bodies, and the issue may have changed since: read it again.
      const issue = await forge.issue(slug, candidate.number);
      const why = ineligible(issue, tasks, me, exclude);
      if (why !== undefined) {
        this.deps.host.log(`skipping issue #${issue.number}: ${why}`);
        continue;
      }
      const index = this.parallel
        ? this.takeIndex()
        : (runIssues.picked ?? this.state.itemsCompleted) + 1;
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
      if (this.parallel) setRunItems(this.state, [...runItems(this.state), item]);
      else this.state.item = item;
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
      await this.removeItem(item);
      await this.save();
    }
    return none;
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
    await this.removeItem(item);
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
  private async noteIssue(
    item: ItemState | undefined,
    reason: string,
    kind: "halted" | "blocked",
  ): Promise<void> {
    const issue = item?.issue;
    if (item === undefined || issue === undefined) return;
    const { forge } = this.deps;
    const blocked = this.deps.config.tasks.blocked_label;
    const post = kind === "blocked" ? item.questionPost : undefined;
    if (post !== undefined && post.repoSlug === issue.repoSlug && post.number === issue.number) {
      issue.noted = reason; // the question itself is on this issue already
    }
    if (issue.noted !== reason) {
      await this.github(item, `comment on issue #${issue.number}`, async () => {
        const next =
          kind !== "blocked"
            ? "Once the cause is fixed, `nightshift resume` continues; `nightshift run --force` abandons the run and releases this issue."
            : post !== undefined
              ? `It needs an answer: reply on ${post.url}, and nightshift continues.`
              : 'It needs an answer: whoever runs nightshift continues with `nightshift resume --answer "…"`.';
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
    // A new item (not a restart or resume of one already under way) starts only if the forecast
    // says it fits in what is left of the usage limits and the active hours.
    const fresh = template === "implement" && !restarted && item.startedAt === undefined;
    const gate = await this.gates(fresh ? item : undefined, item);
    if (!gate.ok) return gate;
    if (fresh) item.startedAt = this.deps.host.now().toISOString();
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
    // A resumed session may switch models between steps; Claude Code carries the context over.
    const settings = stepSettings(this.deps.config.agent, STEP_OF_TEMPLATE[template]);
    this.log(
      item,
      `${template}${resume ? "" : " (fresh session)"} · model ${settings.model ?? "default"} · budget $${left.toFixed(2)}`,
    );
    let call = await this.callAgent(
      item,
      template,
      prompt,
      schema,
      settings,
      left,
      resume,
      gate.before,
    );
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
      const again = await this.gates(undefined, item);
      if (!again.ok) return again;
      call = await this.callAgent(
        item,
        template,
        prompt,
        schema,
        settings,
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
          delete item.questionPost;
          await this.save();
          const data = parsed.data as { status?: unknown; summary?: unknown; item?: unknown };
          await this.event({
            type: "result",
            item: item.index,
            step: template,
            status: data.status,
            summary: data.summary,
            label: typeof data.item === "string" ? data.item : item.label,
          });
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
    settings: StepSettings,
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
          ...(settings.model === undefined ? {} : { model: settings.model }),
          maxTurns: settings.maxTurns,
          permissionMode: settings.permissionMode,
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
      ...(settings.model === undefined ? {} : { model: settings.model }),
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
  private async usageGate(lane: ItemState | undefined): Promise<UsageGate> {
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
            "usage_limit",
            new Date(until),
          ),
        };
      }
      const stopped = await this.sleepUntil(
        until,
        `usage limit: ${hit.reason}`,
        `for the ${WINDOW_LABEL[hit.window]} window to reset`,
        "usage_wait",
        lane,
      );
      if (stopped) return { ok: false, exit: stopped };
    }
  }

  /**
   * Everything that must hold before Claude work starts: inside active hours and within the usage
   * limits. A long usage wait can end outside active hours, so both are checked until both hold.
   * `lane` is the item whose step waits, so its active time leaves the wait out.
   */
  private async gates(newItem?: ItemState, lane?: ItemState): Promise<UsageGate> {
    for (;;) {
      const outside = await this.scheduleGate(lane);
      if (outside) return { ok: false, exit: outside };
      const gate = await this.usageGate(lane);
      if (!gate.ok) return gate;
      if (!isActive(this.deps.config.schedule.active_hours, this.deps.host.now())) continue;
      if (newItem === undefined) return gate;
      const fit = await this.forecastGate(newItem, gate.before, lane);
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
    lane: ItemState | undefined,
  ): Promise<Exit | "waited" | undefined> {
    if (!this.forecastEnabled()) return undefined;
    const { usage, schedule, dir } = this.deps.config;
    const now = this.deps.host.now();
    const estimate = estimateItem(await readHistory(dir), usage.forecast_percentile);
    // With lanes, the items running alongside will use more of the windows before this one is
    // done. Only items that started and are not parked count: those not started yet pass this
    // gate themselves, and counting each other would make two new items wait for each other.
    const others = runItems(this.state).filter(
      (other) =>
        other !== item &&
        other.startedAt !== undefined &&
        other.stopped === undefined &&
        !this.awaitingAnswer(other),
    );
    const decision = decideStart({
      estimate,
      limits: this.usageLimits(),
      tally: this.state.usage?.tally ?? {},
      windows,
      ranges: schedule.active_hours,
      now,
      ...(others.length === 0 ? {} : { inProgress: others.map((o) => o.usagePoints ?? {}) }),
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
      const resetsAt = decision.until === undefined ? Number.NaN : Date.parse(decision.until);
      const until = Math.max(
        Number.isNaN(resetsAt) ? 0 : resetsAt + USAGE_RESET_GRACE_MS,
        now.getTime() + usage.check_seconds * 1000,
      );
      if (usage.on_limit === "halt") {
        return this.pause(
          `forecast: ${decision.reason}; not starting a new item before the ${label} window resets ${formatTime(decision.until, now)}`,
          "forecast_usage",
          new Date(until),
        );
      }
      stopped = await this.sleepUntil(
        until,
        `forecast: ${decision.reason}`,
        `for the ${label} window to reset before starting a new item`,
        "forecast_wait",
        lane,
      );
    } else {
      if (schedule.outside_hours === "halt") {
        return this.pause(
          `forecast: ${decision.reason}; not starting a new item before active hours start again ${formatTime(decision.until.toISOString(), now)}`,
          "forecast_hours",
          decision.until,
        );
      }
      stopped = await this.sleepUntil(
        decision.until.getTime(),
        `forecast: ${decision.reason}`,
        "for the next active hours before starting a new item",
        "forecast_wait",
        lane,
      );
    }
    return stopped ?? "waited";
  }

  /**
   * Before Claude work: outside the configured active hours, waits for the next start (or pauses,
   * with outside_hours = "halt"). A step already running is never cut by the schedule.
   */
  private async scheduleGate(lane: ItemState | undefined): Promise<Exit | undefined> {
    const { active_hours: ranges, outside_hours } = this.deps.config.schedule;
    if (ranges.length === 0) return undefined;
    const now = this.deps.host.now();
    if (isActive(ranges, now)) return undefined;
    const start = nextStart(ranges, now);
    const hours = ranges.map((r) => r.text).join(", ");
    if (outside_hours === "halt") {
      return this.pause(
        `outside active hours (${hours}); they start again ${formatTime(start.toISOString(), now)}`,
        "outside_hours",
        start,
      );
    }
    return this.sleepUntil(
      start.getTime(),
      `outside active hours (${hours})`,
      "",
      "schedule_wait",
      lane,
    );
  }

  /**
   * Logs, records and performs a wait; returns an exit if a stop was requested meanwhile. The wait
   * counts against `lane`'s active time.
   */
  private async sleepUntil(
    until: number,
    reason: string,
    purpose: string,
    eventType: string,
    lane?: ItemState,
  ): Promise<Exit | undefined> {
    const untilIso = new Date(until).toISOString();
    this.deps.host.log(
      `${reason}; waiting until ${formatTime(untilIso, this.deps.host.now())}${purpose ? ` ${purpose}` : ""}`,
    );
    this.state.waiting = { until: untilIso, reason };
    this.sleepers += 1;
    await this.save();
    await this.event({ type: eventType, reason, until: untilIso });
    const started = this.deps.host.now().getTime();
    try {
      return await this.waitUntil(until);
    } finally {
      if (lane !== undefined) {
        const waited = Math.max(0, this.deps.host.now().getTime() - started);
        this.waitedMs.set(lane.index, this.waited(lane) + waited);
      }
      this.sleepers -= 1;
      // Lanes share `state.waiting`: it goes once nobody waits.
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
   * Live progress of a Claude step: every tool call is logged and appended to the run's progress
   * feed (for `watch`), and `status` sees the step, its tool count and the latest call (state is
   * saved at most every PROGRESS_SAVE_MS while it runs).
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
        // The feed is only for `nightshift watch`; failing to write it must not fail the step.
        this.deps.store
          .progress(this.state.runId, {
            at: activity.lastAt,
            item: item.index,
            step: template,
            tool: name,
            detail,
          })
          .catch(() => {});
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

  /** Takes an item that ended off the list; with lanes, also removes the worktree it had. */
  private async removeItem(item: ItemState): Promise<void> {
    if (!this.parallel) {
      if (this.state.item === item) delete this.state.item;
      return;
    }
    setRunItems(
      this.state,
      runItems(this.state).filter((other) => other !== item),
    );
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

  /** A STOP file (or, with lanes, a stop another lane hit) ends the run at the next step. */
  private async stopRequest(): Promise<Exit | undefined> {
    if (this.runStop !== undefined) return this.runStop.exit;
    if (!this.deps.host.stopRequested()) return undefined;
    this.deps.host.clearStop();
    return this.pause("stop requested (STOP file)", "stop_requested");
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

  private async blocked(item: ItemState, question: string): Promise<Exit> {
    item.pendingQuestion = question;
    delete item.questionPost;
    if (this.deps.config.answers.via === "github") await this.askOnGitHub(item, question);
    return this.stopLane(item, `needs a human: ${question}`, "blocked", "question");
  }

  // ── answers on GitHub ───────────────────────────────────────────────────

  /** Posts the open question on the item's PR (or a new issue). A failure is logged, not fatal. */
  private async askOnGitHub(item: ItemState, question: string): Promise<void> {
    const { forge, config } = this.deps;
    try {
      item.questionPost = await postQuestion(forge, config, this.state.runId, item, question, () =>
        forge.repoSlug(this.repoPath(item)),
      );
    } catch (error) {
      this.log(item, `could not post the question on GitHub: ${(error as Error).message}`);
      await this.event({
        type: "question_post_failed",
        item: item.index,
        error: (error as Error).message,
      });
      return;
    }
    this.log(item, `asked on GitHub: ${item.questionPost.url}`);
    await this.event({
      type: "question_posted",
      item: item.index,
      kind: item.questionPost.kind,
      url: item.questionPost.url,
    });
  }

  /**
   * With `[answers] via = "github"`, looks for a reply to the open question and makes it the
   * pending answer. Posts the question first if that failed when the run stopped. Returns whether
   * an answer was found.
   */
  private async answerFromGitHub(item: ItemState): Promise<boolean> {
    const { forge, config } = this.deps;
    if (config.answers.via !== "github" || item.pendingQuestion === undefined) return false;
    const post = item.questionPost;
    if (post === undefined) {
      await this.askOnGitHub(item, item.pendingQuestion);
      return false;
    }
    let answer: Awaited<ReturnType<typeof findAnswer>>;
    try {
      answer = await findAnswer(forge, post, await allowedUsers(config, forge));
    } catch (error) {
      throw new Error(
        `could not read the answer to the open question on GitHub (${post.url}): ${(error as Error).message}`,
      );
    }
    if (answer === undefined) return false;
    item.pendingAnswer = answer.text;
    this.log(item, `answer from @${answer.by.join(", @")} on GitHub: ${post.url}`);
    await this.save();
    await this.event({
      type: "answer",
      item: item.index,
      source: "github",
      by: answer.by.join(", "),
      url: answer.comments[0]?.url,
    });
    for (const problem of await acknowledge(forge, post, answer)) this.log(item, problem);
    delete item.questionPost; // answered and acknowledged; the answer is kept until a step succeeds
    await this.save();
    return true;
  }

  /** An answer given with `--answer` closes the question asked on GitHub. */
  private async answeredLocally(item: ItemState): Promise<void> {
    const post = item.questionPost;
    if (post === undefined) return;
    await this.event({ type: "answer", item: item.index, source: "terminal" });
    for (const problem of await acknowledge(this.deps.forge, post, undefined)) {
      this.log(item, problem);
    }
    delete item.questionPost;
  }

  private pause(reason: string, cause: StopCause, resumeAt?: Date): Promise<Exit> {
    return this.halt(reason, "paused", cause, resumeAt);
  }

  /**
   * Stops the run. With one lane it ends at once; with several, every lane stops at its next step
   * (a running step finishes) and the run ends when the last one has.
   */
  private async halt(
    reason: string,
    kind: "halted" | "blocked" | "paused",
    cause: StopCause = kind === "blocked" ? "question" : "failure",
    resumeAt?: Date,
  ): Promise<Exit> {
    if (this.parallel) {
      const exit = { kind, reason, state: this.state };
      if (this.runStop === undefined || SEVERITY[kind] > SEVERITY[this.runStop.exit.kind]) {
        this.runStop = { exit, cause, resumeAt };
        this.deps.host.log(`stopping all lanes (${kind}): ${reason}`);
        await this.event({ type: "run_stop", kind, reason, cause });
      }
      return exit;
    }
    // A planned pause or Ctrl-C is no news for the issue; everything else needs a human.
    if (kind !== "paused" && !this.signal.aborted) {
      await this.noteIssue(this.state.item, reason, kind);
    }
    return this.conclude(reason, kind, cause, resumeAt);
  }

  /**
   * Stops what one item hit (a question, a failure). With one lane that stops the run; with several,
   * only this item's lane stops, and the others finish their current item before the run ends.
   */
  private async stopLane(
    item: ItemState,
    reason: string,
    kind: "halted" | "blocked",
    cause: StopCause = kind === "blocked" ? "question" : "failure",
  ): Promise<Exit> {
    if (!this.parallel) return this.halt(reason, kind, cause);
    item.stopped = { kind, reason, cause };
    if (!this.draining) {
      this.draining = true;
      this.deps.host.log(
        "a lane stopped: the other lanes finish their current item, then the run stops",
      );
    }
    if (!this.signal.aborted) await this.noteIssue(item, reason, kind);
    await this.save();
    await this.event({
      type: "lane_stop",
      kind,
      reason,
      cause,
      item: item.index,
      phase: item.phase,
    });
    this.log(item, `${kind}: ${reason}`);
    return { kind, reason, state: this.state };
  }

  /** Ends the invocation: records why, writes the report and notifies. */
  private async conclude(
    reason: string,
    kind: "halted" | "blocked" | "paused",
    cause: StopCause,
    resumeAt?: Date,
  ): Promise<Exit> {
    this.state.status = "halted";
    this.state.haltReason = reason;
    this.state.stop = {
      kind,
      cause,
      at: this.deps.host.now().toISOString(),
      ...(resumeAt === undefined ? {} : { resumeAt: resumeAt.toISOString() }),
    };
    await this.save();
    await this.closePhase();
    const item = this.focus();
    await this.event({
      type: kind,
      reason,
      cause,
      item: item?.index,
      phase: item?.phase,
    });
    this.deps.host.log(`${kind}: ${reason}`);
    const report = await this.report();
    await this.deps.host.notify("halted", this.notifyFields(kind, reason, report));
    return { kind, reason, state: this.state };
  }

  private async finish(reason: string): Promise<Exit> {
    this.state.status = "done";
    this.state.haltReason = reason;
    this.state.stop = { kind: "done", cause: "done", at: this.deps.host.now().toISOString() };
    await this.save();
    await this.closePhase();
    await this.event({ type: "done", reason, itemsCompleted: this.state.itemsCompleted });
    this.deps.host.log(`done: ${reason}`);
    const report = await this.report();
    await this.deps.host.notify("done", this.notifyFields("done", reason, report));
    return { kind: "done", reason, state: this.state };
  }

  /** Writes the morning report; returns its path, or "" when it could not be written. */
  private async report(): Promise<string> {
    try {
      const file = await writeReport(this.deps.store, this.state, this.deps.host.now());
      this.deps.host.log(`report: ${file}`);
      return file;
    } catch (error) {
      this.deps.host.log(`could not write the report: ${(error as Error).message}`);
      return "";
    }
  }

  /** The item an exit is mostly about: the first that stopped or waits for a human. */
  private focus(): ItemState | undefined {
    const items = runItems(this.state);
    return (
      items.find((i) => i.stopped !== undefined) ??
      items.find((i) => i.pendingQuestion !== undefined) ??
      items[0]
    );
  }

  private notifyFields(kind: string, reason: string, report: string): Record<string, string> {
    const item = this.focus();
    return {
      kind,
      reason,
      run: this.state.runId,
      item: item ? (item.label ?? String(item.index)) : "",
      pr: item?.pr?.url ?? "",
      cost: this.state.costUsd.toFixed(2),
      question_url: item?.questionPost?.url ?? "",
      report,
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

  /** One line about an item in progress, for the prompt that picks items to run alongside it. */
  private describe(item: ItemState): string {
    const handoff = (item.issue === undefined ? item.handoff : item.issue.title)
      .replace(/\s+/g, " ")
      .trim();
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
