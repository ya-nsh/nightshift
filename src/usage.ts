import type { Config } from "./config.js";
import { exec, tail } from "./exec.js";
import type { UsageMeter, UsageReading, UsageWindows, WindowReading } from "./ports.js";

/**
 * Claude subscription usage (the 5-hour "session" window and the weekly window), read from Claude
 * Code itself, and the arithmetic that keeps nightshift inside the share of it you allow.
 *
 * Utilization is account-wide: interactive Claude Code sessions count too. nightshift attributes to
 * itself only what changes while one of its own steps runs, so `share` limits are "points of the
 * window that nightshift used"; `max` limits are about the account's total.
 */

export const USAGE_WINDOWS = ["five_hour", "seven_day"] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

export const WINDOW_LABEL: Record<UsageWindow, string> = {
  five_hour: "5-hour",
  seven_day: "weekly",
};

/** What nightshift itself has used of each window, in percentage points. */
export interface WindowTally {
  resetsAt: string | undefined;
  used: number;
}
export type UsageTally = Partial<Record<UsageWindow, WindowTally>>;

export interface WindowLimits {
  /** Points of the window nightshift may use itself; 0 = no limit. */
  share: number;
  /** Account-wide utilization (%) at which nightshift stops starting work; 0 = no limit. */
  max: number;
}
export type UsageLimits = Record<UsageWindow, WindowLimits>;

export interface LimitHit {
  window: UsageWindow;
  reason: string;
  resetsAt: string | undefined;
}

/** The configured limits; `sessionShare` (from `--usage-share`) overrides `session_share`. */
export function usageLimits(usage: Config["usage"], sessionShare?: number): UsageLimits {
  return {
    five_hour: { share: sessionShare ?? usage.session_share, max: usage.session_max },
    seven_day: { share: usage.weekly_share, max: usage.weekly_max },
  };
}

export function limitsEnabled(limits: UsageLimits): boolean {
  return USAGE_WINDOWS.some((w) => limits[w].share > 0 || limits[w].max > 0);
}

/**
 * Reset times come back with sub-second jitter between calls, so two readings belong to the same
 * window when their reset times are within a few minutes of each other.
 */
const SAME_WINDOW_TOLERANCE_MS = 5 * 60_000;

export function sameWindow(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a === b;
  return Math.abs(ta - tb) < SAME_WINDOW_TOLERANCE_MS;
}

/** Points nightshift has used in the window the reading is in (0 once that window has reset). */
export function usedInWindow(
  tally: UsageTally,
  window: UsageWindow,
  reading: WindowReading,
): number {
  const entry = tally[window];
  return entry !== undefined && sameWindow(entry.resetsAt, reading.resetsAt) ? entry.used : 0;
}

/**
 * Adds what changed between two readings taken around (or during) one of nightshift's own steps to
 * the tally, and returns the points added per window.
 */
export function account(
  tally: UsageTally,
  before: UsageWindows,
  after: UsageWindows,
): Partial<Record<UsageWindow, number>> {
  const added: Partial<Record<UsageWindow, number>> = {};
  for (const window of USAGE_WINDOWS) {
    const a = after[window];
    if (a === undefined) continue;
    const b = before[window];
    // When the window reset during the step, everything in the new window happened since.
    const delta =
      b !== undefined && sameWindow(b.resetsAt, a.resetsAt)
        ? Math.max(0, a.utilization - b.utilization)
        : a.utilization;
    const entry = tally[window];
    const used = entry !== undefined && sameWindow(entry.resetsAt, a.resetsAt) ? entry.used : 0;
    tally[window] = { resetsAt: a.resetsAt, used: used + delta };
    added[window] = delta;
  }
  return added;
}

/** The first limit the reading is at or past, if any. */
export function limitHit(
  limits: UsageLimits,
  tally: UsageTally,
  windows: UsageWindows,
): LimitHit | undefined {
  for (const window of USAGE_WINDOWS) {
    const { share, max } = limits[window];
    if (share <= 0 && max <= 0) continue;
    const reading = windows[window];
    if (reading === undefined) continue;
    const label = WINDOW_LABEL[window];
    const key = window === "five_hour" ? "session" : "weekly";
    if (max > 0 && reading.utilization >= max) {
      return {
        window,
        resetsAt: reading.resetsAt,
        reason: `${label} usage is at ${reading.utilization}% (${key}_max = ${max})`,
      };
    }
    const used = usedInWindow(tally, window, reading);
    if (share > 0 && used >= share) {
      return {
        window,
        resetsAt: reading.resetsAt,
        reason: `nightshift used ${used} of its ${share}-point share of the ${label} window (${key}_share = ${share})`,
      };
    }
  }
  return undefined;
}

/** Windows that have a limit configured but are missing from the reading, so cannot be enforced. */
export function missingWindows(limits: UsageLimits, windows: UsageWindows): UsageWindow[] {
  return USAGE_WINDOWS.filter(
    (w) => (limits[w].share > 0 || limits[w].max > 0) && windows[w] === undefined,
  );
}

/** "17:00", or "Wed 11 Nov 22:00" when the time is not today. */
export function formatTime(iso: string | undefined, now: Date): string {
  if (iso === undefined) return "unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === now.toDateString()) return time;
  const day = date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  return `${day} ${time}`;
}

/** One line per window: account utilization, nightshift's share, and the reset time. */
export function describeUsage(
  windows: UsageWindows,
  tally: UsageTally,
  limits: UsageLimits,
  now: Date,
): string {
  const parts: string[] = [];
  for (const window of USAGE_WINDOWS) {
    const reading = windows[window];
    if (reading === undefined) continue;
    const { share, max } = limits[window];
    let text = `${WINDOW_LABEL[window]} ${reading.utilization}%`;
    if (max > 0) text += ` of max ${max}%`;
    if (share > 0) text += ` (nightshift ${usedInWindow(tally, window, reading)}/${share} points)`;
    text += ` · resets ${formatTime(reading.resetsAt, now)}`;
    parts.push(text);
  }
  return parts.length > 0 ? parts.join(" · ") : "no usage windows reported";
}

// ── reading usage from Claude Code ─────────────────────────────────────────

const REQUEST_ID = "nightshift-usage";
const READ_TIMEOUT_MS = 60_000;

/**
 * Asks Claude Code for the account's plan usage with a `get_usage` control request over
 * `--input-format stream-json`. No model turn runs, so it costs nothing. This control request is
 * not a documented API, so every failure is reported as unavailable rather than thrown.
 */
export class ClaudeUsageMeter implements UsageMeter {
  constructor(
    private readonly claudePath: string,
    private readonly cwd: string,
  ) {}

  async read(signal?: AbortSignal): Promise<UsageReading> {
    const request = {
      type: "control_request",
      request_id: REQUEST_ID,
      request: { subtype: "get_usage", skip_behaviors: true },
    };
    let result: Awaited<ReturnType<typeof exec>>;
    try {
      result = await exec(
        this.claudePath,
        [
          "-p",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose",
          "--no-session-persistence",
        ],
        {
          cwd: this.cwd,
          input: `${JSON.stringify(request)}\n`,
          timeoutMs: READ_TIMEOUT_MS,
          ...(signal === undefined ? {} : { signal }),
        },
      );
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
    if (result.aborted) return { ok: false, detail: "aborted" };
    if (result.timedOut) return { ok: false, detail: "claude did not answer within 60 s" };
    const parsed = parseUsageResponse(result.stdout);
    if (!parsed.ok && parsed.detail === NO_RESPONSE) {
      const output = tail((result.stderr || result.stdout).trim(), 500) || "(no output)";
      return { ok: false, detail: `claude exited ${String(result.code)}: ${output}` };
    }
    return parsed;
  }
}

const NO_RESPONSE = "no usage response";

/** Extracts the usage windows from Claude Code's stream-json output. */
export function parseUsageResponse(stdout: string): UsageReading {
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      continue;
    }
    const m = message as {
      type?: unknown;
      response?: { subtype?: unknown; request_id?: unknown; error?: unknown; response?: unknown };
    };
    if (m.type !== "control_response" || m.response?.request_id !== REQUEST_ID) continue;
    if (m.response.subtype !== "success") {
      return { ok: false, detail: `claude refused the usage request: ${String(m.response.error)}` };
    }
    const body = (m.response.response ?? {}) as {
      rate_limits_available?: unknown;
      rate_limits?: Record<string, unknown> | null;
      subscription_type?: unknown;
    };
    if (body.rate_limits_available !== true || body.rate_limits == null) {
      return {
        ok: false,
        detail:
          "this Claude login reports no plan usage limits (API-key logins have no 5-hour or weekly windows)",
      };
    }
    const windows: UsageWindows = {};
    for (const window of USAGE_WINDOWS) {
      const raw = body.rate_limits[window] as
        | { utilization?: unknown; resets_at?: unknown }
        | null
        | undefined;
      if (raw == null || typeof raw.utilization !== "number" || !Number.isFinite(raw.utilization)) {
        continue;
      }
      windows[window] = {
        utilization: raw.utilization,
        resetsAt: typeof raw.resets_at === "string" ? raw.resets_at : undefined,
      };
    }
    return {
      ok: true,
      windows,
      ...(typeof body.subscription_type === "string" ? { plan: body.subscription_type } : {}),
    };
  }
  return { ok: false, detail: NO_RESPONSE };
}
