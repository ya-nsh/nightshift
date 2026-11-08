import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";
import {
  activeUntil,
  decideStart,
  describeForecast,
  estimateItem,
  type ForecastContext,
  type ItemSample,
  longestActiveMs,
  percentile,
  readHistory,
  samplesFromEvents,
} from "../src/forecast.js";
import { configTemplate } from "../src/init.js";
import { newRunState, Pipeline } from "../src/pipeline.js";
import type { AgentRequest } from "../src/ports.js";
import { parseRange, type TimeRange } from "../src/schedule.js";
import type { RunState } from "../src/state.js";
import { usageLimits } from "../src/usage.js";
import { describeEvent } from "../src/watch.js";
import {
  FakeAgent,
  FIVE_HOURS_MS,
  type Harness,
  harness,
  PASSED,
  PENDING,
  SimulatedPlan,
  tempHome,
} from "./fakes.js";

const MIN = 60_000;
const range = (text: string) => parseRange(text) as TimeRange;
/** Local time on 4 Nov 2026 (or another day). */
const at = (h: number, m = 0, day = 4) => new Date(2026, 10, day, h, m);

const sample = (points: number, minutes: number, cost = 2, i = 0): ItemSample => ({
  at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
  points: { five_hour: points, seven_day: points / 10 },
  activeMs: minutes * MIN,
  costUsd: cost,
});

const limits = (toml: string) => usageLimits(parseConfig(`[repos]\na = "."\n${toml}`, "/h").usage);

// ── estimation ───────────────────────────────────────────────────────────

describe("estimating a typical item", () => {
  it("takes percentiles with interpolation", () => {
    expect(percentile([], 50)).toBeUndefined();
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([9, 1, 5], 50)).toBe(5);
    expect(percentile([1, 2, 3, 10], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5], 75)).toBe(4);
    expect(percentile([1, 2, 3, 4, 5], 100)).toBe(5);
  });

  it("needs three items, uses only recent ones, and counts each metric's items", () => {
    const two = estimateItem([sample(6, 40), sample(8, 50)]);
    expect(two.points).toEqual({});
    expect(two.activeMs).toBeUndefined();
    expect(two.items).toBe(2);

    // An outlier does not move the median.
    const samples = [sample(5, 30), sample(6, 40), sample(7, 45), sample(90, 600)];
    const estimate = estimateItem(samples);
    expect(estimate.statistic).toBe("median");
    expect(estimate.points.five_hour).toEqual({ value: 6.5, n: 4 });
    expect(estimate.activeMs).toEqual({ value: 42.5 * MIN, n: 4 });

    // Items from runs without usage measured still count for time and cost.
    const mixed = [...samples, { ...sample(0, 60), points: undefined }];
    expect(estimateItem(mixed).points.five_hour?.n).toBe(4);
    expect(estimateItem(mixed).activeMs?.n).toBe(5);

    const many = Array.from({ length: 30 }, (_, i) => sample(i < 10 ? 50 : 4, 20, 1, i));
    expect(estimateItem(many).items).toBe(20);
    expect(estimateItem(many).points.five_hour?.value).toBe(4);
    expect(estimateItem(samples, 75).statistic).toBe("p75");
  });
});

describe("history from events", () => {
  const t = (minutes: number) => new Date(Date.UTC(2026, 10, 4, 0, minutes)).toISOString();

  it("reads the fields item_done records", () => {
    const samples = samplesFromEvents([
      { at: t(0), type: "invocation_start", item: 1 },
      {
        at: t(50),
        type: "item_done",
        item: 1,
        costUsd: 3,
        usagePoints: { five_hour: 6, seven_day: 0.5 },
        activeMs: 42 * MIN,
      },
    ]);
    expect(samples).toEqual([
      {
        at: t(50),
        points: { five_hour: 6, seven_day: 0.5 },
        activeMs: 42 * MIN,
        costUsd: 3,
      },
    ]);
  });

  it("reconstructs points and active time for items recorded without them (0.3.0)", () => {
    const samples = samplesFromEvents([
      { at: t(0), type: "invocation_start", item: 1 },
      { at: t(10), type: "usage", item: 1, step: "implement", points: { five_hour: 4 } },
      { at: t(20), type: "usage_wait", reason: "limit", until: t(80) },
      { at: t(80), type: "usage", item: 1, step: "review", points: { five_hour: 2 } },
      { at: t(90), type: "halted", reason: "needs a human" },
      { at: t(300), type: "invocation_start", item: 1 },
      { at: t(310), type: "item_done", item: 1, costUsd: 2 },
      // the next item starts when the previous one is done
      { at: t(330), type: "usage", item: 2, step: "implement", points: { five_hour: 1 } },
      { at: t(340), type: "item_done", item: 2, costUsd: 1 },
    ]);
    // 0→20 and 80→90 before the halt, then 300→310: 40 minutes.
    expect(samples[0]).toMatchObject({
      points: { five_hour: 6, seven_day: 0 },
      activeMs: 40 * MIN,
    });
    expect(samples[1]).toMatchObject({ points: { five_hour: 1 }, activeMs: 30 * MIN });
  });

  it("leaves points unknown in runs that did not measure usage", () => {
    const samples = samplesFromEvents([
      { at: t(0), type: "invocation_start" },
      { at: t(5), type: "item_done", item: 1, costUsd: 1 },
    ]);
    expect(samples[0]?.points).toBeUndefined();
    expect(samples[0]?.activeMs).toBe(5 * MIN);
  });

  it("reads every run's journal, skipping damaged lines", async () => {
    const dir = path.join(await tempHome(), ".nightshift");
    expect(await readHistory(dir)).toEqual([]);
    await mkdir(path.join(dir, "runs", "b"), { recursive: true });
    await mkdir(path.join(dir, "runs", "a"), { recursive: true });
    await mkdir(path.join(dir, "runs", "empty"), { recursive: true });
    const line = (minutes: number, points: number) =>
      JSON.stringify({
        at: t(minutes),
        type: "item_done",
        item: 1,
        costUsd: 1,
        usagePoints: { five_hour: points },
        activeMs: MIN,
      });
    await writeFile(path.join(dir, "runs", "b", "events.jsonl"), `${line(20, 2)}\n{"at":`);
    await writeFile(path.join(dir, "runs", "a", "events.jsonl"), `${line(10, 1)}\n\n`);
    const samples = await readHistory(dir);
    expect(samples.map((s) => s.points?.five_hour)).toEqual([1, 2]);
  });
});

// ── active hours ─────────────────────────────────────────────────────────

describe("how long active hours last", () => {
  it("finds the end of the current range, across midnight and through touching ranges", () => {
    const night = [range("23:00-07:00")];
    expect(activeUntil(night, at(23, 30))).toEqual(at(7, 0, 5));
    expect(activeUntil(night, at(6, 30))).toEqual(at(7));
    expect(activeUntil(night, at(12))).toBeUndefined();
    expect(activeUntil([], at(12))).toBeUndefined();
    const touching = [range("22:00-24:00"), range("00:00-06:00")];
    expect(activeUntil(touching, at(23))).toEqual(at(6, 0, 5));
    expect(activeUntil([range("00:00-12:00"), range("12:00-24:00")], at(9))).toBeUndefined();
    expect(longestActiveMs(night, at(12))).toBe(8 * 60 * MIN);
    expect(longestActiveMs([range("01:00-02:00"), range("13:00-17:00")], at(12))).toBe(
      4 * 60 * MIN,
    );
  });
});

// ── the start-or-wait decision ───────────────────────────────────────────

describe("deciding whether a new item fits", () => {
  const nine = Array.from({ length: 9 }, (_, i) => sample(6, 40, 3, i));
  const resets = new Date(at(3).getTime() + 2 * 60 * MIN).toISOString();
  const ctx = (overrides: Partial<ForecastContext>): ForecastContext => ({
    estimate: estimateItem(nine),
    limits: limits(""),
    tally: {},
    windows: { five_hour: { utilization: 30, resetsAt: resets } },
    ranges: [],
    now: at(3),
    ...overrides,
  });

  it("starts without enough history", () => {
    const decision = decideStart(ctx({ estimate: estimateItem(nine.slice(0, 2)) }));
    expect(decision).toEqual({
      start: true,
      reason: "not enough history to forecast yet (2 finished items; need 3)",
    });
  });

  it("waits for the reset when the rest of the share is too small", () => {
    const share = limits("[usage]\nsession_share = 15");
    const tally = { five_hour: { resetsAt: resets, used: 10 } };
    const decision = decideStart(ctx({ limits: share, tally }));
    expect(decision).toMatchObject({
      start: false,
      kind: "usage",
      window: "five_hour",
      until: resets,
    });
    expect(decision.reason).toBe(
      "a typical item uses ~6 points of the 5-hour window (median of 9 items), but 5 of nightshift's 15-point share left (session_share = 15)",
    );
    expect(
      decideStart(ctx({ limits: share, tally: { five_hour: { resetsAt: resets, used: 9 } } })),
    ).toMatchObject({ start: true, reason: expect.stringContaining("the next item fits") });
    // The plan's own limit caps the share: at 96% only 4 points are left for anyone.
    const full = decideStart(
      ctx({
        limits: share,
        tally: {},
        windows: { five_hour: { utilization: 96, resetsAt: resets } },
      }),
    );
    expect(full).toMatchObject({ start: false, kind: "usage" });
    expect(full.reason).toContain("but the account's 5-hour usage is at 96%");
    // The reading is from a window that has reset since: all of the share is there again.
    const stale = ctx({ limits: share, tally, now: new Date(Date.parse(resets) + MIN) });
    expect(decideStart(stale).start).toBe(true);
  });

  it("keeps the account under session_max", () => {
    const decision = decideStart(
      ctx({
        limits: limits("[usage]\nsession_max = 35"),
        windows: { five_hour: { utilization: 30, resetsAt: resets } },
      }),
    );
    expect(decision).toMatchObject({ start: false, kind: "usage" });
    expect(decision.reason).toContain("but usage is at 30% (session_max = 35)");
  });

  it("starts an item that could never fit in a window anyway", () => {
    const decision = decideStart(ctx({ limits: limits("[usage]\nsession_share = 5"), tally: {} }));
    expect(decision.start).toBe(true);
    expect(decision.reason).toContain("more than a whole window allows; starting anyway");
  });

  it("waits for the next active hours when the item would not finish before they end", () => {
    const night = [range("23:00-07:00")];
    const decision = decideStart(ctx({ ranges: night, now: at(6, 40) }));
    expect(decision).toMatchObject({ start: false, kind: "schedule", until: at(23) });
    expect(decision.reason).toBe(
      "a typical item takes ~40 min (median of 9 items), but active hours end 07:00, in 20 min",
    );
    expect(decideStart(ctx({ ranges: night, now: at(6) })).start).toBe(true);
    // Longer than the whole night: waiting would not help.
    const long = estimateItem(Array.from({ length: 3 }, () => sample(1, 9 * 60)));
    expect(decideStart(ctx({ estimate: long, ranges: night, now: at(6) })).start).toBe(true);
  });

  it("waits for whichever reason lasts longer", () => {
    const decision = decideStart(
      ctx({
        limits: limits("[usage]\nsession_share = 15"),
        tally: { five_hour: { resetsAt: resets, used: 12 } },
        ranges: [range("23:00-07:00")],
        now: at(6, 40),
      }),
    );
    expect(decision).toMatchObject({ start: false, kind: "schedule" });
  });

  it("describes how many more items fit", () => {
    const lines = describeForecast(
      ctx({
        limits: limits("[usage]\nsession_share = 30"),
        tally: { five_hour: { resetsAt: at(7).toISOString(), used: 12 } },
        windows: { five_hour: { utilization: 30, resetsAt: at(7).toISOString() } },
        ranges: [range("23:00-07:00")],
        now: at(5, 30),
      }),
    );
    expect(lines).toEqual([
      "a typical item: ~6 points of the 5-hour window, ~0.6 points of the weekly window, ~40 min, ~$3.00 (median of the last 9 items)",
      "~3 more items fit in this 5-hour window (resets 07:00) at ~6 points each (median of 9 items)",
      "active hours end 07:00 — ~2 items of ~40 min (median of 9 items)",
    ]);
    const outside = describeForecast(ctx({ ranges: [range("23:00-07:00")], now: at(12) }));
    expect(outside).toContain(
      "active hours start 23:00 and end Thu 5 Nov 07:00 — ~12 items of ~40 min (median of 9 items)",
    );
    // Without limits, room is what is left of the account's window.
    expect(describeForecast(ctx({}))[1]).toMatch(/^~11 more items fit in this 5-hour window/);
    expect(describeForecast(ctx({ estimate: estimateItem([]) }))).toEqual([
      "not enough history to forecast yet (0 finished items; need 3)",
    ]);
  });
});

describe("forecast events in nightshift watch", () => {
  it("describes forecasts and forecast waits", () => {
    expect(
      describeEvent({ at: "", type: "forecast", item: 2, start: false, reason: "too big" }),
    ).toEqual({ text: "item 2 · forecast: too big", style: "yellow" });
    expect(
      describeEvent({ at: "", type: "forecast", item: 2, start: true, reason: "fits" }),
    ).toEqual({ text: "item 2 · forecast: fits" });
    expect(
      describeEvent({ at: "", type: "forecast_wait", reason: "forecast: x", until: "nonsense" })
        .text,
    ).toMatch(/^waiting until .*: forecast: x$/);
  });
});

describe("forecast config", () => {
  it("is optional, validated, and in init's template", () => {
    const config = parseConfig('[repos]\na = "."', "/h");
    expect(config.usage.start_item_only_if_it_fits).toBeUndefined();
    expect(config.usage.forecast_percentile).toBe(50);
    expect(() => parseConfig('[repos]\na = "."\n[usage]\nforecast_percentile = 20', "/h")).toThrow(
      ConfigError,
    );
    const template = parseConfig(configTemplate("app", false), "/h");
    expect(template.usage.forecast_percentile).toBe(50);
    expect(configTemplate("app", false)).toContain("start_item_only_if_it_fits");
  });
});

// ── the pipeline ─────────────────────────────────────────────────────────

const implement = (pr: number) => ({
  structured: { status: "pr_opened", item: `T${pr}`, summary: "implemented", pr_number: pr },
});
const ready = { structured: { status: "ready", pushed_changes: false, summary: "addressed" } };
const next = (prompt: string) => ({
  structured: { status: "continue", summary: "done", next_repo: "main", next_prompt: prompt },
});
const allDone = { structured: { status: "all_done", summary: "nothing left" } };
const using =
  (plan: SimulatedPlan, points: number, result: object) =>
  (_request: AgentRequest): object => {
    plan.use(points);
    return result;
  };

/** Earlier runs in which every item used `points` of the 5-hour window and took `minutes`. */
async function seedHistory(h: Harness, points: number, minutes: number, count = 3) {
  const dir = h.store.runDir("20261101-000000-past");
  await mkdir(dir, { recursive: true });
  const lines = Array.from({ length: count }, (_, i) =>
    JSON.stringify({
      at: new Date(Date.UTC(2026, 10, 1, i)).toISOString(),
      type: "item_done",
      item: i + 1,
      costUsd: 2,
      usagePoints: { five_hour: points, seven_day: 0 },
      activeMs: minutes * MIN,
    }),
  );
  await writeFile(path.join(dir, "events.jsonl"), `${lines.join("\n")}\n`);
}

function start(h: Harness, agent: FakeAgent, plan?: SimulatedPlan, state?: RunState) {
  const s = state ?? newRunState("run-1", h.host.now(), "main", "do task one");
  const pipeline = new Pipeline(
    {
      config: h.config,
      templates: h.templates,
      agent,
      forge: h.forge,
      reviewer: h.reviewer,
      host: h.host,
      store: h.store,
      ...(plan === undefined ? {} : { usage: plan }),
    },
    s,
  );
  return { state: s, pipeline, signal: new AbortController().signal };
}

async function events(h: Harness): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path.join(h.store.runDir("run-1"), "events.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("pipeline: starting a new item only if it fits", () => {
  it("waits for the window reset instead of starting an item the share cannot finish", async () => {
    const h = await harness("[usage]\nsession_share = 14");
    await seedHistory(h, 6, 30);
    h.forge.addPr(11);
    h.forge.addPr(12);
    const plan = new SimulatedPlan(h.host);
    const agent = new FakeAgent([
      using(plan, 3, implement(11)),
      using(plan, 3, ready),
      using(plan, 3, next("do task two")),
      using(plan, 3, implement(12)),
      using(plan, 2, ready),
      using(plan, 1, allDone),
    ]);
    const { pipeline, signal, state } = start(h, agent, plan);
    const startedAt = h.host.now().getTime();
    let secondStartedAt = 0;
    const run = agent.run.bind(agent);
    agent.run = (request) => {
      if (agent.requests.length === 3) secondStartedAt = h.host.now().getTime();
      return run(request);
    };

    const exit = await pipeline.run({ signal });

    expect(exit.kind).toBe("done");
    expect(state.itemsCompleted).toBe(2);
    // 9 of 14 points used by item 1: a typical item (6) does not fit in the 5 left, so item 2
    // started in the next window rather than being cut part-way.
    expect(secondStartedAt - startedAt).toBeGreaterThanOrEqual(FIVE_HOURS_MS);
    expect(agent.requests[3]?.prompt).toContain("do task two");
    expect(
      h.host.logs.some((l) =>
        l.includes(
          // this run's first item counts too: 6, 6, 6 and 9 points
          "forecast: a typical item uses ~6 points of the 5-hour window (median of 4 items), but 5 of nightshift's 14-point share left",
        ),
      ),
    ).toBe(true);
    expect(h.host.logs.some((l) => l.includes("before starting a new item"))).toBe(true);
    // Nothing was cut: the limit was never crossed mid-step.
    const all = await events(h);
    expect(all.some((e) => e.type === "usage_cut")).toBe(false);
    expect(all.filter((e) => e.type === "forecast_wait")).toHaveLength(1);
    expect(all.filter((e) => e.type === "forecast").map((e) => e.start)).toEqual([
      true,
      false,
      true,
    ]);
    // item_done records what forecasts need.
    const done = all.filter((e) => e.type === "item_done");
    expect(done[0]).toMatchObject({ usagePoints: { five_hour: 9 }, activeMs: expect.any(Number) });
    expect(done[1]).toMatchObject({ usagePoints: { five_hour: 6 } });
    expect(state.waiting).toBeUndefined();
  });

  it("pauses instead with on_limit = halt, and starts once it fits", async () => {
    const h = await harness('[usage]\nsession_share = 14\non_limit = "halt"');
    await seedHistory(h, 6, 30);
    h.forge.addPr(11);
    const plan = new SimulatedPlan(h.host);
    const state = newRunState("run-1", h.host.now(), "main", "do task one");
    state.usage = {
      tally: { five_hour: { resetsAt: new Date(plan.resetsAt).toISOString(), used: 10 } },
    };
    const agent = new FakeAgent([]);
    const exit = await start(h, agent, plan, state).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(exit.kind).toBe("paused");
    expect(exit.reason).toContain("forecast: a typical item uses ~6 points");
    expect(exit.reason).toContain("not starting a new item before the 5-hour window resets");
    expect(agent.requests).toHaveLength(0);
    // The daemon resumes it once the window has reset.
    expect(state.stop).toMatchObject({ kind: "paused", cause: "forecast_usage" });
    expect(Date.parse(state.stop?.resumeAt ?? "")).toBeGreaterThanOrEqual(plan.resetsAt);
    const report = await readFile(path.join(h.config.dir, "report.md"), "utf8");
    expect(report).toContain("## Forecast");
    expect(report).toContain("held back item 1: a typical item uses ~6 points");
    expect(state.item?.startedAt).toBeUndefined();

    h.host.time = new Date(plan.resetsAt + 1000);
    const resumed = new FakeAgent([implement(11), ready, allDone]);
    const second = await start(h, resumed, plan, state).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(second.kind).toBe("done");
  });

  it("does not hold back an item that is already under way", async () => {
    const h = await harness("[usage]\nsession_share = 14");
    await seedHistory(h, 6, 30);
    h.forge.addPr(11);
    const plan = new SimulatedPlan(h.host);
    const state = newRunState("run-1", h.host.now(), "main", "do task one");
    state.usage = {
      tally: { five_hour: { resetsAt: new Date(plan.resetsAt).toISOString(), used: 10 } },
    };
    if (state.item) state.item.startedAt = h.host.now().toISOString(); // e.g. implement failed
    const agent = new FakeAgent([using(plan, 1, implement(11)), ready, allDone]);
    const exit = await start(h, agent, plan, state).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(exit.kind).toBe("done");
    expect(h.host.logs.some((l) => l.includes("forecast:"))).toBe(false);
  });

  it("waits for the next active hours when an item would not finish before they end", async () => {
    const h = await harness();
    await seedHistory(h, 6, 40);
    h.config.schedule.active_hours = [range("23:00-07:00")];
    h.host.time = at(6, 40);
    h.forge.addPr(11);
    const agent = new FakeAgent([implement(11), ready, allDone]);
    let startedAt: Date | undefined;
    const run = agent.run.bind(agent);
    agent.run = (request) => {
      startedAt ??= h.host.now();
      return run(request);
    };
    const exit = await start(h, agent).pipeline.run({ signal: new AbortController().signal });
    expect(exit.kind).toBe("done");
    expect(startedAt?.getTime()).toBeGreaterThanOrEqual(at(23).getTime());
    expect(
      h.host.logs.some((l) =>
        l.includes(
          "forecast: a typical item takes ~40 min (median of 3 items), but active hours end 07:00, in 20 min",
        ),
      ),
    ).toBe(true);
  });

  it("pauses outside the remaining hours with outside_hours = halt", async () => {
    const h = await harness();
    await seedHistory(h, 6, 40);
    h.config.schedule.active_hours = [range("23:00-07:00")];
    h.config.schedule.outside_hours = "halt";
    h.host.time = at(6, 40);
    const agent = new FakeAgent([]);
    const { pipeline, state } = start(h, agent);
    const exit = await pipeline.run({ signal: new AbortController().signal });
    expect(exit.kind).toBe("paused");
    expect(exit.reason).toContain("not starting a new item before active hours start again 23:00");
    expect(state.stop).toMatchObject({
      cause: "forecast_hours",
      resumeAt: at(23).toISOString(),
    });
  });

  it("starts with too little history, and can be turned off", async () => {
    const h = await harness("[usage]\nsession_share = 14");
    await seedHistory(h, 6, 30, 2);
    h.forge.addPr(11);
    const plan = new SimulatedPlan(h.host);
    const agent = new FakeAgent([implement(11), ready, allDone]);
    const exit = await start(h, agent, plan).pipeline.run({ signal: new AbortController().signal });
    expect(exit.kind).toBe("done");
    expect(
      h.host.logs.some((l) =>
        l.includes("forecast: not enough history to forecast yet (2 finished items; need 3)"),
      ),
    ).toBe(true);

    const off = await harness("[usage]\nsession_share = 14\nstart_item_only_if_it_fits = false");
    await seedHistory(off, 6, 30);
    off.forge.addPr(11);
    const offPlan = new SimulatedPlan(off.host);
    const state = newRunState("run-1", off.host.now(), "main", "do task one");
    state.usage = {
      tally: { five_hour: { resetsAt: new Date(offPlan.resetsAt).toISOString(), used: 10 } },
    };
    const offAgent = new FakeAgent([implement(11), ready, allDone]);
    const offExit = await start(off, offAgent, offPlan, state).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(offExit.kind).toBe("done");
    expect(off.host.logs.some((l) => l.includes("forecast:"))).toBe(false);
  });

  it("records an item's active time without usage waits", async () => {
    const h = await harness("[usage]\nsession_share = 10\n[checks]\npoll_seconds = 60");
    h.forge.addPr(11, {}, [PENDING, PENDING, PASSED]);
    const plan = new SimulatedPlan(h.host);
    const agent = new FakeAgent([
      using(plan, 4, implement(11)),
      using(plan, 8, ready), // crosses the share: the finalize step waits for the reset
      allDone,
    ]);
    const { pipeline, signal } = start(h, agent, plan);
    const exit = await pipeline.run({ signal });
    expect(exit.kind).toBe("done");
    const done = (await events(h)).find((e) => e.type === "item_done");
    const activeMs = done?.activeMs as number;
    // Two CI polls of a minute, plus usage re-reads; not the five hours of waiting.
    expect(activeMs).toBeGreaterThanOrEqual(2 * MIN);
    expect(activeMs).toBeLessThan(10 * MIN);
    expect(h.host.logs.some((l) => l.includes("waiting until"))).toBe(true);
  });
});
