import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCliArgs, ClaudeCliAgent, parseResultJson } from "../src/agent/cli.js";
import { interpretResult } from "../src/agent/result.js";
import { buildSdkOptions, ClaudeSdkAgent, type QueryFn } from "../src/agent/sdk.js";
import { ConfigError, parseConfig } from "../src/config.js";
import { exec, shellQuote } from "../src/exec.js";
import { summarizeChecks, toPullRequest } from "../src/github.js";
import { configTemplate } from "../src/init.js";
import type { AgentRequest } from "../src/ports.js";
import { expandCommand } from "../src/reviewer.js";
import { finalizeResult, implementResult, toJsonSchema } from "../src/schemas.js";
import { Lock } from "../src/state.js";
import { loadTemplates, render, TEMPLATE_NAMES } from "../src/templates.js";

const request = (overrides: Partial<AgentRequest> = {}): AgentRequest => ({
  cwd: "/repo",
  prompt: "hello",
  schema: { type: "object" },
  maxBudgetUsd: 12.345,
  artifactPath: "/tmp/x.json",
  signal: new AbortController().signal,
  ...overrides,
});

describe("config", () => {
  it("applies defaults and resolves paths against the home directory", () => {
    const config = parseConfig(
      '[repos]\napp = "."\nlib = "../lib"\n[agent]\nadd_dirs = [".."]',
      "/w/app",
    );
    expect(config.defaultRepo).toBe("app");
    expect(config.repos).toEqual({ app: "/w/app", lib: "/w/lib" });
    expect(config.agent).toMatchObject({
      backend: "cli",
      permission_mode: "auto",
      add_dirs: ["/w"],
    });
    expect(config.merge.method).toBe("merge");
    expect(config.review.max_rounds).toBe(2);
    expect(config.dir).toBe("/w/app/.nightshift");
  });

  it("rejects unknown keys, bad values and an unknown default repo", () => {
    expect(() => parseConfig('[repos]\na = "."\n[merge]\nmethod = "octopus"', "/h")).toThrow(
      ConfigError,
    );
    expect(() => parseConfig('[repos]\na = "."\n[agent]\ntypo = 1', "/h")).toThrow(/typo/);
    expect(() => parseConfig('default_repo = "b"\n[repos]\na = "."', "/h")).toThrow(/default_repo/);
    expect(() => parseConfig("[repos]", "/h")).toThrow(/at least one repo/);
    expect(() => parseConfig("not toml [", "/h")).toThrow(/invalid TOML/);
  });

  it("the shipped example config is valid", async () => {
    const text = await readFile(
      new URL("../examples/api-and-app/config.toml", import.meta.url),
      "utf8",
    );
    const config = parseConfig(text, "/w/api");
    expect(config.repos).toEqual({ api: "/w/api", app: "/w/app" });
    expect(config.agent.add_dirs).toEqual(["/w"]);
  });

  it("init's template is a valid config", () => {
    for (const eject of [false, true]) {
      const config = parseConfig(configTemplate("my-app", eject), "/w/my-app");
      expect(config.repos).toEqual({ "my-app": "/w/my-app" });
      expect(config.promptsDir).toBe(eject ? "/w/my-app/.nightshift/prompts" : undefined);
    }
  });
});

describe("templates", () => {
  it("renders placeholders and rejects unknown ones", () => {
    expect(render("a {{ x }} b {{y}}", { x: 1, y: "{{z}}" })).toBe("a 1 b {{z}}");
    expect(() => render("{{nope}}", { x: 1 })).toThrow(/unknown placeholder \{\{nope\}\}/);
  });

  it("ships every template", async () => {
    const templates = await loadTemplates(undefined);
    for (const name of TEMPLATE_NAMES) expect(templates[name].length).toBeGreaterThan(50);
  });

  it("prefers overrides", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ns-prompts-"));
    await writeFile(path.join(dir, "implement.md"), "custom {{handoff}}");
    const templates = await loadTemplates(dir);
    expect(templates.implement).toBe("custom {{handoff}}");
    expect(templates.finalize).toContain("Pick the next task");
  });
});

describe("schemas", () => {
  it("produce plain JSON Schema objects", () => {
    const json = toJsonSchema(implementResult);
    expect(json.$schema).toBeUndefined();
    expect(json).toMatchObject({ type: "object", required: ["status", "item", "summary"] });
    expect(toJsonSchema(finalizeResult(["a", "b"]))).toMatchObject({
      properties: { next_repo: { enum: ["a", "b"] } },
    });
  });
});

describe("checks", () => {
  it("summarizes check runs and commit statuses", () => {
    expect(summarizeChecks([])).toEqual({ state: "none", failed: [], pending: [] });
    expect(
      summarizeChecks([
        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SKIPPED" },
        { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS" },
      ]).state,
    ).toBe("passed");
    expect(
      summarizeChecks([
        { __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: "" },
        { __typename: "StatusContext", context: "deploy", state: "PENDING" },
      ]),
    ).toEqual({ state: "pending", failed: [], pending: ["test", "deploy"] });
    expect(
      summarizeChecks([
        { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "CheckRun", name: "test", status: "QUEUED", conclusion: "" },
        { __typename: "StatusContext", context: "ext", state: "ERROR" },
      ]),
    ).toEqual({ state: "failed", failed: ["lint", "ext"], pending: ["test"] });
  });

  it("maps gh pr view JSON", () => {
    const pr = toPullRequest({
      number: 3,
      url: "u",
      state: "OPEN",
      isDraft: false,
      headRefName: "b",
      headRefOid: "abc",
      baseRefName: "main",
      mergeable: "",
      mergeCommit: null,
      statusCheckRollup: [],
    });
    expect(pr).toMatchObject({ mergeable: "UNKNOWN", mergeCommitSha: undefined, headSha: "abc" });
  });
});

describe("result interpretation", () => {
  it("maps CLI/SDK result messages to outcomes", () => {
    const base = { type: "result", session_id: "s", total_cost_usd: 0.25 };
    expect(
      interpretResult({
        ...base,
        subtype: "success",
        is_error: false,
        structured_output: { a: 1 },
      }),
    ).toMatchObject({
      outcome: "success",
      structured: { a: 1 },
      sessionId: "s",
      costUsd: 0.25,
    });
    expect(interpretResult({ ...base, subtype: "success", is_error: false }).outcome).toBe(
      "no_structured_output",
    );
    expect(
      interpretResult({ ...base, subtype: "success", is_error: true, result: "boom" }).outcome,
    ).toBe("error");
    expect(
      interpretResult({ ...base, subtype: "error_max_budget_usd", is_error: true }).outcome,
    ).toBe("max_budget");
    expect(interpretResult({ ...base, subtype: "error_max_turns" }).outcome).toBe("max_turns");
    expect(
      interpretResult({ ...base, subtype: "error_during_execution", errors: ["x"] }).detail,
    ).toContain("x");
    expect(interpretResult(null).outcome).toBe("error");
  });

  it("finds the JSON result among stray lines", () => {
    expect(parseResultJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseResultJson('warning: x\n{"a":2}\n')).toEqual({ a: 2 });
    expect(parseResultJson("nothing")).toBeUndefined();
  });
});

describe("claude CLI backend", () => {
  const agentConfig = parseConfig(
    '[repos]\na = "."\n[agent]\nmodel = "opus"\nallowed_tools = ["Read", "Bash(git *)"]\nadd_dirs = ["/x"]\nextra_args = ["--verbose"]',
    "/h",
  ).agent;

  it("builds the argument list", () => {
    const args = buildCliArgs(agentConfig, request({ resumeSessionId: "s1" }));
    expect(args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--json-schema",
      '{"type":"object"}',
      "--permission-mode",
      "auto",
      "--max-turns",
      "200",
      "--max-budget-usd",
      "12.35",
      "--model",
      "opus",
      "--resume",
      "s1",
      "--allowedTools=Read,Bash(git *)",
      "--add-dir=/x",
      "--verbose",
    ]);
  });

  it("runs a claude executable with the prompt on stdin and parses its result", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ns-fake-claude-"));
    const fake = path.join(dir, "claude");
    await writeFile(
      fake,
      `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  require("fs").writeFileSync(${JSON.stringify(path.join(dir, "seen.json"))}, JSON.stringify({ input, args: process.argv.slice(2) }));
  console.error("a warning");
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "abc", total_cost_usd: 1.5, structured_output: { ok: true } }));
});
`,
    );
    await chmod(fake, 0o755);
    const config = { ...agentConfig, claude_path: fake };
    const result = await new ClaudeCliAgent(config).run(
      request({ cwd: dir, artifactPath: path.join(dir, "out.json") }),
    );
    expect(result).toMatchObject({
      outcome: "success",
      sessionId: "abc",
      costUsd: 1.5,
      structured: { ok: true },
    });
    const seen = JSON.parse(await readFile(path.join(dir, "seen.json"), "utf8"));
    expect(seen.input).toBe("hello");
    expect(seen.args[0]).toBe("-p");
    expect(await readFile(path.join(dir, "out.json"), "utf8")).toContain('"session_id":"abc"');
  });

  it("reports a crash without JSON as an error", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ns-fake-claude-"));
    const fake = path.join(dir, "claude");
    await writeFile(fake, "#!/bin/sh\necho 'not logged in' >&2\nexit 1\n");
    await chmod(fake, 0o755);
    const result = await new ClaudeCliAgent({ ...agentConfig, claude_path: fake }).run(
      request({ cwd: dir, artifactPath: path.join(dir, "o.json") }),
    );
    expect(result.outcome).toBe("error");
    expect(result.detail).toContain("not logged in");
  });
});

describe("Agent SDK backend", () => {
  const agentConfig = parseConfig('[repos]\na = "."\n[agent]\nbackend = "sdk"', "/h").agent;

  it("builds SDK options that load project settings and enforce the schema", () => {
    const options = buildSdkOptions(
      agentConfig,
      request({ resumeSessionId: "s" }),
      new AbortController(),
    );
    expect(options).toMatchObject({
      cwd: "/repo",
      permissionMode: "auto",
      maxBudgetUsd: 12.345,
      resume: "s",
      settingSources: ["user", "project", "local"],
      outputFormat: { type: "json_schema", schema: { type: "object" } },
    });
    expect(options).not.toHaveProperty("allowDangerouslySkipPermissions");
  });

  it("collects the result message from query()", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ns-sdk-"));
    let seen: { prompt: string; options: Record<string, unknown> } | undefined;
    const query: QueryFn = async function* (params) {
      seen = params;
      yield { type: "system", subtype: "init", session_id: "sdk-1" };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sdk-1",
        total_cost_usd: 0.4,
        structured_output: { x: 1 },
      };
    };
    const result = await new ClaudeSdkAgent(agentConfig, query).run(
      request({ artifactPath: path.join(dir, "r.json") }),
    );
    expect(result).toMatchObject({
      outcome: "success",
      sessionId: "sdk-1",
      costUsd: 0.4,
      structured: { x: 1 },
    });
    expect(seen?.prompt).toBe("hello");
  });

  it("reports a stream that throws as an error", async () => {
    const query: QueryFn = async function* () {
      yield { type: "system", session_id: "s" };
      throw new Error("network");
    };
    const result = await new ClaudeSdkAgent(agentConfig, query).run(request());
    expect(result).toMatchObject({ outcome: "error", detail: "network", sessionId: "s" });
  });
});

describe("review command", () => {
  it("substitutes known placeholders shell-quoted and leaves shell syntax alone", () => {
    const values = { pr: "12", pr_url: "u", repo_slug: "a/b", repo_path: "/r p", branch: "it's" };
    const shellVar = "$" + "{HOME}"; // a literal shell variable that must pass through untouched
    expect(expandCommand(`review {pr} {repo_path} {branch} ${shellVar} {other}`, values)).toBe(
      `review '12' '/r p' 'it'\\''s' ${shellVar} {other}`,
    );
  });
});

describe("exec", () => {
  it("passes stdin, captures output and kills on timeout", async () => {
    const echo = await exec("/bin/sh", ["-c", "cat; echo err >&2"], { input: "in" });
    expect(echo).toMatchObject({ code: 0, stdout: "in", stderr: "err\n", timedOut: false });
    const slow = await exec("/bin/sh", ["-c", "sleep 5"], { timeoutMs: 100 });
    expect(slow.timedOut).toBe(true);
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });

  it("aborts", async () => {
    const controller = new AbortController();
    const running = exec("/bin/sh", ["-c", "sleep 5"], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect((await running).aborted).toBe(true);
  });
});

describe("lock", () => {
  it("is exclusive while held and reclaimable after release", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ns-lock-"));
    const lock = await Lock.acquire(dir);
    await expect(Lock.acquire(dir)).rejects.toThrow(/another nightshift process/);
    await lock.release();
    const again = await Lock.acquire(dir);
    await again.release();
  });

  it("takes over a stale lock", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ns-lock-"));
    await writeFile(path.join(dir, "lock"), "999999");
    const lock = await Lock.acquire(dir);
    await lock.release();
  });
});
