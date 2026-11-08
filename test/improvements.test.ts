import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCliAgent } from "../src/agent/cli.js";
import { describeToolInput, toAgentEvents } from "../src/agent/events.js";
import {
  buildSdkOptions,
  ClaudeSdkAgent,
  type QueryFn,
  resolveClaudePath,
  toSdkExtraArgs,
} from "../src/agent/sdk.js";
import { ConfigError, parseConfig } from "../src/config.js";
import { exec } from "../src/exec.js";
import { toPullRequest } from "../src/github.js";
import { configTemplate } from "../src/init.js";
import { newRunState, Pipeline } from "../src/pipeline.js";
import type { AgentEvent, AgentRequest } from "../src/ports.js";
import { isActive, nextStart, parseRange, type TimeRange } from "../src/schedule.js";
import { Lock, LockedError, lockHolder, type RunState, StateStore } from "../src/state.js";
import {
  FakeAgent,
  failedChecks,
  type Harness,
  harness,
  PASSED,
  SimulatedPlan,
  tempHome,
  untilAborted,
} from "./fakes.js";

const request = (overrides: Partial<AgentRequest> = {}): AgentRequest => ({
  cwd: "/repo",
  prompt: "hello",
  schema: { type: "object" },
  maxBudgetUsd: 5,
  artifactPath: path.join(tmpdir(), `ns-artifact-${process.pid}-${Math.random()}.jsonl`),
  signal: new AbortController().signal,
  ...overrides,
});

const implement = (pr: number) => ({
  structured: { status: "pr_opened", item: `T${pr}`, summary: "implemented", pr_number: pr },
});
const ready = { structured: { status: "ready", pushed_changes: false, summary: "addressed" } };
const allDone = { structured: { status: "all_done", summary: "nothing left" } };

function start(h: Harness, agent: FakeAgent, state?: RunState, plan?: SimulatedPlan) {
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

// ── exec ──────────────────────────────────────────────────────────────────

describe("exec streaming and graceful stops", () => {
  it("delivers stdout line by line, including a last line without a newline", async () => {
    const lines: string[] = [];
    await exec("/bin/sh", ["-c", "printf 'a\\nb\\n'; sleep 0.05; printf 'c'"], {
      onStdoutLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(["a", "b", "c"]);
  });

  it("sends SIGINT first, so the program can report before it exits", async () => {
    const controller = new AbortController();
    const running = exec(
      "/bin/sh",
      ["-c", "trap 'echo reported; exit 0' INT; while true; do sleep 0.05; done"],
      { signal: controller.signal, stopSignal: "SIGINT" },
    );
    setTimeout(() => controller.abort(), 150);
    const result = await running;
    expect(result.aborted).toBe(true);
    expect(result.stdout).toContain("reported");
  });
});

// ── Claude's streamed messages ───────────────────────────────────────────

describe("streamed Claude messages", () => {
  it("turns tool calls and rate limit events into progress", () => {
    const tool = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Running the tests" },
          { type: "tool_use", name: "Bash", input: { command: "npm test\n# and more" } },
          { type: "tool_use", name: "Edit", input: { file_path: "/repo/src/a.ts" } },
          { type: "tool_use", name: "StructuredOutput", input: { answer: "ok" } },
        ],
      },
    };
    expect(toAgentEvents(tool, "/repo")).toEqual([
      { type: "tool", name: "Bash", detail: "npm test" },
      { type: "tool", name: "Edit", detail: "src/a.ts" },
    ]);
    // A real event (Claude Code 2.1.283), with utilization as a fraction and epoch seconds.
    const limit = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "five_hour",
        unifiedWindows: {
          five_hour: { utilization: 0.29, resetsAt: 1794157200 },
          seven_day: { utilization: 0.34, resetsAt: 1794434400 },
        },
      },
    };
    expect(toAgentEvents(limit, "/repo")).toEqual([
      {
        type: "usage",
        windows: {
          five_hour: { utilization: 29, resetsAt: new Date(1794157200 * 1000).toISOString() },
          seven_day: { utilization: 34, resetsAt: new Date(1794434400 * 1000).toISOString() },
        },
      },
    ]);
    expect(toAgentEvents({ type: "rate_limit_event", rate_limit_info: {} }, "/r")).toEqual([]);
    expect(toAgentEvents({ type: "user" }, "/r")).toEqual([]);
  });

  it("describes tool inputs briefly", () => {
    expect(describeToolInput("Read", { file_path: "/elsewhere/x.md" }, "/repo")).toBe(
      "/elsewhere/x.md",
    );
    expect(describeToolInput("Grep", { pattern: "TODO" }, "/repo")).toBe("TODO");
    expect(describeToolInput("Bash", { command: "x".repeat(300) }, "/repo")).toHaveLength(100);
    expect(describeToolInput("mcp__github__get_pr", { id: 1 }, "/repo")).toBe("");
  });
});

// ── CLI backend ──────────────────────────────────────────────────────────

describe("claude CLI backend streaming", () => {
  const agentConfig = parseConfig('[repos]\na = "."', "/h").agent;

  async function fakeClaude(script: string): Promise<{ dir: string; path: string }> {
    const dir = await mkdtemp(path.join(tmpdir(), "ns-fake-claude-"));
    const file = path.join(dir, "claude");
    await writeFile(file, script);
    await chmod(file, 0o755);
    return { dir, path: file };
  }

  it("reports tool calls while running and returns the final result", async () => {
    const claude = await fakeClaude(`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  const out = (m) => console.log(JSON.stringify(m));
  out({ type: "system", subtype: "init", session_id: "s1" });
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } });
  out({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1794157200 } } } });
  out({ type: "result", subtype: "success", is_error: false, session_id: "s1", total_cost_usd: 0.7, structured_output: { ok: 1 } });
});
`);
    const events: AgentEvent[] = [];
    const artifactPath = path.join(claude.dir, "step.jsonl");
    const result = await new ClaudeCliAgent({ ...agentConfig, claude_path: claude.path }).run(
      request({ cwd: claude.dir, artifactPath, onEvent: (e) => events.push(e) }),
    );
    expect(result).toMatchObject({ outcome: "success", costUsd: 0.7, structured: { ok: 1 } });
    expect(events.map((e) => e.type)).toEqual(["tool", "usage"]);
    expect((await readFile(artifactPath, "utf8")).trim().split("\n")).toHaveLength(4);
  });

  it("stops with SIGINT on abort and keeps the cost Claude reports", async () => {
    const claude = await fakeClaude(`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s2" }));
  setInterval(() => {}, 1000);
});
process.on("SIGINT", () => {
  console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "s2", total_cost_usd: 1.25 }));
  process.exit(0);
});
`);
    const controller = new AbortController();
    const running = new ClaudeCliAgent({ ...agentConfig, claude_path: claude.path }).run(
      request({ cwd: claude.dir, signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 300);
    expect(await running).toMatchObject({ outcome: "aborted", costUsd: 1.25, sessionId: "s2" });
  });
});

// ── SDK backend ──────────────────────────────────────────────────────────

describe("Agent SDK backend options and interrupts", () => {
  const sdkConfig = (extra = "") =>
    parseConfig(`[repos]\na = "."\n[agent]\nbackend = "sdk"\n${extra}`, "/h").agent;

  it("maps extra_args to the SDK's extraArgs", () => {
    expect(toSdkExtraArgs(["--foo", "bar", "--baz=1", "--flag", "--debug-to-stderr"])).toEqual({
      foo: "bar",
      baz: "1",
      flag: null,
      "debug-to-stderr": null,
    });
    expect(() => toSdkExtraArgs(["oops"])).toThrow(/expected a --flag/);
    const options = buildSdkOptions(
      sdkConfig('extra_args = ["--foo", "bar"]'),
      request(),
      new AbortController(),
    );
    expect(options).toMatchObject({ extraArgs: { foo: "bar" } });
    expect(options).not.toHaveProperty("pathToClaudeCodeExecutable");
  });

  it("passes a non-default claude_path as pathToClaudeCodeExecutable", async () => {
    expect(resolveClaudePath("claude")).toBeUndefined();
    expect(resolveClaudePath("/opt/claude/bin/claude")).toBe("/opt/claude/bin/claude");
    expect(resolveClaudePath("sh")).toMatch(/\/sh$/);
    expect(() => resolveClaudePath("definitely-not-a-command-xyz")).toThrow(/not found on PATH/);
    const options = buildSdkOptions(
      sdkConfig('claude_path = "/opt/claude"'),
      request(),
      new AbortController(),
    );
    expect(options).toMatchObject({ pathToClaudeCodeExecutable: "/opt/claude" });
  });

  it("interrupts gracefully on abort, reports events, and keeps the cost", async () => {
    let interrupted = false;
    let wake: () => void = () => {};
    const query: QueryFn = (params) => {
      void params;
      const gen = (async function* () {
        yield { type: "system", subtype: "init", session_id: "sdk-2" };
        yield {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "a" } }] },
        };
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: "sdk-2",
          total_cost_usd: 0.9,
        };
      })();
      return Object.assign(gen, {
        interrupt: async () => {
          interrupted = true;
          wake();
        },
      });
    };
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const running = new ClaudeSdkAgent(sdkConfig(), query).run(
      request({ signal: controller.signal, onEvent: (e) => events.push(e) }),
    );
    setTimeout(() => controller.abort(), 20);
    expect(await running).toMatchObject({ outcome: "aborted", costUsd: 0.9, sessionId: "sdk-2" });
    expect(interrupted).toBe(true);
    expect(events).toEqual([{ type: "tool", name: "Read", detail: "a" }]);
  });
});

// ── schedule ─────────────────────────────────────────────────────────────

describe("active hours", () => {
  const range = (text: string) => parseRange(text) as TimeRange;
  const at = (h: number, m = 0, day = 4) => new Date(2026, 10, day, h, m);

  it("parses ranges and rejects nonsense", () => {
    expect(range("23:00-07:00")).toMatchObject({ start: 1380, end: 420 });
    expect(range("9:30 - 17:00")).toMatchObject({ start: 570, end: 1020 });
    expect(parseRange("25:00-07:00")).toMatch(/not a time range/);
    expect(parseRange("07:00-07:00")).toMatch(/empty/);
    expect(() =>
      parseConfig('[repos]\na = "."\n[schedule]\nactive_hours = ["late"]', "/h"),
    ).toThrow(ConfigError);
    const config = parseConfig('[repos]\na = "."\n[schedule]\nactive_hours = "22:00-06:00"', "/h");
    expect(config.schedule.active_hours).toHaveLength(1);
    expect(parseConfig(configTemplate("app", false), "/h").schedule.active_hours).toEqual([]);
  });

  it("knows whether a time is inside, also across midnight, and when the next range starts", () => {
    const night = [range("23:00-07:00")];
    expect(isActive(night, at(23, 30))).toBe(true);
    expect(isActive(night, at(6, 59))).toBe(true);
    expect(isActive(night, at(7, 0))).toBe(false);
    expect(isActive([], at(12))).toBe(true);
    expect(nextStart(night, at(12))).toEqual(at(23));
    expect(nextStart(night, at(23, 30))).toEqual(at(23, 0, 5));
    const two = [range("13:00-14:00"), range("02:00-03:00")];
    expect(nextStart(two, at(10))).toEqual(at(13));
    expect(nextStart(two, at(15))).toEqual(at(2, 0, 5));
  });

  it("waits for active hours before Claude work, and a usage wait cannot end outside them", async () => {
    const h = await harness();
    h.host.time = at(12);
    h.config.schedule.active_hours = [range("23:00-07:00")];
    h.forge.addPr(11);
    const agent = new FakeAgent([implement(11), ready, allDone]);
    const { pipeline, signal, state } = start(h, agent);
    const exit = await pipeline.run({ signal });
    expect(exit.kind).toBe("done");
    expect(h.host.logs.some((l) => l.includes("outside active hours (23:00-07:00)"))).toBe(true);
    expect(h.host.now().getTime()).toBeGreaterThanOrEqual(at(23).getTime());
    expect(state.waiting).toBeUndefined();
  });

  it("pauses outside active hours with outside_hours = halt", async () => {
    const h = await harness();
    h.host.time = at(12);
    h.config.schedule.active_hours = [range("23:00-07:00")];
    h.config.schedule.outside_hours = "halt";
    const agent = new FakeAgent([]);
    const exit = await start(h, agent).pipeline.run({ signal: new AbortController().signal });
    expect(exit.kind).toBe("paused");
    expect(exit.reason).toContain("outside active hours");
    expect(agent.requests).toHaveLength(0);
  });
});

// ── correctness ──────────────────────────────────────────────────────────

describe("resuming", () => {
  it("keeps a human's answer when the step it was given to fails", async () => {
    const h = await harness();
    h.forge.addPr(11);
    const state = newRunState("run-1", h.host.now(), "main", "do task one");
    if (state.items[0]) state.items[0].pendingQuestion = "which database?";
    state.status = "halted";
    const failing = new FakeAgent([{ outcome: "error", detail: "API overloaded" }]);
    const first = await start(h, failing, state).pipeline.run({
      signal: new AbortController().signal,
      answer: "postgres",
    });
    expect(first.kind).toBe("halted");
    expect(state.items[0]?.pendingAnswer).toBe("postgres");

    const agent = new FakeAgent([implement(11), ready, allDone]);
    const second = await start(h, agent, state).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(second.kind).toBe("done");
    expect(agent.requests[0]?.prompt).toContain("postgres");
    expect(agent.requests[1]?.prompt).not.toContain("postgres");
  });

  it("grants fresh CI fix rounds when resumed after the cap", async () => {
    const h = await harness('[checks]\nmax_fix_rounds = 1\n[review]\ncommand = ""');
    h.forge.addPr(11, {}, [failedChecks("test"), failedChecks("test"), failedChecks("test")]);
    const state = newRunState("run-1", h.host.now(), "main", "do task one");
    const first = await start(h, new FakeAgent([implement(11), ready]), state).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(first.kind).toBe("halted");
    expect(first.reason).toContain("checks failed after 1 fix round");
    expect(state.items[0]?.capHit).toBe("fix_checks");

    h.forge.prs.get(11)?.checks.push(PASSED);
    const agent = new FakeAgent([ready, allDone]);
    const second = await start(h, agent, state).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(second.kind).toBe("done");
    expect(agent.requests[0]?.prompt).toContain("test");
    expect(h.host.logs.some((l) => l.includes("1 more fix round"))).toBe(true);
  });

  it("restarts the checks timeout on resume", async () => {
    const h = await harness(
      '[checks]\ntimeout_minutes = 1\npoll_seconds = 30\n[review]\ncommand = ""',
    );
    h.forge.addPr(11, {}, [{ state: "pending", failed: [], pending: ["ci"] }]);
    const state = newRunState("run-1", h.host.now(), "main", "do task one");
    const first = await start(h, new FakeAgent([implement(11)]), state).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(first.reason).toContain("checks timed out");
    const fake = h.forge.prs.get(11);
    if (fake) fake.checks = [{ state: "pending", failed: [], pending: ["ci"] }, PASSED];
    const second = await start(h, new FakeAgent([allDone]), state).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(second.kind).toBe("done");
  });
});

describe("merging under branch protection", () => {
  it("halts with a clear message when an approval is required", async () => {
    const h = await harness('[review]\ncommand = ""');
    h.forge.addPr(11, { mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" });
    const exit = await start(h, new FakeAgent([implement(11)])).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(exit.kind).toBe("halted");
    expect(exit.reason).toContain("needs an approving review before it can merge");
    expect(h.forge.merges).toEqual([]);
  });

  it("enables auto-merge and waits for GitHub to merge with when_blocked = auto", async () => {
    const h = await harness('[review]\ncommand = ""\n[merge]\nwhen_blocked = "auto"');
    const fake = h.forge.addPr(11, {
      mergeStateStatus: "BLOCKED",
      reviewDecision: "REVIEW_REQUIRED",
    });
    let polls = 0;
    const pullRequest = h.forge.pullRequest.bind(h.forge);
    h.forge.pullRequest = async (slug, n) => {
      const pr = await pullRequest(slug, n);
      if (h.forge.autoMerges.length > 0 && ++polls === 3) {
        fake.pr = { ...fake.pr, state: "MERGED", mergeCommitSha: "auto-sha" };
        return { ...fake.pr };
      }
      return pr;
    };
    const agent = new FakeAgent([implement(11), allDone]);
    const exit = await start(h, agent).pipeline.run({ signal: new AbortController().signal });
    expect(exit.kind).toBe("done");
    expect(h.forge.autoMerges).toEqual([{ number: 11, method: "merge", headSha: "sha-11-a" }]);
    expect(h.forge.deletedBranches).toEqual(["feature-11"]);
    expect(agent.requests[1]?.prompt).toContain("auto-sha");
  });

  it("reads the review decision from gh", () => {
    const pr = toPullRequest({
      number: 1,
      url: "u",
      state: "OPEN",
      headRefName: "b",
      headRefOid: "s",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      reviewDecision: "REVIEW_REQUIRED",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [],
    });
    expect(pr).toMatchObject({ reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED" });
    expect(toPullRequest({ reviewDecision: "", statusCheckRollup: [] })).not.toHaveProperty(
      "reviewDecision",
    );
  });
});

// ── progress and usage per item ─────────────────────────────────────────

describe("live progress", () => {
  it("logs tool calls, exposes the running step, and clears it afterwards", async () => {
    const h = await harness('[review]\ncommand = ""');
    h.forge.addPr(11);
    let seenActivity: unknown;
    const agent = new FakeAgent([
      (req) => {
        req.onEvent?.({ type: "tool", name: "Bash", detail: "npm test" });
        h.host.time = new Date(h.host.time.getTime() + 11_000);
        req.onEvent?.({ type: "tool", name: "Edit", detail: "src/a.ts" });
        return implement(11);
      },
      allDone,
    ]);
    const { pipeline, state } = start(h, agent);
    const store = h.store;
    const save = store.save.bind(store);
    store.save = (s) => {
      if (s.items[0]?.activity?.tools === 2) seenActivity = { ...s.items[0].activity };
      return save(s);
    };
    await pipeline.run({ signal: new AbortController().signal });
    expect(h.host.logs).toContain("[item 1] implement · Bash npm test");
    expect(h.host.logs).toContain("[item 1] implement · Edit src/a.ts");
    expect(seenActivity).toMatchObject({ step: "implement", tools: 2, last: "Edit src/a.ts" });
    expect(state.items).toEqual([]);
    expect(agent.requests[0]?.artifactPath).toMatch(/implement-\d+\.jsonl$/);
  });
});

describe("usage from the stream", () => {
  it("stops a step from a streamed rate limit event, before any usage check is due", async () => {
    const h = await harness('[usage]\nsession_share = 10\non_limit = "halt"\ncheck_seconds = 600');
    const plan = new SimulatedPlan(h.host);
    const agent = new FakeAgent([
      async (req) => {
        plan.use(12);
        const reading = await plan.read();
        if (reading.ok) req.onEvent?.({ type: "usage", windows: reading.windows });
        await untilAborted(req.signal);
        return { outcome: "aborted", costUsd: 0.3 };
      },
    ]);
    const { pipeline, state } = start(h, agent, undefined, plan);
    const exit = await pipeline.run({ signal: new AbortController().signal });
    expect(exit.kind).toBe("paused");
    expect(exit.reason).toContain("nightshift used 12 of its 10-point share");
    expect(state.items[0]?.usagePoints).toEqual({ five_hour: 12, seven_day: 1 });
    expect(state.usage?.points).toEqual({ five_hour: 12, seven_day: 1 });
    // The aborted step's reported cost is counted.
    expect(state.costUsd).toBeCloseTo(0.3);
  });
});

// ── state ────────────────────────────────────────────────────────────────

describe("state", () => {
  it("serializes concurrent saves", async () => {
    const store = new StateStore(await tempHome());
    const state = newRunState("r", new Date(), "main", "p");
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.save({ ...state, itemsCompleted: i })),
    );
    expect((await store.load())?.itemsCompleted).toBe(19);
  });

  it("reports the live lock holder and refuses a second driver with a plain message", async () => {
    const dir = await tempHome();
    expect(lockHolder(dir)).toBeUndefined();
    const lock = await Lock.acquire(dir);
    expect(lockHolder(dir)).toBe(process.pid);
    const second = Lock.acquire(dir);
    await expect(second).rejects.toBeInstanceOf(LockedError);
    await expect(Lock.acquire(dir)).rejects.toThrow(/nightshift stop/);
    await lock.release();
    expect(lockHolder(dir)).toBeUndefined();
  });
});
