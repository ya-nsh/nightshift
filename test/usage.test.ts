import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";
import { configTemplate } from "../src/init.js";
import { newRunState, Pipeline } from "../src/pipeline.js";
import type { AgentRequest, UsageWindows } from "../src/ports.js";
import type { RunState } from "../src/state.js";
import {
  account,
  ClaudeUsageMeter,
  limitHit,
  parseUsageResponse,
  sameWindow,
  type UsageTally,
  usageLimits,
} from "../src/usage.js";
import {
  FakeAgent,
  FIVE_HOURS_MS,
  type Harness,
  harness,
  SimulatedPlan,
  untilAborted,
} from "./fakes.js";

const R1 = "2026-11-04T05:00:00.123456+00:00";
const R1_JITTER = "2026-11-04T05:00:00.987654+00:00";
const R2 = "2026-11-04T10:00:00.5+00:00";
const win = (utilization: number, resetsAt: string | undefined = R1): UsageWindows => ({
  five_hour: { utilization, resetsAt },
});

describe("usage arithmetic", () => {
  it("treats reset times with sub-second jitter as the same window", () => {
    expect(sameWindow(R1, R1_JITTER)).toBe(true);
    expect(sameWindow(R1, R2)).toBe(false);
    expect(sameWindow(undefined, undefined)).toBe(true);
    expect(sameWindow(undefined, R1)).toBe(false);
  });

  it("counts only what changed during nightshift's own steps", () => {
    const tally: UsageTally = {};
    expect(account(tally, win(10), win(16, R1_JITTER))).toEqual({ five_hour: 6 });
    // 20 points of interactive use happened between steps: not nightshift's.
    expect(account(tally, win(36), win(40))).toEqual({ five_hour: 4 });
    expect(tally.five_hour?.used).toBe(10);
    // Utilization never counts negatively.
    account(tally, win(40), win(38));
    expect(tally.five_hour?.used).toBe(10);
  });

  it("starts a new tally when the window resets, even part-way through a step", () => {
    const tally: UsageTally = { five_hour: { resetsAt: R1, used: 14 } };
    expect(account(tally, win(90), win(3, R2))).toEqual({ five_hour: 3 });
    expect(tally.five_hour).toEqual({ resetsAt: R2, used: 3 });
    // A window that had no usage yet has no reset time; its first use starts it.
    const fresh: UsageTally = {};
    account(fresh, win(0, undefined), win(2, R2));
    expect(fresh.five_hour).toEqual({ resetsAt: R2, used: 2 });
  });

  it("reports the first limit reached", () => {
    const config = parseConfig(
      '[repos]\na = "."\n[usage]\nsession_share = 15\nweekly_max = 80',
      "/h",
    );
    const limits = usageLimits(config.usage);
    const weekly = { utilization: 50, resetsAt: "2026-11-10T00:00:00Z" };
    const tally: UsageTally = { five_hour: { resetsAt: R1, used: 15 } };
    expect(limitHit(limits, tally, { ...win(30, R1_JITTER), seven_day: weekly })?.reason).toBe(
      "nightshift used 15 of its 15-point share of the 5-hour window (session_share = 15)",
    );
    // Once the window has reset, the old tally no longer applies.
    expect(limitHit(limits, tally, { ...win(30, R2), seven_day: weekly })).toBeUndefined();
    expect(
      limitHit(limits, {}, { ...win(30), seven_day: { ...weekly, utilization: 80 } })?.reason,
    ).toBe("weekly usage is at 80% (weekly_max = 80)");
    // --usage-share overrides session_share.
    expect(limitHit(usageLimits(config.usage, 20), tally, win(30))).toBeUndefined();
  });
});

describe("usage config", () => {
  it("defaults to no limits and validates percentages", () => {
    const config = parseConfig('[repos]\na = "."', "/h");
    expect(config.usage).toEqual({
      session_share: 0,
      session_max: 0,
      weekly_share: 0,
      weekly_max: 0,
      on_limit: "wait",
      check_seconds: 60,
    });
    expect(() => parseConfig('[repos]\na = "."\n[usage]\nsession_share = 101', "/h")).toThrow(
      ConfigError,
    );
    expect(() => parseConfig('[repos]\na = "."\n[usage]\non_limit = "panic"', "/h")).toThrow(
      ConfigError,
    );
  });

  it("is in init's template", () => {
    const config = parseConfig(configTemplate("app", false), "/h");
    expect(config.usage.on_limit).toBe("wait");
    expect(configTemplate("app", false)).toContain("session_share");
  });
});

describe("reading usage from Claude Code", () => {
  // Trimmed from a real `get_usage` answer (Claude Code 2.1.283, Max plan).
  const real = JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "nightshift-usage",
      response: {
        session: { total_cost_usd: 0 },
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 19, resets_at: "2026-11-08T17:00:00.387189+00:00" },
          seven_day: { utilization: 33, resets_at: "2026-11-11T22:00:00.387205+00:00" },
          seven_day_opus: null,
        },
      },
    },
  });

  it("parses the control response", () => {
    expect(parseUsageResponse(`{"type":"system"}\nnot json\n${real}\n`)).toEqual({
      ok: true,
      plan: "max",
      windows: {
        five_hour: { utilization: 19, resetsAt: "2026-11-08T17:00:00.387189+00:00" },
        seven_day: { utilization: 33, resetsAt: "2026-11-11T22:00:00.387205+00:00" },
      },
    });
  });

  it("reports logins without plan limits, refusals and silence as unavailable", () => {
    const apiKey = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "nightshift-usage",
        response: { rate_limits_available: false, rate_limits: null },
      },
    });
    expect(parseUsageResponse(apiKey)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("no plan usage limits"),
    });
    const refused = JSON.stringify({
      type: "control_response",
      response: { subtype: "error", request_id: "nightshift-usage", error: "unknown subtype" },
    });
    expect(parseUsageResponse(refused)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("unknown subtype"),
    });
    expect(parseUsageResponse("")).toMatchObject({ ok: false });
  });

  it("sends a get_usage control request to the claude executable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ns-fake-claude-"));
    const fake = path.join(dir, "claude");
    await writeFile(
      fake,
      `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  require("fs").writeFileSync(${JSON.stringify(path.join(dir, "seen.json"))}, JSON.stringify({ input, args: process.argv.slice(2) }));
  console.log(${JSON.stringify(real)});
});
`,
    );
    await chmod(fake, 0o755);
    const reading = await new ClaudeUsageMeter(fake, dir).read();
    expect(reading).toMatchObject({ ok: true, windows: { five_hour: { utilization: 19 } } });
    const seen = JSON.parse(await readFile(path.join(dir, "seen.json"), "utf8"));
    expect(JSON.parse(seen.input)).toMatchObject({
      type: "control_request",
      request: { subtype: "get_usage" },
    });
    expect(seen.args).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
    ]);

    await writeFile(fake, "#!/bin/sh\necho 'Not logged in' >&2\nexit 1\n");
    expect(await new ClaudeUsageMeter(fake, dir).read()).toMatchObject({
      ok: false,
      detail: expect.stringContaining("Not logged in"),
    });
    expect(await new ClaudeUsageMeter(path.join(dir, "missing"), dir).read()).toMatchObject({
      ok: false,
    });
  });
});

// ── the pipeline under a usage budget ────────────────────────────────────

const implement = (pr: number) => ({
  structured: { status: "pr_opened", item: `T${pr}`, summary: "implemented", pr_number: pr },
});
const ready = { structured: { status: "ready", pushed_changes: false, summary: "addressed" } };
const next = (prompt: string) => ({
  structured: { status: "continue", summary: "done", next_repo: "main", next_prompt: prompt },
});
const allDone = { structured: { status: "all_done", summary: "nothing left" } };

/** Each scripted step uses `points` of the plan while it runs. */
const using =
  (plan: SimulatedPlan, points: number, result: object) =>
  (_request: AgentRequest): object => {
    plan.use(points);
    return result;
  };

function start(h: Harness, agent: FakeAgent, plan: SimulatedPlan, state?: RunState) {
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
      usage: plan,
    },
    s,
  );
  return { state: s, pipeline, signal: new AbortController().signal };
}

describe("pipeline with a usage budget", () => {
  it("does not read usage when no limits are set", async () => {
    const h = await harness();
    h.forge.addPr(11);
    const plan = new SimulatedPlan(h.host);
    const agent = new FakeAgent([implement(11), ready, allDone]);
    const exit = await start(h, agent, plan).pipeline.run({ signal: new AbortController().signal });
    expect(exit.kind).toBe("done");
    expect(plan.reads).toBe(0);
  });

  it("waits for the 5-hour window to reset once nightshift used its share, then continues", async () => {
    const h = await harness("[usage]\nsession_share = 15");
    h.forge.addPr(11);
    h.forge.addPr(12);
    const plan = new SimulatedPlan(h.host);
    const agent = new FakeAgent([
      using(plan, 6, implement(11)),
      using(plan, 6, ready),
      using(plan, 6, next("do task two")),
      using(plan, 6, implement(12)),
      using(plan, 6, ready),
      using(plan, 6, allDone),
    ]);
    const { pipeline, signal, state } = start(h, agent, plan);
    const startedAt = h.host.now().getTime();

    const exit = await pipeline.run({ signal });

    expect(exit.kind).toBe("done");
    expect(state.itemsCompleted).toBe(2);
    // 6 + 6 + 6 = 18 ≥ 15 after item 1, so item 2 started only after the window reset.
    expect(h.host.now().getTime() - startedAt).toBeGreaterThanOrEqual(FIVE_HOURS_MS);
    expect(h.host.logs.some((l) => l.includes("waiting until"))).toBe(true);
    expect(agent.requests[3]?.prompt).toContain("do task two");
    expect(state.usage?.tally.five_hour?.used).toBe(18);
    expect(state.usage?.waitingUntil).toBeUndefined();
    const events = await readFile(path.join(h.store.runDir("run-1"), "events.jsonl"), "utf8");
    expect(events).toContain('"type":"usage_wait"');
    expect(events).toContain('"type":"usage","item":1,"step":"implement","points":{"five_hour":6');
  });

  it("does not count usage from outside its own steps", async () => {
    const h = await harness("[usage]\nsession_share = 15");
    h.forge.addPr(11);
    const plan = new SimulatedPlan(h.host);
    const pullRequest = h.forge.pullRequest.bind(h.forge);
    let outside = true;
    h.forge.pullRequest = (slug, n) => {
      if (outside) plan.use(50); // e.g. an interactive session while CI runs
      outside = false;
      return pullRequest(slug, n);
    };
    const agent = new FakeAgent([
      using(plan, 5, implement(11)),
      using(plan, 5, ready),
      using(plan, 1, allDone),
    ]);
    const { pipeline, signal, state } = start(h, agent, plan);
    const exit = await pipeline.run({ signal });
    expect(exit.kind).toBe("done");
    expect(plan.utilization).toBe(61);
    expect(state.usage?.tally.five_hour?.used).toBe(11);
    expect(h.host.logs.some((l) => l.includes("waiting until"))).toBe(false);
  });

  it("stops a step that crosses the limit, waits, and restarts it", async () => {
    const h = await harness("[usage]\nsession_share = 15\ncheck_seconds = 30");
    h.forge.addPr(11);
    const plan = new SimulatedPlan(h.host);
    let cutSignal: AbortSignal | undefined;
    const agent = new FakeAgent([
      async (request) => {
        plan.use(20);
        cutSignal = request.signal;
        await untilAborted(request.signal);
        return { outcome: "aborted", costUsd: 0, sessionId: undefined };
      },
      using(plan, 2, implement(11)),
      using(plan, 2, ready),
      using(plan, 2, allDone),
    ]);
    const { pipeline, signal, state } = start(h, agent, plan);

    const exit = await pipeline.run({ signal });

    expect(exit.kind).toBe("done");
    expect(cutSignal?.aborted).toBe(true);
    expect(signal.aborted).toBe(false);
    expect(h.host.sleeps[0]).toBe(30_000);
    expect(h.host.logs.some((l) => l.includes("usage limit reached during implement"))).toBe(true);
    // The restarted implement runs in the next window, told that it was interrupted.
    expect(agent.requests[1]?.prompt).toContain("was interrupted");
    expect(agent.requests[1]?.resumeSessionId).toBeUndefined();
    expect(state.item).toBeUndefined();
    expect(state.usage?.tally.five_hour?.used).toBe(6);
    const events = await readFile(path.join(h.store.runDir("run-1"), "events.jsonl"), "utf8");
    expect(events).toContain('"type":"usage_cut"');
  });

  it("keeps the human's answer when the usage limit stops the step it was given to", async () => {
    const h = await harness('[usage]\nsession_share = 15\non_limit = "halt"');
    h.forge.addPr(11);
    const plan = new SimulatedPlan(h.host);
    const state = newRunState("run-1", h.host.now(), "main", "do task one");
    if (state.item) state.item.pendingQuestion = "which database?";
    state.status = "halted";
    const agent = new FakeAgent([
      async (request) => {
        plan.use(20);
        await untilAborted(request.signal);
        return { outcome: "aborted", costUsd: 0 };
      },
    ]);
    const first = await start(h, agent, plan, state).pipeline.run({
      signal: new AbortController().signal,
      answer: "postgres",
    });
    expect(first.kind).toBe("paused");
    expect(first.reason).toContain("usage limit: nightshift used 20 of its 15-point share");
    expect(state.item?.pendingAnswer).toBe("postgres");
    expect(state.item?.interruptedPhase).toBe("implement");

    h.host.time = new Date(h.host.time.getTime() + FIVE_HOURS_MS);
    const resumed = new FakeAgent([implement(11), ready, allDone]);
    const second = await start(h, resumed, plan, state).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(second.kind).toBe("done");
    expect(resumed.requests[0]?.prompt).toContain("postgres");
    expect(resumed.requests[0]?.prompt).toContain("was interrupted");
  });

  it("pauses at session_max with on_limit = halt, without starting a step", async () => {
    const h = await harness('[usage]\nsession_max = 40\non_limit = "halt"');
    const plan = new SimulatedPlan(h.host);
    plan.use(50);
    const agent = new FakeAgent([]);
    const exit = await start(h, agent, plan).pipeline.run({ signal: new AbortController().signal });
    expect(exit.kind).toBe("paused");
    expect(exit.reason).toContain("5-hour usage is at 50% (session_max = 40)");
    expect(agent.requests).toHaveLength(0);
  });

  it("halts when usage cannot be read while limits are set", async () => {
    const h = await harness("[usage]\nsession_share = 15");
    const plan = new SimulatedPlan(h.host);
    plan.failure = "claude exited 1: Not logged in";
    const exit = await start(h, new FakeAgent([]), plan).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(exit.kind).toBe("halted");
    expect(exit.reason).toContain("cannot read Claude plan usage");
    expect(exit.reason).toContain("Not logged in");
    expect(plan.reads).toBe(3);
  });

  it("applies --usage-share from the run state over the config, and counts the review", async () => {
    const h = await harness('[usage]\nsession_share = 50\non_limit = "halt"');
    h.forge.addPr(11);
    const plan = new SimulatedPlan(h.host);
    const reviewer = h.reviewer;
    const run = reviewer.run.bind(reviewer);
    reviewer.run = (request) => {
      plan.use(3); // e.g. `claude -p "/code-review …"`
      return run(request);
    };
    const state = newRunState("run-1", h.host.now(), "main", "do task one");
    state.usageShare = 5;
    const agent = new FakeAgent([using(plan, 4, implement(11))]);
    const exit = await start(h, agent, plan, state).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(exit.kind).toBe("paused");
    expect(exit.reason).toContain("nightshift used 7 of its 5-point share");
    expect(state.item?.phase).toBe("address");
  });

  it("stops waiting when asked to", async () => {
    const h = await harness("[usage]\nsession_max = 10");
    const plan = new SimulatedPlan(h.host);
    plan.use(20);
    const sleep = h.host.sleep.bind(h.host);
    h.host.sleep = (ms) => {
      if (h.host.sleeps.length === 2) h.host.stop = true;
      return sleep(ms);
    };
    const exit = await start(h, new FakeAgent([]), plan).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(exit.kind).toBe("paused");
    expect(exit.reason).toBe("stop requested (STOP file)");
    expect(h.host.sleeps.every((ms) => ms <= 60_000)).toBe(true);
  });
});
