import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { parseRange, type TimeRange } from "./schedule.js";

/** Directory (inside the "home" repo) that holds config, prompts overrides, state and logs. */
export const NIGHTSHIFT_DIR = ".nightshift";
export const CONFIG_FILE = "config.toml";

const repoAlias = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "repo aliases use letters, digits, '.', '_' or '-'");

/** A GitHub user name (bots are never trusted to answer, so `[bot]` accounts are rejected). */
const githubLogin = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "not a GitHub user name (letters, digits, '-')");

/** A percentage of a usage window, 0–100 (0 = no limit). */
const percent = z.number().min(0).max(100);

/** A GitHub label name; `gh` splits flag values on commas, so those are not allowed. */
const labelName = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .refine((name) => !name.includes(","), "label names cannot contain commas");
/** A label nightshift manages, or "" for none. */
const optionalLabel = z.union([z.literal(""), labelName]);

export const TASK_SOURCES = ["handoff", "github_issues"] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

export const PERMISSION_MODES = ["auto", "acceptEdits", "dontAsk", "bypassPermissions"] as const;
export const MERGE_METHODS = ["merge", "rebase", "squash"] as const;
/** Upper bound for `[limits] lanes`: each lane is a Claude session, a worktree and a PR at once. */
export const MAX_LANES = 8;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** The Claude steps of an item whose agent settings `[agent.steps.<step>]` can override. */
export const AGENT_STEPS = [
  "implement",
  "address",
  "fix_checks",
  "resolve_conflicts",
  "finalize",
] as const;
export type AgentStep = (typeof AGENT_STEPS)[number];

/** One `[agent.steps.<step>]` table: unset keys fall back to `[agent]`. */
const stepOverride = z.strictObject({
  model: z.string().trim().min(1, "model must not be empty").optional(),
  max_turns: z.number().int().positive().optional(),
  permission_mode: z.enum(PERMISSION_MODES).optional(),
});

/** `[agent.steps.plan]` (`nightshift plan`): no permission_mode, the plan session is always read-only. */
const planOverride = stepOverride.omit({ permission_mode: true });

const agentSteps = z
  .strictObject(
    {
      ...(Object.fromEntries(AGENT_STEPS.map((step) => [step, stepOverride.optional()])) as Record<
        AgentStep,
        z.ZodOptional<typeof stepOverride>
      >),
      plan: planOverride.optional(),
    },
    {
      error: (issue) =>
        issue.code === "unrecognized_keys"
          ? `unknown step${issue.keys.length === 1 ? "" : "s"} ${issue.keys.map((k) => `"${k}"`).join(", ")}; steps are ${AGENT_STEPS.join(", ")}, plan`
          : undefined,
    },
  )
  .default({});

const configSchema = z.strictObject({
  default_repo: repoAlias.optional(),
  repos: z
    .record(repoAlias, z.string().min(1))
    .refine((repos) => Object.keys(repos).length > 0, "declare at least one repo"),
  agent: z
    .strictObject({
      backend: z.enum(["cli", "sdk"]).default("cli"),
      claude_path: z.string().min(1).default("claude"),
      model: z.string().min(1).optional(),
      permission_mode: z.enum(PERMISSION_MODES).default("auto"),
      allowed_tools: z.array(z.string().min(1)).default([]),
      add_dirs: z.array(z.string().min(1)).default([]),
      max_turns: z.number().int().positive().default(200),
      extra_args: z.array(z.string()).default([]),
      steps: agentSteps,
    })
    .prefault({}),
  budget: z
    .strictObject({
      item_usd: z.number().positive().default(25),
      invocation_usd: z.number().positive().default(150),
      /** Ceiling for one `nightshift plan` session. */
      plan_usd: z.number().positive().default(2),
    })
    .prefault({}),
  review: z
    .strictObject({
      command: z.string().default(""),
      max_rounds: z.number().int().min(1).max(5).default(2),
      timeout_minutes: z.number().positive().default(45),
      on_failure: z.enum(["halt", "skip"]).default("halt"),
    })
    .prefault({}),
  checks: z
    .strictObject({
      wait: z.boolean().default(true),
      require_checks: z.boolean().default(false),
      settle_seconds: z.number().int().min(0).default(90),
      poll_seconds: z.number().int().min(1).default(30),
      timeout_minutes: z.number().positive().default(60),
      max_fix_rounds: z.number().int().min(0).max(5).default(2),
    })
    .prefault({}),
  merge: z
    .strictObject({
      method: z.enum(MERGE_METHODS).default("merge"),
      delete_branch: z.boolean().default(true),
      when_blocked: z.enum(["halt", "auto"]).default("halt"),
      max_conflict_rounds: z.number().int().min(0).max(5).default(2),
    })
    .prefault({}),
  limits: z
    .strictObject({
      max_items: z.number().int().min(0).default(0),
      min_free_disk_gb: z.number().min(0).default(0),
      lanes: z.number().int().min(1).max(MAX_LANES).default(1),
      worktree_dir: z.string().min(1).default(`${NIGHTSHIFT_DIR}/worktrees`),
    })
    .prefault({}),
  usage: z
    .strictObject({
      session_share: percent.default(0),
      session_max: percent.default(0),
      weekly_share: percent.default(0),
      weekly_max: percent.default(0),
      on_limit: z.enum(["wait", "halt"]).default("wait"),
      check_seconds: z.number().int().min(10).max(3600).default(60),
      /** Unset: on when usage limits or active hours are set. */
      start_item_only_if_it_fits: z.boolean().optional(),
      forecast_percentile: z.number().int().min(50).max(100).default(50),
    })
    .prefault({}),
  schedule: z
    .strictObject({
      active_hours: z
        .union([z.string(), z.array(z.string())])
        .default([])
        .transform((value, ctx): TimeRange[] => {
          const ranges: TimeRange[] = [];
          for (const text of typeof value === "string" ? [value] : value) {
            const range = parseRange(text);
            if (typeof range === "string") ctx.addIssue({ code: "custom", message: range });
            else ranges.push(range);
          }
          return ranges;
        }),
      outside_hours: z.enum(["wait", "halt"]).default("wait"),
    })
    .prefault({}),
  tasks: z
    .strictObject({
      source: z.enum(TASK_SOURCES).default("handoff"),
      label: labelName.default("nightshift"),
      repo: repoAlias.optional(),
      priority_labels: z.array(labelName).default([]),
      skip_labels: z.array(labelName).default(["blocked"]),
      authors: z.array(z.string().trim().min(1)).default([]),
      assign: z.boolean().default(true),
      in_progress_label: optionalLabel.default("nightshift-in-progress"),
      blocked_label: optionalLabel.default("nightshift-blocked"),
    })
    .prefault({}),
  notify: z.strictObject({ command: z.string().default("") }).prefault({}),
  answers: z
    .strictObject({
      via: z.enum(["terminal", "github"]).default("terminal"),
      users: z.array(githubLogin).default([]),
      poll_seconds: z.number().int().min(30).max(3600).default(120),
    })
    .prefault({}),
  prompts: z.strictObject({ dir: z.string().min(1).optional() }).prefault({}),
});

export type RawConfig = z.infer<typeof configSchema>;

/** Validated config with every path made absolute. */
export interface Config extends Omit<RawConfig, "repos" | "default_repo" | "tasks"> {
  /** Directory containing `.nightshift/`; relative paths in the config resolve against it. */
  home: string;
  /** `<home>/.nightshift` */
  dir: string;
  repos: Record<string, string>;
  defaultRepo: string;
  promptsDir: string | undefined;
  /** `[tasks]`, with `repo` resolved to an alias (default: `defaultRepo`). */
  tasks: Omit<RawConfig["tasks"], "repo"> & { repo: string };
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function parseConfig(text: string, home: string): Config {
  let data: unknown;
  try {
    data = parseToml(text);
  } catch (error) {
    throw new ConfigError(`invalid TOML: ${(error as Error).message}`);
  }
  const parsed = configSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`invalid config:\n${issues}`);
  }
  const raw = parsed.data;
  const aliases = Object.keys(raw.repos);
  const defaultRepo = raw.default_repo ?? aliases[0];
  if (defaultRepo === undefined || !aliases.includes(defaultRepo)) {
    throw new ConfigError(
      `default_repo "${raw.default_repo}" is not one of: ${aliases.join(", ")}`,
    );
  }
  const tasks = { ...raw.tasks, repo: raw.tasks.repo ?? defaultRepo };
  const taskIssues = validateTasks(tasks, aliases);
  if (taskIssues.length > 0) {
    throw new ConfigError(
      `invalid config:\n${taskIssues.map((i) => `  - tasks: ${i}`).join("\n")}`,
    );
  }
  const resolve = (p: string) => path.resolve(home, expandHome(p));
  const { repos: _repos, default_repo: _default, ...rest } = raw;
  return {
    ...rest,
    agent: {
      ...raw.agent,
      add_dirs: raw.agent.add_dirs.map(resolve),
      claude_path: raw.agent.claude_path.includes("/")
        ? resolve(raw.agent.claude_path)
        : raw.agent.claude_path,
    },
    limits: { ...raw.limits, worktree_dir: resolve(raw.limits.worktree_dir) },
    home,
    dir: path.join(home, NIGHTSHIFT_DIR),
    repos: Object.fromEntries(Object.entries(raw.repos).map(([alias, p]) => [alias, resolve(p)])),
    defaultRepo,
    promptsDir: raw.prompts.dir === undefined ? undefined : resolve(raw.prompts.dir),
    tasks,
  };
}

function validateTasks(tasks: Config["tasks"], aliases: string[]): string[] {
  const issues: string[] = [];
  if (!aliases.includes(tasks.repo)) {
    issues.push(`repo "${tasks.repo}" is not one of: ${aliases.join(", ")}`);
  }
  const managed = {
    in_progress_label: tasks.in_progress_label,
    blocked_label: tasks.blocked_label,
  };
  for (const [key, name] of Object.entries(managed)) {
    if (name === "") continue;
    if (name === tasks.label) issues.push(`${key} must differ from label ("${name}")`);
  }
  if (tasks.in_progress_label !== "" && tasks.in_progress_label === tasks.blocked_label) {
    issues.push("in_progress_label and blocked_label must differ");
  }
  if (tasks.skip_labels.includes(tasks.label)) {
    issues.push(`label "${tasks.label}" is also in skip_labels, so no issue could be picked`);
  }
  if (tasks.source === "github_issues" && !tasks.assign && tasks.in_progress_label === "") {
    issues.push("an issue must be claimed somehow: set assign = true or an in_progress_label");
  }
  return issues;
}

/** The agent settings one Claude step runs with. */
export interface StepSettings {
  /** undefined: Claude Code's default model. */
  model: string | undefined;
  maxTurns: number;
  permissionMode: PermissionMode;
}

/**
 * The effective settings for `step`: its `[agent.steps.<step>]` overrides on top of `[agent]`.
 * Without a step (a Claude call that is not one of an item's steps) `[agent]` applies as is.
 */
export function stepSettings(agent: Config["agent"], step: AgentStep | undefined): StepSettings {
  const override = step === undefined ? undefined : agent.steps[step];
  return {
    model: override?.model ?? agent.model,
    maxTurns: override?.max_turns ?? agent.max_turns,
    permissionMode: override?.permission_mode ?? agent.permission_mode,
  };
}

/**
 * The model and max_turns of `nightshift plan`: `[agent.steps.plan]` on top of `[agent]`. Its
 * permission mode is not configurable; the session is always read-only.
 */
export function planSettings(agent: Config["agent"]): Omit<StepSettings, "permissionMode"> {
  const override = agent.steps.plan;
  return {
    model: override?.model ?? agent.model,
    maxTurns: override?.max_turns ?? agent.max_turns,
  };
}

/** Every step's model, plus any max_turns/permission_mode override, for `nightshift doctor`. */
export function describeStepSettings(agent: Config["agent"]): string {
  return AGENT_STEPS.map((step) => {
    const settings = stepSettings(agent, step);
    const extras = [
      settings.maxTurns === agent.max_turns ? "" : `max_turns ${settings.maxTurns}`,
      settings.permissionMode === agent.permission_mode ? "" : settings.permissionMode,
    ].filter((extra) => extra !== "");
    return `${step} ${settings.model ?? "default"}${extras.length > 0 ? ` (${extras.join(", ")})` : ""}`;
  }).join(" · ");
}

export function expandHome(p: string): string {
  const home = process.env.HOME;
  if (home && (p === "~" || p.startsWith("~/"))) return path.join(home, p.slice(1));
  return p;
}

/** Finds `.nightshift/config.toml` in `start` or the nearest ancestor. */
export function findConfig(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, NIGHTSHIFT_DIR, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function loadConfig(explicitPath: string | undefined, cwd: string): Promise<Config> {
  const file = explicitPath ? path.resolve(cwd, explicitPath) : findConfig(cwd);
  if (file === undefined) {
    throw new ConfigError(
      `no ${NIGHTSHIFT_DIR}/${CONFIG_FILE} found here or in any parent directory; run \`nightshift init\``,
    );
  }
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    throw new ConfigError(`cannot read ${file}: ${error.message}`);
  });
  // The home is the directory that contains `.nightshift/` (or holds the config file directly).
  const configDir = path.dirname(file);
  const home = path.basename(configDir) === NIGHTSHIFT_DIR ? path.dirname(configDir) : configDir;
  return parseConfig(text, home);
}
