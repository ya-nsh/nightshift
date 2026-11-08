import { accessSync, constants, existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { loadSdkQuery } from "./agent/sdk.js";
import { type Config, expandHome } from "./config.js";
import { exec, shellQuote } from "./exec.js";
import {
  ClaudeUsageMeter,
  describeUsage,
  limitsEnabled,
  missingWindows,
  type UsageTally,
  usageLimits,
  WINDOW_LABEL,
} from "./usage.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** Verifies everything an unattended run depends on, before it spends anything. */
export async function preflight(
  config: Config,
  usage: { share?: number; tally?: UsageTally } = {},
): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const node = Number(process.versions.node.split(".")[0]);
  add("node", node >= 22, `v${process.versions.node}${node >= 22 ? "" : " (need ≥ 22)"}`);

  const gh = await run("gh", ["--version"]);
  add("gh installed", gh.ok, gh.ok ? firstLine(gh.out) : gh.out);
  if (gh.ok) {
    const auth = await run("gh", ["auth", "status"]);
    add("gh authenticated", auth.ok, auth.ok ? "ok" : auth.out);
  }

  if (config.agent.backend === "cli") {
    const claude = await run(config.agent.claude_path, ["--version"]);
    add("claude CLI", claude.ok, claude.ok ? firstLine(claude.out) : claude.out);
  } else {
    try {
      await loadSdkQuery(config.home);
      add("Agent SDK", true, "importable");
    } catch (error) {
      add("Agent SDK", false, (error as Error).message);
    }
  }

  for (const [alias, dir] of Object.entries(config.repos)) {
    if (!existsSync(dir)) {
      add(`repo ${alias}`, false, `${dir} does not exist`);
      continue;
    }
    const top = await run("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
    if (!top.ok) {
      add(`repo ${alias}`, false, `${dir} is not a git repository`);
      continue;
    }
    const slug = gh.ok
      ? await run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], dir)
      : undefined;
    add(
      `repo ${alias}`,
      slug?.ok ?? false,
      slug?.ok ? `${dir} → ${slug.out.trim()}` : `${dir}: ${slug?.out ?? "gh unavailable"}`,
    );
  }

  const command = config.review.command.trim();
  if (command === "") {
    add("review command", true, "none configured (review is skipped)");
  } else {
    const program = expandHome(command.split(/\s+/)[0] ?? "");
    if (program.includes("/")) {
      let ok = existsSync(program);
      if (ok) {
        try {
          accessSync(program, constants.X_OK);
        } catch {
          ok = false;
        }
      }
      add("review command", ok, ok ? program : `${program} is missing or not executable`);
    } else {
      const found = await run("/bin/sh", ["-c", `command -v ${shellQuote(program)}`]);
      add("review command", found.ok, found.ok ? found.out.trim() : `${program} not found on PATH`);
    }
  }

  const limits = usageLimits(config.usage, usage.share);
  const enforced = limitsEnabled(limits);
  const reading = await new ClaudeUsageMeter(config.agent.claude_path, config.home).read();
  if (reading.ok) {
    const missing = missingWindows(limits, reading.windows);
    const summary = describeUsage(reading.windows, usage.tally ?? {}, limits, new Date());
    add(
      "plan usage",
      missing.length === 0,
      missing.length === 0
        ? `${summary}${enforced ? ` · on_limit = "${config.usage.on_limit}"` : " (no [usage] limits set)"}`
        : `no ${missing.map((w) => WINDOW_LABEL[w]).join(" or ")} window reported, so its limit cannot be kept`,
    );
  } else {
    add(
      "plan usage",
      !enforced,
      enforced
        ? `cannot read it, so the [usage] limits cannot be kept: ${reading.detail}`
        : `not available (${reading.detail}); fine, no [usage] limits are set`,
    );
  }

  const stats = await statfs(config.home);
  const freeGb = (Number(stats.bavail) * Number(stats.bsize)) / 1e9;
  const min = config.limits.min_free_disk_gb;
  add("disk", freeGb >= min, `${freeGb.toFixed(1)} GB free${min > 0 ? ` (min ${min})` : ""}`);

  return checks;
}

async function run(
  command: string,
  args: string[],
  cwd?: string,
): Promise<{ ok: boolean; out: string }> {
  try {
    const result = await exec(command, args, {
      ...(cwd === undefined ? {} : { cwd }),
      timeoutMs: 30_000,
    });
    return { ok: result.code === 0, out: (result.stdout || result.stderr).trim() };
  } catch (error) {
    return { ok: false, out: (error as Error).message };
  }
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}
