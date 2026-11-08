import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import { STOP_FILE } from "./host.js";
import {
  lockHolder,
  PROGRESS_FILE,
  PROGRESS_ROTATED_FILE,
  type ProgressEntry,
  type RunState,
  StateStore,
} from "./state.js";
import {
  formatTime,
  limitsEnabled,
  USAGE_WINDOWS,
  type UsageLimits,
  type UsageWindow,
  usageLimits,
  usedInWindow,
  WINDOW_LABEL,
} from "./usage.js";

/**
 * `nightshift watch`: a live view of a run driven by another process. Everything it shows comes
 * from files (state.json, the run's events.jsonl and progress.jsonl, the lock and the STOP file),
 * so it never interferes with the run. Rendering is a pure function of what was read and the clock.
 */

/** A line of a run's events.jsonl. */
export interface WatchEvent {
  at: string;
  type: string;
  [field: string]: unknown;
}

/** Everything one frame shows. */
export interface WatchView {
  state: RunState | undefined;
  /** The pid of the live process holding the run's lock, if any. */
  holder: number | undefined;
  /** A STOP file is waiting for the driving process. */
  stopRequested: boolean;
  /** The run's events, oldest first (only the last few are shown). */
  events: WatchEvent[];
  /** The run's latest tool calls, oldest first (only the last few are shown). */
  progress: ProgressEntry[];
  limits: UsageLimits;
  /** Why the last read of state.json failed, if it did. */
  error?: string;
}

export interface RenderOptions {
  now: Date;
  /** Terminal columns: every line is cut to fit, never wrapped. */
  width: number;
  /** Terminal rows: the tool-call and event lists shrink to fit. Unlimited when omitted. */
  height?: number;
  color: boolean;
  /** A last line, e.g. the keys that work. */
  footer?: string;
}

export const MAX_TOOL_LINES = 8;
export const MAX_EVENT_LINES = 10;

// ── text that fits ─────────────────────────────────────────────────────────

type Style = "bold" | "dim" | "red" | "green" | "yellow" | "cyan" | "magenta";
type Segment = readonly [text: string, style?: Style];
type Line = Segment[];

const SGR: Record<Style, string> = {
  bold: "1",
  dim: "2",
  red: "31",
  green: "32",
  yellow: "33",
  cyan: "36",
  magenta: "35",
};

/** Control characters (newlines, ESC…) from Claude's tool input must not reach the terminal. */
export function sanitize(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
}

/** Columns a code point takes in a terminal: 0 for combining marks, 2 for wide (CJK, emoji). */
export function charWidth(cp: number): number {
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0x20e3
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function textWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch.codePointAt(0) ?? 0);
  return width;
}

/** Joins the segments into one terminal line at most `width` columns wide, ending in "…" if cut. */
function fitLine(line: Line, width: number, color: boolean): string {
  const total = line.reduce((sum, [text]) => sum + textWidth(sanitize(text)), 0);
  let room = total <= width ? width : Math.max(0, width - 1);
  let out = "";
  for (const [raw, style] of line) {
    if (room <= 0) break;
    let piece = "";
    for (const ch of sanitize(raw)) {
      const w = charWidth(ch.codePointAt(0) ?? 0);
      if (w > room) {
        room = 0;
        break;
      }
      piece += ch;
      room -= w;
    }
    if (piece === "") continue;
    out += color && style ? `\x1b[${SGR[style]}m${piece}\x1b[0m` : piece;
  }
  if (total > width && width > 0) out += "…";
  return out;
}

// ── formatting ─────────────────────────────────────────────────────────────

/** "45s", "12m 03s", "2h 05m", "3d 4h". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Local "HH:MM:SS". */
export function clock(iso: string | Date): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function since(iso: string | undefined, now: Date): string {
  if (iso === undefined) return "?";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "?" : formatDuration(now.getTime() - t);
}

function until(iso: string | undefined, now: Date): string {
  if (iso === undefined) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const left = t - now.getTime();
  return left <= 0 ? " (due now)" : ` (in ${formatDuration(left)})`;
}

const money = (usd: number) => `$${usd.toFixed(2)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

/** One line about an event, and the colour it deserves. */
export function describeEvent(event: WatchEvent): { text: string; style?: Style } {
  const item = event.item === undefined ? "" : `item ${str(event.item)} · `;
  switch (event.type) {
    case "invocation_start":
      return { text: `${item}started (phase ${str(event.phase)})`, style: "cyan" };
    case "agent": {
      const cost = typeof event.costUsd === "number" ? ` · ${money(event.costUsd)}` : "";
      const ok = event.outcome === "success";
      return {
        text: `${item}${str(event.step)} → ${str(event.outcome)}${cost}`,
        ...(ok ? {} : { style: "yellow" as const }),
      };
    }
    case "pr_opened":
      return { text: `${item}opened ${str(event.pr)}`, style: "cyan" };
    case "review": {
      const how = event.timedOut === true ? "timed out" : `exit ${str(event.exitCode)}`;
      return {
        text: `${item}review round ${str(event.round)} (${how})`,
        ...(event.exitCode === 0 ? {} : { style: "yellow" as const }),
      };
    }
    case "merged": {
      const sha = typeof event.sha === "string" ? ` as ${event.sha.slice(0, 7)}` : "";
      return { text: `${item}merged ${str(event.pr)}${sha}`, style: "green" };
    }
    case "auto_merge":
      return { text: `${item}auto-merge on: ${str(event.reason)}` };
    case "item_done":
      return { text: `${item}done${event.label ? ` — ${str(event.label)}` : ""}`, style: "green" };
    case "usage": {
      const points = (event.points ?? {}) as Partial<Record<UsageWindow, number>>;
      const used = USAGE_WINDOWS.filter((w) => typeof points[w] === "number")
        .map((w) => `${WINDOW_LABEL[w]} +${round2(points[w] as number)}`)
        .join(" ");
      return { text: `${item}${str(event.step)} used ${used || "no measurable"} points` };
    }
    case "usage_cut":
      return { text: `${item}${str(event.step)} stopped: ${str(event.reason)}`, style: "yellow" };
    case "usage_wait":
    case "schedule_wait":
      return {
        text: `waiting until ${clock(str(event.until))}: ${str(event.reason)}`,
        style: "yellow",
      };
    case "halted":
    case "blocked":
      return { text: `${event.type}: ${str(event.reason)}`, style: "red" };
    case "paused":
      return { text: `paused: ${str(event.reason)}`, style: "yellow" };
    case "done":
      return {
        text: `run done: ${str(event.reason)} (${str(event.itemsCompleted)} item(s))`,
        style: "green",
      };
    default: {
      const { at: _at, type, ...rest } = event;
      const fields = Object.entries(rest)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      return { text: `${type}${fields ? ` ${fields}` : ""}` };
    }
  }
}

export function describeProgress(entry: ProgressEntry): string {
  return `${entry.step} · ${entry.tool}${entry.detail ? ` ${entry.detail}` : ""}`;
}

// ── the frame ──────────────────────────────────────────────────────────────

/** Cells of a usage bar: █ nightshift's points, ▓ the rest of the account, │ the max limit. */
function usageBar(utilization: number, used: number, max: number, width: number): Line {
  const cells = (pct: number) => Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
  const total = cells(utilization);
  const mine = Math.min(total, cells(used));
  const marker = max > 0 ? Math.min(width - 1, cells(max)) : -1;
  const line: Line = [];
  const push = (ch: string, style: Style) => {
    const last = line[line.length - 1];
    if (last !== undefined && last[1] === style) line[line.length - 1] = [last[0] + ch, style];
    else line.push([ch, style]);
  };
  for (let i = 0; i < width; i++) {
    if (i === marker && i >= total) push("│", "red");
    else if (i < total - mine) push("▓", "cyan");
    else if (i < total) push("█", "magenta");
    else push("░", "dim");
  }
  return line;
}

function statusLine(view: WatchView, state: RunState): Line {
  const line: Line = [["run ", "bold"], [state.runId, "bold"], [" · "]];
  const reason = state.haltReason ? `: ${state.haltReason}` : "";
  if (state.status === "running") {
    if (view.holder !== undefined) {
      line.push(["running", "green"], [` · pid ${view.holder}`]);
      if (view.stopRequested) line.push([" · stop requested", "yellow"]);
    } else {
      line.push(
        ["not running", "red"],
        [" — state.json says running, but no process holds the lock (killed?); "],
        ["`nightshift resume` continues"],
      );
    }
    return line;
  }
  line.push([state.status, state.status === "done" ? "green" : "red"], [reason]);
  if (view.holder !== undefined) line.push([` · pid ${view.holder} holds the lock`]);
  return line;
}

/** The screen for one moment: a list of lines, each at most `width` columns. */
export function renderWatch(view: WatchView, options: RenderOptions): string[] {
  const { now, color } = options;
  const width = Math.max(1, Math.floor(options.width));
  const head: Line[] = [];
  const header: Line = [
    ["nightshift watch", "bold"],
    [` · ${clock(now)}`, "dim"],
  ];
  if (view.error !== undefined) header.push([` · could not read state: ${view.error}`, "red"]);
  head.push(header);

  const state = view.state;
  let tools: Line[] = [];
  const tail: Line[] = [];
  if (state === undefined) {
    head.push([
      ["no run yet", "dim"],
      [" — this view follows the next one when it starts", "dim"],
    ]);
    if (view.holder !== undefined)
      head.push([[`pid ${view.holder} holds the lock (starting a run?)`]]);
  } else {
    const alive = view.holder !== undefined;
    head.push(statusLine(view, state));
    head.push([
      [
        `started ${formatTime(state.startedAt, now)} (${since(state.startedAt, now)} ago) · items completed ${state.itemsCompleted}`,
        "dim",
      ],
    ]);

    const item = state.item;
    if (item === undefined) {
      head.push([["no current item", "dim"]]);
    } else {
      const rounds = [
        item.reviewRound > 0 ? `review round ${item.reviewRound}` : "",
        item.fixRound > 0 ? `fix round ${item.fixRound}` : "",
        item.conflictRound > 0 ? `conflict round ${item.conflictRound}` : "",
      ].filter(Boolean);
      head.push([
        [`item ${item.index}`, "bold"],
        [item.label ? ` — ${item.label}` : ""],
        [` · repo ${item.repo} · phase `],
        [item.phase, "cyan"],
        [rounds.length > 0 ? ` · ${rounds.join(" · ")}` : ""],
      ]);
      if (item.pr) head.push([[`PR #${item.pr.number} `], [item.pr.url, "cyan"]]);
      if (item.pendingQuestion) {
        head.push([
          ["needs an answer: ", "yellow"],
          [item.pendingQuestion],
          [' — nightshift resume --answer "…"', "dim"],
        ]);
      }
      const activity = item.activity;
      if (activity !== undefined && alive) {
        const last =
          activity.lastAt === undefined ? "" : ` · last call ${since(activity.lastAt, now)} ago`;
        head.push([
          ["step ", "bold"],
          [activity.step, "cyan"],
          [` · running ${since(activity.since, now)} · ${activity.tools} tool call(s)${last}`],
        ]);
      } else if (activity !== undefined) {
        head.push([
          [
            `step ${activity.step} was running when the process stopped (${activity.tools} tool call(s))`,
            "dim",
          ],
        ]);
      } else if (alive && state.status === "running") {
        head.push([["no Claude step running", "dim"]]);
      }
    }

    tools = view.progress.map((entry) => [
      [`  ${clock(entry.at)}  `, "dim"],
      [describeProgress(entry)],
    ]);

    const usagePoints = state.usage?.points?.five_hour;
    tail.push([
      ["cost ", "bold"],
      [`${money(state.costUsd)} run`],
      [item ? ` · ${money(item.costUsd)} item ${item.index}` : ""],
      [
        usagePoints !== undefined && usagePoints > 0
          ? ` · ${round2(usagePoints)} points of 5-hour usage`
          : "",
      ],
    ]);

    tail.push(...usageLines(state, view.limits, now, width));

    if (state.waiting !== undefined && alive) {
      tail.push([
        [`waiting until ${formatTime(state.waiting.until, now)}`, "yellow"],
        [until(state.waiting.until, now), "yellow"],
        [`: ${state.waiting.reason}`],
      ]);
    }
  }

  const events: Line[] = view.events.map((event) => {
    const { text, style } = describeEvent(event);
    return [[`  ${clock(event.at)}  `, "dim"], style ? [text, style] : [text]];
  });

  // Fit the two lists into the rows left; each keeps its newest lines.
  const footer: Line[] = options.footer === undefined ? [] : [[[options.footer, "dim"]]];
  const toolsHeader = tools.length > 0 ? 1 : 0;
  const fixed = head.length + tail.length + footer.length + toolsHeader + 1;
  let budget =
    options.height === undefined ? Number.POSITIVE_INFINITY : Math.max(0, options.height - fixed);
  let toolCount = 0;
  let eventCount = 0;
  const toolMax = Math.min(MAX_TOOL_LINES, tools.length);
  const eventMax = Math.min(MAX_EVENT_LINES, events.length);
  while (budget > 0 && (toolCount < toolMax || eventCount < eventMax)) {
    if (eventCount < eventMax) {
      eventCount += 1;
      budget -= 1;
    }
    if (budget > 0 && toolCount < toolMax) {
      toolCount += 1;
      budget -= 1;
    }
  }

  const lines: Line[] = [...head];
  if (toolsHeader) {
    lines.push([["recent tool calls", "bold"]], ...tools.slice(tools.length - toolCount));
  }
  lines.push(...tail);
  lines.push(
    events.length > 0
      ? [["events", "bold"]]
      : [
          ["events: ", "bold"],
          ["none yet", "dim"],
        ],
    ...events.slice(events.length - eventCount),
  );
  lines.push(...footer);
  const cut = options.height === undefined ? lines : lines.slice(0, Math.max(0, options.height));
  return cut.map((line) => fitLine(line, width, color));
}

function usageLines(state: RunState, limits: UsageLimits, now: Date, width: number): Line[] {
  const usage = state.usage;
  const last = usage?.last;
  if (last === undefined) {
    return [
      [
        ["usage ", "bold"],
        [limitsEnabled(limits) ? "not read yet" : "not measured (no [usage] limits)", "dim"],
      ],
    ];
  }
  const lines: Line[] = [
    [
      ["usage ", "bold"],
      [`read ${formatTime(last.at, now)} (${since(last.at, now)} ago) · `, "dim"],
      ["█", "magenta"],
      [" nightshift ", "dim"],
      ["▓", "cyan"],
      [" other sessions (points)", "dim"],
    ],
  ];
  // Narrow terminals get a shorter bar first, so the numbers and the reset time still fit.
  const barWidth = width < 40 ? 0 : Math.min(30, Math.max(10, width - 70));
  let any = false;
  for (const window of USAGE_WINDOWS) {
    const reading = last.windows[window];
    if (reading === undefined) continue;
    any = true;
    const { share, max } = limits[window];
    const used = round2(usedInWindow(usage?.tally ?? {}, window, reading));
    const line: Line = [[`  ${WINDOW_LABEL[window].padEnd(7)}`]];
    if (barWidth > 0) line.push(...usageBar(reading.utilization, used, max, barWidth), [" "]);
    line.push([`${reading.utilization}%`, max > 0 && reading.utilization >= max ? "red" : "bold"]);
    line.push([
      ` · nightshift ${used}${share > 0 ? `/${share}` : ""}`,
      share > 0 && used >= share ? "red" : undefined,
    ] as Segment);
    if (max > 0) line.push([` · max ${max}%`]);
    line.push([` · resets ${formatTime(reading.resetsAt, now)}${until(reading.resetsAt, now)}`]);
    lines.push(line);
  }
  if (!any) lines.push([["  no usage windows reported", "dim"]]);
  return lines;
}

/** A one-line summary for line-by-line output; printed again whenever it changes. */
export function summarize(view: WatchView): string {
  const state = view.state;
  if (state === undefined) return "no run yet";
  const alive = view.holder !== undefined;
  const parts = [`run ${state.runId}`];
  if (state.status === "running")
    parts.push(
      alive
        ? `running (pid ${view.holder})`
        : "not running (process gone; `nightshift resume` continues)",
    );
  else parts.push(`${state.status}${state.haltReason ? `: ${state.haltReason}` : ""}`);
  const item = state.item;
  if (item) {
    parts.push(`item ${item.index}${item.label ? ` — ${item.label}` : ""}`, `phase ${item.phase}`);
    if (item.pr) parts.push(item.pr.url);
    if (item.activity && alive) parts.push(`step ${item.activity.step}`);
    if (item.pendingQuestion) parts.push(`needs an answer: ${item.pendingQuestion}`);
  }
  if (state.waiting && alive)
    parts.push(`waiting until ${state.waiting.until}: ${state.waiting.reason}`);
  if (alive && view.stopRequested) parts.push("stop requested");
  return sanitize(parts.join(" · "));
}

// ── reading the files ──────────────────────────────────────────────────────

const INITIAL_TAIL_BYTES = 64 * 1024;

async function readRange(file: string, start: number, end: number): Promise<Buffer> {
  if (end <= start) return Buffer.alloc(0);
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(end - start);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, start + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read);
  } finally {
    await handle.close();
  }
}

async function statOrUndefined(file: string) {
  try {
    return await stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Follows a JSON-lines file like `tail -f`: the first read returns what is in its last
 * `initialBytes`, later reads return only complete lines appended since. When the file is
 * replaced (a rotation renames it to `rotated`), the rest of the old file is read from there.
 */
export class JsonlFollower {
  private ino: number | undefined;
  private offset = 0;
  private rest: Buffer = Buffer.alloc(0);
  private started = false;

  constructor(
    readonly file: string,
    private readonly rotated?: string,
    private readonly initialBytes = INITIAL_TAIL_BYTES,
  ) {}

  async read(): Promise<unknown[]> {
    const chunks: Buffer[] = [];
    const current = await statOrUndefined(this.file);
    if (!this.started) {
      this.started = true;
      const size = current?.size ?? 0;
      let skipPartial = false;
      // Right after a rotation the new file is short: take the older lines from the rotated one.
      if (size < this.initialBytes && this.rotated !== undefined) {
        const old = await statOrUndefined(this.rotated);
        if (old !== undefined && old.size > 0) {
          const from = Math.max(0, old.size - (this.initialBytes - size));
          chunks.push(await readRange(this.rotated, from, old.size));
          skipPartial = from > 0;
        }
      }
      const from = Math.max(0, size - this.initialBytes);
      if (current !== undefined) chunks.push(await readRange(this.file, from, size));
      skipPartial ||= from > 0;
      this.ino = current?.ino;
      this.offset = size;
      return this.parse(Buffer.concat(chunks), skipPartial);
    }

    if (this.ino !== undefined && (current === undefined || current.ino !== this.ino)) {
      // The file we were reading was rotated or replaced: finish it, then start the new one.
      const old = this.rotated === undefined ? undefined : await statOrUndefined(this.rotated);
      if (old !== undefined && this.rotated !== undefined && old.ino === this.ino) {
        chunks.push(await readRange(this.rotated, this.offset, old.size));
      }
      this.ino = undefined;
      this.offset = 0;
    }
    if (current !== undefined) {
      if (current.size < this.offset) {
        // Truncated in place: start over.
        this.offset = 0;
        this.rest = Buffer.alloc(0);
      }
      chunks.push(await readRange(this.file, this.offset, current.size));
      this.ino = current.ino;
      this.offset = current.size;
    }
    return this.parse(Buffer.concat(chunks), false);
  }

  private parse(chunk: Buffer, skipPartial: boolean): unknown[] {
    let data = this.rest.length > 0 ? Buffer.concat([this.rest, chunk]) : chunk;
    if (skipPartial) {
      const first = data.indexOf(0x0a);
      data = first === -1 ? Buffer.alloc(0) : data.subarray(first + 1);
    }
    // Only complete lines: a newline byte never occurs inside a multi-byte UTF-8 character.
    const end = data.lastIndexOf(0x0a);
    this.rest = Buffer.from(end === -1 ? data : data.subarray(end + 1));
    if (end === -1) return [];
    const out: unknown[] = [];
    for (const line of data.subarray(0, end).toString("utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // a damaged line; skip it
      }
    }
    return out;
  }
}

function isEvent(value: unknown): value is WatchEvent {
  const v = value as WatchEvent | null;
  return (
    typeof v === "object" && v !== null && typeof v.at === "string" && typeof v.type === "string"
  );
}

function isProgress(value: unknown): value is ProgressEntry {
  const v = value as ProgressEntry | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.at === "string" &&
    typeof v.step === "string" &&
    typeof v.tool === "string"
  );
}

/** Keeps the state, the lock and the newest events and tool calls of the current run. */
export class RunReader {
  readonly events: WatchEvent[] = [];
  readonly progress: ProgressEntry[] = [];
  private runId: string | undefined;
  private eventFeed: JsonlFollower | undefined;
  private progressFeed: JsonlFollower | undefined;
  private state: RunState | undefined;
  private readonly store: StateStore;

  constructor(
    readonly dir: string,
    private readonly usage: Config["usage"],
    private readonly keep = 50,
  ) {
    this.store = new StateStore(dir);
  }

  /** Reads what changed; returns the view and the events and tool calls new since the last call. */
  async refresh(): Promise<{
    view: WatchView;
    newEvents: WatchEvent[];
    newProgress: ProgressEntry[];
  }> {
    let error: string | undefined;
    try {
      this.state = await this.store.load();
    } catch (e) {
      error = (e as Error).message; // keep showing the last state that could be read
    }
    const runId = this.state?.runId;
    if (runId !== this.runId) {
      this.runId = runId;
      this.events.length = 0;
      this.progress.length = 0;
      if (runId === undefined) {
        this.eventFeed = undefined;
        this.progressFeed = undefined;
      } else {
        const runDir = this.store.runDir(runId);
        this.eventFeed = new JsonlFollower(path.join(runDir, "events.jsonl"));
        this.progressFeed = new JsonlFollower(
          path.join(runDir, PROGRESS_FILE),
          path.join(runDir, PROGRESS_ROTATED_FILE),
        );
      }
    }
    const newEvents: WatchEvent[] = [];
    const newProgress: ProgressEntry[] = [];
    try {
      if (this.eventFeed) newEvents.push(...(await this.eventFeed.read()).filter(isEvent));
      if (this.progressFeed)
        newProgress.push(...(await this.progressFeed.read()).filter(isProgress));
    } catch (e) {
      error ??= (e as Error).message;
    }
    this.events.push(...newEvents);
    this.events.splice(0, Math.max(0, this.events.length - this.keep));
    this.progress.push(...newProgress);
    this.progress.splice(0, Math.max(0, this.progress.length - this.keep));
    const view: WatchView = {
      state: this.state,
      holder: lockHolder(this.dir),
      stopRequested: existsSync(path.join(this.dir, STOP_FILE)),
      events: this.events,
      progress: this.progress,
      limits: usageLimits(this.usage, this.state?.usageShare),
      ...(error === undefined ? {} : { error }),
    };
    return { view, newEvents, newProgress };
  }
}

// ── the command ────────────────────────────────────────────────────────────

export interface WatchOptions {
  dir: string;
  usage: Config["usage"];
  once: boolean;
  intervalMs?: number;
  out?: NodeJS.WriteStream;
  input?: NodeJS.ReadStream;
  env?: NodeJS.ProcessEnv;
}

const ENTER = "\x1b[?1049h\x1b[?25l"; // alternate screen, hide cursor
const LEAVE = "\x1b[?25h\x1b[?1049l";

export async function watch(options: WatchOptions): Promise<number> {
  const out = options.out ?? process.stdout;
  const input = options.input ?? process.stdin;
  const env = options.env ?? process.env;
  const interval = options.intervalMs ?? 1000;
  const reader = new RunReader(options.dir, options.usage);
  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
  const tty = out.isTTY === true && env.TERM !== "dumb";
  const columns = () => out.columns || Number(env.COLUMNS) || (tty ? 80 : 120);

  if (options.once) {
    const { view } = await reader.refresh();
    const lines = renderWatch(view, { now: new Date(), width: columns(), color: tty && !noColor });
    out.write(`${lines.join("\n")}\n`);
    return 0;
  }

  let stop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  let done = false;
  stopped.then(() => {
    done = true;
  });
  const onSignal = () => stop();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const pause = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, interval);
      stopped.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });

  try {
    if (!tty) {
      await followPlain(reader, out, pause, () => done);
      return 0;
    }
    return await followScreen(reader, out, input, !noColor, columns, pause, stop, () => done);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/** Line-by-line output for pipes and logs: new events and tool calls, and status changes. */
async function followPlain(
  reader: RunReader,
  out: NodeJS.WritableStream,
  pause: () => Promise<void>,
  done: () => boolean,
): Promise<void> {
  let summary: string | undefined;
  let first = true;
  while (!done()) {
    const { view, newEvents, newProgress } = await reader.refresh();
    const lines: { at: string; text: string }[] = [
      ...(first ? newEvents.slice(-MAX_EVENT_LINES) : newEvents).map((event) => ({
        at: event.at,
        text: describeEvent(event).text,
      })),
      ...(first ? newProgress.slice(-MAX_TOOL_LINES) : newProgress).map((entry) => ({
        at: entry.at,
        text: `[item ${entry.item}] ${describeProgress(entry)}`,
      })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    first = false;
    let text = lines.map((line) => `${clock(line.at)}  ${sanitize(line.text)}\n`).join("");
    const next = summarize(view);
    if (next !== summary) {
      summary = next;
      text += `${clock(new Date())}  ${next}\n`;
    }
    if (view.error !== undefined)
      text += `${clock(new Date())}  could not read state: ${view.error}\n`;
    if (text !== "") out.write(text);
    await pause();
  }
}

/** The full-screen view: redrawn every interval and on resize; q or Ctrl-C quits. */
async function followScreen(
  reader: RunReader,
  out: NodeJS.WriteStream,
  input: NodeJS.ReadStream,
  color: boolean,
  columns: () => number,
  pause: () => Promise<void>,
  stop: () => void,
  done: () => boolean,
): Promise<number> {
  const keys = input.isTTY === true;
  const restore = () => out.write(LEAVE);
  let view: WatchView | undefined;
  const draw = () => {
    if (view === undefined) return;
    const lines = renderWatch(view, {
      now: new Date(),
      width: columns(),
      height: out.rows || 24,
      color,
      footer: keys ? "q quit" : "Ctrl-C quits",
    });
    out.write(`\x1b[H${lines.map((line) => `${line}\x1b[K`).join("\n")}\x1b[J`);
  };
  const onKey = (data: Buffer) => {
    const key = data.toString("utf8");
    if (key === "q" || key === "Q" || key === "\x03" || key === "\x04") stop();
  };
  // Restore the terminal even if the process exits some other way.
  process.on("exit", restore);
  out.write(ENTER);
  if (keys) {
    input.setRawMode(true);
    input.on("data", onKey);
    input.resume();
  }
  out.on("resize", draw);
  try {
    while (!done()) {
      view = (await reader.refresh()).view;
      draw();
      await pause();
    }
    return 0;
  } finally {
    out.off("resize", draw);
    if (keys) {
      input.off("data", onKey);
      input.setRawMode(false);
      input.pause();
    }
    restore();
    process.off("exit", restore);
  }
}
