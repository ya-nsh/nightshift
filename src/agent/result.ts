import type { AgentResult } from "../ports.js";

/**
 * Maps a Claude Code result message (identical in `claude -p --output-format json` and the Agent
 * SDK's `type: "result"` message) to an AgentResult.
 */
export function interpretResult(message: unknown): AgentResult {
  if (typeof message !== "object" || message === null) {
    return {
      outcome: "error",
      sessionId: undefined,
      costUsd: 0,
      structured: undefined,
      detail: "no result message",
    };
  }
  const m = message as Record<string, unknown>;
  const sessionId = typeof m.session_id === "string" ? m.session_id : undefined;
  const costUsd =
    typeof m.total_cost_usd === "number" && Number.isFinite(m.total_cost_usd)
      ? m.total_cost_usd
      : 0;
  const base = { sessionId, costUsd, structured: undefined };
  if (m.type !== "result") {
    return { ...base, outcome: "error", detail: `unexpected message type ${String(m.type)}` };
  }
  const detail = describe(m);
  switch (m.subtype) {
    case "success":
      if (m.is_error === true) return { ...base, outcome: "error", detail };
      if (m.structured_output === undefined || m.structured_output === null) {
        return { ...base, outcome: "no_structured_output", detail };
      }
      return { ...base, outcome: "success", structured: m.structured_output, detail: "" };
    case "error_max_budget_usd":
      return { ...base, outcome: "max_budget", detail };
    case "error_max_turns":
      return { ...base, outcome: "max_turns", detail };
    case "error_max_structured_output_retries":
      return { ...base, outcome: "no_structured_output", detail };
    default:
      return { ...base, outcome: "error", detail };
  }
}

function describe(m: Record<string, unknown>): string {
  const errors = Array.isArray(m.errors) ? m.errors.filter((e) => typeof e === "string") : [];
  const parts = [
    typeof m.subtype === "string" ? m.subtype : undefined,
    errors.length > 0 ? errors.join("; ") : undefined,
    typeof m.result === "string" && m.result !== "" ? m.result.slice(0, 500) : undefined,
  ].filter((p) => p !== undefined);
  return parts.join(": ");
}
