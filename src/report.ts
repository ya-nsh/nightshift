import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type ItemState, type RunState, runItems, type StateStore } from "./state.js";
import { USAGE_WINDOWS, type UsageWindow, WINDOW_LABEL } from "./usage.js";
import { formatDuration } from "./watch.js";

/**
 * The morning report: what a run did, from its event journal plus the live state. Written on every
 * stop to `runs/<run-id>/report.md` and copied to `.nightshift/report.md`.
 */

export const REPORT_FILE = "report.md";
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type Event = Record<string, unknown> & { type?: unknown; at?: unknown };
type Points = Partial<Record<UsageWindow, number>>;

interface ItemReport {
  index: number;
  label?: string;
  repo?: string;
  pr?: string;
  mergeSha?: string;
  summary?: string;
  done: boolean;
  costUsd: number;
  points: Points;
  /** Points from item_done, which already sums every step. */
  pointsFinal?: Points;
  /** Milliseconds per phase, in the order phases first ran. */
  steps: Map<string, number>;
  answeredBy?: string;
  /** The GitHub issue the item worked on (`[tasks] source = "github_issues"`). */
  issue?: string;
  /** Claude found nothing to change for the issue, so it was set aside. */
  setAside?: string;
  /** Time on the item without usage, schedule and forecast waits (from item_done). */
  activeMs?: number;
}

interface ForecastEvent {
  at: string;
  item: number | undefined;
  start: boolean;
  reason: string;
}

interface StopEvent {
  kind: string;
  reason: string;
  at: string;
  item: number | undefined;
}

const STOP_KINDS = new Set(["halted", "blocked", "paused", "done"]);

/** Whether `id` is safe to use as a run directory name. */
export function isRunId(id: string): boolean {
  return RUN_ID.test(id) && !id.includes("..");
}

export async function readEvents(store: StateStore, runId: string): Promise<Event[]> {
  let text: string;
  try {
    text = await readFile(path.join(store.runDir(runId), "events.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const events: Event[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object") events.push(parsed as Event);
    } catch {
      // a line cut by a crash; the rest of the journal still counts
    }
  }
  return events;
}

export function buildReport(state: RunState, events: readonly Event[], now: Date): string {
  const items = new Map<number, ItemReport>();
  const itemAt = (index: unknown): ItemReport | undefined => {
    if (typeof index !== "number") return undefined;
    let item = items.get(index);
    if (item === undefined) {
      item = { index, done: false, costUsd: 0, points: {}, steps: new Map() };
      items.set(index, item);
    }
    return item;
  };
  const stops: StopEvent[] = [];
  const forecasts: ForecastEvent[] = [];

  for (const e of events) {
    const item = itemAt(e.item);
    switch (e.type) {
      case "agent":
        if (item && !item.done && typeof e.costUsd === "number") item.costUsd += e.costUsd;
        break;
      case "result":
        if (item && typeof e.label === "string") item.label = e.label;
        if (item && e.step === "implement" && typeof e.summary === "string") {
          item.summary = e.summary;
        }
        break;
      case "pr_opened":
        if (item && typeof e.pr === "string") item.pr = e.pr;
        if (item && typeof e.label === "string") item.label = e.label;
        break;
      case "merged":
        if (item && typeof e.sha === "string") item.mergeSha = e.sha;
        break;
      case "usage":
        if (item) addPoints(item.points, e.points);
        break;
      case "phase":
        if (item && typeof e.phase === "string" && typeof e.durationMs === "number") {
          item.steps.set(e.phase, (item.steps.get(e.phase) ?? 0) + e.durationMs);
        }
        break;
      case "answer":
        if (item && typeof e.by === "string") item.answeredBy = e.by;
        break;
      case "issue_picked":
        if (item && typeof e.issue === "string") item.issue = e.issue;
        break;
      case "issue_set_aside":
        if (!item) break;
        if (typeof e.issue === "string") item.issue = e.issue;
        item.setAside = typeof e.summary === "string" ? e.summary : "";
        break;
      case "forecast":
        forecasts.push({
          at: typeof e.at === "string" ? e.at : "",
          item: typeof e.item === "number" ? e.item : undefined,
          start: e.start !== false,
          reason: typeof e.reason === "string" ? e.reason : "",
        });
        break;
      case "item_done":
        if (!item) break;
        item.done = true;
        if (typeof e.label === "string") item.label = e.label;
        if (typeof e.pr === "string") item.pr = e.pr;
        if (typeof e.mergeSha === "string") item.mergeSha = e.mergeSha;
        if (typeof e.costUsd === "number") item.costUsd = e.costUsd;
        if (typeof e.activeMs === "number") item.activeMs = e.activeMs;
        if (e.usagePoints !== undefined) {
          item.pointsFinal = {};
          addPoints(item.pointsFinal, e.usagePoints);
        }
        break;
      default:
        if (typeof e.type === "string" && STOP_KINDS.has(e.type)) {
          stops.push({
            kind: e.type,
            reason: typeof e.reason === "string" ? e.reason : "",
            at: typeof e.at === "string" ? e.at : "",
            item: typeof e.item === "number" ? e.item : undefined,
          });
        }
    }
  }

  // The items in progress: the live state knows more than the journal.
  for (const current of runItems(state)) {
    const item = itemAt(current.index) as ItemReport;
    item.repo = current.repo;
    if (current.label !== undefined) item.label = current.label;
    if (current.pr !== undefined) item.pr = current.pr.url;
    if (current.mergeSha !== undefined) item.mergeSha = current.mergeSha;
    if (current.issue !== undefined) item.issue = current.issue.url;
    if (current.activeMs !== undefined) item.activeMs = current.activeMs;
    item.costUsd = current.costUsd;
    if (current.usagePoints !== undefined) item.pointsFinal = { ...current.usagePoints };
  }

  const lines: string[] = [`# nightshift report · run ${state.runId}`, ""];
  lines.push(...headline(state));
  lines.push("");
  const runPoints = formatPoints(state.usage?.points);
  lines.push(
    `- Started: ${formatDate(state.startedAt)}`,
    `- ${state.stop ? `Stopped: ${formatDate(state.stop.at)}` : `Report written: ${formatDate(now.toISOString())}`}`,
    `- Items completed: ${state.itemsCompleted}`,
    `- Cost: $${state.costUsd.toFixed(2)}`,
  );
  if (runPoints !== "") lines.push(`- Usage: ${runPoints}`);
  lines.push("");

  const attention = needsAttention(state, stops);
  if (attention.length > 0) {
    lines.push("## Needs attention", "", ...attention, "");
  }

  lines.push("## Items", "");
  const ordered = [...items.values()].sort((a, b) => a.index - b.index);
  if (ordered.length === 0) lines.push("No items yet.", "");
  for (const item of ordered) lines.push(...itemSection(item, state), "");

  const held = forecasts.filter((f) => !f.start);
  const lastForecast = forecasts.at(-1);
  if (lastForecast !== undefined) {
    lines.push("## Forecast", "", `- Latest: ${lastForecast.reason}`);
    for (const f of held) {
      const what = f.item === undefined ? "a new item" : `item ${f.item}`;
      lines.push(`- ${formatDate(f.at)} · held back ${what}: ${f.reason}`);
    }
    lines.push("");
  }

  const history = stops.filter((s) => s.kind !== "done");
  if (history.length > 0) {
    lines.push("## Stops this run", "");
    for (const stop of history) {
      const where = stop.item === undefined ? "" : ` (item ${stop.item})`;
      lines.push(`- ${formatDate(stop.at)} · ${stop.kind}${where}: ${stop.reason}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function headline(state: RunState): string[] {
  const stop = state.stop;
  if (state.status === "running" || stop === undefined) {
    return [
      `**${state.status === "done" ? "Done" : "Running"}**${state.haltReason ? `: ${state.haltReason}` : ""}`,
    ];
  }
  const title = { done: "Done", paused: "Paused", blocked: "Blocked", halted: "Halted" }[stop.kind];
  const lines = [`**${title}**: ${state.haltReason ?? ""}`];
  if (stop.resumeAt !== undefined) {
    lines.push(
      "",
      `The daemon resumes it after ${formatDate(stop.resumeAt)}, or run \`nightshift resume\`.`,
    );
  }
  return lines;
}

function needsAttention(state: RunState, stops: readonly StopEvent[]): string[] {
  const out: string[] = [];
  const item = state.item;
  const stop = state.stop;
  const items = runItems(state);
  if (items.length > 1) {
    out.push(...lanesNeedAttention(state, items));
  } else if (
    state.status === "halted" &&
    stop?.kind === "blocked" &&
    item?.pendingQuestion !== undefined
  ) {
    out.push(
      `- **Question** (${item.label ?? `item ${item.index}`}): ${oneLine(item.pendingQuestion)}`,
    );
    if (item.questionPost !== undefined) {
      out.push(`  - Reply on GitHub: ${item.questionPost.url}`);
    }
    out.push('  - Or answer here: `nightshift resume --answer "…"`');
  } else if (state.status === "halted" && stop?.kind === "halted") {
    out.push(`- **Halted**: ${oneLine(state.haltReason ?? "")}`);
    out.push("  - Fix the cause, then `nightshift resume`.");
  }
  // Earlier failures and questions in this run that a later resume got past.
  const past = state.status === "running" ? stops : stops.slice(0, -1);
  const earlier = past.filter((s) => s.kind === "halted" || s.kind === "blocked");
  if (earlier.length > 0) {
    out.push(`- ${earlier.length} earlier stop(s) this run needed a human (see "Stops this run").`);
  }
  return out;
}

/**
 * With parallel lanes: each open question and each lane that stopped, with how to go on. Lanes
 * stop separately, so the run's own stop says less about each of them.
 */
function lanesNeedAttention(state: RunState, items: readonly ItemState[]): string[] {
  if (state.status !== "halted") return [];
  const out: string[] = [];
  const open = items.filter(
    (i) => i.pendingQuestion !== undefined && i.pendingAnswer === undefined,
  );
  for (const item of open) {
    out.push(
      `- **Question** (${item.label ?? `item ${item.index}`}): ${oneLine(item.pendingQuestion ?? "")}`,
    );
    if (item.questionPost !== undefined) out.push(`  - Reply on GitHub: ${item.questionPost.url}`);
    out.push(
      `  - Or answer here: \`nightshift resume --answer "…"${open.length > 1 ? ` --item ${item.index}` : ""}\``,
    );
  }
  const halted = items.filter((i) => i.stopped?.kind === "halted");
  for (const item of halted) {
    out.push(
      `- **Halted** (${item.label ?? `item ${item.index}`}): ${oneLine(item.stopped?.reason ?? "")}`,
    );
  }
  if (state.stop?.kind === "halted" && halted.length === 0) {
    out.push(`- **Halted**: ${oneLine(state.haltReason ?? "")}`);
  }
  if (halted.length > 0 || state.stop?.kind === "halted") {
    out.push("  - Fix the cause, then `nightshift resume`.");
  }
  return out;
}

function itemSection(item: ItemReport, state: RunState): string[] {
  const items = runItems(state);
  const current = items.find((i) => i.index === item.index);
  let status: string;
  if (item.done) status = item.mergeSha ? "merged" : "done";
  else if (item.setAside !== undefined) status = "set aside (no change needed)";
  else if (current === undefined) status = "not finished";
  else if (items.length > 1) status = laneStatus(current);
  else if (state.status === "halted" && state.stop?.kind === "blocked") status = "blocked";
  else if (state.status === "halted" && state.stop?.kind === "halted") {
    status = `halted in ${current.phase}`;
  } else status = `in progress (${current.phase})`;
  const lines = [`### ${item.index}. ${item.label ?? "(no label yet)"} · ${status}`, ""];
  if (item.repo !== undefined) lines.push(`- Repo: ${item.repo}`);
  if (item.issue !== undefined) lines.push(`- Issue: ${item.issue}`);
  if (item.pr !== undefined) lines.push(`- PR: ${item.pr}`);
  if (item.mergeSha !== undefined) lines.push(`- Merged as \`${item.mergeSha}\``);
  const summary = item.setAside || item.summary;
  if (summary !== undefined && summary !== "") lines.push(`- Claude: ${oneLine(summary)}`);
  if (item.answeredBy !== undefined) lines.push(`- Answer from @${item.answeredBy} on GitHub`);
  const points = formatPoints(item.pointsFinal ?? item.points);
  lines.push(`- Cost: $${item.costUsd.toFixed(2)}${points === "" ? "" : ` · usage: ${points}`}`);
  if (item.steps.size > 0) {
    let total = 0;
    const parts: string[] = [];
    for (const [phase, ms] of item.steps) {
      total += ms;
      parts.push(`${phase} ${formatDuration(ms)}`);
    }
    const active =
      item.activeMs === undefined ? "" : `; active ${formatDuration(item.activeMs)} without waits`;
    lines.push(`- Time: ${parts.join(" · ")} (total ${formatDuration(total)}${active})`);
  } else if (item.activeMs !== undefined) {
    lines.push(`- Time: active ${formatDuration(item.activeMs)}`);
  }
  return lines;
}

/** With parallel lanes, each item in progress has its own status. */
function laneStatus(item: ItemState): string {
  if (item.pendingQuestion !== undefined && item.pendingAnswer === undefined) return "blocked";
  if (item.stopped?.kind === "halted") return `halted in ${item.phase}`;
  return `in progress (${item.phase})`;
}

function addPoints(into: Points, raw: unknown): void {
  if (raw === null || typeof raw !== "object") return;
  for (const window of USAGE_WINDOWS) {
    const value = (raw as Record<string, unknown>)[window];
    if (typeof value === "number" && value > 0) {
      into[window] = Math.round(((into[window] ?? 0) + value) * 100) / 100;
    }
  }
}

function formatPoints(points: Points | undefined): string {
  if (points === undefined) return "";
  return USAGE_WINDOWS.filter((w) => (points[w] ?? 0) > 0)
    .map((w) => `${points[w]} points of the ${WINDOW_LABEL[w]} window`)
    .join(", ");
}

/** Local time as `YYYY-MM-DD HH:MM`. */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso || "unknown";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Writes the report for the run in `state` to `runs/<id>/report.md` and copies it to
 * `.nightshift/report.md`. Returns the run's report path.
 */
export async function writeReport(store: StateStore, state: RunState, now: Date): Promise<string> {
  const text = buildReport(state, await readEvents(store, state.runId), now);
  const dir = store.runDir(state.runId);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, REPORT_FILE);
  await atomicWrite(file, text);
  const latest = path.join(store.dir, REPORT_FILE);
  const tmp = `${latest}.${process.pid}.tmp`;
  await copyFile(file, tmp);
  await rename(tmp, latest);
  return file;
}

async function atomicWrite(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

/**
 * The report for `runId` (default: the current run). The current run's report is rebuilt from its
 * journal, so it is up to date even while the run is going; an archived run's saved report is
 * returned as written, or rebuilt from its journal and final state.
 */
export async function loadReport(
  store: StateStore,
  runId: string | undefined,
  now: Date,
): Promise<string | undefined> {
  if (runId !== undefined && !isRunId(runId)) throw new Error(`invalid run id "${runId}"`);
  const state = await store.load();
  if (state !== undefined && (runId === undefined || runId === state.runId)) {
    return buildReport(state, await readEvents(store, state.runId), now);
  }
  if (runId === undefined) return undefined;
  const dir = store.runDir(runId);
  try {
    return await readFile(path.join(dir, REPORT_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let final: RunState;
  try {
    final = JSON.parse(await readFile(path.join(dir, "final-state.json"), "utf8")) as RunState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return buildReport(final, await readEvents(store, runId), now);
}
