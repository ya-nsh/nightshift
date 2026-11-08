/**
 * The pipeline talks to the outside world only through these interfaces, so tests can drive it with
 * in-memory fakes and the real adapters stay thin.
 */

export interface AgentRequest {
  /** Working directory for the session (the repo the item runs in). */
  cwd: string;
  prompt: string;
  /** JSON Schema the final structured result must match. */
  schema: Record<string, unknown>;
  /** Continue this Claude session; omit for a fresh one. */
  resumeSessionId?: string;
  /** Hard ceiling for this call, in USD. */
  maxBudgetUsd: number;
  /** Where the adapter stores the streamed messages (JSON lines) for debugging. */
  artifactPath: string;
  /** Aborting stops the step gracefully, so Claude can still report what it cost. */
  signal: AbortSignal;
  /** Progress while the step runs: tool calls, and plan usage when Claude reports it. */
  onEvent?: (event: AgentEvent) => void;
}

export type AgentEvent =
  | { type: "tool"; name: string; detail: string }
  | { type: "usage"; windows: UsageWindows };

export type AgentOutcome =
  | "success"
  | "max_budget"
  | "max_turns"
  | "no_structured_output"
  | "error"
  | "aborted";

export interface AgentResult {
  outcome: AgentOutcome;
  sessionId: string | undefined;
  costUsd: number;
  /** The structured result, when `outcome` is "success". */
  structured: unknown;
  /** Human-readable detail for non-success outcomes. */
  detail: string;
}

export interface Agent {
  readonly name: string;
  run(request: AgentRequest): Promise<AgentResult>;
}

export type PrState = "OPEN" | "CLOSED" | "MERGED";
export type Mergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

export interface CheckSummary {
  /** none: no checks reported (yet). */
  state: "none" | "pending" | "passed" | "failed";
  failed: string[];
  pending: string[];
}

export interface PullRequest {
  number: number;
  url: string;
  state: PrState;
  isDraft: boolean;
  headRefName: string;
  headSha: string;
  baseRefName: string;
  mergeable: Mergeable;
  mergeCommitSha: string | undefined;
  checks: CheckSummary;
  /** GitHub's review verdict, e.g. "APPROVED" or "REVIEW_REQUIRED"; undefined without reviews. */
  reviewDecision?: string;
  /** e.g. "CLEAN", "BLOCKED" (branch protection unmet), "BEHIND", "DIRTY", "UNKNOWN". */
  mergeStateStatus?: string;
}

export interface Forge {
  /** `owner/name` of the repository checked out at `cwd`. */
  repoSlug(cwd: string): Promise<string>;
  pullRequest(repoSlug: string, number: number): Promise<PullRequest>;
  /**
   * Merges only if the head is still `headSha`, so nothing unreviewed or unchecked slips in. With
   * `auto`, enables GitHub auto-merge instead, so GitHub merges once branch protection allows.
   */
  merge(
    repoSlug: string,
    number: number,
    method: "merge" | "rebase" | "squash",
    headSha: string,
    options?: { auto?: boolean },
  ): Promise<void>;
  deleteBranch(repoSlug: string, branch: string): Promise<void>;
}

export interface ReviewRequest {
  command: string;
  cwd: string;
  repoSlug: string;
  pr: number;
  prUrl: string;
  branch: string;
  timeoutMs: number;
  logPath: string;
  signal: AbortSignal;
}

export interface ReviewResult {
  exitCode: number | null;
  timedOut: boolean;
  /** Tail of the combined output, bounded in size. */
  output: string;
}

export interface Reviewer {
  run(request: ReviewRequest): Promise<ReviewResult>;
}

export interface WindowReading {
  /** Account-wide utilization of the window, 0–100. */
  utilization: number;
  /** When the window resets (ISO time); unknown while nothing has been used in it. */
  resetsAt: string | undefined;
}

export interface UsageWindows {
  /** The rolling 5-hour ("session") window. */
  five_hour?: WindowReading;
  /** The weekly window. */
  seven_day?: WindowReading;
}

export type UsageReading =
  | { ok: true; windows: UsageWindows; plan?: string }
  | { ok: false; detail: string };

/** Reads the Claude subscription's plan usage. Failures are values, never exceptions. */
export interface UsageMeter {
  read(signal?: AbortSignal): Promise<UsageReading>;
}

export interface Host {
  now(): Date;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  freeDiskGb(dir: string): Promise<number>;
  stopRequested(): boolean;
  clearStop(): void;
  notify(event: "halted" | "done", fields: Record<string, string>): Promise<void>;
  log(message: string): void;
}
