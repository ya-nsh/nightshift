import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCliArgs } from "../src/agent/cli.js";
import { READ_ONLY_TOOLS, readOnlyExtraArgs } from "../src/agent/readonly.js";
import { buildSdkOptions } from "../src/agent/sdk.js";
import { newRunState } from "../src/pipeline.js";
import {
  formatPlan,
  makePlan,
  type Plan,
  PlanError,
  parsePlanCount,
  planStart,
  writePlan,
} from "../src/plan.js";
import type { AgentRequest, AgentResult } from "../src/ports.js";
import type { RunState } from "../src/state.js";
import { loadTemplates } from "../src/templates.js";
import { FakeAgent, FakeHost, SimulatedPlan, tempHome, testConfig } from "./fakes.js";

const ITEM = {
  id: "T12",
  title: "Add rate limiting",
  repo: "main",
  why_now: "Next unchecked item in AGENTS.md.",
  size: "M",
  risk: "medium",
  risk_note: "Touches the request path.",
  needs_human: false,
};
const HUMAN_ITEM = {
  id: "T13",
  title: "Wire up billing",
  repo: "other",
  why_now: "Follows T12.",
  size: "L",
  risk: "high",
  needs_human: true,
  question: "Which Stripe account should billing use?",
};
const RESULT = { summary: "Two tasks left before the release.", items: [ITEM, HUMAN_ITEM] };

async function setup(extra = "") {
  const home = await tempHome();
  const config = testConfig(home, extra);
  return { home, config, templates: await loadTemplates(undefined) };
}

function liveState(overrides: Partial<NonNullable<RunState["item"]>> = {}): RunState {
  const state = newRunState("run-1", new Date("2026-11-04T00:00:00Z"), "main", "Do T12 next.");
  state.item = { ...(state.item as NonNullable<RunState["item"]>), ...overrides };
  return state;
}

const opts = (overrides: Partial<Parameters<typeof makePlan>[2]> = {}) => ({
  count: 3,
  signal: new AbortController().signal,
  ...overrides,
});

describe("plan: starting point", () => {
  it("starts from the given prompt in the default repo, or --repo", async () => {
    const { config } = await setup();
    const start = planStart(config, liveState(), { prompt: "Build the CLI." });
    expect(start).toMatchObject({ source: "prompt", repo: "main" });
    expect(start.text).toContain("<prompt>\nBuild the CLI.\n</prompt>");
    expect(planStart(config, undefined, { prompt: "x", repo: "other" }).repo).toBe("other");
  });

  it("starts from a pending handoff that has not started, as the first item", async () => {
    const { config } = await setup();
    const start = planStart(config, liveState(), {});
    expect(start.source).toBe("handoff");
    expect(start.repo).toBe("main");
    expect(start.text).toContain("<handoff>\nDo T12 next.\n</handoff>");
    expect(start.text).toContain("Your first item is the task it describes");
  });

  it("plans after an item that is under way, and passes on a pending question", async () => {
    const { config } = await setup();
    const state = liveState({
      repo: "other",
      phase: "checks",
      sessionId: "s1",
      label: "T11 — Cache",
      pr: {
        number: 7,
        url: "https://github.com/acme/app/pull/7",
        repoSlug: "acme/app",
        branch: "b",
      },
      pendingQuestion: "Which region?",
    });
    state.status = "halted";
    state.haltReason = "blocked";
    const start = planStart(config, state, {});
    expect(start.source).toBe("after_current");
    expect(start.repo).toBe("other");
    expect(start.text).toContain(
      "now at the checks step with pull request https://github.com/acme/app/pull/7",
    );
    expect(start.text).toContain("Do not list it");
    expect(start.text).toContain("The run is halted: blocked.");
    expect(start.text).toContain("waiting for a human to answer: Which region?");
    expect(start.description).toContain("after item 1 (T11 — Cache)");
  });

  it("falls back to the repositories' instructions without a live run", async () => {
    const { config } = await setup();
    expect(planStart(config, undefined, {}).source).toBe("instructions");
    const done = liveState();
    done.status = "done";
    done.haltReason = "no task left";
    const start = planStart(config, done, {});
    expect(start.source).toBe("instructions");
    expect(start.text).toContain("The last run (run-1) finished: no task left.");
  });

  it("validates -n", () => {
    expect(parsePlanCount(undefined)).toBe(5);
    expect(parsePlanCount("3")).toBe(3);
    for (const bad of ["0", "21", "1.5", "x", ""])
      expect(() => parsePlanCount(bad)).toThrow(PlanError);
  });
});

describe("plan: the read-only session", () => {
  it("asks Claude read-only, with the plan budget, the handoff and every repo", async () => {
    const { config, templates } = await setup();
    const agent = new FakeAgent([{ structured: RESULT, costUsd: 0.12 }]);
    const logs: string[] = [];
    const outcome = await makePlan(
      {
        config,
        templates,
        agent: {
          name: "fake",
          run: (request) => {
            request.onEvent?.({ type: "tool", name: "Read", detail: "AGENTS.md" });
            return agent.run(request);
          },
        },
        now: () => new Date("2026-11-08T21:00:00Z"),
        log: (line) => logs.push(line),
      },
      liveState(),
      opts(),
    );
    const request = agent.requests[0] as AgentRequest;
    expect(request.readOnly).toBe(true);
    expect(request.resumeSessionId).toBeUndefined();
    expect(request.maxBudgetUsd).toBe(2);
    expect(request.cwd).toBe(config.repos.main);
    expect(request.addDirs).toEqual([config.repos.other]);
    expect(request.artifactPath).toBe(path.join(config.dir, "plans", "20261108T210000.jsonl"));
    expect(request.prompt).toContain("the next 3 task(s)");
    expect(request.prompt).toContain("<handoff>\nDo T12 next.\n</handoff>");
    expect(request.prompt).toContain(`- other: ${config.repos.other}`);
    expect(request.prompt).toContain("This session is read-only");
    const items = (request.schema.properties as Record<string, Record<string, unknown>>).items;
    expect(items?.maxItems).toBe(3);
    expect(logs).toEqual(["plan · Read AGENTS.md"]);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan).toMatchObject({
      source: "handoff",
      run_id: "run-1",
      repo: "main",
      count: 3,
      summary: RESULT.summary,
      cost_usd: 0.12,
      generated_at: "2026-11-08T21:00:00.000Z",
    });
    expect(outcome.plan.items).toHaveLength(2);
  });

  it("uses a configured plan budget", async () => {
    const { config, templates } = await setup("[budget]\nplan_usd = 0.75");
    const agent = new FakeAgent([{ structured: { summary: "s", items: [] } }]);
    const outcome = await makePlan(
      { config, templates, agent, now: () => new Date() },
      undefined,
      opts(),
    );
    expect(agent.requests[0]?.maxBudgetUsd).toBe(0.75);
    expect(outcome.ok).toBe(true);
  });

  it("runs with [agent.steps.plan] model and max_turns over [agent]", async () => {
    const run = async (extra: string) => {
      const { config, templates } = await setup(extra);
      const agent = new FakeAgent([{ structured: { summary: "s", items: [] } }]);
      await makePlan({ config, templates, agent, now: () => new Date() }, undefined, opts());
      return agent.requests[0] as AgentRequest;
    };
    const plain = await run('[agent]\nmodel = "opus"\nmax_turns = 120');
    expect(plain).toMatchObject({ model: "opus", maxTurns: 120 });
    expect(plain.permissionMode).toBeUndefined();
    const own = await run(
      '[agent]\nmodel = "opus"\n[agent.steps.plan]\nmodel = "haiku"\nmax_turns = 30\n[agent.steps.implement]\nmodel = "sonnet"',
    );
    expect(own).toMatchObject({ model: "haiku", maxTurns: 30, readOnly: true });
    const none = await run("");
    expect(none).not.toHaveProperty("model");
  });

  it("does not accept a permission_mode for the plan step", async () => {
    await expect(setup('[agent.steps.plan]\npermission_mode = "auto"')).rejects.toThrow(
      /agent\.steps\.plan.*permission_mode/s,
    );
  });

  it("rejects results that break the schema", async () => {
    const { config, templates } = await setup();
    const bad = [
      { summary: "s", items: [{ ...HUMAN_ITEM, question: undefined }] },
      { summary: "s", items: [ITEM, ITEM] },
      { summary: "s", items: [{ ...ITEM, repo: "nope" }] },
    ];
    for (const structured of bad) {
      const agent = new FakeAgent([{ structured, costUsd: 0.3 }]);
      const outcome = await makePlan(
        { config, templates, agent, now: () => new Date() },
        undefined,
        opts({ count: 1 }),
      );
      expect(outcome).toMatchObject({ ok: false, costUsd: 0.3, aborted: false });
      if (!outcome.ok) expect(outcome.reason).toContain("invalid structured result");
    }
  });

  it("reports budget, error and interruption outcomes", async () => {
    const { config, templates } = await setup();
    const run = async (result: Partial<AgentResult>) =>
      makePlan(
        { config, templates, agent: new FakeAgent([result]), now: () => new Date() },
        undefined,
        opts(),
      );
    expect(await run({ outcome: "max_budget" })).toMatchObject({
      ok: false,
      reason: "Claude hit the plan budget ($2.00, [budget] plan_usd)",
    });
    expect(await run({ outcome: "error", detail: "boom" })).toMatchObject({
      ok: false,
      reason: "agent error: boom",
    });
    expect(await run({ outcome: "aborted" })).toMatchObject({ ok: false, aborted: true });
  });

  it("refuses an unknown repo", async () => {
    const { config, templates } = await setup();
    await expect(
      makePlan(
        { config, templates, agent: new FakeAgent([]), now: () => new Date() },
        undefined,
        opts({ repo: "nope" }),
      ),
    ).rejects.toThrow(/unknown repo "nope"/);
  });
});

describe("plan: [usage] limits", () => {
  it("does not read usage when no limits are set", async () => {
    const { config, templates } = await setup();
    const plan = new SimulatedPlan(new FakeHost());
    const agent = new FakeAgent([{ structured: { summary: "s", items: [] } }]);
    await makePlan(
      { config, templates, agent, usage: plan, now: () => new Date() },
      undefined,
      opts(),
    );
    expect(plan.reads).toBe(0);
  });

  it("refuses to plan at a limit, without calling Claude", async () => {
    const { config, templates } = await setup("[usage]\nsession_max = 80");
    const host = new FakeHost();
    const plan = new SimulatedPlan(host);
    plan.use(85);
    const agent = new FakeAgent([]);
    const outcome = await makePlan(
      { config, templates, agent, usage: plan, now: () => host.now() },
      undefined,
      opts(),
    );
    expect(agent.requests).toHaveLength(0);
    expect(outcome).toMatchObject({ ok: false, costUsd: 0 });
    if (!outcome.ok)
      expect(outcome.reason).toMatch(/^not planning: usage limit: 5-hour usage is at 85%/);
  });

  it("counts the live run's share and --usage-share", async () => {
    const { config, templates } = await setup();
    const host = new FakeHost();
    const plan = new SimulatedPlan(host);
    plan.use(10);
    const reading = await plan.read();
    if (!reading.ok) throw new Error("no reading");
    const state = liveState();
    state.usageShare = 10;
    state.usage = {
      tally: { five_hour: { resetsAt: reading.windows.five_hour?.resetsAt, used: 10 } },
    };
    const outcome = await makePlan(
      { config, templates, agent: new FakeAgent([]), usage: plan, now: () => host.now() },
      state,
      opts(),
    );
    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) expect(outcome.reason).toContain("10-point share of the 5-hour window");
  });

  it("refuses when usage cannot be read but limits are set", async () => {
    const { config, templates } = await setup("[usage]\nweekly_max = 90");
    const plan = new SimulatedPlan(new FakeHost());
    plan.failure = "not logged in";
    const outcome = await makePlan(
      { config, templates, agent: new FakeAgent([]), usage: plan, now: () => new Date() },
      undefined,
      opts(),
    );
    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) expect(outcome.reason).toContain("cannot read Claude plan usage");
  });
});

describe("plan: output", () => {
  const plan: Plan = {
    generated_at: "2026-11-08T21:00:00.000Z",
    source: "handoff",
    start: "the pending handoff of run run-1 (item 1, repo main)",
    run_id: "run-1",
    repo: "main",
    count: 3,
    summary: "Two tasks left before the release.",
    items: [ITEM, HUMAN_ITEM] as Plan["items"],
    cost_usd: 0.12,
  };

  it("formats the plan readably", () => {
    const text = formatPlan(plan);
    expect(text).toContain("# nightshift plan");
    expect(text).toContain("Next 3 items, starting from the pending handoff of run run-1");
    expect(text).toContain("cost $0.12");
    expect(text).toContain("1. **T12 — Add rate limiting** · `main` · size M · risk medium");
    expect(text).toContain("   Why now: Next unchecked item in AGENTS.md.");
    expect(text).toContain("   Risk: Touches the request path.");
    expect(text).toContain("2. **T13 — Wire up billing** · `other` · size L · risk high");
    expect(text).toContain("   **Needs a human:** Which Stripe account should billing use?");
    expect(text).toContain("1 of 2 item(s) need a human");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("says when nothing is left and avoids repeating an ID in the title", () => {
    expect(formatPlan({ ...plan, items: [] })).toContain("Nothing left to do.");
    const text = formatPlan({
      ...plan,
      items: [{ ...ITEM, title: "T12 Add rate limiting" }] as Plan["items"],
    });
    expect(text).toContain("**T12 Add rate limiting**");
  });

  it("writes .nightshift/plan.md", async () => {
    const { config } = await setup();
    const file = await writePlan(config.dir, plan);
    expect(file).toBe(path.join(config.dir, "plan.md"));
    expect(await readFile(file, "utf8")).toBe(formatPlan(plan));
  });
});

describe("plan: read-only agent settings", () => {
  const request: AgentRequest = {
    cwd: "/repo",
    prompt: "p",
    schema: { type: "object" },
    maxBudgetUsd: 2,
    artifactPath: "/tmp/p.jsonl",
    signal: new AbortController().signal,
    readOnly: true,
    addDirs: ["/other"],
  };

  it("drops extra_args flags that could widen the session", () => {
    expect(
      readOnlyExtraArgs([
        "--verbose",
        "--permission-mode",
        "bypassPermissions",
        "--dangerously-skip-permissions",
        "--allowedTools",
        "Bash",
        "Edit",
        "--tools=Bash",
        "--mcp-config",
        "m.json",
        "--settings",
        "s.json",
      ]),
    ).toEqual(["--verbose", "--settings", "s.json"]);
  });

  it("locks the CLI session down to reading files", async () => {
    const { config } = await setup(
      '[agent]\npermission_mode = "bypassPermissions"\nallowed_tools = ["Bash(*)"]\nadd_dirs = ["/x"]\nextra_args = ["--dangerously-skip-permissions", "--effort", "low"]',
    );
    const args = buildCliArgs(config.agent, request);
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args).toContain(`--tools=${READ_ONLY_TOOLS.join(",")}`);
    expect(args).toContain("--allowedTools=Read,Glob,Grep");
    expect(args).toContain("--disallowedTools=Bash,Edit,Write,NotebookEdit,Agent,Task");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--allowedTools=Bash(*)");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).toContain("--add-dir=/x");
    expect(args).toContain("--add-dir=/other");
    expect(args.slice(-2)).toEqual(["--effort", "low"]);
    expect(args).not.toContain("--resume");
    // A step permission mode on the request cannot widen a read-only session either.
    const stepped = buildCliArgs(config.agent, { ...request, permissionMode: "bypassPermissions" });
    expect(stepped[stepped.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    const sdk = buildSdkOptions(
      config.agent,
      { ...request, permissionMode: "bypassPermissions" },
      new AbortController(),
    );
    expect(sdk.permissionMode).toBe("dontAsk");
    expect(sdk).not.toHaveProperty("allowDangerouslySkipPermissions");
  });

  it("locks the SDK session down the same way", async () => {
    const { config } = await setup(
      '[agent]\nbackend = "sdk"\npermission_mode = "bypassPermissions"\nallowed_tools = ["Bash(*)"]\nextra_args = ["--permission-mode", "auto", "--effort", "low"]',
    );
    const options = buildSdkOptions(config.agent, request, new AbortController());
    expect(options).toMatchObject({
      permissionMode: "dontAsk",
      allowedTools: ["Read", "Glob", "Grep"],
      disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit", "Agent", "Task"],
      additionalDirectories: ["/other"],
      extraArgs: { effort: "low", tools: "Read,Glob,Grep", "strict-mcp-config": null },
    });
    expect(options).not.toHaveProperty("allowDangerouslySkipPermissions");
    expect(options.extraArgs).not.toHaveProperty("permission-mode");
  });

  it("leaves normal steps as configured", async () => {
    const { config } = await setup('[agent]\nallowed_tools = ["Bash(git *)"]');
    const args = buildCliArgs(config.agent, { ...request, readOnly: false, addDirs: [] });
    expect(args).toContain("--allowedTools=Bash(git *)");
    expect(args.join(" ")).not.toContain("--tools");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("auto");
  });
});
