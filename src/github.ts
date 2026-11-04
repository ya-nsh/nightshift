import { tmpdir } from "node:os";
import { exec } from "./exec.js";
import type { CheckSummary, Forge, Mergeable, PrState, PullRequest } from "./ports.js";

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
  ): Promise<void> {
    // No --delete-branch: with it gh also edits the local checkout. The branch is deleted via the API.
    await this.gh([
      "pr",
      "merge",
      String(number),
      "-R",
      repoSlug,
      `--${method}`,
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

  private async gh(args: string[], cwd: string = tmpdir()): Promise<string> {
    const result = await exec(this.ghPath, args, {
      cwd,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
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
