import type { Config } from "./config.js";
import type { Forge, IssueComment } from "./ports.js";
import type { ItemState, QuestionPost } from "./state.js";

/**
 * Asking a human on GitHub (`[answers] via = "github"`): the question goes on the item's PR, or
 * into a new issue when there is no PR yet, and a later comment from an allowed user is the answer.
 */

/** Every comment nightshift posts carries this, so its own comments are never taken as answers. */
export const MARKER_PREFIX = "<!-- nightshift:";
/** Longer replies are cut: an answer is a decision, not a document. */
export const MAX_ANSWER_CHARS = 20_000;

export interface Answer {
  text: string;
  /** Logins of the users whose replies make up the answer. */
  by: string[];
  /** The reply comments, so they can be acknowledged. */
  comments: IssueComment[];
}

/** Who may answer: `[answers] users`, or the account `gh` is logged in as. */
export async function allowedUsers(config: Config, forge: Forge): Promise<string[]> {
  if (config.answers.users.length > 0) return config.answers.users;
  return [await forge.currentUser()];
}

export function questionBody(
  question: string,
  context: { runId: string; item: ItemState; kind: QuestionPost["kind"]; users: string[] },
): string {
  const { runId, item, kind, users } = context;
  const label = item.label ?? `item ${item.index}`;
  // Claude wrote the question: quote it, and keep @mentions in it from pinging anyone.
  const quoted = question
    .trim()
    .split("\n")
    .map((line) => `> ${line.replaceAll("@", "@\u200b")}`)
    .join("\n");
  const who = users.map((u) => `@${u}`).join(" or ");
  return [
    `${MARKER_PREFIX}question run=${runId} item=${item.index} -->`,
    `**nightshift needs an answer** to continue (run \`${runId}\`, ${label}):`,
    "",
    quoted,
    "",
    `Reply to this ${kind === "pr_comment" ? "pull request" : "issue"} with a comment that holds just your answer. ` +
      `Comments from ${who} posted after this one are taken as the answer; nightshift picks it up ` +
      "with its background service, or on the next `nightshift resume`, and reacts with 👍. " +
      'You can also answer locally: `nightshift resume --answer "…"`.',
  ].join("\n");
}

function issueTitle(item: ItemState): string {
  const title = `nightshift question: ${item.label ?? `item ${item.index}`}`;
  return title.length <= 120 ? title : `${title.slice(0, 119)}…`;
}

/**
 * Posts the question as a comment on the item's PR; with no PR yet, on the GitHub issue the item
 * works on (`[tasks] source = "github_issues"`), or else in a new issue in `repoSlug`. Returns
 * where it was posted; throws when GitHub refuses.
 */
export async function postQuestion(
  forge: Forge,
  config: Config,
  runId: string,
  item: ItemState,
  question: string,
  repoSlug: () => Promise<string>,
): Promise<QuestionPost> {
  const users = await allowedUsers(config, forge);
  if (item.pr !== undefined) {
    const body = questionBody(question, { runId, item, kind: "pr_comment", users });
    const posted = await forge.commentIssue(item.pr.repoSlug, item.pr.number, body);
    return {
      kind: "pr_comment",
      repoSlug: item.pr.repoSlug,
      number: item.pr.number,
      id: posted.id,
      url: posted.url,
      postedAt: posted.createdAt,
    };
  }
  if (item.issue !== undefined) {
    const body = questionBody(question, { runId, item, kind: "issue_comment", users });
    const posted = await forge.commentIssue(item.issue.repoSlug, item.issue.number, body);
    return {
      kind: "issue_comment",
      repoSlug: item.issue.repoSlug,
      number: item.issue.number,
      id: posted.id,
      url: posted.url,
      postedAt: posted.createdAt,
    };
  }
  const slug = await repoSlug();
  const body = questionBody(question, { runId, item, kind: "issue", users });
  const issue = await forge.createIssue(slug, issueTitle(item), body);
  return {
    kind: "issue",
    repoSlug: slug,
    number: issue.number,
    id: issue.id,
    url: issue.url,
    postedAt: issue.createdAt,
  };
}

/**
 * The replies to `post` that count as the answer: created at or after the question, by an allowed
 * user, not by a bot, and not one of nightshift's own comments. Several replies are joined in order.
 * The text is data for Claude, exactly like `--answer`.
 */
export function answerFrom(
  post: QuestionPost,
  comments: readonly IssueComment[],
  users: readonly string[],
): Answer | undefined {
  const allowed = new Set(users.map((u) => u.toLowerCase()));
  const postedAt = Date.parse(post.postedAt);
  const replies = comments
    .filter(
      (c) =>
        c.id !== post.id &&
        !c.authorIsBot &&
        !c.author.toLowerCase().endsWith("[bot]") &&
        allowed.has(c.author.toLowerCase()) &&
        !c.body.includes(MARKER_PREFIX) &&
        c.body.trim() !== "" &&
        Date.parse(c.createdAt) >= postedAt,
    )
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id);
  if (replies.length === 0) return undefined;
  let text = replies.map((c) => c.body.trim()).join("\n\n");
  if (text.length > MAX_ANSWER_CHARS) {
    text = `${text.slice(0, MAX_ANSWER_CHARS)}\n[… answer cut at ${MAX_ANSWER_CHARS} characters …]`;
  }
  return { text, by: [...new Set(replies.map((c) => c.author))], comments: replies };
}

/** Reads the conversation and returns the answer, if one was posted. */
export async function findAnswer(
  forge: Forge,
  post: QuestionPost,
  users: readonly string[],
): Promise<Answer | undefined> {
  const comments = await forge.listComments(post.repoSlug, post.number, post.postedAt);
  return answerFrom(post, comments, users);
}

/**
 * Tells the human the answer was picked up: 👍 on each reply, and an issue opened just for the
 * question is closed (never the issue an item works on). Best effort; returns the problems
 * instead of throwing.
 */
export async function acknowledge(
  forge: Forge,
  post: QuestionPost,
  answer: Answer | undefined,
): Promise<string[]> {
  const problems: string[] = [];
  const attempt = async (what: string, action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      problems.push(`could not ${what} ${post.url}: ${(error as Error).message}`);
    }
  };
  for (const comment of answer?.comments ?? []) {
    try {
      await forge.addReaction(post.repoSlug, comment.id, "+1");
    } catch (error) {
      problems.push(`could not react to ${comment.url}: ${(error as Error).message}`);
    }
  }
  const note =
    answer === undefined
      ? `${MARKER_PREFIX}answered -->\nAnswered from the terminal (\`nightshift resume --answer\`); nightshift continues.`
      : `${MARKER_PREFIX}answered -->\nAnswer from @${answer.by.join(", @")} picked up; nightshift continues.`;
  if (post.kind === "issue") {
    await attempt("close", () => forge.closeIssue(post.repoSlug, post.number, note));
  } else if (answer === undefined) {
    // Answered from the terminal: say so where the question was asked.
    await attempt("comment on", () => forge.commentIssue(post.repoSlug, post.number, note));
  }
  return problems;
}
