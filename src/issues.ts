import type { Config } from "./config.js";
import type { Forge, Issue } from "./ports.js";
import type { ItemIssue } from "./state.js";

/** The `[tasks]` settings that decide which issue is next. */
export type IssueRules = Pick<
  Config["tasks"],
  "label" | "priority_labels" | "skip_labels" | "authors" | "in_progress_label" | "blocked_label"
>;

export const IN_PROGRESS_COLOR = "1D76DB";
export const IN_PROGRESS_DESCRIPTION = "nightshift is working on this issue";
export const BLOCKED_COLOR = "D93F0B";
export const BLOCKED_DESCRIPTION = "nightshift stopped on this issue; see its comment";

/** GitHub label names are case-insensitive. */
export function hasLabel(issue: Pick<Issue, "labels">, name: string): boolean {
  const wanted = name.toLowerCase();
  return issue.labels.some((label) => label.toLowerCase() === wanted);
}

/**
 * Why nightshift must not pick `issue` now, or undefined when it may. `me` is the account nightshift
 * acts as; `exclude` holds issues this run already let go of.
 */
export function ineligible(
  issue: Issue,
  rules: IssueRules,
  me: string,
  exclude: ReadonlySet<number> = new Set(),
): string | undefined {
  if (issue.state !== "OPEN") return "closed";
  if (!hasLabel(issue, rules.label)) return `no longer labelled "${rules.label}"`;
  if (exclude.has(issue.number)) return "already set aside in this run";
  const skip = rules.skip_labels.find((label) => hasLabel(issue, label));
  if (skip !== undefined) return `labelled "${skip}"`;
  if (rules.blocked_label !== "" && hasLabel(issue, rules.blocked_label)) {
    return `labelled "${rules.blocked_label}" (a human must look at it first)`;
  }
  if (rules.in_progress_label !== "" && hasLabel(issue, rules.in_progress_label)) {
    return `already claimed (labelled "${rules.in_progress_label}")`;
  }
  const others = issue.assignees.filter((login) => login.toLowerCase() !== me.toLowerCase());
  if (others.length > 0) return `assigned to ${others.join(", ")}`;
  if (
    rules.authors.length > 0 &&
    !rules.authors.some((login) => login.toLowerCase() === issue.author.toLowerCase())
  ) {
    return `opened by ${issue.author || "an unknown author"}, who is not in tasks.authors`;
  }
  return undefined;
}

export interface RankedIssues {
  /** Issues nightshift may pick, best first. */
  queue: Issue[];
  skipped: Array<{ issue: Issue; why: string }>;
}

/**
 * Orders the open issues: the first matching `priority_labels` entry wins (earlier = more urgent),
 * issues without a priority label come after, and within a priority the oldest comes first.
 */
export function rankIssues(
  issues: readonly Issue[],
  rules: IssueRules,
  me: string,
  exclude: ReadonlySet<number> = new Set(),
): RankedIssues {
  const queue: Issue[] = [];
  const skipped: RankedIssues["skipped"] = [];
  for (const issue of issues) {
    const why = ineligible(issue, rules, me, exclude);
    if (why === undefined) queue.push(issue);
    else skipped.push({ issue, why });
  }
  const priority = (issue: Issue): number => {
    const index = rules.priority_labels.findIndex((label) => hasLabel(issue, label));
    return index === -1 ? rules.priority_labels.length : index;
  };
  const created = (issue: Issue): number => {
    const time = Date.parse(issue.createdAt);
    return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
  };
  queue.sort((a, b) => priority(a) - priority(b) || created(a) - created(b) || a.number - b.number);
  return { queue, skipped };
}

/** One line on the issue queue, for `doctor` and `status`; failures are values, never thrown. */
export async function describeQueue(
  forge: Forge,
  config: Config,
): Promise<{ ok: boolean; detail: string }> {
  const { tasks } = config;
  const dir = config.repos[tasks.repo];
  if (dir === undefined) return { ok: false, detail: `unknown repo alias "${tasks.repo}"` };
  try {
    const slug = await forge.repoSlug(dir);
    const [me, issues] = await Promise.all([
      forge.currentUser(),
      forge.listIssues(slug, tasks.label),
    ]);
    const { queue, skipped } = rankIssues(issues, tasks, me);
    const where = `GitHub issues labelled "${tasks.label}" in ${slug}`;
    const counts = `${queue.length} ready${skipped.length > 0 ? `, ${skipped.length} skipped` : ""}`;
    const next = queue[0];
    return {
      ok: true,
      detail: `${where} · ${counts} · next: ${next === undefined ? "none" : `#${next.number} ${next.title}`}`,
    };
  } catch (error) {
    return { ok: false, detail: `cannot list issues: ${(error as Error).message}` };
  }
}

/**
 * Takes back what claiming the issue added (its in-progress label and the assignee nightshift
 * added), and only that.
 */
export async function releaseClaim(forge: Forge, issue: ItemIssue): Promise<void> {
  const current = await forge.issue(issue.repoSlug, issue.number);
  const removeLabels =
    issue.claimLabel !== undefined && hasLabel(current, issue.claimLabel) ? [issue.claimLabel] : [];
  const removeAssignees =
    issue.assignee !== undefined && current.assignees.includes(issue.assignee)
      ? [issue.assignee]
      : [];
  await forge.editIssue(issue.repoSlug, issue.number, { removeLabels, removeAssignees });
  delete issue.claimLabel;
  delete issue.assignee;
  issue.claimed = false;
}

/** Quotes text as a Markdown block quote. */
export function quote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}
