import { describe, expect, it } from "vitest";
import { newRunState, Pipeline } from "../src/pipeline.js";
import type { RunState } from "../src/state.js";
import { FakeAgent, failedChecks, type Harness, harness, NONE, PASSED, PENDING } from "./fakes.js";

const implement = (pr: number, item = `T${pr}`) => ({
  structured: { status: "pr_opened", item, summary: "implemented", pr_number: pr },
});
const ready = (pushed = false) => ({
  structured: { status: "ready", pushed_changes: pushed, summary: "addressed" },
});
const next = (prompt: string, repo = "main") => ({
  structured: {
    status: "continue",
    summary: "post-merge done",
    next_repo: repo,
    next_prompt: prompt,
  },
});
const allDone = { structured: { status: "all_done", summary: "nothing left" } };

function start(h: Harness, agent: FakeAgent, state?: RunState) {
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
    },
    s,
  );
  return { state: s, pipeline, signal: new AbortController().signal };
}

describe("pipeline", () => {
  it("runs items end to end: fresh session per item, resumed steps, normal merge, handoff", async () => {
    const h = await harness();
    h.forge.addPr(11);
    h.forge.addPr(12);
    const agent = new FakeAgent([
      implement(11),
      ready(),
      next("do task two"),
      implement(12),
      ready(),
      allDone,
    ]);
    const { pipeline, signal, state } = start(h, agent);

    const exit = await pipeline.run({ signal });

    expect(exit.kind).toBe("done");
    expect(state.itemsCompleted).toBe(2);
    expect(h.forge.merges).toEqual([
      { number: 11, method: "merge", headSha: "sha-11-a" },
      { number: 12, method: "merge", headSha: "sha-12-a" },
    ]);
    expect(h.forge.deletedBranches).toEqual(["feature-11", "feature-12"]);
    expect(h.reviewer.requests.map((r) => r.pr)).toEqual([11, 12]);

    const [impl1, addr1, fin1, impl2, addr2, fin2] = agent.requests;
    expect(impl1?.resumeSessionId).toBeUndefined();
    expect(impl1?.prompt).toContain("do task one");
    expect(impl1?.prompt).toContain("nightshift merges, not you");
    expect(addr1?.resumeSessionId).toBe("session-1");
    expect(addr1?.prompt).toContain("P2: tighten validation");
    expect(fin1?.resumeSessionId).toBe("session-1");
    expect(fin1?.prompt).toContain("merge-11");
    expect(impl2?.resumeSessionId).toBeUndefined();
    expect(impl2?.prompt).toContain("do task two");
    expect(addr2?.resumeSessionId).toBe("session-2");
    expect(fin2?.resumeSessionId).toBe("session-2");
    expect(impl1?.schema).toMatchObject({ type: "object" });
    expect(h.host.notifications.map((n) => n.event)).toEqual(["done"]);
    expect((await h.store.load())?.status).toBe("done");
  });

  it("re-reviews after pushed fixes, up to max_rounds", async () => {
    const h = await harness();
    h.forge.addPr(5);
    const agent = new FakeAgent([implement(5), ready(true), ready(true), allDone]);
    const exit = await start(h, agent).pipeline.run({ signal: new AbortController().signal });
    expect(exit.kind).toBe("done");
    expect(h.reviewer.requests).toHaveLength(2); // max_rounds = 2
    expect(agent.requests[2]?.prompt).toContain("round\n2 of at most 2");
  });

  it("skips review and address when no review command is configured", async () => {
    const h = await harness();
    const config = { ...h.config, review: { ...h.config.review, command: "" } };
    h.forge.addPr(5);
    const agent = new FakeAgent([implement(5), allDone]);
    const pipeline = new Pipeline(
      { ...h, config, agent },
      newRunState("r", h.host.now(), "main", "x"),
    );
    expect((await pipeline.run({ signal: new AbortController().signal })).kind).toBe("done");
    expect(h.reviewer.requests).toHaveLength(0);
  });

  it("halts on a question and continues with the answer in the same session", async () => {
    const h = await harness();
    h.forge.addPr(7);
    const agent = new FakeAgent([
      {
        structured: {
          status: "blocked",
          item: "T7",
          summary: "need city",
          question: "Which region launches first?",
        },
      },
      implement(7),
      ready(),
      allDone,
    ]);
    const { pipeline, state } = start(h, agent);
    const first = await pipeline.run({ signal: new AbortController().signal });
    expect(first.kind).toBe("blocked");
    expect(first.reason).toContain("Which region launches first?");
    expect(state.items[0]?.pendingQuestion).toBe("Which region launches first?");

    const saved = (await h.store.load()) as RunState;
    await expect(
      start(h, agent, saved).pipeline.run({ signal: new AbortController().signal }),
    ).rejects.toThrow(/waiting for an answer/);
    const second = await start(h, agent, saved).pipeline.run({
      signal: new AbortController().signal,
      answer: "EU",
    });
    expect(second.kind).toBe("done");
    const resumed = agent.requests[1];
    expect(resumed?.resumeSessionId).toBe("session-1");
    expect(resumed?.prompt).toContain("Question: Which region launches first?");
    expect(resumed?.prompt).toContain("Answer: EU");
  });

  it("hands the next prompt over when finalize is blocked, and attaches the answer to it", async () => {
    const h = await harness();
    h.forge.addPr(1);
    h.forge.addPr(2);
    const agent = new FakeAgent([
      implement(1),
      ready(),
      {
        structured: {
          status: "blocked",
          summary: "done",
          next_repo: "other",
          next_prompt: "do T8",
          question: "Create the staging environment?",
        },
      },
      implement(2),
      ready(),
      allDone,
    ]);
    const { pipeline } = start(h, agent);
    const first = await pipeline.run({ signal: new AbortController().signal });
    expect(first.kind).toBe("blocked");
    expect(first.state.itemsCompleted).toBe(1);
    expect(first.state.items[0]).toMatchObject({ index: 2, repo: "other", phase: "implement" });

    const saved = (await h.store.load()) as RunState;
    await start(h, agent, saved).pipeline.run({
      signal: new AbortController().signal,
      answer: "done, ref xyz",
    });
    const impl2 = agent.requests[3];
    expect(impl2?.resumeSessionId).toBeUndefined();
    expect(impl2?.cwd.endsWith("other")).toBe(true);
    expect(impl2?.prompt).toContain("do T8");
    expect(impl2?.prompt).toContain("Answer: done, ref xyz");
  });

  it("sends failing checks back to Claude and merges once they pass", async () => {
    const h = await harness();
    // The first value is consumed when implement looks the PR up.
    h.forge.addPr(3, {}, [PASSED, PENDING, failedChecks("test"), PASSED]);
    const agent = new FakeAgent([implement(3), ready(), ready(true), allDone]);
    const exit = await start(h, agent).pipeline.run({ signal: new AbortController().signal });
    expect(exit.kind).toBe("done");
    expect(agent.requests[2]?.prompt).toContain("Failing checks: test");
    expect(h.forge.merges).toHaveLength(1);
    expect(h.host.sleeps).toEqual([30_000]); // one poll while pending
  });

  it("halts when checks keep failing after max_fix_rounds", async () => {
    const h = await harness("[checks]\nmax_fix_rounds = 1");
    h.forge.addPr(3, {}, [failedChecks("lint")]);
    const agent = new FakeAgent([implement(3), ready(), ready(true)]);
    const exit = await start(h, agent).pipeline.run({ signal: new AbortController().signal });
    expect(exit.kind).toBe("halted");
    expect(exit.reason).toMatch(/checks failed after 1 fix round\(s\): lint/);
    expect(h.forge.merges).toHaveLength(0);
  });

  it("merges a PR without CI only after the settle time", async () => {
    const h = await harness("[checks]\nsettle_seconds = 60\npoll_seconds = 30");
    h.forge.addPr(4, {}, [NONE]);
    const exit = await start(h, new FakeAgent([implement(4), ready(), allDone])).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(exit.kind).toBe("done");
    expect(h.host.sleeps).toEqual([30_000, 30_000]);
  });

  it("halts when checks are required but none are reported", async () => {
    const h = await harness(
      "[checks]\nrequire_checks = true\ntimeout_minutes = 2\npoll_seconds = 60",
    );
    h.forge.addPr(4, {}, [NONE]);
    const exit = await start(h, new FakeAgent([implement(4), ready()])).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(exit.kind).toBe("halted");
    expect(exit.reason).toContain("no checks were reported");
  });

  it("re-checks when the head moves after checks passed", async () => {
    const h = await harness();
    const fake = h.forge.addPr(6);
    const original = h.forge.pullRequest.bind(h.forge);
    let calls = 0;
    h.forge.pullRequest = async (slug, n) => {
      calls += 1;
      if (calls === 3) fake.pr = { ...fake.pr, headSha: "sha-6-b" }; // pushed between checks and merge
      return original(slug, n);
    };
    const exit = await start(h, new FakeAgent([implement(6), ready(), allDone])).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(exit.kind).toBe("done");
    expect(h.forge.merges).toEqual([{ number: 6, method: "merge", headSha: "sha-6-b" }]);
  });

  it("asks Claude to resolve conflicts, then re-checks and merges", async () => {
    const h = await harness();
    const fake = h.forge.addPr(8);
    fake.mergeable = ["MERGEABLE", "MERGEABLE", "CONFLICTING", "MERGEABLE"];
    const agent = new FakeAgent([implement(8), ready(), ready(true), allDone]);
    const exit = await start(h, agent).pipeline.run({ signal: new AbortController().signal });
    expect(exit.kind).toBe("done");
    expect(agent.requests[2]?.prompt).toContain("conflicts with its base branch");
  });

  it("uses the configured merge method and survives a branch that is already gone", async () => {
    const h = await harness('[merge]\nmethod = "rebase"');
    h.forge.addPr(9);
    h.forge.deleteBranch = () => Promise.reject(new Error("boom"));
    const exit = await start(h, new FakeAgent([implement(9), ready(), allDone])).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(exit.kind).toBe("done");
    expect(h.forge.merges[0]?.method).toBe("rebase");
    expect(h.host.logs.some((l) => l.includes("could not delete branch"))).toBe(true);
  });

  it("halts when the merge itself fails", async () => {
    const h = await harness();
    h.forge.addPr(9);
    h.forge.mergeError = new Error("Required status check is expected");
    const exit = await start(h, new FakeAgent([implement(9), ready()])).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(exit.kind).toBe("halted");
    expect(exit.reason).toContain("Required status check is expected");
  });

  it("enforces the per-item budget before starting a step", async () => {
    const h = await harness("[budget]\nitem_usd = 1");
    h.forge.addPr(2);
    const agent = new FakeAgent([{ ...implement(2), costUsd: 0.7 }]);
    const exit = await start(h, agent).pipeline.run({ signal: new AbortController().signal });
    expect(exit.kind).toBe("halted");
    expect(exit.reason).toMatch(/budget exhausted/);
    expect(agent.requests[0]?.maxBudgetUsd).toBe(1);
  });

  it("halts on agent failures and invalid structured results", async () => {
    for (const [scripted, pattern] of [
      [{ outcome: "max_budget" as const }, /budget ceiling/],
      [{ outcome: "max_turns" as const }, /max_turns/],
      [{ outcome: "error" as const, detail: "API down" }, /API down/],
      [{ structured: { status: "pr_opened", item: "x", summary: "y" } }, /without pr_number/],
      [{ structured: { status: "weird" } }, /invalid structured result/],
    ] as const) {
      const h = await harness();
      const exit = await start(h, new FakeAgent([scripted])).pipeline.run({
        signal: new AbortController().signal,
      });
      expect(exit.kind).toBe("halted");
      expect(exit.reason).toMatch(pattern);
    }
  });

  it("pauses after max_items with the next item prepared, and resume continues it", async () => {
    const h = await harness();
    h.forge.addPr(1);
    h.forge.addPr(2);
    const agent = new FakeAgent([
      implement(1),
      ready(),
      next("task two"),
      implement(2),
      ready(),
      allDone,
    ]);
    const first = await start(h, agent).pipeline.run({
      signal: new AbortController().signal,
      maxItems: 1,
    });
    expect(first.kind).toBe("paused");
    expect(first.state.items[0]).toMatchObject({
      index: 2,
      phase: "implement",
      handoff: "task two",
    });

    const saved = (await h.store.load()) as RunState;
    const second = await start(h, agent, saved).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(second.kind).toBe("done");
    expect(second.state.itemsCompleted).toBe(2);
  });

  it("tells Claude when a step was interrupted and is being restarted", async () => {
    const h = await harness();
    h.forge.addPr(1);
    const agent = new FakeAgent([ready(), allDone]);
    const state = newRunState("r", h.host.now(), "main", "x");
    Object.assign(state.items[0] ?? {}, {
      phase: "address",
      inFlight: "address",
      sessionId: "session-9",
      reviewRound: 1,
      reviewOutput: "P1: bug",
      pr: { number: 1, url: "u", repoSlug: "acme/app", branch: "feature-1" },
    });
    const exit = await start(h, agent, state).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(exit.kind).toBe("done");
    expect(agent.requests[0]?.prompt).toContain("was interrupted");
    expect(agent.requests[0]?.resumeSessionId).toBe("session-9");
  });

  it("stops at a STOP request and on abort", async () => {
    const h = await harness();
    h.forge.addPr(1);
    // A STOP file left over from before the invocation is cleared; one created during it is honoured.
    h.host.stop = true;
    const agent = new FakeAgent([
      () => {
        h.host.stop = true;
        return implement(1);
      },
    ]);
    const paused = await start(h, agent).pipeline.run({ signal: new AbortController().signal });
    expect(paused.kind).toBe("paused");
    expect(paused.reason).toContain("STOP");
    expect(paused.state.items[0]?.phase).toBe("review");

    const controller = new AbortController();
    controller.abort();
    const interrupted = await start(h, new FakeAgent([])).pipeline.run({
      signal: controller.signal,
    });
    expect(interrupted.reason).toBe("interrupted");
  });

  it("halts on review failure, or skips the review when configured to", async () => {
    const h = await harness();
    h.forge.addPr(1);
    h.reviewer.run = (r) =>
      Promise.resolve({ exitCode: 2, timedOut: false, output: `failed ${r.pr}` });
    const halted = await start(h, new FakeAgent([implement(1)])).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(halted.reason).toMatch(/review command exited 2/);

    const s = await harness('[review]\ncommand = "x"\non_failure = "skip"');
    s.forge.addPr(1);
    s.reviewer.run = () => Promise.resolve({ exitCode: null, timedOut: true, output: "" });
    const done = await start(s, new FakeAgent([implement(1), allDone])).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(done.kind).toBe("done");
  });

  it("halts when free disk drops below the minimum", async () => {
    const h = await harness("[limits]\nmin_free_disk_gb = 10");
    h.host.freeGb = 7;
    const exit = await start(h, new FakeAgent([])).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(exit.reason).toMatch(/7\.0 GB of disk free/);
  });
});
