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
  /** Where the adapter may store the raw transcript/result for debugging. */
  artifactPath: string;
  signal: AbortSignal;
}

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
}

export interface Forge {
  /** `owner/name` of the repository checked out at `cwd`. */
  repoSlug(cwd: string): Promise<string>;
  pullRequest(repoSlug: string, number: number): Promise<PullRequest>;
  /** Merges only if the head is still `headSha`, so nothing unreviewed or unchecked slips in. */
  merge(
    repoSlug: string,
    number: number,
    method: "merge" | "rebase" | "squash",
    headSha: string,
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

export interface Host {
  now(): Date;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  freeDiskGb(dir: string): Promise<number>;
  stopRequested(): boolean;
  clearStop(): void;
  notify(event: "halted" | "done", fields: Record<string, string>): Promise<void>;
  log(message: string): void;
}
