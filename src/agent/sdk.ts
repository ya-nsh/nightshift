import { accessSync, constants } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Config } from "../config.js";
import { INTERRUPT_GRACE_MS } from "../exec.js";
import type { Agent, AgentRequest, AgentResult } from "../ports.js";
import { toAgentEvents } from "./events.js";
import { interpretResult } from "./result.js";

export const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/** The slice of the Agent SDK's `query()` that nightshift uses. */
export type QueryFn = (params: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<Record<string, unknown>> & { interrupt?: () => Promise<void> };

type AgentConfig = Config["agent"];

/**
 * Runs each step through the Claude Agent SDK's `query()`. The SDK is an optional peer dependency:
 * it is resolved next to nightshift first, then from the project (`home`).
 */
export class ClaudeSdkAgent implements Agent {
  readonly name = "claude-agent-sdk";

  constructor(
    private readonly config: AgentConfig,
    private readonly query: QueryFn,
  ) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    const abortController = new AbortController();
    const stream = this.query({
      prompt: request.prompt,
      options: buildSdkOptions(this.config, request, abortController),
    });
    // Stop gracefully first: interrupt() ends the turn and the SDK still yields a result message
    // with the cost so far. A hard abort follows if it does not finish in time.
    let hardStop: NodeJS.Timeout | undefined;
    const onAbort = () => {
      const interrupt = stream.interrupt?.bind(stream);
      if (interrupt === undefined) {
        abortController.abort();
        return;
      }
      interrupt().catch(() => abortController.abort());
      hardStop = setTimeout(() => abortController.abort(), INTERRUPT_GRACE_MS);
      hardStop.unref();
    };
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener("abort", onAbort, { once: true });

    const lines: string[] = [];
    let sessionId: string | undefined;
    let result: Record<string, unknown> | undefined;
    let failure: string | undefined;
    try {
      for await (const message of stream) {
        lines.push(JSON.stringify(message));
        if (typeof message.session_id === "string") sessionId = message.session_id;
        if (message.type === "result") result = message;
        if (request.onEvent) {
          for (const event of toAgentEvents(message, request.cwd)) request.onEvent(event);
        }
      }
    } catch (error) {
      failure = (error as Error).message;
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      if (hardStop) clearTimeout(hardStop);
    }
    await mkdir(path.dirname(request.artifactPath), { recursive: true });
    await writeFile(request.artifactPath, lines.length > 0 ? `${lines.join("\n")}\n` : "");

    const partial = result === undefined ? undefined : interpretResult(result);
    if (request.signal.aborted) {
      return {
        outcome: "aborted",
        sessionId: partial?.sessionId ?? sessionId,
        costUsd: partial?.costUsd ?? 0,
        structured: undefined,
        detail: "aborted",
      };
    }
    if (failure !== undefined || partial === undefined) {
      return {
        outcome: "error",
        sessionId,
        costUsd: partial?.costUsd ?? 0,
        structured: undefined,
        detail: failure ?? "the SDK returned no result message",
      };
    }
    return { ...partial, sessionId: partial.sessionId ?? sessionId };
  }
}

export function buildSdkOptions(
  config: AgentConfig,
  request: AgentRequest,
  abortController: AbortController,
): Record<string, unknown> {
  const extraArgs = toSdkExtraArgs(config.extra_args);
  const executable = resolveClaudePath(config.claude_path);
  return {
    cwd: request.cwd,
    permissionMode: config.permission_mode,
    ...(config.permission_mode === "bypassPermissions"
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    maxTurns: config.max_turns,
    maxBudgetUsd: request.maxBudgetUsd,
    outputFormat: { type: "json_schema", schema: request.schema },
    // Load the same settings, CLAUDE.md files and skills as the CLI does.
    settingSources: ["user", "project", "local"],
    abortController,
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(request.resumeSessionId === undefined ? {} : { resume: request.resumeSessionId }),
    ...(config.allowed_tools.length > 0 ? { allowedTools: config.allowed_tools } : {}),
    ...(config.add_dirs.length > 0 ? { additionalDirectories: config.add_dirs } : {}),
    ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}),
    ...(executable === undefined ? {} : { pathToClaudeCodeExecutable: executable }),
  };
}

/**
 * `extra_args` is written as CLI arguments (`["--foo", "bar", "--baz=1", "--flag"]`); the SDK wants
 * `{ foo: "bar", baz: "1", flag: null }`. Anything that is not a `--flag` is an error, not a guess.
 */
export function toSdkExtraArgs(args: readonly string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith("--") || arg.length < 3) {
      throw new Error(`agent.extra_args: expected a --flag, got "${arg}"`);
    }
    const eq = arg.indexOf("=");
    if (eq > 2) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[arg.slice(2)] = next;
      i++;
    } else {
      out[arg.slice(2)] = null;
    }
  }
  return out;
}

/**
 * The SDK runs its bundled Claude Code unless told otherwise. A non-default `claude_path` (a path,
 * or another command name on PATH) is passed on as `pathToClaudeCodeExecutable`.
 */
export function resolveClaudePath(claudePath: string): string | undefined {
  if (claudePath === "claude") return undefined;
  if (claudePath.includes("/")) return claudePath;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, claudePath);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  throw new Error(`agent.claude_path: "${claudePath}" was not found on PATH`);
}

export async function loadSdkQuery(projectDir: string): Promise<QueryFn> {
  const candidates: Array<() => Promise<unknown>> = [
    () => import(SDK_PACKAGE),
    () => {
      const resolved = createRequire(path.join(projectDir, "noop.js")).resolve(SDK_PACKAGE);
      return import(pathToFileURL(resolved).href);
    },
  ];
  for (const load of candidates) {
    try {
      const mod = (await load()) as { query?: unknown };
      if (typeof mod.query === "function") return mod.query as QueryFn;
    } catch {
      // try the next location
    }
  }
  throw new Error(
    `agent.backend = "sdk" needs ${SDK_PACKAGE}; install it next to nightshift or in ${projectDir} (npm install ${SDK_PACKAGE})`,
  );
}
