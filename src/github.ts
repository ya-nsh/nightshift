import { tmpdir } from "node:os";
import { exec } from "./exec.js";
import type {
  CheckSummary,
  Forge,
  IssueComment,
  Mergeable,
  PostedComment,
  PrState,
  PullRequest,
} from "./ports.js";

const PR_FIELDS = [
  "number",
  "url",
  "state",
  "isDraft",
  "headRefName",
  "headRefOid",
  "baseRefName",
  "mergeable",
  "mergeCommit",
  "statusCheckRollup",
  "reviewDecision",
  "mergeStateStatus",
].join(",");

/** GitHub through the `gh` CLI, so it uses whatever account `gh auth login` set up. */
export class GhForge implements Forge {
  constructor(private readonly ghPath = "gh") {}

  async repoSlug(cwd: string): Promise<string> {
    return (
      await this.gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], cwd)
    ).trim();
  }

  async pullRequest(repoSlug: string, number: number): Promise<PullRequest> {
    const out = await this.gh(["pr", "view", String(number), "-R", repoSlug, "--json", PR_FIELDS]);
    return toPullRequest(JSON.parse(out));
  }

  async merge(
    repoSlug: string,
    number: number,
    method: "merge" | "rebase" | "squash",
    headSha: string,
    options: { auto?: boolean } = {},
  ): Promise<void> {
    // No --delete-branch: with it gh also edits the local checkout. The branch is deleted via the API.
    await this.gh([
      "pr",
      "merge",
      String(number),
      "-R",
      repoSlug,
      `--${method}`,
      ...(options.auto ? ["--auto"] : []),
      "--match-head-commit",
      headSha,
    ]);
  }

  async deleteBranch(repoSlug: string, branch: string): Promise<void> {
    const ref = branch.split("/").map(encodeURIComponent).join("/");
    try {
      await this.gh(["api", "-X", "DELETE", `repos/${repoSlug}/git/refs/heads/${ref}`]);
    } catch (error) {
      // Already deleted (e.g. by the repo's "automatically delete head branches" setting).
      if (/Reference does not exist|HTTP 422|HTTP 404/.test((error as Error).message)) return;
      throw error;
    }
  }

  async currentUser(): Promise<string> {
    const login = (await this.gh(["api", "user", "--jq", ".login"])).trim();
    if (login === "") throw new Error("gh api user returned no login");
    return login;
  }

  async postComment(repoSlug: string, number: number, body: string): Promise<PostedComment> {
    const out = await this.api("POST", `repos/${repoSlug}/issues/${number}/comments`, { body });
    return toPosted(JSON.parse(out));
  }

  async createIssue(
    repoSlug: string,
    title: string,
    body: string,
  ): Promise<PostedComment & { number: number }> {
    const json = JSON.parse(await this.api("POST", `repos/${repoSlug}/issues`, { title, body }));
    return { ...toPosted(json), number: Number(json.number) };
  }

  async listComments(repoSlug: string, number: number, since: string): Promise<IssueComment[]> {
    // `since` filters on the update time, so edited older comments still come back; the caller
    // compares creation times. --jq prints one compact object per line across all pages.
    const out = await this.gh([
      "api",
      "--paginate",
      `repos/${repoSlug}/issues/${number}/comments?per_page=100&since=${encodeURIComponent(since)}`,
      "--jq",
      ".[]",
    ]);
    return out
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => toIssueComment(JSON.parse(line)));
  }

  async addReaction(repoSlug: string, commentId: number, content: "+1" | "eyes"): Promise<void> {
    await this.api("POST", `repos/${repoSlug}/issues/comments/${commentId}/reactions`, { content });
  }

  async closeIssue(repoSlug: string, number: number): Promise<void> {
    await this.api("PATCH", `repos/${repoSlug}/issues/${number}`, {
      state: "closed",
      state_reason: "completed",
    });
  }

  /** A REST call with a JSON body sent on stdin, so no text is ever parsed as a flag. */
  private api(method: string, endpoint: string, body: Record<string, unknown>): Promise<string> {
    return this.gh(["api", "-X", method, endpoint, "--input", "-"], tmpdir(), JSON.stringify(body));
  }

  private async gh(args: string[], cwd: string = tmpdir(), input?: string): Promise<string> {
    const result = await exec(this.ghPath, args, {
      cwd,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
      ...(input === undefined ? {} : { input }),
    });
    if (result.code !== 0) {
      throw new Error(
        `gh ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
      );
    }
    return result.stdout;
  }
}

export function toPullRequest(json: Record<string, unknown>): PullRequest {
  const mergeCommit = json.mergeCommit as { oid?: unknown } | null | undefined;
  return {
    number: Number(json.number),
    url: String(json.url),
    state: String(json.state) as PrState,
    isDraft: json.isDraft === true,
    headRefName: String(json.headRefName),
    headSha: String(json.headRefOid),
    baseRefName: String(json.baseRefName),
    mergeable: (["MERGEABLE", "CONFLICTING"].includes(String(json.mergeable))
      ? json.mergeable
      : "UNKNOWN") as Mergeable,
    mergeCommitSha: typeof mergeCommit?.oid === "string" ? mergeCommit.oid : undefined,
    checks: summarizeChecks(Array.isArray(json.statusCheckRollup) ? json.statusCheckRollup : []),
    ...(typeof json.reviewDecision === "string" && json.reviewDecision !== ""
      ? { reviewDecision: json.reviewDecision }
      : {}),
    ...(typeof json.mergeStateStatus === "string"
      ? { mergeStateStatus: json.mergeStateStatus }
      : {}),
  };
}

function toPosted(json: Record<string, unknown>): PostedComment {
  const id = Number(json.id);
  if (!Number.isInteger(id) || typeof json.html_url !== "string") {
    throw new Error(`unexpected GitHub response: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return { id, url: json.html_url, createdAt: String(json.created_at) };
}

/** Maps a REST issue comment. */
export function toIssueComment(json: Record<string, unknown>): IssueComment {
  const user = (json.user ?? {}) as { login?: unknown; type?: unknown };
  const author = typeof user.login === "string" ? user.login : "";
  return {
    id: Number(json.id),
    author,
    authorIsBot: user.type === "Bot" || author.endsWith("[bot]"),
    body: typeof json.body === "string" ? json.body : "",
    createdAt: String(json.created_at),
    url: String(json.html_url),
  };
}

const PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/** Reduces `statusCheckRollup` (check runs and commit statuses) to one verdict. */
export function summarizeChecks(rollup: readonly unknown[]): CheckSummary {
  const failed: string[] = [];
  const pending: string[] = [];
  for (const entry of rollup) {
    const c = entry as Record<string, unknown>;
    if (c.__typename === "StatusContext" || ("context" in c && "state" in c)) {
      const name = String(c.context ?? "status");
      const state = String(c.state);
      if (state === "SUCCESS") continue;
      if (state === "PENDING" || state === "EXPECTED") pending.push(name);
      else failed.push(name);
      continue;
    }
    const name = String(c.name ?? c.workflowName ?? "check");
    if (c.status !== "COMPLETED") {
      pending.push(name);
      continue;
    }
    if (!PASSING_CONCLUSIONS.has(String(c.conclusion))) failed.push(name);
  }
  // A failure is final even while other checks still run: fixing can start right away.
  const state =
    failed.length > 0
      ? "failed"
      : pending.length > 0
        ? "pending"
        : rollup.length === 0
          ? "none"
          : "passed";
  return { state, failed, pending };
}
