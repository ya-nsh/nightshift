import { exec, shellQuote, tail } from "./exec.js";
import type { Reviewer, ReviewRequest, ReviewResult } from "./ports.js";

/** How much review output is handed to Claude in the address step. */
export const REVIEW_OUTPUT_CHARS = 30_000;

/**
 * Runs the configured review command with `/bin/sh -c`. Placeholders `{pr}`, `{pr_url}`,
 * `{repo_slug}`, `{repo_path}` and `{branch}` are substituted shell-quoted; the same values are also
 * exported as NIGHTSHIFT_* environment variables.
 */
export class ShellReviewer implements Reviewer {
  async run(request: ReviewRequest): Promise<ReviewResult> {
    const values = reviewValues(request);
    const command = expandCommand(request.command, values);
    const result = await exec("/bin/sh", ["-c", command], {
      cwd: request.cwd,
      env: {
        ...process.env,
        NIGHTSHIFT_PR: values.pr,
        NIGHTSHIFT_PR_URL: values.pr_url,
        NIGHTSHIFT_REPO_SLUG: values.repo_slug,
        NIGHTSHIFT_REPO_PATH: values.repo_path,
        NIGHTSHIFT_BRANCH: values.branch,
      },
      signal: request.signal,
      timeoutMs: request.timeoutMs,
      teeFile: request.logPath,
    });
    return {
      exitCode: result.aborted ? null : result.code,
      timedOut: result.timedOut,
      output: tail(result.combined, REVIEW_OUTPUT_CHARS),
    };
  }
}

type ReviewValues = Record<"pr" | "pr_url" | "repo_slug" | "repo_path" | "branch", string>;

function reviewValues(request: ReviewRequest): ReviewValues {
  return {
    pr: String(request.pr),
    pr_url: request.prUrl,
    repo_slug: request.repoSlug,
    repo_path: request.cwd,
    branch: request.branch,
  };
}

/** Substitutes only known placeholders, so shell syntax such as `${VAR}` passes through untouched. */
export function expandCommand(command: string, values: ReviewValues): string {
  return command.replace(
    /(?<!\$)\{(pr|pr_url|repo_slug|repo_path|branch)\}/g,
    (_m, name: keyof ReviewValues) => shellQuote(values[name]),
  );
}
