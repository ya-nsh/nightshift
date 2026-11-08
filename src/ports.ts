/**
 * The pipeline talks to the outside world only through these interfaces, so tests can drive it with
 * in-memory fakes and the real adapters stay thin.
 */

import type { PermissionMode } from "./config.js";

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
  /**
   * This step's effective settings (`[agent.steps.<step>]` over `[agent]`). Each one left out falls
   * back to the backend's `[agent]` config; `model` left out there too means Claude Code's default.
   */
  model?: string;
  maxTurns?: number;
  /** Ignored when `readOnly` is set. */
  permissionMode?: PermissionMode;
  /**
   * Run the session read-only (`nightshift plan`): only the Read, Glob and Grep tools exist, nothing
   * else may be approved, MCP servers and the config's own tool and permission settings are left out.
   */
  readOnly?: boolean;
  /** More directories the session may use, besides `cwd` and `agent.add_dirs`. */
  addDirs?: string[];
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

  // ── issues (the `github_issues` task source) ──
  /** Login of the account the forge acts as. */
  currentUser(): Promise<string>;
  /** Open issues carrying `label`; `body` may be empty here, `issue()` has it. */
  listIssues(repoSlug: string, label: string): Promise<Issue[]>;
  issue(repoSlug: string, number: number): Promise<Issue>;
  editIssue(repoSlug: string, number: number, edit: IssueEdit): Promise<void>;
  /** Comments on an issue or a PR (`number`), in its conversation tab. */
  commentIssue(repoSlug: string, number: number, body: string): Promise<PostedComment>;
  /** Closes the issue as completed, with a comment. */
  closeIssue(repoSlug: string, number: number, comment: string): Promise<void>;
  /** Creates the label if the repository does not have it yet. */
  ensureLabel(repoSlug: string, name: string, color: string, description: string): Promise<void>;

  // ── conversation (asking a human on GitHub, `[answers] via = "github"`) ──
  createIssue(
    repoSlug: string,
    title: string,
    body: string,
  ): Promise<PostedComment & { number: number }>;
  /** Comments on an issue or PR created at or after `since` (ISO), oldest first. */
  listComments(repoSlug: string, number: number, since: string): Promise<IssueComment[]>;
  addReaction(repoSlug: string, commentId: number, content: "+1" | "eyes"): Promise<void>;
}

export type IssueState = "OPEN" | "CLOSED";

export interface Issue {
  number: number;
  title: string;
  body: string;
  url: string;
  state: IssueState;
  labels: string[];
  assignees: string[];
  author: string;
  createdAt: string;
}

export interface IssueEdit {
  addLabels?: string[];
  removeLabels?: string[];
  addAssignees?: string[];
  removeAssignees?: string[];
}

/** A comment nightshift posted, or an issue it opened (`id` is the issue's own id). */
export interface PostedComment {
  id: number;
  url: string;
  /** GitHub's timestamp (ISO), so replies are compared on GitHub's clock. */
  createdAt: string;
}

/** A comment in a PR's or issue's conversation. */
export interface IssueComment {
  id: number;
  author: string;
  /** A GitHub App or other bot account. */
  authorIsBot: boolean;
  body: string;
  createdAt: string;
  url: string;
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

/** Git worktrees that isolate items running in parallel lanes. */
export interface Worktrees {
  /**
   * Makes `dir` a git worktree of the repository at `repoDir`, detached at the latest commit of the
   * repository's default branch (fetched first), and returns that branch's name. An existing
   * worktree of the same repository at `dir` is kept as it is.
   */
  create(repoDir: string, dir: string, signal: AbortSignal): Promise<{ base: string }>;
  /** Removes the worktree at `dir`, and the local branch `branch` when given. Missing is fine. */
  remove(repoDir: string, dir: string, branch?: string): Promise<void>;
}
