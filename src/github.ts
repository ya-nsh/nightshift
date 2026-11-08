import { tmpdir } from "node:os";
import { exec } from "./exec.js";
import type {
  CheckSummary,
  Forge,
  Issue,
  IssueComment,
  IssueEdit,
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

const ISSUE_LIST_FIELDS = "number,title,url,state,labels,assignees,author,createdAt";
const ISSUE_FIELDS = `${ISSUE_LIST_FIELDS},body`;
/** More open issues than this with one label is not a queue nightshift is meant to drain. */
const ISSUE_LIST_LIMIT = 1000;

/** GitHub through the `gh` CLI, so it uses whatever account `gh auth login` set up. */
export class GhForge implements Forge {
  private login: Promise<string> | undefined;

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
    if (this.login === undefined) {
      const pending = this.gh(["api", "user", "-q", ".login"]).then((out) => {
        const login = out.trim();
        if (login === "") throw new Error("gh api user returned no login");
        return login;
      });
      this.login = pending;
      // Retry next time instead of caching a failure.
      pending.catch(() => {
        if (this.login === pending) this.login = undefined;
      });
    }
    return this.login;
  }

  async listIssues(repoSlug: string, label: string): Promise<Issue[]> {
    const out = await this.gh([
      "issue",
      "list",
      "-R",
      repoSlug,
      "--state",
      "open",
      "--label",
      label,
      "--limit",
      String(ISSUE_LIST_LIMIT),
      "--json",
      ISSUE_LIST_FIELDS,
    ]);
    const json: unknown = JSON.parse(out);
    if (!Array.isArray(json)) throw new Error("gh issue list did not return a JSON array");
    return json.map((entry) => toIssue(entry as Record<string, unknown>));
  }

  async issue(repoSlug: string, number: number): Promise<Issue> {
    const out = await this.gh([
      "issue",
      "view",
      String(number),
      "-R",
      repoSlug,
      "--json",
      ISSUE_FIELDS,
    ]);
    return toIssue(JSON.parse(out));
  }

  async editIssue(repoSlug: string, number: number, edit: IssueEdit): Promise<void> {
    const args = issueEditArgs(edit);
    if (args.length === 0) return;
    await this.gh(["issue", "edit", String(number), "-R", repoSlug, ...args]);
  }

  async commentIssue(repoSlug: string, number: number, body: string): Promise<PostedComment> {
    const out = await this.api("POST", `repos/${repoSlug}/issues/${number}/comments`, { body });
    return toPosted(JSON.parse(out));
  }

  async closeIssue(repoSlug: string, number: number, comment: string): Promise<void> {
    await this.gh([
      "issue",
      "close",
      String(number),
      "-R",
      repoSlug,
      "--reason",
      "completed",
      "--comment",
      comment,
    ]);
  }

  async ensureLabel(
    repoSlug: string,
    name: string,
    color: string,
    description: string,
  ): Promise<void> {
    try {
      await this.gh([
        "label",
        "create",
        name,
        "-R",
        repoSlug,
        "--color",
        color,
        "--description",
        description,
      ]);
    } catch (error) {
      if (/already exists/i.test((error as Error).message)) return;
      throw error;
    }
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

  /** A REST call with a JSON body sent on stdin, so no text is ever parsed as a flag. */
  private api(method: string, endpoint: string, body: Record<string, unknown>): Promise<string> {
    return this.gh(["api", "-X", method, endpoint, "--input", "-"], {
      input: JSON.stringify(body),
    });
  }

  private async gh(
    args: string[],
    options: string | { cwd?: string; input?: string } = {},
  ): Promise<string> {
    const { cwd = tmpdir(), input } = typeof options === "string" ? { cwd: options } : options;
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

/** Maps `gh issue list/view --json` output; labels and assignees become plain names. */
export function toIssue(json: Record<string, unknown>): Issue {
  const number = Number(json.number);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`gh returned an issue without a valid number: ${JSON.stringify(json.number)}`);
  }
  const names = (list: unknown, key: "name" | "login"): string[] =>
    Array.isArray(list)
      ? list
          .map((entry) => (entry as Record<string, unknown> | null)?.[key])
          .filter((value): value is string => typeof value === "string" && value !== "")
      : [];
  const author = json.author as { login?: unknown } | null | undefined;
  return {
    number,
    title: typeof json.title === "string" ? json.title : "",
    body: typeof json.body === "string" ? json.body : "",
    url: typeof json.url === "string" ? json.url : "",
    state: String(json.state).toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN",
    labels: names(json.labels, "name"),
    assignees: names(json.assignees, "login"),
    author: typeof author?.login === "string" ? author.login : "",
    createdAt: typeof json.createdAt === "string" ? json.createdAt : "",
  };
}

/** `gh issue edit` flags for an edit; empty when there is nothing to change. */
export function issueEditArgs(edit: IssueEdit): string[] {
  const args: string[] = [];
  const add = (flag: string, values: string[] | undefined) => {
    const list = (values ?? []).filter((v) => v !== "");
    if (list.length > 0) args.push(flag, list.join(","));
  };
  add("--add-label", edit.addLabels);
  add("--remove-label", edit.removeLabels);
  add("--add-assignee", edit.addAssignees);
  add("--remove-assignee", edit.removeAssignees);
  return args;
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
