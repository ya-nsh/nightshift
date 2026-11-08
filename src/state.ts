import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { UsageWindows } from "./ports.js";
import type { UsageTally, UsageWindow } from "./usage.js";

export const PHASES = [
  "implement",
  "review",
  "address",
  "checks",
  "fix_checks",
  "merge",
  "resolve_conflicts",
  "finalize",
] as const;
export type Phase = (typeof PHASES)[number];

/** Phases that run a Claude step (and so may be resumed with a human's answer). */
export const AGENT_PHASES: ReadonlySet<Phase> = new Set([
  "implement",
  "address",
  "fix_checks",
  "resolve_conflicts",
  "finalize",
]);

export interface ItemState {
  /** 1-based position of this item within the run. */
  index: number;
  repo: string;
  /** The prompt that started this item (the previous item's handoff). */
  handoff: string;
  /** Short identifier reported by Claude, e.g. "T12 — Add rate limiting". */
  label?: string;
  phase: Phase;
  /** Set while a phase is executing; still set on startup means the last attempt was interrupted. */
  inFlight?: Phase;
  /** A Claude step that the usage limit stopped part-way; it restarts with the "restarted" prompt. */
  interruptedPhase?: Phase;
  sessionId?: string;
  pr?: { number: number; url: string; repoSlug: string; branch: string };
  reviewRound: number;
  fixRound: number;
  conflictRound: number;
  /** Head commit that passed checks; merge is pinned to it. */
  checkedSha?: string;
  mergeSha?: string | undefined;
  /** When "no checks reported" was first seen for the current head. */
  noChecksSince?: string;
  checksSince?: string;
  failedChecks?: string[];
  reviewOutput?: string;
  pendingQuestion?: string;
  pendingAnswer?: string;
  costUsd: number;
  /** When the item's first implement step started (after the forecast let it start). */
  startedAt?: string;
  /** Time spent on the item so far, without usage/schedule waits and pauses (for forecasts). */
  activeMs?: number;
  /** Percentage points of each usage window this item's steps used (when usage is measured). */
  usagePoints?: Partial<Record<UsageWindow, number>>;
  /** The Claude step running right now, for `status`. */
  activity?: { step: string; since: string; tools: number; last?: string; lastAt?: string };
  /** Head commit auto-merge was enabled for (merge.when_blocked = "auto"). */
  autoMergeSha?: string;
  /** The bounded loop whose cap halted the run; `resume` grants that loop fresh rounds. */
  capHit?: "fix_checks" | "resolve_conflicts";
  /** Where `pendingQuestion` was asked on GitHub (`[answers] via = "github"`). */
  questionPost?: QuestionPost;
  /** The GitHub issue this item works on (`[tasks] source = "github_issues"`). */
  issue?: ItemIssue;
  /** With parallel lanes: the git worktree nightshift created for this item. */
  worktree?: { path: string; base: string };
  /** With parallel lanes: why this item's lane stopped while others went on; cleared by `resume`. */
  stopped?: { kind: "halted" | "blocked" | "paused"; reason: string; cause: StopCause };
}

export interface QuestionPost {
  /**
   * A comment on the item's PR, a comment on the GitHub issue the item works on, or an issue
   * opened for the question because there was neither.
   */
  kind: "pr_comment" | "issue_comment" | "issue";
  repoSlug: string;
  /** The PR or issue number the conversation is on. */
  number: number;
  /** Id of the question comment (or of the issue). */
  id: number;
  url: string;
  /** GitHub's creation time; only replies created at or after it count. */
  postedAt: string;
}

/** Why a run stopped. The daemon decides on `cause`, never on the human-readable reason. */
export type StopCause =
  /** Nothing left to do. */
  | "done"
  /** Claude asked a question (`pendingQuestion`). */
  | "question"
  /** `nightshift stop`. */
  | "stop_requested"
  /** `--once`, `--max-items`, `[limits] max_items`. */
  | "item_limit"
  /** A `[usage]` limit with on_limit = "halt"; clears at `resumeAt`. */
  | "usage_limit"
  /** Outside `[schedule] active_hours` with outside_hours = "halt"; clears at `resumeAt`. */
  | "outside_hours"
  /** The forecast said a typical item would not fit the usage limits (on_limit = "halt"). */
  | "forecast_usage"
  /** The forecast said a typical item would not fit the active hours (outside_hours = "halt"). */
  | "forecast_hours"
  /** Ctrl-C (SIGINT). */
  | "interrupted"
  /** SIGTERM: a shutdown, logout or service stop; nobody chose to stop the run. */
  | "terminated"
  /** Something went wrong that a human must look at. */
  | "failure";

export interface StopInfo {
  kind: "done" | "paused" | "blocked" | "halted";
  cause: StopCause;
  at: string;
  /** When the cause clears by itself (usage window reset, start of active hours, forecasts). */
  resumeAt?: string;
}

export interface ItemIssue {
  number: number;
  title: string;
  url: string;
  repoSlug: string;
  /** Set once the claim (in-progress label and/or assignee) is in place. */
  claimed?: boolean;
  /** The in-progress label the claim uses; removed again when the claim is released. */
  claimLabel?: string;
  /** The assignee the claim added (not one a human had set); removed when the claim is released. */
  assignee?: string;
  /** The blocked label nightshift added when the item stopped; removed on `resume`. */
  flagged?: string;
  /** The stop reason last posted on the issue, so the same stop is not commented twice. */
  noted?: string;
  /** Finalize's post-merge work is done; what is left is making sure the issue is closed. */
  finalized?: boolean;
}

/** Run-wide state of the `github_issues` task source. */
export interface IssuesRunState {
  /** `--prompt` given to `run`: extra instructions added to every issue's prompt. */
  instructions?: string;
  /** Index of the last item created from an issue. */
  picked?: number;
  /** Issues this run let go of without a PR (Claude found nothing to change); not picked again. */
  skipped?: number[];
}

/**
 * State files are version 1 while a run has at most one item in progress, which is always the case
 * with `[limits] lanes = 1`; a run holding more items (`moreItems`) is version 2, so a nightshift that
 * knows only one item refuses it instead of losing the others.
 */
export const STATE_VERSIONS = [1, 2] as const;

export interface RunState {
  version: (typeof STATE_VERSIONS)[number];
  runId: string;
  startedAt: string;
  status: "running" | "halted" | "done";
  haltReason?: string;
  itemsCompleted: number;
  costUsd: number;
  /** The item in progress; with parallel lanes, the first of them (see `runItems`). */
  item?: ItemState;
  /** With parallel lanes: the items in progress besides `item`, in the order they were handed over. */
  moreItems?: ItemState[];
  /** With parallel lanes: the index the next item gets (indexes are never reused within a run). */
  nextIndex?: number;
  /** `--usage-share` given to `run` or `resume`; overrides `[usage] session_share` for this run. */
  usageShare?: number;
  usage?: UsageState;
  /** Set while the run sleeps: for a usage window to reset, or for its active hours. */
  waiting?: { until: string; reason: string };
  /** Why the run last stopped; unset while it runs. */
  stop?: StopInfo;
  /** Present when the run takes its tasks from GitHub issues. */
  issues?: IssuesRunState;
}

export interface UsageState {
  /** Points of each window that nightshift's own steps used. */
  tally: UsageTally;
  /** Points nightshift used over the whole run, across window resets. */
  points?: Partial<Record<UsageWindow, number>>;
  /** The latest reading, for `status`. */
  last?: { at: string; windows: UsageWindows };
}

/** One tool call of a Claude step, as appended to a run's progress feed for `nightshift watch`. */
export interface ProgressEntry {
  at: string;
  item: number;
  step: string;
  tool: string;
  detail: string;
}

export const PROGRESS_FILE = "progress.jsonl";
/** The previous progress feed, kept after a rotation. */
export const PROGRESS_ROTATED_FILE = "progress.1.jsonl";
/** The progress feed rotates when it grows past this, so it stays bounded at about twice this. */
export const PROGRESS_MAX_BYTES = 256 * 1024;

/** Every item in progress, in hand-over order: `item` first, then the other lanes' items. */
export function runItems(state: Pick<RunState, "item" | "moreItems">): ItemState[] {
  const more = state.moreItems ?? [];
  return state.item === undefined ? [...more] : [state.item, ...more];
}

/** Replaces the items in progress (see `runItems`), keeping the file version 1 while it can be. */
export function setRunItems(state: RunState, items: readonly ItemState[]): void {
  const [first, ...more] = items;
  if (first === undefined) delete state.item;
  else state.item = first;
  if (more.length > 0) {
    state.moreItems = more;
    state.version = 2;
  } else {
    delete state.moreItems;
    state.version = 1;
  }
}

export function newRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

/** Persists run state atomically and keeps an append-only event journal per run. */
export class StateStore {
  /** Saves run one after another: a usage check and progress updates may save during a step. */
  private saving: Promise<void> = Promise.resolve();
  /** Appends to the progress feed one after another, so a rotation never races an append. */
  private feeding: Promise<void> = Promise.resolve();

  constructor(readonly dir: string) {}

  get statePath(): string {
    return path.join(this.dir, "state.json");
  }

  runDir(runId: string): string {
    return path.join(this.dir, "runs", runId);
  }

  async load(): Promise<RunState | undefined> {
    let text: string;
    try {
      text = await readFile(this.statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const state = JSON.parse(text) as RunState;
    if (!(STATE_VERSIONS as readonly number[]).includes(state.version)) {
      throw new Error(
        `unsupported state version ${String(state.version)} (this nightshift reads versions ${STATE_VERSIONS.join(" and ")}; upgrade nightshift)`,
      );
    }
    if (state.moreItems !== undefined && !Array.isArray(state.moreItems)) {
      throw new Error("invalid state: moreItems is not a list");
    }
    return state;
  }

  save(state: RunState): Promise<void> {
    // Serialize now, so the file holds the state as it was when save() was called.
    const text = `${JSON.stringify(state, null, 2)}\n`;
    const next = this.saving.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${this.statePath}.${process.pid}.tmp`;
      await writeFile(tmp, text);
      await rename(tmp, this.statePath);
    });
    this.saving = next.catch(() => {});
    return next;
  }

  /** Moves the current state into its run directory so a new run can start. */
  async archive(state: RunState): Promise<void> {
    const dir = this.runDir(state.runId);
    await mkdir(dir, { recursive: true });
    await rename(this.statePath, path.join(dir, "final-state.json"));
  }

  async event(runId: string, event: Record<string, unknown>): Promise<void> {
    const dir = this.runDir(runId);
    await mkdir(dir, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), ...event });
    await appendFile(path.join(dir, "events.jsonl"), `${line}\n`);
  }

  /**
   * Appends a tool call to the run's progress feed. The feed is bounded: past `maxBytes` the file
   * becomes `progress.1.jsonl` (replacing the one before) and a new one starts.
   */
  progress(runId: string, entry: ProgressEntry, maxBytes = PROGRESS_MAX_BYTES): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    const dir = this.runDir(runId);
    const next = this.feeding.then(async () => {
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, PROGRESS_FILE);
      await appendFile(file, line);
      if ((await stat(file)).size > maxBytes) {
        await rename(file, path.join(dir, PROGRESS_ROTATED_FILE));
      }
    });
    this.feeding = next.catch(() => {});
    return next;
  }
}

export class LockedError extends Error {
  override name = "LockedError";
}

/** The pid holding the lock in `dir`, if that process is alive. */
export function lockHolder(dir: string, name = "lock"): number | undefined {
  let text: string;
  try {
    text = readFileSync(path.join(dir, name), "utf8");
  } catch {
    return undefined;
  }
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : undefined;
}

/** A pid lock so two nightshift processes never drive the same state. */
export class Lock {
  private constructor(private readonly file: string) {}

  /** `name` is the lock file in `dir`; the daemon has its own, so it never blocks a run. */
  static async acquire(dir: string, name = "lock"): Promise<Lock> {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(file, "wx");
        await handle.writeFile(String(process.pid));
        await handle.close();
        return new Lock(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const pid = Number((await readFile(file, "utf8").catch(() => "")).trim());
        if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
          throw new LockedError(
            `another nightshift process (pid ${pid}) is already driving this run; \`nightshift status\` shows what it is doing, \`nightshift stop\` stops it after the current step`,
          );
        }
        await rm(file, { force: true }); // stale lock from a crashed process
      }
    }
    throw new Error(`could not acquire ${file}`);
  }

  async release(): Promise<void> {
    await rm(this.file, { force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
