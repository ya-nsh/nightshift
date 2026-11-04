import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

/** Directory (inside the "home" repo) that holds config, prompts overrides, state and logs. */
export const NIGHTSHIFT_DIR = ".nightshift";
export const CONFIG_FILE = "config.toml";

const repoAlias = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "repo aliases use letters, digits, '.', '_' or '-'");

export const PERMISSION_MODES = ["auto", "acceptEdits", "dontAsk", "bypassPermissions"] as const;
export const MERGE_METHODS = ["merge", "rebase", "squash"] as const;

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
    })
    .prefault({}),
  budget: z
    .strictObject({
      item_usd: z.number().positive().default(25),
      invocation_usd: z.number().positive().default(150),
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
      max_conflict_rounds: z.number().int().min(0).max(5).default(2),
    })
    .prefault({}),
  limits: z
    .strictObject({
      max_items: z.number().int().min(0).default(0),
      min_free_disk_gb: z.number().min(0).default(0),
    })
    .prefault({}),
  notify: z.strictObject({ command: z.string().default("") }).prefault({}),
  prompts: z.strictObject({ dir: z.string().min(1).optional() }).prefault({}),
});

export type RawConfig = z.infer<typeof configSchema>;

/** Validated config with every path made absolute. */
export interface Config extends Omit<RawConfig, "repos" | "default_repo"> {
  /** Directory containing `.nightshift/`; relative paths in the config resolve against it. */
  home: string;
  /** `<home>/.nightshift` */
  dir: string;
  repos: Record<string, string>;
  defaultRepo: string;
  promptsDir: string | undefined;
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
    home,
    dir: path.join(home, NIGHTSHIFT_DIR),
    repos: Object.fromEntries(Object.entries(raw.repos).map(([alias, p]) => [alias, resolve(p)])),
    defaultRepo,
    promptsDir: raw.prompts.dir === undefined ? undefined : resolve(raw.prompts.dir),
  };
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
