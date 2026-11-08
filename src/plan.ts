import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import type { Agent, UsageMeter } from "./ports.js";
import { type PlanItem, type PlanResult, planResult, toJsonSchema } from "./schemas.js";
import type { ItemState, RunState } from "./state.js";
import { render, type Templates } from "./templates.js";
import {
  formatTime,
  limitHit,
  limitsEnabled,
  missingWindows,
  usageLimits,
  WINDOW_LABEL,
} from "./usage.js";

/**
 * `nightshift plan`: asks Claude, in a fresh read-only session, which items it would do next. It
 * reads the run's state but never writes it and does not take the run lock, so it is safe next to a
 * live run; what it plans from is the state as it was when the plan started.
 */

export const DEFAULT_PLAN_COUNT = 5;
export const MAX_PLAN_COUNT = 20;
/** `--write` saves the plan here, inside `.nightshift/`. */
export const PLAN_FILE = "plan.md";

export class PlanError extends Error {
  override name = "PlanError";
}

/** What the plan starts from. */
export type PlanSource =
  /** `--prompt` / `--prompt-file`. */
  | "prompt"
  /** The current run's next item, which has not started yet. */
  | "handoff"
  /** The current run's item is under way; the plan covers what comes after it. */
  | "after_current"
  /** No run in progress: the repositories' own instructions. */
  | "instructions";

export interface PlanStart {
  source: PlanSource;
  /** The repo alias the planning session runs in. */
  repo: string;
  /** The "where things stand" section of the prompt. */
  text: string;
  /** One line for the human. */
  description: string;
}

export interface PlanOptions {
  count: number;
  prompt?: string;
  repo?: string;
  signal: AbortSignal;
}

export interface PlanDeps {
  config: Config;
  templates: Templates;
  agent: Agent;
  /** Required when `[usage]` limits are configured. */
  usage?: UsageMeter;
  now: () => Date;
  /** Progress lines (tool calls), for stderr. */
  log?: (line: string) => void;
}

export interface Plan {
  generated_at: string;
  source: PlanSource;
  /** Where the plan started from, in words. */
  start: string;
  run_id?: string;
  repo: string;
  count: number;
  summary: string;
  items: PlanItem[];
  cost_usd: number;
}

export type PlanOutcome =
  | { ok: true; plan: Plan }
  | { ok: false; reason: string; costUsd: number; aborted: boolean };

export function parsePlanCount(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PLAN_COUNT;
  const n = Number(value);
  if (value.trim() === "" || !Number.isInteger(n) || n < 1 || n > MAX_PLAN_COUNT) {
    throw new PlanError(`-n must be a whole number from 1 to ${MAX_PLAN_COUNT}`);
  }
  return n;
}

/** Decides what the plan starts from: the given prompt, the run's pending handoff, or nothing. */
export function planStart(
  config: Config,
  state: RunState | undefined,
  options: { prompt?: string; repo?: string },
): PlanStart {
  const live = state !== undefined && state.status !== "done" ? state : undefined;
  const item = live?.item;
  if (options.prompt !== undefined) {
    const repo = options.repo ?? config.defaultRepo;
    return {
      source: "prompt",
      repo,
      text: [
        `nightshift would start with this prompt for its first task, in \`${repo}\`. Your first item is the task it describes.`,
        "",
        tagged("prompt", options.prompt),
      ].join("\n"),
      description: `the given prompt (repo ${repo})`,
    };
  }
  if (live !== undefined && item !== undefined) {
    const repo = options.repo ?? item.repo;
    const lines: string[] = [];
    let source: PlanSource;
    let description: string;
    if (started(item)) {
      source = "after_current";
      description = `after item ${item.index}${item.label ? ` (${item.label})` : ""} of run ${live.runId}, which is under way`;
      lines.push(
        `Run ${live.runId} is working on item ${item.index}${item.label ? ` (${item.label})` : ""} in \`${item.repo}\`, now at the ${item.phase} step${item.pr ? ` with pull request ${item.pr.url}` : ""}. It started from this handoff:`,
        "",
        tagged("handoff", item.handoff),
        "",
        "Assume it lands as its handoff describes. Do not list it: your first item is the task after it.",
      );
    } else {
      source = "handoff";
      description = `the pending handoff of run ${live.runId} (item ${item.index}, repo ${item.repo})`;
      lines.push(
        `Run ${live.runId} is about to start item ${item.index} in \`${item.repo}\` with this handoff prompt. Your first item is the task it describes.`,
        "",
        tagged("handoff", item.handoff),
      );
    }
    if (live.status === "halted") {
      lines.push("", `The run is halted: ${live.haltReason ?? "(no reason recorded)"}.`);
    }
    if (item.pendingQuestion !== undefined) {
      lines.push(
        "",
        `It is waiting for a human to answer: ${item.pendingQuestion}`,
        item.pendingAnswer === undefined
          ? "Mark the tasks that depend on that answer as needing a human."
          : `The answer given: ${item.pendingAnswer}`,
      );
    }
    return { source, repo, text: lines.join("\n"), description };
  }
  const repo = options.repo ?? config.defaultRepo;
  const lines = [
    "No run is in progress and no prompt was given. Pick the next tasks from the repositories' own instructions, starting with the one nightshift should do first.",
  ];
  if (state?.status === "done") {
    lines.push("", `The last run (${state.runId}) finished: ${state.haltReason ?? "done"}.`);
  }
  return {
    source: "instructions",
    repo,
    text: lines.join("\n"),
    description: "the repositories' own instructions (no pending handoff)",
  };
}

/** Whether the item's first Claude step has run, so the plan should start after it. */
function started(item: ItemState): boolean {
  return item.phase !== "implement" || item.sessionId !== undefined || item.label !== undefined;
}

function tagged(tag: string, text: string): string {
  return `<${tag}>\n${text.trim()}\n</${tag}>`;
}

/**
 * The `[usage]` gate for a plan: unlike a run, a plan does not wait for a window to reset; it
 * refuses to start. Share limits count the live run's own tally (a plan's usage is not added to it).
 */
export async function planUsageRefusal(
  config: Config,
  state: RunState | undefined,
  meter: UsageMeter | undefined,
  now: Date,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const live = state !== undefined && state.status !== "done" ? state : undefined;
  const limits = usageLimits(config.usage, live?.usageShare);
  if (!limitsEnabled(limits)) return undefined;
  const reading =
    meter === undefined
      ? { ok: false as const, detail: "no usage meter is available" }
      : await meter.read(signal);
  if (!reading.ok) {
    return `cannot read Claude plan usage, so the [usage] limits cannot be kept: ${reading.detail}`;
  }
  const missing = missingWindows(limits, reading.windows);
  if (missing.length > 0) {
    return `Claude reported no ${missing.map((w) => WINDOW_LABEL[w]).join(" or ")} usage window, so its [usage] limit cannot be kept`;
  }
  const hit = limitHit(limits, live?.usage?.tally ?? {}, reading.windows);
  if (hit !== undefined) {
    return `usage limit: ${hit.reason}; the ${WINDOW_LABEL[hit.window]} window resets ${formatTime(hit.resetsAt, now)}`;
  }
  return undefined;
}

/** Runs the read-only planning session and validates its result. */
export async function makePlan(
  deps: PlanDeps,
  state: RunState | undefined,
  options: PlanOptions,
): Promise<PlanOutcome> {
  const { config } = deps;
  const aliases = Object.keys(config.repos) as [string, ...string[]];
  const start = planStart(config, state, options);
  const repoPath = config.repos[start.repo];
  if (repoPath === undefined) {
    throw new PlanError(`unknown repo "${start.repo}"; configured: ${aliases.join(", ")}`);
  }
  const refusal = await planUsageRefusal(config, state, deps.usage, deps.now(), options.signal);
  if (refusal !== undefined) {
    return { ok: false, reason: `not planning: ${refusal}`, costUsd: 0, aborted: false };
  }

  const prompt = render(deps.templates.plan, {
    count: options.count,
    start: start.text,
    repos: Object.entries(config.repos)
      .map(([alias, dir]) => `- ${alias}: ${dir}`)
      .join("\n"),
    repo: start.repo,
    repo_path: repoPath,
  });
  const schema = planResult(aliases, options.count);
  const generatedAt = deps.now();
  const stamp = generatedAt.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const otherRepos = [...new Set(Object.values(config.repos))].filter((dir) => dir !== repoPath);
  const result = await deps.agent.run({
    cwd: repoPath,
    prompt,
    schema: toJsonSchema(schema),
    maxBudgetUsd: config.budget.plan_usd,
    artifactPath: path.join(config.dir, "plans", `${stamp}.jsonl`),
    signal: options.signal,
    readOnly: true,
    ...(otherRepos.length > 0 ? { addDirs: otherRepos } : {}),
    onEvent: (event) => {
      if (event.type === "tool") deps.log?.(`plan · ${event.name} ${event.detail}`.trimEnd());
    },
  });
  const costUsd = result.costUsd;
  const fail = (reason: string, aborted = false): PlanOutcome => ({
    ok: false,
    reason,
    costUsd,
    aborted,
  });
  switch (result.outcome) {
    case "aborted":
      return fail("interrupted", true);
    case "max_budget":
      return fail(
        `Claude hit the plan budget ($${config.budget.plan_usd.toFixed(2)}, [budget] plan_usd)`,
      );
    case "max_turns":
      return fail("Claude hit max_turns");
    case "no_structured_output":
      return fail("no structured result returned");
    case "error":
      return fail(`agent error: ${result.detail}`);
    case "success":
      break;
  }
  const parsed = schema.safeParse(result.structured);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return fail(`invalid structured result (${issues})`);
  }
  const value: PlanResult = parsed.data;
  const live = state !== undefined && state.status !== "done" ? state : undefined;
  return {
    ok: true,
    plan: {
      generated_at: generatedAt.toISOString(),
      source: start.source,
      start: start.description,
      ...(live !== undefined && start.source !== "prompt" ? { run_id: live.runId } : {}),
      repo: start.repo,
      count: options.count,
      summary: value.summary,
      items: value.items,
      cost_usd: costUsd,
    },
  };
}

/** The plan as Markdown, for the terminal and for `.nightshift/plan.md`. */
export function formatPlan(plan: Plan): string {
  const when = new Date(plan.generated_at);
  const stamp = Number.isNaN(when.getTime())
    ? plan.generated_at
    : when.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  const lines = [
    "# nightshift plan",
    "",
    `Next ${plan.count === 1 ? "item" : `${plan.count} items`}, starting from ${plan.start} · ${stamp} · cost $${plan.cost_usd.toFixed(2)}`,
    "",
    plan.summary.trim(),
    "",
  ];
  if (plan.items.length === 0) lines.push("Nothing left to do.", "");
  plan.items.forEach((item, i) => {
    lines.push(
      `${i + 1}. **${label(item)}** · \`${item.repo}\` · size ${item.size} · risk ${item.risk}`,
      `   Why now: ${oneLine(item.why_now)}`,
    );
    if (item.risk_note !== undefined && item.risk_note.trim() !== "") {
      lines.push(`   Risk: ${oneLine(item.risk_note)}`);
    }
    if (item.needs_human) lines.push(`   **Needs a human:** ${oneLine(item.question ?? "")}`);
    lines.push("");
  });
  const humans = plan.items.filter((item) => item.needs_human).length;
  if (humans > 0) {
    lines.push(
      `${humans} of ${plan.items.length} item(s) need a human; a run stops at the first with a question.`,
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Saves the plan to `<dir>/plan.md` and returns the file's path. */
export async function writePlan(dir: string, plan: Plan): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, PLAN_FILE);
  await writeFile(file, formatPlan(plan));
  return file;
}

function label(item: PlanItem): string {
  const id = item.id.trim();
  const title = item.title.trim();
  return title.startsWith(id) ? title : `${id} — ${title}`;
}

function oneLine(text: string): string {
  return text.trim().replace(/\s*\n\s*/g, " ");
}
