import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { answerFrom, MAX_ANSWER_CHARS, questionBody } from "../src/answers.js";
import { ConfigError, parseConfig } from "../src/config.js";
import { BASE_BACKOFF_MS, Daemon, type DaemonDeps, decide } from "../src/daemon.js";
import { exec } from "../src/exec.js";
import { toIssueComment } from "../src/github.js";
import { configTemplate } from "../src/init.js";
import { newItem, newRunState, Pipeline } from "../src/pipeline.js";
import type { IssueComment } from "../src/ports.js";
import { buildReport, loadReport } from "../src/report.js";
import { parseRange, type TimeRange } from "../src/schedule.js";
import {
  installService,
  installWarnings,
  launchdPlist,
  type Runner,
  ServiceError,
  serviceSpec,
  serviceStatus,
  stableNodePath,
  systemdQuote,
  systemdUnit,
  uninstallService,
} from "../src/service.js";
import type { QuestionPost, RunState } from "../src/state.js";
import {
  FakeAgent,
  type Harness,
  harness,
  PASSED,
  PENDING,
  SimulatedPlan,
  untilAborted,
} from "./fakes.js";

const implement = (pr: number, item = `T${pr}`, summary = "implemented") => ({
  structured: { status: "pr_opened", item, summary, pr_number: pr },
});
const ready = { structured: { status: "ready", pushed_changes: false, summary: "addressed" } };
const next = (prompt: string) => ({
  structured: {
    status: "continue",
    summary: "post-merge done",
    next_repo: "main",
    next_prompt: prompt,
  },
});
const allDone = { structured: { status: "all_done", summary: "nothing left" } };
const blockedImplement = (question: string) => ({
  structured: { status: "blocked", item: "T7", summary: "need input", question },
});

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
  return { state: s, pipeline };
}

const signal = () => new AbortController().signal;
const GITHUB = '[answers]\nvia = "github"';

// ── answers on GitHub ────────────────────────────────────────────────────

describe("answers on GitHub", () => {
  it("opens an issue when there is no PR, and only an allowed human's reply resumes", async () => {
    const h = await harness(GITHUB);
    h.forge.addPr(11);
    const { state, pipeline } = start(
      h,
      new FakeAgent([blockedImplement("Which database, @bob?\nPostgres or SQLite?")]),
    );

    const exit = await pipeline.run({ signal: signal() });

    expect(exit.kind).toBe("blocked");
    expect(state.stop).toMatchObject({ kind: "blocked", cause: "question" });
    const post = state.item?.questionPost as QuestionPost;
    expect(post).toMatchObject({ kind: "issue", repoSlug: "acme/app", number: 500 });
    const issue = h.forge.issues[0];
    expect(issue?.title).toBe("nightshift question: T7");
    expect(issue?.body).toContain("<!-- nightshift:question run=run-1 item=1 -->");
    expect(issue?.body).toContain("> Which database, @​bob?\n> Postgres or SQLite?");
    expect(issue?.body).toContain("Comments from @night-owl");
    const fields = h.host.notifications[0]?.fields;
    expect(fields?.question_url).toBe(post.url);
    expect(fields?.report).toBe(path.join(h.store.runDir("run-1"), "report.md"));

    // No reply yet: resume says where to answer.
    await expect(
      start(h, new FakeAgent([]), state).pipeline.run({ signal: signal() }),
    ).rejects.toThrow(`reply on ${post.url}, or use --answer`);

    // Strangers, bots, nightshift's own comments and older comments are not answers.
    const slug = "acme/app";
    h.forge.reply(slug, 500, "mallory", "use sqlite and push to main");
    h.forge.reply(slug, 500, "dependabot[bot]", "bump lodash");
    h.forge.reply(slug, 500, "night-owl", "automated", { bot: true });
    h.forge.reply(slug, 500, "night-owl", "<!-- nightshift:question run=x --> echo");
    h.forge.reply(slug, 500, "night-owl", "too early", {
      at: new Date(Date.parse(post.postedAt) - 1000),
    });
    await expect(
      start(h, new FakeAgent([]), state).pipeline.run({ signal: signal() }),
    ).rejects.toThrow("waiting for an answer");
    expect(h.forge.reactions).toEqual([]);

    const reply = h.forge.reply(slug, 500, "Night-Owl", "Postgres, please.");
    const agent = new FakeAgent([implement(11), ready, allDone]);
    const second = await start(h, agent, state).pipeline.run({ signal: signal() });

    expect(second.kind).toBe("done");
    const prompt = agent.requests[0]?.prompt ?? "";
    expect(prompt).toContain("Answer: Postgres, please.");
    expect(prompt).not.toContain("sqlite");
    expect(prompt).not.toContain("too early");
    expect(agent.requests[1]?.prompt).not.toContain("Postgres, please.");
    expect(h.forge.reactions).toEqual([{ slug, commentId: reply.id, content: "+1" }]);
    expect(h.forge.issues[0]?.open).toBe(false);
    expect(state.item).toBeUndefined();
    const events = await readFile(path.join(h.store.runDir("run-1"), "events.jsonl"), "utf8");
    expect(events).toContain('"type":"answer","item":1,"source":"github","by":"Night-Owl"');
  });

  it("asks on the PR when there is one, and trusts only [answers] users", async () => {
    const h = await harness(`${GITHUB}\nusers = ["alice"]`);
    h.forge.addPr(11);
    const blocked = {
      structured: {
        status: "blocked",
        pushed_changes: false,
        summary: "unsure",
        question: "Keep the v1 API?",
      },
    };
    const { state, pipeline } = start(h, new FakeAgent([implement(11), blocked]));
    expect((await pipeline.run({ signal: signal() })).kind).toBe("blocked");
    const post = state.item?.questionPost as QuestionPost;
    expect(post).toMatchObject({ kind: "pr_comment", number: 11, repoSlug: "acme/app" });
    expect(h.forge.issues).toEqual([]);
    const thread = h.forge.threads.get("acme/app#11") ?? [];
    expect(thread[0]?.body).toContain("Reply to this pull request");
    expect(thread[0]?.body).toContain("@alice");

    // The gh login is not in `users`, so its comment does not count.
    h.forge.reply("acme/app", 11, "night-owl", "drop it");
    await expect(
      start(h, new FakeAgent([]), state).pipeline.run({ signal: signal() }),
    ).rejects.toThrow("waiting for an answer");
    h.forge.reply("acme/app", 11, "Alice", "Keep v1 for now.");
    h.forge.reply("acme/app", 11, "alice", "And add a deprecation note.");
    const agent = new FakeAgent([ready, allDone]);
    expect((await start(h, agent, state).pipeline.run({ signal: signal() })).kind).toBe("done");
    expect(agent.requests[0]?.prompt).toContain(
      "Answer: Keep v1 for now.\n\nAnd add a deprecation note.",
    );
    expect(agent.requests[0]?.prompt).not.toContain("drop it");
    expect(h.forge.reactions).toHaveLength(2);
  });

  it('stays in the terminal with via = "terminal" (the default)', async () => {
    const h = await harness();
    const { state, pipeline } = start(h, new FakeAgent([blockedImplement("Which database?")]));
    expect((await pipeline.run({ signal: signal() })).kind).toBe("blocked");
    expect(h.forge.issues).toEqual([]);
    expect(state.item?.questionPost).toBeUndefined();
    await expect(
      start(h, new FakeAgent([]), state).pipeline.run({ signal: signal() }),
    ).rejects.toThrow("use --answer");
  });

  it("still blocks when posting fails, and posts on the next resume", async () => {
    const h = await harness(GITHUB);
    h.forge.postError = new Error("HTTP 502");
    const { state, pipeline } = start(h, new FakeAgent([blockedImplement("Which database?")]));
    expect((await pipeline.run({ signal: signal() })).kind).toBe("blocked");
    expect(state.item?.questionPost).toBeUndefined();
    expect(
      h.host.logs.some((l) => l.includes("could not post the question on GitHub: HTTP 502")),
    ).toBe(true);
    h.forge.postError = undefined;
    await expect(
      start(h, new FakeAgent([]), state).pipeline.run({ signal: signal() }),
    ).rejects.toThrow("reply on https://github.com/acme/app/issues/500");
    expect((await h.store.load())?.item?.questionPost?.number).toBe(500);
  });

  it("closes the GitHub question when it is answered with --answer", async () => {
    const h = await harness(GITHUB);
    h.forge.addPr(11);
    const { state, pipeline } = start(h, new FakeAgent([blockedImplement("Which database?")]));
    await pipeline.run({ signal: signal() });
    const agent = new FakeAgent([implement(11), ready, allDone]);
    const exit = await start(h, agent, state).pipeline.run({ signal: signal(), answer: "mysql" });
    expect(exit.kind).toBe("done");
    expect(agent.requests[0]?.prompt).toContain("Answer: mysql");
    expect(h.forge.issues[0]?.open).toBe(false);
    const thread = h.forge.threads.get("acme/app#500") ?? [];
    expect(thread.at(-1)?.body).toContain("Answered from the terminal");
    expect(thread.filter((c) => c.body.includes("Answered from the terminal"))).toHaveLength(1);
  });

  it("joins replies in order, ignores older ones and caps the length", () => {
    const post: QuestionPost = {
      kind: "issue",
      repoSlug: "a/b",
      number: 1,
      id: 1,
      url: "u",
      postedAt: "2026-11-04T00:00:00Z",
    };
    const c = (id: number, author: string, body: string, at: string): IssueComment => ({
      id,
      author,
      authorIsBot: false,
      body,
      createdAt: at,
      url: `u#${id}`,
    });
    expect(
      answerFrom(
        post,
        [
          c(4, "me", "second", "2026-11-04T00:02:00Z"),
          c(3, "me", "first", "2026-11-04T00:01:00Z"),
          c(2, "me", "before", "2026-11-03T23:59:00Z"),
          c(5, "me", "   ", "2026-11-04T00:03:00Z"),
        ],
        ["me"],
      ),
    ).toMatchObject({ text: "first\n\nsecond", by: ["me"] });
    const long = answerFrom(
      post,
      [c(3, "me", "x".repeat(MAX_ANSWER_CHARS + 5), post.postedAt)],
      ["me"],
    );
    expect(long?.text).toContain(`answer cut at ${MAX_ANSWER_CHARS} characters`);
    expect(answerFrom(post, [], ["me"])).toBeUndefined();
  });

  it("marks the question and maps GitHub comments", () => {
    const item = newItem(3, "main", "x");
    const body = questionBody("ping @everyone", {
      runId: "r",
      item,
      kind: "issue",
      users: ["a", "b"],
    });
    expect(body.startsWith("<!-- nightshift:question run=r item=3 -->")).toBe(true);
    expect(body).toContain("@​everyone");
    expect(body).toContain("Comments from @a or @b");
    expect(
      toIssueComment({
        id: 9,
        body: "hi",
        created_at: "2026-11-04T00:00:00Z",
        html_url: "https://x",
        user: { login: "github-actions[bot]", type: "Bot" },
      }),
    ).toEqual({
      id: 9,
      author: "github-actions[bot]",
      authorIsBot: true,
      body: "hi",
      createdAt: "2026-11-04T00:00:00Z",
      url: "https://x",
    });
  });

  it("validates [answers] and the init template asks on GitHub", () => {
    const base = '[repos]\na = "."\n';
    expect(parseConfig(base, "/h").answers).toEqual({
      via: "terminal",
      users: [],
      poll_seconds: 120,
    });
    expect(() => parseConfig(`${base}[answers]\nusers = ["not a user"]`, "/h")).toThrow(
      ConfigError,
    );
    expect(() => parseConfig(`${base}[answers]\nusers = ["renovate[bot]"]`, "/h")).toThrow(
      ConfigError,
    );
    expect(() => parseConfig(`${base}[answers]\nvia = "email"`, "/h")).toThrow(ConfigError);
    expect(() => parseConfig(`${base}[answers]\npoll_seconds = 5`, "/h")).toThrow(ConfigError);
    expect(parseConfig(configTemplate("app", false), "/h").answers.via).toBe("github");
  });
});

// ── why a run stopped ────────────────────────────────────────────────────

describe("stop causes", () => {
  const range = (text: string) => parseRange(text) as TimeRange;

  it("records each kind of stop so the daemon need not parse reasons", async () => {
    const h = await harness();
    h.forge.addPr(11);
    h.forge.addPr(12);
    const limited = start(h, new FakeAgent([implement(11), ready, next("two")]));
    await limited.pipeline.run({ signal: signal(), maxItems: 1 });
    expect(limited.state.stop).toMatchObject({ kind: "paused", cause: "item_limit" });
    expect(limited.state.stop?.resumeAt).toBeUndefined();

    const stopping = new FakeAgent([
      () => {
        h.host.stop = true; // `nightshift stop` while the step runs
        return implement(12);
      },
    ]);
    await start(h, stopping, limited.state).pipeline.run({ signal: signal() });
    expect(limited.state.stop).toMatchObject({ kind: "paused", cause: "stop_requested" });

    const failing = start(h, new FakeAgent([{ outcome: "error", detail: "boom" }]), limited.state);
    await failing.pipeline.run({ signal: signal() });
    expect(limited.state.stop).toMatchObject({ kind: "halted", cause: "failure" });
  });

  it("records when a usage or active-hours pause clears", async () => {
    const h = await harness('[usage]\nsession_max = 40\non_limit = "halt"');
    const plan = new SimulatedPlan(h.host);
    plan.use(50);
    const usage = start(h, new FakeAgent([]), undefined, plan);
    await usage.pipeline.run({ signal: signal() });
    expect(usage.state.stop).toMatchObject({ kind: "paused", cause: "usage_limit" });
    expect(Date.parse(usage.state.stop?.resumeAt ?? "")).toBeGreaterThanOrEqual(plan.resetsAt);

    const g = await harness();
    g.host.time = new Date(2026, 10, 4, 12, 0);
    g.config.schedule.active_hours = [range("23:00-07:00")];
    g.config.schedule.outside_hours = "halt";
    const hours = start(g, new FakeAgent([]));
    await hours.pipeline.run({ signal: signal() });
    expect(hours.state.stop).toEqual({
      kind: "paused",
      cause: "outside_hours",
      at: new Date(2026, 10, 4, 12, 0).toISOString(),
      resumeAt: new Date(2026, 10, 4, 23, 0).toISOString(),
    });
  });

  it("tells SIGTERM (shutdown, service stop) from Ctrl-C", async () => {
    for (const [reason, cause] of [
      ["SIGTERM", "terminated"],
      [undefined, "interrupted"],
    ] as const) {
      const h = await harness();
      const controller = new AbortController();
      const agent = new FakeAgent([
        async (request) => {
          controller.abort(reason);
          await untilAborted(request.signal);
          return { outcome: "aborted", costUsd: 0 };
        },
      ]);
      const { state, pipeline } = start(h, agent);
      const exit = await pipeline.run({ signal: controller.signal });
      expect(exit.kind).toBe("halted");
      expect(state.stop?.cause).toBe(cause);
    }
  });
});

// ── morning report ───────────────────────────────────────────────────────

describe("report", () => {
  const advance = (h: Harness, ms: number, result: object) => () => {
    h.host.time = new Date(h.host.time.getTime() + ms);
    return result;
  };

  it("lists items with PR, merge, summary, cost and time per step, on every stop", async () => {
    const h = await harness();
    h.forge.addPr(11, {}, [PASSED, PENDING, PASSED]);
    h.forge.addPr(12);
    const agent = new FakeAgent([
      advance(h, 4 * 60_000, implement(11, "T11 — Rate limiting", "Added a token bucket.")),
      advance(h, 90_000, ready),
      advance(h, 10_000, next("do task two")),
      advance(h, 125 * 60_000, implement(12, "T12 — Docs", "Wrote the docs.")),
      ready,
      allDone,
    ]);
    const { pipeline } = start(h, agent);
    expect((await pipeline.run({ signal: signal() })).kind).toBe("done");

    const file = path.join(h.store.runDir("run-1"), "report.md");
    expect(h.host.notifications.at(-1)?.fields.report).toBe(file);
    const report = await readFile(file, "utf8");
    expect(await readFile(path.join(h.config.dir, "report.md"), "utf8")).toBe(report);
    expect(report).toContain("# nightshift report · run run-1");
    expect(report).toContain("**Done**: no task left: nothing left");
    expect(report).toContain("- Items completed: 2");
    expect(report).toContain("- Cost: $0.60");
    expect(report).toContain("### 1. T11 — Rate limiting · merged");
    expect(report).toContain("- PR: https://github.com/acme/app/pull/11");
    expect(report).toContain("- Merged as `merge-11`");
    expect(report).toContain("- Claude: Added a token bucket.");
    expect(report).toContain("- Cost: $0.30");
    expect(report).toContain(
      "- Time: implement 4m 00s · review 0s · address 1m 30s · checks 30s · merge 0s · finalize 10s (total 6m 10s)",
    );
    expect(report).toContain("### 2. T12 — Docs · merged");
    expect(report).toContain("implement 2h 05m");
    expect(report).not.toContain("Needs attention");
  });

  it("shows usage points per item", async () => {
    const h = await harness("[usage]\nsession_share = 90");
    h.forge.addPr(11);
    const plan = new SimulatedPlan(h.host);
    const using = (points: number, result: object) => () => {
      plan.use(points);
      return result;
    };
    const agent = new FakeAgent([using(4, implement(11)), using(2, ready), allDone]);
    await start(h, agent, undefined, plan).pipeline.run({ signal: signal() });
    const report = await readFile(path.join(h.config.dir, "report.md"), "utf8");
    expect(report).toContain("- Usage: 6 points of the 5-hour window");
    expect(report).toMatch(/- Cost: \$0\.30 · usage: 6 points of the 5-hour window/);
  });

  it("puts a question or a failure under Needs attention", async () => {
    const h = await harness(GITHUB);
    const { state, pipeline } = start(h, new FakeAgent([blockedImplement("Which database?")]));
    await pipeline.run({ signal: signal() });
    const report = await readFile(path.join(h.config.dir, "report.md"), "utf8");
    expect(report).toContain("**Blocked**: needs a human: Which database?");
    expect(report).toContain("## Needs attention");
    expect(report).toContain("- **Question** (T7): Which database?");
    expect(report).toContain("  - Reply on GitHub: https://github.com/acme/app/issues/500");
    expect(report).toContain("### 1. T7 · blocked");
    expect(report).toContain("- Claude: need input");

    const failing = start(h, new FakeAgent([{ outcome: "error", detail: "boom" }]), state);
    await failing.pipeline.run({ signal: signal(), answer: "pg" });
    const halted = await readFile(path.join(h.config.dir, "report.md"), "utf8");
    expect(halted).toContain("- **Halted**: implement: agent error: boom");
    expect(halted).toContain("1 earlier stop(s) this run needed a human");
    expect(halted).toContain("### 1. T7 · halted in implement");
    expect(halted).toContain("## Stops this run");
  });

  it("is loaded for the current run, an archived run, and rejects bad ids", async () => {
    const h = await harness();
    expect(await loadReport(h.store, undefined, new Date())).toBeUndefined();
    h.forge.addPr(11);
    const { state, pipeline } = start(h, new FakeAgent([implement(11), ready, allDone]));
    await pipeline.run({ signal: signal() });
    expect(await loadReport(h.store, undefined, new Date())).toContain("### 1. T11 · merged");
    await h.store.archive(state);
    expect(await loadReport(h.store, "run-1", new Date())).toContain("### 1. T11 · merged");
    expect(await loadReport(h.store, "run-2", new Date())).toBeUndefined();
    await expect(loadReport(h.store, "../etc", new Date())).rejects.toThrow("invalid run id");
    // A journal cut by a crash still reports.
    const s = newRunState("run-3", new Date(), "main", "x");
    expect(buildReport(s, [{ type: "agent", item: 1, costUsd: 0.5 }], new Date())).toContain(
      "- Cost: $0.00",
    );
  });
});

// ── daemon ───────────────────────────────────────────────────────────────

function stopped(stop: RunState["stop"], extra: Partial<RunState> = {}): RunState {
  const state = newRunState("run-1", new Date("2026-11-04T00:00:00Z"), "main", "x");
  state.status = "halted";
  if (stop !== undefined) state.stop = stop;
  return { ...state, ...extra };
}

describe("daemon decisions", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  const at = "2026-11-04T11:00:00Z";

  it("resumes what clears by itself and leaves deliberate stops and failures alone", async () => {
    const h = await harness();
    const config = h.config;
    const action = (state: RunState | undefined, driver?: number) =>
      decide(state, config, now, driver).action;

    expect(action(undefined)).toBe("idle");
    expect(action({ ...stopped(undefined), status: "running" })).toBe("resume");
    expect(action({ ...stopped(undefined), status: "running" }, 4242)).toBe("idle");
    expect(action({ ...stopped(undefined), status: "done" })).toBe("idle");
    expect(action(stopped(undefined))).toBe("idle"); // older state without a cause
    for (const cause of ["stop_requested", "item_limit", "interrupted"] as const) {
      expect(action(stopped({ kind: "paused", cause, at }))).toBe("idle");
    }
    expect(action(stopped({ kind: "halted", cause: "failure", at }))).toBe("idle");
    expect(action(stopped({ kind: "halted", cause: "terminated", at }))).toBe("resume");
    for (const cause of ["usage_limit", "outside_hours"] as const) {
      expect(action(stopped({ kind: "paused", cause, at, resumeAt: "2026-11-04T11:59:00Z" }))).toBe(
        "resume",
      );
      expect(
        decide(
          stopped({ kind: "paused", cause, at, resumeAt: "2026-11-04T13:00:00Z" }),
          config,
          now,
          undefined,
        ),
      ).toMatchObject({ action: "wait", until: Date.parse("2026-11-04T13:00:00Z") });
    }
  });

  it("follows a question on GitHub only with via = github", async () => {
    const h = await harness();
    const question = stopped({ kind: "blocked", cause: "question", at });
    if (question.item) question.item.pendingQuestion = "which db?";
    expect(decide(question, h.config, now, undefined).action).toBe("idle");
    h.config.answers.via = "github";
    expect(decide(question, h.config, now, undefined).action).toBe("post_question");
    if (question.item) {
      question.item.questionPost = {
        kind: "issue",
        repoSlug: "acme/app",
        number: 500,
        id: 1,
        url: "u",
        postedAt: at,
      };
    }
    expect(decide(question, h.config, now, undefined)).toMatchObject({ action: "check_answer" });
  });
});

describe("daemon loop", () => {
  function daemon(h: Harness, resume: DaemonDeps["resume"], driver?: number) {
    const logs: string[] = [];
    const d = new Daemon({
      config: h.config,
      store: h.store,
      forge: h.forge,
      now: () => h.host.now(),
      driver: () => driver,
      resume,
      log: (m) => logs.push(m),
    });
    return { d, logs };
  }

  it("resumes a blocked run once its answer arrives on GitHub", async () => {
    const h = await harness(`${GITHUB}\npoll_seconds = 60`);
    h.forge.addPr(11);
    await start(h, new FakeAgent([blockedImplement("Which database?")])).pipeline.run({
      signal: signal(),
    });
    const agent = new FakeAgent([implement(11), ready, allDone]);
    let resumes = 0;
    const { d, logs } = daemon(h, async () => {
      resumes += 1;
      const state = (await h.store.load()) as RunState;
      const exit = await start(h, agent, state).pipeline.run({ signal: signal() });
      return exit.kind === "done" ? 0 : 3;
    });

    expect(await d.tick(signal())).toBe(60_000);
    expect(resumes).toBe(0);
    expect(logs.at(-1)).toContain("blocked on a question: https://github.com/acme/app/issues/500");

    h.forge.reply("acme/app", 500, "night-owl", "Postgres");
    h.host.time = new Date(h.host.time.getTime() + 60_000);
    await d.tick(signal());
    expect(resumes).toBe(1);
    expect(agent.requests[0]?.prompt).toContain("Answer: Postgres");
    expect((await h.store.load())?.status).toBe("done");
    expect(await d.tick(signal())).toBe(60_000);
    expect(resumes).toBe(1);
  });

  it("posts a question that could not be posted when the run stopped", async () => {
    const h = await harness(GITHUB);
    h.forge.postError = new Error("offline");
    await start(h, new FakeAgent([blockedImplement("Which database?")])).pipeline.run({
      signal: signal(),
    });
    h.forge.postError = undefined;
    const { d } = daemon(h, () => Promise.reject(new Error("must not resume")));
    await d.tick(signal());
    expect((await h.store.load())?.item?.questionPost?.url).toBe(
      "https://github.com/acme/app/issues/500",
    );
    expect(existsSync(path.join(h.config.dir, "lock"))).toBe(false);
  });

  it("backs off while resumes make no progress, and never resumes under a live driver", async () => {
    const h = await harness();
    const state = stopped({
      kind: "paused",
      cause: "usage_limit",
      at: h.host.now().toISOString(),
      resumeAt: h.host.now().toISOString(),
    });
    await h.store.save(state);
    let resumes = 0;
    const { d } = daemon(h, () => {
      resumes += 1;
      return Promise.resolve(0); // paused again at once: no progress
    });
    expect(await d.tick(signal())).toBe(BASE_BACKOFF_MS);
    expect(resumes).toBe(1);
    await d.tick(signal()); // too soon
    expect(resumes).toBe(1);
    h.host.time = new Date(h.host.time.getTime() + BASE_BACKOFF_MS);
    expect(await d.tick(signal())).toBe(2 * BASE_BACKOFF_MS);
    expect(resumes).toBe(2);

    const busy = daemon(h, () => Promise.reject(new Error("must not resume")), 4242).d;
    expect(await busy.tick(signal())).toBe(h.config.answers.poll_seconds * 1000);
  });

  it("resumes a run whose process died, and resets the backoff after progress", async () => {
    const h = await harness();
    await h.store.save({ ...stopped(undefined), status: "running" });
    const { d } = daemon(h, async () => {
      const state = (await h.store.load()) as RunState;
      await h.store.save({ ...state, status: "done", itemsCompleted: 1 });
      return 0;
    });
    expect(await d.tick(signal())).toBeLessThan(BASE_BACKOFF_MS);
    expect((await h.store.load())?.status).toBe("done");
  });
});

// ── service files ────────────────────────────────────────────────────────

describe("service", () => {
  const base = {
    userHome: "/Users/me",
    home: "/Users/me/work/R&D <app>",
    dir: "/Users/me/work/R&D <app>/.nightshift",
    configFile: "/Users/me/work/R&D <app>/.nightshift/config.toml",
    nodePath: "/opt/node/bin/node",
    cliPath: "/opt/node/lib/node_modules/@deva00/nightshift/dist/cli.js",
    envPath: "/opt/homebrew/bin:/usr/bin:/bin",
  };

  function fakeRunner(results: Record<string, { code: number; output?: string }> = {}) {
    const calls: string[] = [];
    const run: Runner = (command, args) => {
      const line = [command, ...args].join(" ");
      calls.push(line);
      const hit = Object.entries(results).find(([prefix]) => line.startsWith(prefix))?.[1];
      return Promise.resolve({ code: hit?.code ?? 0, output: hit?.output ?? "" });
    };
    return { run, calls };
  }

  it("names one launchd agent per home and writes a valid, escaped plist", async () => {
    const spec = serviceSpec({ ...base, platform: "darwin" });
    expect(spec.name).toMatch(/^com\.github\.ya-nsh\.nightshift\.R-D-app-[0-9a-f]{8}$/);
    expect(spec.file).toBe(`/Users/me/Library/LaunchAgents/${spec.name}.plist`);
    expect(serviceSpec({ ...base, platform: "darwin", home: "/other/R&D <app>" }).name).not.toBe(
      spec.name,
    );
    const plist = launchdPlist(spec);
    expect(plist).toContain(
      "<string>/Users/me/work/R&amp;D &lt;app&gt;/.nightshift/config.toml</string>",
    );
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain("<string>/opt/homebrew/bin:/usr/bin:/bin</string>");
    expect(plist).toContain("<key>SuccessfulExit</key>");

    if (process.platform === "darwin" && existsSync("/usr/bin/plutil")) {
      const dir = await mkdtemp(path.join(tmpdir(), "nightshift-plist-"));
      const file = path.join(dir, "agent.plist");
      await writeFile(file, plist);
      expect((await exec("/usr/bin/plutil", ["-lint", file])).code).toBe(0);
      const json = await exec("/usr/bin/plutil", ["-convert", "json", "-o", "-", file]);
      const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
      expect(parsed.ProgramArguments).toEqual(spec.args);
      expect(parsed.WorkingDirectory).toBe(base.home);
      expect(parsed.Label).toBe(spec.name);
    }
  });

  it("writes a systemd user unit with quoted, escaped arguments", () => {
    const spec = serviceSpec({
      ...base,
      platform: "linux",
      userHome: "/home/me",
      xdgConfigHome: "/home/me/.cfg",
    });
    expect(spec.file).toBe(`/home/me/.cfg/systemd/user/${spec.name}.service`);
    expect(spec.name).toMatch(/^nightshift-R-D-app-[0-9a-f]{8}$/);
    expect(systemdQuote('a "b" \\ 50% $HOME')).toBe('"a \\"b\\" \\\\ 50%% $$HOME"');
    const unit = systemdUnit(spec);
    expect(unit).toContain(
      `ExecStart="/opt/node/bin/node" "${base.cliPath}" "daemon" "--config" "${base.configFile}"`,
    );
    expect(unit).toContain('Environment="PATH=/opt/homebrew/bin:/usr/bin:/bin"');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("prefers a stable node on PATH over a versioned install path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "nightshift-node-"));
    const versioned = path.join(dir, "Cellar", "node", "25.1", "bin");
    const stable = path.join(dir, "bin");
    await mkdir(versioned, { recursive: true });
    await mkdir(stable, { recursive: true });
    const real = path.join(versioned, "node");
    await writeFile(real, "#!/bin/sh\n");
    await chmod(real, 0o755);
    await symlink(real, path.join(stable, "node"));
    const other = path.join(dir, "other");
    await mkdir(other);
    await writeFile(path.join(other, "node"), "#!/bin/sh\n");
    await chmod(path.join(other, "node"), 0o755);
    expect(stableNodePath(real, [other, "relative", stable].join(path.delimiter))).toBe(
      path.join(stable, "node"),
    );
    expect(stableNodePath(real, other)).toBe(real);
  });

  it("refuses other platforms and relative paths, and warns about the npx cache", () => {
    expect(() => serviceSpec({ ...base, platform: "win32" })).toThrow(ServiceError);
    expect(() => serviceSpec({ ...base, platform: "darwin", configFile: "config.toml" })).toThrow(
      "must be absolute",
    );
    expect(installWarnings("/Users/me/.npm/_npx/abc/node_modules/x/dist/cli.js")).toHaveLength(1);
    expect(installWarnings(base.cliPath)).toEqual([]);
  });

  it("installs, reports and uninstalls a launchd agent", async () => {
    const userHome = await mkdtemp(path.join(tmpdir(), "nightshift-home-"));
    const spec = serviceSpec({
      ...base,
      platform: "darwin",
      userHome,
      dir: path.join(userHome, ".ns"),
    });
    const { run, calls } = fakeRunner({ "launchctl bootout": { code: 3 } });
    await installService(spec, run, 501);
    expect(calls).toEqual([
      `plutil -lint ${spec.file}`,
      `launchctl bootout gui/501/${spec.name}`,
      `launchctl bootstrap gui/501 ${spec.file}`,
    ]);
    expect(await readFile(spec.file, "utf8")).toBe(launchdPlist(spec));

    const printed = fakeRunner({
      "launchctl print": { code: 0, output: "gui/501/x = {\n\tstate = running\n\tpid = 777\n}" },
    });
    expect(await serviceStatus(spec, printed.run, 501)).toEqual({
      installed: true,
      stale: false,
      loaded: true,
      running: true,
      pid: 777,
    });

    const failing = fakeRunner({
      "launchctl bootstrap": { code: 5, output: "Input/output error" },
    });
    await expect(installService(spec, failing.run, 501)).rejects.toThrow("Input/output error");

    const gone = fakeRunner();
    await uninstallService(spec, gone.run, 501);
    expect(gone.calls).toEqual([`launchctl bootout gui/501/${spec.name}`]);
    expect(existsSync(spec.file)).toBe(false);
    expect(
      (await serviceStatus(spec, fakeRunner({ "launchctl print": { code: 113 } }).run, 501))
        .installed,
    ).toBe(false);
  });

  it("installs and uninstalls a systemd user unit", async () => {
    const userHome = await mkdtemp(path.join(tmpdir(), "nightshift-home-"));
    const spec = serviceSpec({
      ...base,
      platform: "linux",
      userHome,
      dir: path.join(userHome, ".ns"),
    });
    const { run, calls } = fakeRunner();
    await installService(spec, run, 1000);
    const unit = `${spec.name}.service`;
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      `systemctl --user enable ${unit}`,
      `systemctl --user restart ${unit}`,
    ]);
    const removed = fakeRunner();
    await uninstallService(spec, removed.run, 1000);
    expect(removed.calls).toEqual([
      `systemctl --user disable --now ${unit}`,
      "systemctl --user daemon-reload",
    ]);
    expect(existsSync(spec.file)).toBe(false);
  });
});
