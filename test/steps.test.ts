import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCliArgs } from "../src/agent/cli.js";
import { buildSdkOptions } from "../src/agent/sdk.js";
import {
  AGENT_STEPS,
  ConfigError,
  describeStepSettings,
  parseConfig,
  stepSettings,
} from "../src/config.js";
import { configTemplate } from "../src/init.js";
import { newRunState, Pipeline } from "../src/pipeline.js";
import type { AgentRequest } from "../src/ports.js";
import { FakeAgent, failedChecks, type Harness, harness, PASSED, PENDING } from "./fakes.js";

const STEPS_CONFIG = `
[agent]
model = "haiku"
max_turns = 100
[agent.steps.implement]
model = "opus"
max_turns = 300
[agent.steps.address]
model = "sonnet"
[agent.steps.fix_checks]
model = "sonnet"
permission_mode = "dontAsk"
`;

const agentOf = (text: string) => parseConfig(`[repos]\na = "."\n${text}`, "/h").agent;

const request = (overrides: Partial<AgentRequest> = {}): AgentRequest => ({
  cwd: "/repo",
  prompt: "hello",
  schema: { type: "object" },
  maxBudgetUsd: 5,
  artifactPath: "/tmp/x.json",
  signal: new AbortController().signal,
  ...overrides,
});

/** The value following `flag` in a CLI argument list. */
const flag = (args: string[], name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

describe("[agent.steps] config", () => {
  it("defaults to no overrides, so every step uses [agent]", () => {
    const agent = agentOf('[agent]\nmodel = "opus"');
    expect(agent.steps).toEqual({});
    for (const step of AGENT_STEPS) {
      expect(stepSettings(agent, step)).toEqual({
        model: "opus",
        maxTurns: 200,
        permissionMode: "auto",
      });
    }
  });

  it("overrides model, max_turns and permission_mode per step, falling back to [agent]", () => {
    const agent = agentOf(STEPS_CONFIG);
    expect(stepSettings(agent, "implement")).toEqual({
      model: "opus",
      maxTurns: 300,
      permissionMode: "auto",
    });
    expect(stepSettings(agent, "address")).toEqual({
      model: "sonnet",
      maxTurns: 100,
      permissionMode: "auto",
    });
    expect(stepSettings(agent, "fix_checks")).toEqual({
      model: "sonnet",
      maxTurns: 100,
      permissionMode: "dontAsk",
    });
    expect(stepSettings(agent, "finalize")).toEqual({
      model: "haiku",
      maxTurns: 100,
      permissionMode: "auto",
    });
    // A Claude call that is not an item step gets [agent] as is.
    expect(stepSettings(agent, undefined)).toEqual({
      model: "haiku",
      maxTurns: 100,
      permissionMode: "auto",
    });
  });

  it("leaves the model to Claude Code when neither the step nor [agent] sets one", () => {
    const agent = agentOf("[agent.steps.finalize]\nmax_turns = 20");
    expect(stepSettings(agent, "finalize")).toEqual({
      model: undefined,
      maxTurns: 20,
      permissionMode: "auto",
    });
    expect(stepSettings(agent, "implement").model).toBeUndefined();
  });

  it("rejects unknown steps, unknown keys and bad values", () => {
    const bad = (text: string) => () => agentOf(text);
    expect(bad('[agent.steps.implment]\nmodel = "opus"')).toThrow(ConfigError);
    expect(bad('[agent.steps.implment]\nmodel = "opus"')).toThrow(
      /agent\.steps: unknown step "implment"; steps are implement, address, fix_checks, resolve_conflicts, finalize/,
    );
    // Template names use dashes; step names use underscores, like every other config key.
    expect(bad('[agent.steps.fix-checks]\nmodel = "opus"')).toThrow(/unknown step "fix-checks"/);
    expect(bad('[agent.steps.implement]\nbackend = "sdk"')).toThrow(
      /agent\.steps\.implement: .*backend/,
    );
    expect(bad("[agent.steps.address]\nmax_turns = 0")).toThrow(/agent\.steps\.address\.max_turns/);
    expect(bad("[agent.steps.address]\nmax_turns = 1.5")).toThrow(/max_turns/);
    expect(bad('[agent.steps.address]\nmodel = "  "')).toThrow(/model must not be empty/);
    expect(bad('[agent.steps.address]\npermission_mode = "yolo"')).toThrow(
      /agent\.steps\.address\.permission_mode/,
    );
    expect(bad('[agent]\nsteps = "opus"')).toThrow(/agent\.steps/);
  });

  it("describes every step's settings for doctor", () => {
    expect(describeStepSettings(agentOf(STEPS_CONFIG))).toBe(
      "implement opus (max_turns 300) · address sonnet · fix_checks sonnet (dontAsk) · resolve_conflicts haiku · finalize haiku",
    );
    expect(describeStepSettings(agentOf(""))).toBe(
      "implement default · address default · fix_checks default · resolve_conflicts default · finalize default",
    );
  });

  it("init's commented step example is valid once uncommented", () => {
    const template = configTemplate("app", false);
    const lines = template.split("\n");
    const start = lines.findIndex((line) => line.startsWith("# [agent.steps."));
    expect(start).toBeGreaterThan(-1);
    const end = lines.findIndex((line, i) => i > start && line.trim() === "");
    const example = lines
      .slice(start, end)
      .map((line) => line.replace(/^# /, ""))
      .join("\n");
    const agent = agentOf(example);
    expect(stepSettings(agent, "implement").model).toBe("opus");
    expect(stepSettings(agent, "address").model).toBe("sonnet");
    expect(stepSettings(agent, "fix_checks")).toMatchObject({ model: "sonnet", maxTurns: 80 });
  });
});

describe("per-step settings in the agent backends", () => {
  it("the CLI backend uses the request's settings over [agent]", () => {
    const agent = agentOf('[agent]\nmodel = "haiku"\nmax_turns = 100\npermission_mode = "auto"');
    const args = buildCliArgs(
      agent,
      request({ model: "opus", maxTurns: 300, permissionMode: "dontAsk" }),
    );
    expect(flag(args, "--model")).toBe("opus");
    expect(flag(args, "--max-turns")).toBe("300");
    expect(flag(args, "--permission-mode")).toBe("dontAsk");
    expect(args.filter((a) => a === "--model")).toHaveLength(1);
  });

  it("the CLI backend falls back to [agent] for settings the request leaves out", () => {
    const withModel = buildCliArgs(agentOf('[agent]\nmodel = "haiku"\nmax_turns = 7'), request());
    expect(flag(withModel, "--model")).toBe("haiku");
    expect(flag(withModel, "--max-turns")).toBe("7");
    expect(flag(withModel, "--permission-mode")).toBe("auto");
    expect(buildCliArgs(agentOf(""), request())).not.toContain("--model");
  });

  it("the SDK backend uses the request's settings over [agent]", () => {
    const agent = agentOf('[agent]\nbackend = "sdk"\nmodel = "haiku"\nmax_turns = 100');
    const options = buildSdkOptions(
      agent,
      request({ model: "sonnet", maxTurns: 40, permissionMode: "acceptEdits" }),
      new AbortController(),
    );
    expect(options).toMatchObject({
      model: "sonnet",
      maxTurns: 40,
      permissionMode: "acceptEdits",
    });
    expect(options).not.toHaveProperty("allowDangerouslySkipPermissions");
  });

  it("the SDK backend falls back to [agent] and keys the bypass flag off the effective mode", () => {
    const agent = agentOf('[agent]\nbackend = "sdk"\nmax_turns = 9\npermission_mode = "dontAsk"');
    const fallback = buildSdkOptions(agent, request(), new AbortController());
    expect(fallback).toMatchObject({ maxTurns: 9, permissionMode: "dontAsk" });
    expect(fallback).not.toHaveProperty("model");
    const bypass = buildSdkOptions(
      agent,
      request({ permissionMode: "bypassPermissions" }),
      new AbortController(),
    );
    expect(bypass).toMatchObject({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
  });
});

const implement = (pr: number) => ({
  structured: { status: "pr_opened", item: `T${pr}`, summary: "implemented", pr_number: pr },
});
const ready = (pushed = false) => ({
  structured: { status: "ready", pushed_changes: pushed, summary: "addressed" },
});
const allDone = { structured: { status: "all_done", summary: "nothing left" } };

function run(h: Harness, agent: FakeAgent) {
  const state = newRunState("run-1", h.host.now(), "main", "do task one");
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
  return pipeline.run({ signal: new AbortController().signal });
}

const settingsOf = (r: AgentRequest | undefined) => ({
  model: r?.model,
  maxTurns: r?.maxTurns,
  permissionMode: r?.permissionMode,
});

describe("per-step settings in the pipeline", () => {
  it("runs each step with its own model in the same resumed session, and logs and records it", async () => {
    const h = await harness(STEPS_CONFIG);
    // The first value is consumed when implement looks the PR up.
    h.forge.addPr(3, {}, [PASSED, PENDING, failedChecks("test"), PASSED]);
    const agent = new FakeAgent([implement(3), ready(), ready(true), allDone]);

    const exit = await run(h, agent);

    expect(exit.kind).toBe("done");
    const [impl, address, fixChecks, finalize] = agent.requests;
    expect(fixChecks?.prompt).toContain("Failing checks: test");
    expect(settingsOf(impl)).toEqual({ model: "opus", maxTurns: 300, permissionMode: "auto" });
    expect(settingsOf(address)).toEqual({ model: "sonnet", maxTurns: 100, permissionMode: "auto" });
    expect(settingsOf(fixChecks)).toEqual({
      model: "sonnet",
      maxTurns: 100,
      permissionMode: "dontAsk",
    });
    expect(settingsOf(finalize)).toEqual({ model: "haiku", maxTurns: 100, permissionMode: "auto" });
    // Switching models does not start a new session.
    expect(impl?.resumeSessionId).toBeUndefined();
    for (const later of [address, fixChecks, finalize])
      expect(later?.resumeSessionId).toBe("session-1");

    expect(h.host.logs).toContain("[T3] address · model sonnet · budget $24.90");
    expect(h.host.logs.some((l) => /implement \(fresh session\) · model opus · /.test(l))).toBe(
      true,
    );
    expect(h.host.logs.some((l) => /fix-checks · model sonnet · /.test(l))).toBe(true);
    expect(h.host.logs.some((l) => /finalize · model haiku · /.test(l))).toBe(true);

    const events = (await readFile(path.join(h.store.runDir("run-1"), "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event.type === "agent")
      .map((event) => [event.step, event.model]);
    expect(events).toEqual([
      ["implement", "opus"],
      ["address", "sonnet"],
      ["fix-checks", "sonnet"],
      ["finalize", "haiku"],
    ]);
  });

  it("uses the resolve_conflicts settings for the conflict step", async () => {
    const h = await harness('[agent.steps.resolve_conflicts]\nmodel = "opus"\nmax_turns = 50');
    const fake = h.forge.addPr(8);
    fake.mergeable = ["MERGEABLE", "MERGEABLE", "CONFLICTING", "MERGEABLE"];
    const agent = new FakeAgent([implement(8), ready(), ready(true), allDone]);

    const exit = await run(h, agent);

    expect(exit.kind).toBe("done");
    const [impl, , resolve, finalize] = agent.requests;
    expect(resolve?.prompt).toContain("conflicts with its base branch");
    expect(settingsOf(resolve)).toEqual({ model: "opus", maxTurns: 50, permissionMode: "auto" });
    // No model anywhere else: the request leaves it to Claude Code, and the log says so.
    expect(settingsOf(impl)).toEqual({ model: undefined, maxTurns: 200, permissionMode: "auto" });
    expect(settingsOf(finalize).model).toBeUndefined();
    expect(impl && "model" in impl).toBe(false);
    expect(h.host.logs.some((l) => /implement \(fresh session\) · model default · /.test(l))).toBe(
      true,
    );
  });
});
