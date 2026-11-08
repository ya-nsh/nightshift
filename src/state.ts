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
}

export interface RunState {
  version: 1;
  runId: string;
  startedAt: string;
  status: "running" | "halted" | "done";
  haltReason?: string;
  itemsCompleted: number;
  costUsd: number;
  item?: ItemState;
  /** `--usage-share` given to `run` or `resume`; overrides `[usage] session_share` for this run. */
  usageShare?: number;
  usage?: UsageState;
  /** Set while the run sleeps: for a usage window to reset, or for its active hours. */
  waiting?: { until: string; reason: string };
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
    if (state.version !== 1) throw new Error(`unsupported state version ${String(state.version)}`);
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
export function lockHolder(dir: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(path.join(dir, "lock"), "utf8");
  } catch {
    return undefined;
  }
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : undefined;
}

/** A pid lock so two nightshift processes never drive the same state. */
export class Lock {
  private constructor(private readonly file: string) {}

  static async acquire(dir: string): Promise<Lock> {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "lock");
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
