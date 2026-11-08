import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { UsageWindows, WindowReading } from "./ports.js";
import { isActive, nextStart, type TimeRange } from "./schedule.js";
import {
  formatTime,
  limitsEnabled,
  USAGE_WINDOWS,
  type UsageLimits,
  type UsageTally,
  type UsageWindow,
  usedInWindow,
  WINDOW_LABEL,
} from "./usage.js";

/**
 * Forecasts from history: what a typical item costs in plan usage, time and money, estimated from
 * the `item_done` events of this run and earlier ones, and whether the next item fits in what is
 * left of the usage share and the active hours. Everything here but `readHistory` is pure.
 */

/** Fewer finished items than this, and there is no estimate (and nothing is held back). */
export const MIN_FORECAST_ITEMS = 3;
/** Only the most recent items count, so the estimate follows the work as it changes. */
export const FORECAST_RECENT_ITEMS = 20;

/** One finished item, as history remembers it. */
export interface ItemSample {
  /** When it finished (ISO). */
  at: string;
  /** Points of each window it used; undefined when usage was not measured in its run. */
  points: Partial<Record<UsageWindow, number>> | undefined;
  /** Time it was being worked on, without usage/schedule waits and pauses; undefined if unknown. */
  activeMs: number | undefined;
  costUsd: number | undefined;
}

export interface Stat {
  value: number;
  /** How many items it is based on. */
  n: number;
}

export interface ItemEstimate {
  /** Recent finished items looked at (some may lack a metric). */
  items: number;
  /** "median", or "p75" etc. */
  statistic: string;
  /** Present only when based on at least MIN_FORECAST_ITEMS items. */
  points: Partial<Record<UsageWindow, Stat>>;
  activeMs: Stat | undefined;
  costUsd: Stat | undefined;
}

// ── history ─────────────────────────────────────────────────────────────

type Event = Record<string, unknown>;

const WAIT_EVENTS = new Set(["usage_wait", "schedule_wait", "forecast_wait"]);
const STOP_EVENTS = new Set(["halted", "paused", "blocked", "done"]);

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timeOf(event: Event): number | undefined {
  const t = typeof event.at === "string" ? Date.parse(event.at) : Number.NaN;
  return Number.isNaN(t) ? undefined : t;
}

function readPoints(value: unknown): Partial<Record<UsageWindow, number>> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const points: Partial<Record<UsageWindow, number>> = {};
  for (const window of USAGE_WINDOWS) {
    const p = finite((value as Record<string, unknown>)[window]);
    if (p !== undefined) points[window] = Math.max(0, p);
  }
  return points;
}

/**
 * The finished items of one run, from its events in journal order. Items recorded by nightshift
 * 0.3.0 lack `usagePoints` and `activeMs` in `item_done`: their points are the sum of the item's
 * `usage` events, and their active time is reconstructed from event times, leaving out usage and
 * schedule waits and the time between a halt and the next invocation.
 */
export function samplesFromEvents(events: readonly Event[]): ItemSample[] {
  const measured = events.some((e) => e.type === "usage");
  const pointsByItem = new Map<number, Partial<Record<UsageWindow, number>>>();
  const samples: ItemSample[] = [];
  let active = 0;
  let running = false;
  let last: number | undefined;
  let waitUntil: number | undefined;

  for (const event of events) {
    const t = timeOf(event);
    if (t !== undefined && last !== undefined && running && t > last) {
      const waited = waitUntil === undefined ? 0 : Math.max(0, Math.min(t, waitUntil) - last);
      active += t - last - waited;
    }
    if (t !== undefined) last = t;
    waitUntil = undefined;

    const type = event.type;
    if (type === "invocation_start") {
      running = true;
    } else if (STOP_EVENTS.has(String(type))) {
      running = false;
    } else if (WAIT_EVENTS.has(String(type))) {
      const until = typeof event.until === "string" ? Date.parse(event.until) : Number.NaN;
      if (!Number.isNaN(until)) waitUntil = until;
    } else if (type === "usage") {
      const index = finite(event.item);
      const points = readPoints(event.points);
      if (index === undefined || points === undefined) continue;
      const sum = pointsByItem.get(index) ?? {};
      for (const window of USAGE_WINDOWS) {
        const p = points[window];
        if (p !== undefined) sum[window] = (sum[window] ?? 0) + p;
      }
      pointsByItem.set(index, sum);
    } else if (type === "item_done") {
      if (typeof event.at !== "string") continue;
      const index = finite(event.item);
      const explicitPoints = readPoints(event.usagePoints);
      const reconstructed =
        measured && index !== undefined ? (pointsByItem.get(index) ?? {}) : undefined;
      const points = explicitPoints ?? reconstructed;
      const explicitActive = finite(event.activeMs);
      samples.push({
        at: event.at,
        points:
          points === undefined
            ? undefined
            : Object.fromEntries(USAGE_WINDOWS.map((w) => [w, points[w] ?? 0])),
        activeMs: explicitActive ?? (t === undefined ? undefined : active),
        costUsd: finite(event.costUsd),
      });
      active = 0; // the next item starts now
    }
  }
  return samples;
}

/** Every finished item in `<dir>/runs/<run>/events.jsonl`, oldest first. Unreadable runs are skipped. */
export async function readHistory(nightshiftDir: string): Promise<ItemSample[]> {
  const runsDir = path.join(nightshiftDir, "runs");
  let runs: string[];
  try {
    runs = await readdir(runsDir);
  } catch {
    return [];
  }
  const samples: ItemSample[] = [];
  for (const run of runs) {
    let text: string;
    try {
      text = await readFile(path.join(runsDir, run, "events.jsonl"), "utf8");
    } catch {
      continue;
    }
    const events: Event[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === "object" && parsed !== null) events.push(parsed as Event);
      } catch {
        // a line cut short by a crash; the rest of the journal is still good
      }
    }
    samples.push(...samplesFromEvents(events));
  }
  return samples.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// ── estimation ──────────────────────────────────────────────────────────

/** The p-th percentile (0–100) with linear interpolation between ranks; undefined when empty. */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const a = sorted[low] as number;
  const b = sorted[high] as number;
  return a + (b - a) * (rank - low);
}

export function statisticName(p: number): string {
  return p === 50 ? "median" : `p${p}`;
}

/** A typical item, from the most recent finished ones (`samples` oldest first). */
export function estimateItem(
  samples: readonly ItemSample[],
  pct = 50,
  recent = FORECAST_RECENT_ITEMS,
): ItemEstimate {
  const window = samples.slice(-recent);
  const stat = (values: number[]): Stat | undefined => {
    if (values.length < MIN_FORECAST_ITEMS) return undefined;
    const value = percentile(values, pct);
    return value === undefined ? undefined : { value, n: values.length };
  };
  const points: Partial<Record<UsageWindow, Stat>> = {};
  for (const w of USAGE_WINDOWS) {
    const s = stat(window.flatMap((x) => (x.points?.[w] === undefined ? [] : [x.points[w]])));
    if (s !== undefined) points[w] = s;
  }
  return {
    items: window.length,
    statistic: statisticName(pct),
    points,
    activeMs: stat(window.flatMap((x) => (x.activeMs === undefined ? [] : [x.activeMs]))),
    costUsd: stat(window.flatMap((x) => (x.costUsd === undefined ? [] : [x.costUsd]))),
  };
}

function basis(estimate: ItemEstimate, stat: Stat): string {
  return `${estimate.statistic} of ${stat.n} item${stat.n === 1 ? "" : "s"}`;
}

/** Whether there is anything to forecast with. */
export function hasEstimate(estimate: ItemEstimate): boolean {
  return Object.keys(estimate.points).length > 0 || estimate.activeMs !== undefined;
}

function notEnough(estimate: ItemEstimate): string {
  return `not enough history to forecast yet (${estimate.items} finished item${estimate.items === 1 ? "" : "s"}; need ${MIN_FORECAST_ITEMS})`;
}

// ── active hours ────────────────────────────────────────────────────────

function minutesOf(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function contains(range: TimeRange, minutes: number): boolean {
  return range.start < range.end
    ? minutes >= range.start && minutes < range.end
    : minutes >= range.start || minutes < range.end;
}

/**
 * When the active hours that `at` is inside end, following ranges that touch ("22:00-24:00" then
 * "00:00-06:00" ends at 06:00). Undefined when they never end, or when `at` is outside them.
 */
export function activeUntil(ranges: readonly TimeRange[], at: Date): Date | undefined {
  if (ranges.length === 0) return undefined;
  let t = new Date(at);
  // Each pass moves to the end of one range; more passes than ranges means they cover the clock.
  for (let pass = 0; pass <= ranges.length + 1; pass++) {
    const minutes = minutesOf(t);
    const range = ranges.find((r) => contains(r, minutes));
    if (range === undefined) return pass === 0 ? undefined : t;
    const end = new Date(t);
    end.setHours(Math.floor(range.end / 60), range.end % 60, 0, 0);
    if (end.getTime() <= t.getTime()) end.setDate(end.getDate() + 1);
    t = end;
  }
  return undefined;
}

/** The longest stretch of active hours (ms) starting from any range's start; Infinity if endless. */
export function longestActiveMs(ranges: readonly TimeRange[], ref: Date): number {
  let longest = 0;
  for (const range of ranges) {
    const start = new Date(ref);
    start.setHours(Math.floor(range.start / 60), range.start % 60, 0, 0);
    const end = activeUntil(ranges, start);
    if (end === undefined) return Number.POSITIVE_INFINITY;
    longest = Math.max(longest, end.getTime() - start.getTime());
  }
  return longest;
}

// ── formatting ──────────────────────────────────────────────────────────

export function formatPointsValue(points: number): string {
  return points >= 10 ? String(Math.round(points)) : String(Math.round(points * 10) / 10);
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function itemsWord(n: number): string {
  return `${n} item${n === 1 ? "" : "s"}`;
}

// ── the next item ───────────────────────────────────────────────────────

export interface ForecastContext {
  estimate: ItemEstimate;
  limits: UsageLimits;
  tally: UsageTally;
  /** The latest usage reading; undefined when usage is not read. */
  windows: UsageWindows | undefined;
  ranges: readonly TimeRange[];
  now: Date;
}

/** A reading whose window has already reset counts as a fresh, empty window. */
function current(reading: WindowReading, now: Date): { reading: WindowReading; fresh: boolean } {
  const resets = reading.resetsAt === undefined ? Number.NaN : Date.parse(reading.resetsAt);
  if (!Number.isNaN(resets) && resets <= now.getTime()) {
    return { reading: { utilization: 0, resetsAt: undefined }, fresh: true };
  }
  return { reading, fresh: false };
}

interface Room {
  /** Points an item may still use in this window. */
  left: number;
  /** Points the most an item can ever get in a fresh window. */
  full: number;
  /** Which limit sets `left`, for messages. */
  what: string;
}

/** Room left in a window under its limits and under the plan's own 100%. */
function roomIn(
  window: UsageWindow,
  ctx: ForecastContext,
  reading: WindowReading,
  fresh: boolean,
): Room {
  const { share, max } = ctx.limits[window];
  const key = window === "five_hour" ? "session" : "weekly";
  const rooms: Room[] = [];
  if (share > 0) {
    const used = fresh ? 0 : usedInWindow(ctx.tally, window, reading);
    rooms.push({
      left: share - used,
      full: share,
      what: `${formatPointsValue(Math.max(0, share - used))} of nightshift's ${share}-point share left (${key}_share = ${share})`,
    });
  }
  if (max > 0) {
    rooms.push({
      left: max - reading.utilization,
      full: max,
      what: `usage is at ${formatPointsValue(reading.utilization)}% (${key}_max = ${max})`,
    });
  }
  // The plan itself stops at 100%, whatever share is left.
  rooms.push({
    left: 100 - reading.utilization,
    full: 100,
    what: `the account's ${WINDOW_LABEL[window]} usage is at ${formatPointsValue(reading.utilization)}%`,
  });
  return rooms.reduce((a, b) => (b.left < a.left ? b : a));
}

export type StartDecision =
  | { start: true; reason: string }
  | {
      start: false;
      kind: "usage";
      window: UsageWindow;
      reason: string;
      /** When the window resets (ISO), if known. */
      until: string | undefined;
    }
  | { start: false; kind: "schedule"; reason: string; until: Date };

/**
 * Whether a new item should start now: it should not when a typical item would not fit in what is
 * left of a usage window's limits, or in what is left of the active hours. An item that could
 * never fit (it needs more than a whole window's share, or more than the longest stretch of active
 * hours) starts anyway, since waiting would not help. Without enough history, it starts.
 */
export function decideStart(ctx: ForecastContext): StartDecision {
  const { estimate, now } = ctx;
  if (!hasEstimate(estimate)) return { start: true, reason: notEnough(estimate) };
  const blocks: Exclude<StartDecision, { start: true }>[] = [];
  const fits: string[] = [];
  const anyway: string[] = [];

  for (const window of USAGE_WINDOWS) {
    const { share, max } = ctx.limits[window];
    const stat = estimate.points[window];
    const raw = ctx.windows?.[window];
    if ((share <= 0 && max <= 0) || stat === undefined || raw === undefined) continue;
    const { reading, fresh } = current(raw, now);
    const room = roomIn(window, ctx, reading, fresh);
    const need = `a typical item uses ~${formatPointsValue(stat.value)} points of the ${WINDOW_LABEL[window]} window (${basis(estimate, stat)})`;
    if (stat.value <= room.left) {
      fits.push(
        `~${formatPointsValue(stat.value)} of the ${formatPointsValue(room.left)} points left in the ${WINDOW_LABEL[window]} window`,
      );
    } else if (stat.value > room.full) {
      anyway.push(`${need}, more than a whole window allows; starting anyway`);
    } else {
      blocks.push({
        start: false,
        kind: "usage",
        window,
        until: reading.resetsAt,
        reason: `${need}, but ${room.what}`,
      });
    }
  }

  const duration = estimate.activeMs;
  if (ctx.ranges.length > 0 && duration !== undefined && isActive(ctx.ranges, now)) {
    const end = activeUntil(ctx.ranges, now);
    const need = `a typical item takes ~${formatDuration(duration.value)} (${basis(estimate, duration)})`;
    if (end !== undefined) {
      const left = end.getTime() - now.getTime();
      if (duration.value <= left) {
        fits.push(
          `~${formatDuration(duration.value)} of ${formatDuration(left)} active hours left`,
        );
      } else if (duration.value > longestActiveMs(ctx.ranges, now)) {
        anyway.push(`${need}, longer than the active hours; starting anyway`);
      } else {
        blocks.push({
          start: false,
          kind: "schedule",
          until: nextStart(ctx.ranges, end),
          reason: `${need}, but active hours end ${formatTime(end.toISOString(), now)}, in ${formatDuration(left)}`,
        });
      }
    }
  }

  if (blocks.length > 0) {
    // Wait for whichever reason lasts longest: waiting for an earlier one would only wake up to
    // wait again.
    const until = (b: (typeof blocks)[number]): number =>
      b.kind === "schedule"
        ? b.until.getTime()
        : b.until === undefined
          ? 0
          : Date.parse(b.until) || 0;
    return blocks.reduce((a, b) => (until(b) > until(a) ? b : a));
  }
  const parts = [...anyway];
  if (fits.length > 0) parts.push(`the next item fits: ${fits.join(", ")}`);
  if (parts.length === 0) parts.push("no limits or active hours to fit the next item into");
  return { start: true, reason: parts.join("; ") };
}

/**
 * Human lines for `status` and `doctor`: what a typical item uses, and how many more fit in the
 * current usage windows and the active hours.
 */
export function describeForecast(ctx: ForecastContext): string[] {
  const { estimate, now } = ctx;
  if (!hasEstimate(estimate)) return [notEnough(estimate)];
  const lines: string[] = [];
  const typical: string[] = [];
  for (const window of USAGE_WINDOWS) {
    const stat = estimate.points[window];
    if (stat !== undefined) {
      typical.push(
        `~${formatPointsValue(stat.value)} points of the ${WINDOW_LABEL[window]} window`,
      );
    }
  }
  if (estimate.activeMs !== undefined) typical.push(`~${formatDuration(estimate.activeMs.value)}`);
  if (estimate.costUsd !== undefined) typical.push(`~$${estimate.costUsd.value.toFixed(2)}`);
  const ns = [
    ...Object.values(estimate.points).map((s) => s.n),
    estimate.activeMs?.n ?? 0,
    estimate.costUsd?.n ?? 0,
  ];
  lines.push(
    `a typical item: ${typical.join(", ")} (${estimate.statistic} of the last ${itemsWord(Math.max(...ns))})`,
  );

  const limited = limitsEnabled(ctx.limits);
  for (const window of USAGE_WINDOWS) {
    const stat = estimate.points[window];
    const raw = ctx.windows?.[window];
    if (stat === undefined || raw === undefined) continue;
    const { share, max } = ctx.limits[window];
    // Without limits, only the 5-hour window is worth a line.
    if (share <= 0 && max <= 0 && (limited || window !== "five_hour")) continue;
    const { reading, fresh } = current(raw, now);
    const room = roomIn(window, ctx, reading, fresh);
    const n = stat.value > 0 ? Math.max(0, Math.floor(room.left / stat.value)) : undefined;
    const resets =
      reading.resetsAt === undefined ? "" : ` (resets ${formatTime(reading.resetsAt, now)})`;
    lines.push(
      n === undefined
        ? `items use no measurable ${WINDOW_LABEL[window]} usage${resets}`
        : `~${n} more item${n === 1 ? "" : "s"} fit in this ${WINDOW_LABEL[window]} window${resets} at ~${formatPointsValue(stat.value)} points each (${basis(estimate, stat)})`,
    );
  }

  const duration = estimate.activeMs;
  if (ctx.ranges.length > 0 && duration !== undefined && duration.value > 0) {
    const inside = isActive(ctx.ranges, now);
    const from = inside ? now : nextStart(ctx.ranges, now);
    const end = activeUntil(ctx.ranges, from);
    const of = `~${formatDuration(duration.value)} (${basis(estimate, duration)})`;
    if (end === undefined) {
      lines.push(`active hours never end; a typical item takes ${of}`);
    } else {
      const n = Math.floor((end.getTime() - from.getTime()) / duration.value);
      const endText = formatTime(end.toISOString(), now);
      lines.push(
        inside
          ? `active hours end ${endText} — ~${itemsWord(n)} of ${of}`
          : `active hours start ${formatTime(from.toISOString(), now)} and end ${endText} — ~${itemsWord(n)} of ${of}`,
      );
    }
  }
  return lines;
}
