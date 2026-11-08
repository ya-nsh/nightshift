import { randomBytes } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { UsageWindows } from "./ports.js";
import type { UsageTally } from "./usage.js";

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
}

export interface UsageState {
  /** Points of each window that nightshift's own steps used. */
  tally: UsageTally;
  /** The latest reading, for `status`. */
  last?: { at: string; windows: UsageWindows };
  /** Set while the run waits for a usage window to reset. */
  waitingUntil?: string;
  waitingFor?: string;
}

export function newRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

/** Persists run state atomically and keeps an append-only event journal per run. */
export class StateStore {
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

  async save(state: RunState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tmp, this.statePath);
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
          throw new Error(`another nightshift process (pid ${pid}) is running in ${dir}`);
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
