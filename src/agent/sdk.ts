import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Config } from "../config.js";
import type { Agent, AgentRequest, AgentResult } from "../ports.js";
import { interpretResult } from "./result.js";

export const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/** The slice of the Agent SDK's `query()` that nightshift uses. */
export type QueryFn = (params: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<Record<string, unknown>>;

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
    const onAbort = () => abortController.abort();
    request.signal.addEventListener("abort", onAbort, { once: true });
    let sessionId: string | undefined;
    let result: Record<string, unknown> | undefined;
    try {
      for await (const message of this.query({
        prompt: request.prompt,
        options: buildSdkOptions(this.config, request, abortController),
      })) {
        if (typeof message.session_id === "string") sessionId = message.session_id;
        if (message.type === "result") result = message;
      }
    } catch (error) {
      if (request.signal.aborted) {
        return {
          outcome: "aborted",
          sessionId,
          costUsd: 0,
          structured: undefined,
          detail: "aborted",
        };
      }
      return {
        outcome: "error",
        sessionId,
        costUsd: 0,
        structured: undefined,
        detail: (error as Error).message,
      };
    } finally {
      request.signal.removeEventListener("abort", onAbort);
    }
    await mkdir(path.dirname(request.artifactPath), { recursive: true });
    await writeFile(request.artifactPath, `${JSON.stringify(result ?? null, null, 2)}\n`);
    if (result === undefined) {
      if (request.signal.aborted) {
        return {
          outcome: "aborted",
          sessionId,
          costUsd: 0,
          structured: undefined,
          detail: "aborted",
        };
      }
      return {
        outcome: "error",
        sessionId,
        costUsd: 0,
        structured: undefined,
        detail: "the SDK returned no result message",
      };
    }
    const interpreted = interpretResult(result);
    return { ...interpreted, sessionId: interpreted.sessionId ?? sessionId };
  }
}

export function buildSdkOptions(
  config: AgentConfig,
  request: AgentRequest,
  abortController: AbortController,
): Record<string, unknown> {
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
  };
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
