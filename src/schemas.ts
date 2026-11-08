import { z } from "zod";

/**
 * Structured results each Claude step must return. They are sent to Claude as JSON Schema
 * (`--json-schema` / `outputFormat`) and validated again here, so a malformed result halts the run
 * instead of steering it.
 */

export const implementResult = z.strictObject({
  status: z
    .enum(["pr_opened", "blocked", "all_done", "failed"])
    .describe(
      "pr_opened: the task is implemented and a pull request is open. blocked: a human must act or decide first. all_done: there is no task left. failed: you could not complete it.",
    ),
  item: z.string().describe("Short identifier of the task, e.g. its todo ID and title."),
  summary: z.string().describe("One or two sentences on what you did or why you stopped."),
  pr_number: z.number().int().positive().optional().describe("Required when status is pr_opened."),
  question: z
    .string()
    .optional()
    .describe("Required when status is blocked: the precise question for the human."),
});
export type ImplementResult = z.infer<typeof implementResult>;

/** Shared by the address-review, fix-checks and resolve-conflicts steps. */
export const stepResult = z.strictObject({
  status: z
    .enum(["ready", "blocked", "failed"])
    .describe(
      "ready: the step is done and the pull request is ready for the next stage. blocked: a human must act or decide first. failed: you could not complete it.",
    ),
  pushed_changes: z
    .boolean()
    .describe("Whether you pushed new commits to the pull request branch."),
  summary: z.string().describe("One or two sentences on what you changed and why."),
  question: z
    .string()
    .optional()
    .describe("Required when status is blocked: the precise question for the human."),
});
export type StepResult = z.infer<typeof stepResult>;

export function finalizeResult(repoAliases: readonly [string, ...string[]]) {
  return z.strictObject({
    status: z
      .enum(["continue", "all_done", "blocked"])
      .describe(
        "continue: post-merge steps are done and next_prompt holds the next task. all_done: no task is left. blocked: a human must act or decide before the next task.",
      ),
    summary: z.string().describe("One or two sentences on the post-merge steps you did."),
    next_repo: z
      .enum(repoAliases)
      .optional()
      .describe("Required when status is continue: the repo the next task runs in."),
    next_prompt: z
      .string()
      .optional()
      .describe(
        "Required when status is continue (and wanted when blocked): the complete, self-contained prompt for a brand-new session that does the next task.",
      ),
    question: z
      .string()
      .optional()
      .describe("Required when status is blocked: the precise question for the human."),
  });
}
export type FinalizeResult = z.infer<ReturnType<typeof finalizeResult>>;

export const PLAN_SIZES = ["S", "M", "L", "XL"] as const;
export const PLAN_RISKS = ["low", "medium", "high"] as const;

/** `nightshift plan`: the next `count` items nightshift would work on, without doing any of them. */
export function planResult(repoAliases: readonly [string, ...string[]], count: number) {
  const item = z
    .strictObject({
      id: z
        .string()
        .min(1)
        .describe("The task's ID in the repository's todo list (e.g. T12), or a short slug."),
      title: z.string().min(1).describe("The task's title, in a few words."),
      repo: z.enum(repoAliases).describe("Alias of the repository the task runs in."),
      why_now: z
        .string()
        .min(1)
        .describe(
          "Why this task comes next: the rule, order, dependency or priority that puts it here.",
        ),
      size: z
        .enum(PLAN_SIZES)
        .describe(
          "Rough size for one unattended session. S: a small change, under an hour. M: a few hours. L: about a day. XL: more than a day; it should probably be split.",
        ),
      risk: z
        .enum(PLAN_RISKS)
        .describe(
          "How likely it is to go wrong or break something: low, medium or high (migrations, auth, money, public APIs, wide refactors).",
        ),
      risk_note: z
        .string()
        .optional()
        .describe("When risk is not low: what could go wrong, in one sentence."),
      needs_human: z
        .boolean()
        .describe(
          "Whether a human must act or decide before or during this task (credentials, accounts, money, a product decision, anything the instructions reserve for the user).",
        ),
      question: z
        .string()
        .optional()
        .describe("Required when needs_human is true: the precise question for the human."),
    })
    .refine((i) => !i.needs_human || (i.question ?? "").trim() !== "", {
      message: "needs_human items need a question",
      path: ["question"],
    });
  return z.strictObject({
    summary: z
      .string()
      .describe("One or two sentences: where the work stands and what the next tasks are about."),
    items: z
      .array(item)
      .max(count)
      .describe(
        `The next tasks in the order nightshift would do them, at most ${count}; fewer, or none, when fewer are left.`,
      ),
  });
}
export type PlanResult = z.infer<ReturnType<typeof planResult>>;
export type PlanItem = PlanResult["items"][number];

/** JSON Schema for a result schema, in the form both the CLI and the SDK accept. */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  return json;
}
