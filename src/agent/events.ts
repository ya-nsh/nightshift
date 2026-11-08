import path from "node:path";
import type { AgentEvent, UsageWindows } from "../ports.js";

/**
 * Turns one streamed Claude Code message (`--output-format stream-json`, or a message yielded by
 * the Agent SDK's `query()`; both have the same shapes) into progress events for the pipeline.
 */
export function toAgentEvents(message: unknown, cwd: string): AgentEvent[] {
  if (typeof message !== "object" || message === null) return [];
  const m = message as Record<string, unknown>;
  if (m.type === "assistant") {
    const content = (m.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return [];
    const events: AgentEvent[] = [];
    for (const block of content) {
      const b = block as { type?: unknown; name?: unknown; input?: unknown };
      if (b.type !== "tool_use" || typeof b.name !== "string") continue;
      // How Claude hands over the step's structured result; not progress.
      if (b.name === "StructuredOutput") continue;
      events.push({ type: "tool", name: b.name, detail: describeToolInput(b.name, b.input, cwd) });
    }
    return events;
  }
  if (m.type === "rate_limit_event") {
    const windows = usageFromRateLimitEvent(m);
    return windows === undefined ? [] : [{ type: "usage", windows }];
  }
  return [];
}

const MAX_DETAIL = 100;

/** A short, single-line description of what a tool call is about. */
export function describeToolInput(name: string, input: unknown, cwd: string): string {
  const i = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const str = (key: string) => (typeof i[key] === "string" ? (i[key] as string) : undefined);
  let detail: string | undefined;
  switch (name) {
    case "Bash":
      detail = str("command");
      break;
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit": {
      const file = str("file_path") ?? str("notebook_path");
      detail = file === undefined ? undefined : relativeTo(cwd, file);
      break;
    }
    case "Grep":
    case "Glob":
      detail = str("pattern");
      break;
    case "WebFetch":
      detail = str("url");
      break;
    case "WebSearch":
      detail = str("query");
      break;
    case "Task":
    case "Agent":
      detail = str("description");
      break;
    case "Skill":
      detail = str("skill") ?? str("command");
      break;
    default:
      detail = undefined;
  }
  if (detail === undefined) return "";
  const line = detail.split("\n")[0]?.trim() ?? "";
  return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL - 1)}…` : line;
}

function relativeTo(cwd: string, file: string): string {
  if (!path.isAbsolute(file)) return file;
  const rel = path.relative(cwd, file);
  return rel !== "" && !rel.startsWith("..") ? rel : file;
}

/**
 * `rate_limit_event` carries `rate_limit_info.unifiedWindows`, with utilization as a fraction and
 * reset times in epoch seconds. Like `get_usage`, this is not a documented format, so anything
 * unexpected yields nothing and the periodic usage check stays the source of truth.
 */
export function usageFromRateLimitEvent(
  message: Record<string, unknown>,
): UsageWindows | undefined {
  const info = message.rate_limit_info as { unifiedWindows?: unknown } | undefined;
  const unified = info?.unifiedWindows;
  if (typeof unified !== "object" || unified === null) return undefined;
  const windows: UsageWindows = {};
  for (const key of ["five_hour", "seven_day"] as const) {
    const w = (unified as Record<string, unknown>)[key] as
      | { utilization?: unknown; resetsAt?: unknown }
      | undefined;
    if (w === undefined || typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) {
      continue;
    }
    windows[key] = {
      utilization: Math.round(w.utilization * 10_000) / 100,
      resetsAt:
        typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt)
          ? new Date(w.resetsAt * 1000).toISOString()
          : undefined,
    };
  }
  return windows.five_hour === undefined && windows.seven_day === undefined ? undefined : windows;
}
