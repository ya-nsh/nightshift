import { appendFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { newRunState, Pipeline } from "../src/pipeline.js";
import {
  PROGRESS_FILE,
  PROGRESS_ROTATED_FILE,
  type ProgressEntry,
  type RunState,
  StateStore,
} from "../src/state.js";
import { type UsageLimits, usageLimits } from "../src/usage.js";
import {
  clock,
  describeEvent,
  formatDuration,
  JsonlFollower,
  RunReader,
  renderWatch,
  sanitize,
  summarize,
  textWidth,
  type WatchEvent,
  type WatchView,
} from "../src/watch.js";
import { FakeAgent, harness, tempHome } from "./fakes.js";

const NOW = new Date("2026-11-08T12:00:00Z");
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const NO_LIMITS: UsageLimits = {
  five_hour: { share: 0, max: 0 },
  seven_day: { share: 0, max: 0 },
};
const LIMITS: UsageLimits = {
  five_hour: { share: 20, max: 80 },
  seven_day: { share: 0, max: 0 },
};

function runningState(overrides: Partial<RunState> = {}): RunState {
  return {
    version: 1,
    runId: "20261108-110000-abcd",
    startedAt: at(-3_600_000),
    status: "running",
    itemsCompleted: 2,
    costUsd: 12.5,
    item: {
      index: 3,
      repo: "backend",
      handoff: "do it",
      label: "B1.6 — geo module",
      phase: "implement",
      reviewRound: 0,
      fixRound: 0,
      conflictRound: 0,
      costUsd: 3.25,
      pr: {
        number: 7,
        url: "https://github.com/o/r/pull/7",
        repoSlug: "o/r",
        branch: "todo/b16",
      },
      activity: {
        step: "implement",
        since: at(-754_000),
        tools: 42,
        last: "Bash npm test",
        lastAt: at(-5_000),
      },
    },
    ...overrides,
  };
}

const progress = (n: number): ProgressEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    at: at(-60_000 + i * 1000),
    item: 3,
    step: "implement",
    tool: "Bash",
    detail: `cmd-${i}`,
  }));

const events = (n: number): WatchEvent[] =>
  Array.from({ length: n }, (_, i) => ({
    at: at(-600_000 + i * 1000),
    type: "agent",
    item: 3,
    step: `step-${i}`,
    outcome: "success",
    costUsd: 1,
  }));

function view(overrides: Partial<WatchView> = {}): WatchView {
  return {
    state: runningState(),
    holder: 4242,
    stopRequested: false,
    events: [],
    progress: [],
    limits: NO_LIMITS,
    ...overrides,
  };
}

const render = (v: WatchView, width = 200, extra: { height?: number; color?: boolean } = {}) =>
  renderWatch(v, { now: NOW, width, color: extra.color ?? false, ...extra });
const text = (v: WatchView, width = 200) => render(v, width).join("\n");

describe("renderWatch", () => {
  it("says when there is no run yet", () => {
    const lines = render(view({ state: undefined, holder: undefined }));
    expect(lines[0]).toContain("nightshift watch");
    expect(lines.join("\n")).toContain("no run yet");
    expect(lines.join("\n")).toContain("events: none yet");
  });

  it("shows a live run's status, item, phase, PR and running step", () => {
    const out = text(view());
    expect(out).toContain("run 20261108-110000-abcd · running · pid 4242");
    expect(out).toContain("item 3 — B1.6 — geo module · repo backend · phase implement");
    expect(out).toContain("PR #7 https://github.com/o/r/pull/7");
    expect(out).toContain("step implement · running 12m 34s · 42 tool call(s) · last call 5s ago");
    expect(out).toContain("items completed 2");
  });

  it("shows review, fix and conflict rounds once they started", () => {
    const state = runningState();
    if (state.item) Object.assign(state.item, { phase: "fix_checks", reviewRound: 1, fixRound: 2 });
    expect(text(view({ state }))).toContain("phase fix_checks · review round 1 · fix round 2");
  });

  it("lists the newest tool calls, oldest first", () => {
    const out = render(view({ progress: progress(12) }));
    const start = out.indexOf("recent tool calls");
    expect(start).toBeGreaterThan(0);
    const listed = out.slice(start + 1, start + 9);
    expect(listed.map((l) => l.trim().split("  ")[1])).toEqual(
      [4, 5, 6, 7, 8, 9, 10, 11].map((i) => `implement · Bash cmd-${i}`),
    );
    expect(out[start + 1]).toContain(clock(at(-56_000)));
    expect(out[start + 9]).not.toContain("cmd-");
  });

  it("omits the tool-call list when the run has no progress feed", () => {
    expect(text(view())).not.toContain("recent tool calls");
  });

  it("shows run and item cost and the run's usage points", () => {
    const state = runningState({ usage: { tally: {}, points: { five_hour: 31.456 } } });
    expect(text(view({ state }))).toContain(
      "cost $12.50 run · $3.25 item 3 · 31.46 points of 5-hour usage",
    );
  });

  it("draws usage bars with nightshift's share, the max marker and reset times", () => {
    const state = runningState({
      usage: {
        tally: {
          five_hour: { resetsAt: at(7_200_000), used: 10 },
          seven_day: { resetsAt: at(3 * 86_400_000), used: 3 },
        },
        last: {
          at: at(-60_000),
          windows: {
            five_hour: { utilization: 50, resetsAt: at(7_200_000) },
            seven_day: { utilization: 71, resetsAt: at(3 * 86_400_000) },
          },
        },
      },
    });
    const lines = render(view({ state, limits: LIMITS }), 80);
    const five = lines.find((l) => l.includes("5-hour")) ?? "";
    const week = lines.find((l) => l.includes("weekly")) ?? "";
    // 80 columns → 10-cell bars: 50% = 5 cells, nightshift's 10 points = 1 of them; max 80% = cell 8
    expect(five).toContain("5-hour ▓▓▓▓█░░░│░ 50%");
    expect(five).toContain("nightshift 10/20 · max 80% · resets");
    expect(five).toContain("(in 2h 00m)");
    expect(week).toContain("71% · nightshift 3 · resets");
    expect(week).toContain("(in 3d 0h)");
    expect(lines.join("\n")).toContain("usage read");
  });

  it("explains missing usage readings", () => {
    expect(text(view())).toContain("usage not measured (no [usage] limits)");
    expect(text(view({ limits: LIMITS }))).toContain("usage not read yet");
    const empty = runningState({ usage: { tally: {}, last: { at: at(0), windows: {} } } });
    expect(text(view({ state: empty }))).toContain("no usage windows reported");
  });

  it("shows a wait and when it ends", () => {
    const state = runningState({
      waiting: { until: at(4_300_000), reason: "5-hour share used" },
    });
    expect(text(view({ state }))).toMatch(
      /waiting until \d\d:\d\d \(in 1h 11m\): 5-hour share used/,
    );
  });

  it("flags a run whose process was killed, without stale step or wait", () => {
    const state = runningState({ waiting: { until: at(60_000), reason: "x" } });
    const out = text(view({ state, holder: undefined }));
    expect(out).toContain("not running");
    expect(out).toContain("`nightshift resume` continues");
    expect(out).toContain("step implement was running when the process stopped (42 tool call(s))");
    expect(out).not.toContain("waiting until");
    expect(out).not.toContain("running 12m");
  });

  it("shows halted, blocked and done runs with their reason", () => {
    const halted = runningState({ status: "halted", haltReason: "interrupted" });
    expect(text(view({ state: halted, holder: undefined }))).toContain(
      "run 20261108-110000-abcd · halted: interrupted",
    );
    const blocked = runningState({ status: "halted", haltReason: "needs a human: which db?" });
    if (blocked.item) blocked.item.pendingQuestion = "which db?";
    expect(text(view({ state: blocked, holder: undefined }))).toContain(
      "needs an answer: which db?",
    );
    const done = runningState({ status: "done", haltReason: "no task left" });
    delete done.item;
    const out = text(view({ state: done, holder: undefined }));
    expect(out).toContain("done: no task left");
    expect(out).toContain("no current item");
  });

  it("says when a stop was requested", () => {
    expect(text(view({ stopRequested: true }))).toContain("running · pid 4242 · stop requested");
  });

  it("shows the last ten events", () => {
    const out = render(view({ events: events(15) }));
    const listed = out.filter((l) => l.includes("→ success"));
    expect(listed).toHaveLength(10);
    expect(listed[0]).toContain("step-5");
    expect(listed[9]).toContain("step-14");
  });

  it("keeps showing the last state when state.json cannot be read", () => {
    expect(render(view({ error: "Unexpected token" }))[0]).toContain(
      "could not read state: Unexpected token",
    );
  });

  it("cuts every line to a narrow terminal instead of wrapping", () => {
    const state = runningState({
      usage: {
        tally: {},
        last: { at: at(0), windows: { five_hour: { utilization: 5, resetsAt: at(60_000) } } },
      },
    });
    for (const width of [1, 10, 24, 39, 41]) {
      const lines = render(view({ state, events: events(3), progress: progress(3) }), width);
      for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(width);
      expect(lines.some((l) => l.endsWith("…"))).toBe(true);
    }
    // below 40 columns the usage bar is dropped, not squeezed
    const narrow = render(view({ state }), 39).find((l) => l.includes("5-hour")) ?? "";
    expect(narrow).not.toContain("░");
  });

  it("fits the lists into the terminal height, keeping the newest lines", () => {
    const v = view({ events: events(15), progress: progress(12) });
    const full = render(v);
    const lines = render(v, 200, { height: full.length - 10 });
    expect(lines).toHaveLength(full.length - 10);
    const toolLines = lines.filter((l) => l.includes("Bash cmd-"));
    const eventLines = lines.filter((l) => l.includes("→ success"));
    expect(toolLines.length + eventLines.length).toBe(8);
    expect(toolLines.at(-1)).toContain("cmd-11");
    expect(eventLines.at(-1)).toContain("step-14");
    // a tiny terminal still gets the first lines, never more than it has rows
    expect(render(v, 200, { height: 3 })).toHaveLength(3);
  });

  it("colours only when asked", () => {
    expect(text(view({ events: events(2) }))).not.toContain("\x1b[");
    const colored = render(view(), 200, { color: true }).join("\n");
    expect(colored).toContain("\x1b[32mrunning\x1b[0m");
  });

  it("keeps control characters from tool input out of the terminal", () => {
    const entry = { ...progress(1)[0], detail: "evil\x1b[2J\nnext" } as ProgressEntry;
    const out = render(view({ progress: [entry] }), 200, { color: true }).join("\n");
    expect(out).not.toContain("\x1b[2J");
    expect(out).toContain("evil [2J next");
  });

  it("measures wide characters when cutting", () => {
    expect(textWidth("日本")).toBe(4);
    expect(textWidth("e\u0301")).toBe(1);
    const state = runningState();
    if (state.item) state.item.label = "日本語のラベル".repeat(10);
    for (const line of render(view({ state }), 30)) expect(textWidth(line)).toBeLessThanOrEqual(30);
  });
});

describe("watch helpers", () => {
  it("formats durations", () => {
    expect(formatDuration(-5)).toBe("0s");
    expect(formatDuration(45_900)).toBe("45s");
    expect(formatDuration(754_000)).toBe("12m 34s");
    expect(formatDuration(7_500_000)).toBe("2h 05m");
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
  });

  it("describes each event type, and unknown ones by their fields", () => {
    const e = (type: string, fields: Record<string, unknown>) =>
      describeEvent({ at: at(0), type, ...fields });
    expect(e("invocation_start", { item: 1, phase: "review" }).text).toBe(
      "item 1 · started (phase review)",
    );
    expect(e("agent", { item: 1, step: "address", outcome: "aborted", costUsd: 2 })).toEqual({
      text: "item 1 · address → aborted · $2.00",
      style: "yellow",
    });
    expect(e("pr_opened", { item: 1, pr: "u" }).text).toBe("item 1 · opened u");
    expect(e("review", { item: 1, round: 2, exitCode: 0, timedOut: false }).text).toBe(
      "item 1 · review round 2 (exit 0)",
    );
    expect(e("review", { item: 1, round: 2, exitCode: null, timedOut: true }).text).toBe(
      "item 1 · review round 2 (timed out)",
    );
    expect(e("merged", { item: 1, pr: "u", sha: "abcdef0123" }).text).toBe(
      "item 1 · merged u as abcdef0",
    );
    expect(e("item_done", { item: 1, label: "T1" }).style).toBe("green");
    expect(e("usage", { item: 1, step: "implement", points: { five_hour: 1.234 } }).text).toBe(
      "item 1 · implement used 5-hour +1.23 points",
    );
    expect(e("usage_wait", { reason: "share used", until: at(0) }).text).toBe(
      `waiting until ${clock(at(0))}: share used`,
    );
    expect(e("blocked", { reason: "needs a human" })).toEqual({
      text: "blocked: needs a human",
      style: "red",
    });
    expect(e("done", { reason: "no task left", itemsCompleted: 4 }).text).toBe(
      "run done: no task left (4 item(s))",
    );
    expect(e("lane_started", { lane: 2, item: 5 }).text).toBe("lane_started lane=2 item=5");
  });

  it("summarizes a run on one line for plain output", () => {
    expect(summarize(view({ state: undefined }))).toBe("no run yet");
    expect(summarize(view())).toBe(
      "run 20261108-110000-abcd · running (pid 4242) · item 3 — B1.6 — geo module · phase implement · https://github.com/o/r/pull/7 · step implement",
    );
    expect(summarize(view({ holder: undefined }))).toContain("not running (process gone");
    expect(sanitize("a\r\n\tb")).toBe("a b");
  });
});

describe("progress feed", () => {
  it("appends tool calls and rotates past the size limit, keeping one old file", async () => {
    const home = await tempHome();
    const store = new StateStore(home);
    const dir = store.runDir("r1");
    const entries = progress(40);
    await Promise.all(entries.map((entry) => store.progress("r1", entry, 1000)));
    const current = await stat(path.join(dir, PROGRESS_FILE));
    const rotated = await stat(path.join(dir, PROGRESS_ROTATED_FILE));
    expect(current.size).toBeLessThanOrEqual(1000);
    expect(rotated.size).toBeGreaterThan(1000);
    expect(rotated.size).toBeLessThan(1200);
    // appends stay in order, and the newest entry is the last line of the current file
    const lines = (await readFile(path.join(dir, PROGRESS_FILE), "utf8")).trim().split("\n");
    const last = JSON.parse(lines.at(-1) ?? "{}") as ProgressEntry;
    expect(last.detail).toBe("cmd-39");
  });

  it("is written by the pipeline for every tool call of a step", async () => {
    const h = await harness('[review]\ncommand = ""');
    const agent = new FakeAgent([
      (req) => {
        req.onEvent?.({ type: "tool", name: "Bash", detail: "npm test" });
        req.onEvent?.({ type: "tool", name: "Read", detail: "" });
        return { outcome: "error", detail: "boom" };
      },
    ]);
    const state = newRunState("run-feed", h.host.now(), "main", "do task one");
    const pipeline = new Pipeline(
      {
        config: h.config,
        templates: h.templates,
        agent,
        forge: h.forge,
        reviewer: h.reviewer,
        host: h.host,
        store: h.store,
      },
      state,
    );
    await pipeline.run({ signal: new AbortController().signal });
    const file = path.join(h.store.runDir("run-feed"), PROGRESS_FILE);
    await vi.waitFor(async () => {
      const lines = (await readFile(file, "utf8")).trim().split("\n");
      expect(lines.map((l) => JSON.parse(l))).toEqual([
        {
          at: h.host.now().toISOString(),
          item: 1,
          step: "implement",
          tool: "Bash",
          detail: "npm test",
        },
        { at: h.host.now().toISOString(), item: 1, step: "implement", tool: "Read", detail: "" },
      ]);
    });
  });
});

describe("JsonlFollower", () => {
  it("starts from the tail, then returns only complete new lines", async () => {
    const file = path.join(await tempHome(), "events.jsonl");
    const line = (n: number) => `${JSON.stringify({ n, pad: "x".repeat(20) })}\n`;
    await writeFile(file, Array.from({ length: 10 }, (_, n) => line(n)).join(""));
    const follower = new JsonlFollower(file, undefined, 100);
    const first = (await follower.read()) as { n: number }[];
    expect(first.map((e) => e.n)).toEqual([8, 9]); // the partial line at the cut is skipped
    await appendFile(file, `${line(10)}{"n":11,`);
    expect(((await follower.read()) as { n: number }[]).map((e) => e.n)).toEqual([10]);
    await appendFile(file, `"pad":""}\nnot json\n`);
    expect(((await follower.read()) as { n: number }[]).map((e) => e.n)).toEqual([11]);
    expect(await follower.read()).toEqual([]);
  });

  it("waits for a file that does not exist yet", async () => {
    const file = path.join(await tempHome(), "events.jsonl");
    const follower = new JsonlFollower(file);
    expect(await follower.read()).toEqual([]);
    await writeFile(file, '{"n":1}\n');
    expect(await follower.read()).toEqual([{ n: 1 }]);
  });

  it("loses nothing across a rotation", async () => {
    const dir = await tempHome();
    const file = path.join(dir, PROGRESS_FILE);
    const rotated = path.join(dir, PROGRESS_ROTATED_FILE);
    await writeFile(file, '{"n":1}\n');
    const follower = new JsonlFollower(file, rotated);
    expect(await follower.read()).toEqual([{ n: 1 }]);
    await appendFile(file, '{"n":2}\n');
    await rename(file, rotated);
    await writeFile(file, '{"n":3}\n');
    expect(await follower.read()).toEqual([{ n: 2 }, { n: 3 }]);
    // a new follower right after a rotation still sees the older lines
    expect(await new JsonlFollower(file, rotated).read()).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
});

describe("RunReader", () => {
  it("reads state, events and progress, and switches to a new run", async () => {
    const home = await tempHome();
    const store = new StateStore(home);
    const usage = { session_share: 0, weekly_share: 0, session_max: 0, weekly_max: 0 };
    const reader = new RunReader(home, usage as never);
    expect((await reader.refresh()).view.state).toBeUndefined();

    const state = runningState({ runId: "run-a" });
    await store.save(state);
    await store.event("run-a", { type: "invocation_start", item: 3, phase: "implement" });
    await store.progress("run-a", progress(1)[0] as ProgressEntry);
    let result = await reader.refresh();
    expect(result.view.state?.runId).toBe("run-a");
    expect(result.newEvents.map((e) => e.type)).toEqual(["invocation_start"]);
    expect(result.newProgress).toHaveLength(1);
    expect(result.view.holder).toBeUndefined();
    expect(result.view.limits).toEqual(usageLimits(usage as never, undefined));

    await store.event("run-a", { type: "agent", item: 3, step: "implement" });
    result = await reader.refresh();
    expect(result.newEvents.map((e) => e.type)).toEqual(["agent"]);
    expect(result.view.events).toHaveLength(2);

    await store.save(runningState({ runId: "run-b" }));
    result = await reader.refresh();
    expect(result.view.state?.runId).toBe("run-b");
    expect(result.view.events).toEqual([]);

    await writeFile(store.statePath, "{ broken");
    result = await reader.refresh();
    expect(result.view.error).toBeDefined();
    expect(result.view.state?.runId).toBe("run-b");
  });
});
