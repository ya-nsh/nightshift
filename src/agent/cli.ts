import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import { exec, tail } from "../exec.js";
import type { Agent, AgentRequest, AgentResult } from "../ports.js";
import { interpretResult } from "./result.js";

type AgentConfig = Config["agent"];

/** Runs each step as `claude -p` (the prompt goes in on stdin, the result comes back as JSON). */
export class ClaudeCliAgent implements Agent {
  readonly name = "claude-cli";

  constructor(private readonly config: AgentConfig) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    const result = await exec(this.config.claude_path, buildCliArgs(this.config, request), {
      cwd: request.cwd,
      input: request.prompt,
      signal: request.signal,
    });
    await mkdir(path.dirname(request.artifactPath), { recursive: true });
    await writeFile(request.artifactPath, result.stdout || result.stderr);
    if (result.aborted) {
      return {
        outcome: "aborted",
        sessionId: undefined,
        costUsd: 0,
        structured: undefined,
        detail: "aborted",
      };
    }
    const message = parseResultJson(result.stdout);
    if (message === undefined) {
      const output = tail((result.stderr || result.stdout).trim(), 2000) || "(no output)";
      return {
        outcome: "error",
        sessionId: undefined,
        costUsd: 0,
        structured: undefined,
        detail: `claude exited ${String(result.code)} without a JSON result: ${output}`,
      };
    }
    return interpretResult(message);
  }
}

export function buildCliArgs(config: AgentConfig, request: AgentRequest): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(request.schema),
    "--permission-mode",
    config.permission_mode,
    "--max-turns",
    String(config.max_turns),
    "--max-budget-usd",
    request.maxBudgetUsd.toFixed(2),
  ];
  if (config.model !== undefined) args.push("--model", config.model);
  if (request.resumeSessionId !== undefined) args.push("--resume", request.resumeSessionId);
  // Variadic flags use the `=` form so they cannot swallow the arguments that follow.
  if (config.allowed_tools.length > 0)
    args.push(`--allowedTools=${config.allowed_tools.join(",")}`);
  for (const dir of config.add_dirs) args.push(`--add-dir=${dir}`);
  args.push(...config.extra_args);
  return args;
}

/** `--output-format json` prints one JSON object; tolerate stray lines (warnings) around it. */
export function parseResultJson(stdout: string): unknown {
  const text = stdout.trim();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split("\n").reverse();
    for (const line of lines) {
      const candidate = line.trim();
      if (!candidate.startsWith("{")) continue;
      try {
        return JSON.parse(candidate);
      } catch {
        // keep looking
      }
    }
    return undefined;
  }
}
