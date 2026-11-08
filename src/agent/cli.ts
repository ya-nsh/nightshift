import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import { exec, tail } from "../exec.js";
import type { Agent, AgentRequest, AgentResult } from "../ports.js";
import { toAgentEvents } from "./events.js";
import {
  DENIED_TOOLS,
  READ_ONLY_PERMISSION_MODE,
  READ_ONLY_TOOLS,
  readOnlyExtraArgs,
} from "./readonly.js";
import { interpretResult } from "./result.js";

type AgentConfig = Config["agent"];

/**
 * Runs each step as `claude -p` with the prompt on stdin. Output is streamed (`stream-json`), so
 * tool calls show up as progress while the step runs and the final result message comes last.
 */
export class ClaudeCliAgent implements Agent {
  readonly name = "claude-cli";

  constructor(private readonly config: AgentConfig) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    let resultMessage: unknown;
    const result = await exec(this.config.claude_path, buildCliArgs(this.config, request), {
      cwd: request.cwd,
      input: request.prompt,
      signal: request.signal,
      // SIGINT lets Claude Code end the turn and still print its result (with the cost so far).
      stopSignal: "SIGINT",
      onStdoutLine: (line) => {
        const message = parseLine(line);
        if (message === undefined) return;
        if ((message as { type?: unknown }).type === "result") resultMessage = message;
        if (request.onEvent)
          for (const event of toAgentEvents(message, request.cwd)) request.onEvent(event);
      },
    });
    await mkdir(path.dirname(request.artifactPath), { recursive: true });
    await writeFile(request.artifactPath, result.stdout || result.stderr);
    resultMessage ??= parseResultJson(result.stdout);
    if (result.aborted) {
      const partial = resultMessage === undefined ? undefined : interpretResult(resultMessage);
      return {
        outcome: "aborted",
        sessionId: partial?.sessionId,
        costUsd: partial?.costUsd ?? 0,
        structured: undefined,
        detail: "aborted",
      };
    }
    if (resultMessage === undefined) {
      const output = tail((result.stderr || result.stdout).trim(), 2000) || "(no output)";
      return {
        outcome: "error",
        sessionId: undefined,
        costUsd: 0,
        structured: undefined,
        detail: `claude exited ${String(result.code)} without a result: ${output}`,
      };
    }
    return interpretResult(resultMessage);
  }
}

export function buildCliArgs(config: AgentConfig, request: AgentRequest): string[] {
  const readOnly = request.readOnly === true;
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    JSON.stringify(request.schema),
    "--permission-mode",
    readOnly ? READ_ONLY_PERMISSION_MODE : config.permission_mode,
    "--max-turns",
    String(config.max_turns),
    "--max-budget-usd",
    request.maxBudgetUsd.toFixed(2),
  ];
  if (config.model !== undefined) args.push("--model", config.model);
  if (request.resumeSessionId !== undefined) args.push("--resume", request.resumeSessionId);
  // Variadic flags use the `=` form so they cannot swallow the arguments that follow.
  if (readOnly) {
    args.push(
      `--tools=${READ_ONLY_TOOLS.join(",")}`,
      `--allowedTools=${READ_ONLY_TOOLS.join(",")}`,
      `--disallowedTools=${DENIED_TOOLS.join(",")}`,
      "--strict-mcp-config",
    );
  } else if (config.allowed_tools.length > 0) {
    args.push(`--allowedTools=${config.allowed_tools.join(",")}`);
  }
  for (const dir of [...config.add_dirs, ...(request.addDirs ?? [])]) args.push(`--add-dir=${dir}`);
  args.push(...(readOnly ? readOnlyExtraArgs(config.extra_args) : config.extra_args));
  return args;
}

function parseLine(line: string): unknown {
  const text = line.trim();
  if (!text.startsWith("{")) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Finds the result message in Claude's output: the last `type: "result"` line of a stream, or a
 * single JSON object (`--output-format json`, e.g. from an `extra_args` override). Stray lines such
 * as warnings are skipped.
 */
export function parseResultJson(stdout: string): unknown {
  const text = stdout.trim();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // a stream, or noise around the JSON
  }
  const lines = text.split("\n").reverse();
  let fallback: unknown;
  for (const line of lines) {
    const message = parseLine(line);
    if (message === undefined) continue;
    if ((message as { type?: unknown }).type === "result") return message;
    fallback ??= message;
  }
  return fallback;
}
