import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";
import { issueEditArgs, toIssue } from "../src/github.js";
import { describeQueue, ineligible, rankIssues } from "../src/issues.js";
import { newIssuesRunState, Pipeline } from "../src/pipeline.js";
import type { Issue } from "../src/ports.js";
import type { RunState } from "../src/state.js";
import { FakeAgent, FakeForge, type Harness, harness } from "./fakes.js";

const ISSUES = '[review]\ncommand = ""\n[tasks]\nsource = "github_issues"\n';

const implement = (pr: number, item = `#${pr}`) => ({
  structured: { status: "pr_opened", item, summary: "implemented", pr_number: pr },
});
const finalized = { structured: { status: "continue", summary: "post-merge done" } };

function start(h: Harness, agent: FakeAgent, state?: RunState) {
  const s = state ?? newIssuesRunState("run-1", h.host.now(), undefined);
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

describe("GitHub issues as the task source", () => {
  it("picks the oldest eligible issue, claims it, closes it after the merge, then runs out", async () => {
    const h = await harness(ISSUES);
    h.forge.addIssue(1, { assignees: ["bob"] }); // someone else's
    h.forge.addIssue(2, { labels: ["nightshift", "blocked"] }); // skip label
    h.forge.addIssue(3, { labels: ["nightshift", "nightshift-in-progress"] }); // claimed
    h.forge.addIssue(4, { labels: ["nightshift", "nightshift-blocked"] }); // waits for a human
    h.forge.addIssue(5, { title: "Add rate limiting", body: "Limit /login to 5 per minute." });
    h.forge.addIssue(6, { assignees: ["night-bot"] }); // assigned to nightshift's own account
    h.forge.addIssue(7, { labels: ["other"] }); // not in the queue at all
    h.forge.addPr(50);
    h.forge.addPr(60);
    h.forge.closesOnMerge.set(50, 5); // "Closes #5" in PR 50
    const claimedWhenImplementing: Issue[] = [];
    const agent = new FakeAgent([
      async (request) => {
        expect(request.prompt).toContain("Keep PRs small.");
        claimedWhenImplementing.push(await h.forge.issue("acme/app", 5));
        return implement(50);
      },
      finalized,
      implement(60),
      finalized,
    ]);
    const { pipeline, signal, state } = start(h, agent);
    state.issues = { instructions: "Keep PRs small." };

    const exit = await pipeline.run({ signal });

    expect(exit.kind).toBe("done");
    expect(exit.reason).toBe('no open issue labelled "nightshift" is left to do in acme/app');
    expect(state.itemsCompleted).toBe(2);
    expect(state.item).toBeUndefined();

    const [impl5, fin5, impl6, fin6] = agent.requests;
    expect(impl5?.resumeSessionId).toBeUndefined();
    expect(impl5?.prompt).toContain("GitHub issue #5 in acme/app: **Add rate limiting**");
    expect(impl5?.prompt).toContain("Limit /login to 5 per minute.");
    expect(impl5?.prompt).toContain("https://github.com/acme/app/issues/5");
    expect(impl5?.prompt).toContain("`Closes #5`");
    expect(impl5?.prompt).toContain("## Instructions for this run");
    expect(impl5?.prompt).toContain("nightshift merges, not you");
    expect(fin5?.resumeSessionId).toBe("session-1");
    expect(fin5?.prompt).toContain("resolves GitHub issue #5");
    expect(fin5?.prompt).toContain("Do **not** pick or describe a next task");
    expect(fin5?.schema).not.toHaveProperty("properties.next_prompt");
    expect(impl6?.resumeSessionId).toBeUndefined();
    expect(impl6?.prompt).toContain("GitHub issue #6");
    expect(fin6?.prompt).toContain("issue #6");

    // Claimed while Claude worked: label and assignee.
    expect(claimedWhenImplementing[0]?.labels).toContain("nightshift-in-progress");
    expect(claimedWhenImplementing[0]?.assignees).toEqual(["night-bot"]);
    expect(h.forge.labelsCreated).toContain("nightshift-in-progress");

    // #5 was closed by GitHub ("Closes #5"); #6 had to be closed by nightshift, with a link.
    expect(h.forge.closed).toEqual([
      {
        number: 6,
        comment:
          "Fixed by https://github.com/acme/app/pull/60 (merged as merge-60). Closed by nightshift.",
      },
    ]);
    for (const n of [5, 6]) {
      const issue = await h.forge.issue("acme/app", n);
      expect(issue.state).toBe("CLOSED");
      expect(issue.labels).not.toContain("nightshift-in-progress");
      expect(issue.assignees).toEqual(["night-bot"]); // kept as a record
    }
    // Issues that were not eligible are untouched.
    for (const n of [1, 2, 3, 4, 7]) {
      expect(h.forge.edits.some((e) => e.number === n)).toBe(false);
      expect((await h.forge.issue("acme/app", n)).state).toBe("OPEN");
    }
    expect(h.forge.comments).toEqual([]);
    expect((await h.store.load())?.status).toBe("done");
  });

  it("finishes at once when no issue is open", async () => {
    const h = await harness(ISSUES);
    h.forge.addIssue(1, { labels: ["nightshift", "blocked"] });
    const agent = new FakeAgent([]);
    const exit = await start(h, agent).pipeline.run({ signal: new AbortController().signal });
    expect(exit.kind).toBe("done");
    expect(exit.reason).toContain("no open issue");
    expect(agent.requests).toHaveLength(0);
    expect(h.host.notifications.map((n) => n.event)).toEqual(["done"]);
  });

  it("orders by priority label first, then oldest first", async () => {
    const h = await harness(`${ISSUES}priority_labels = ["urgent", "p1"]\n`);
    h.forge.addIssue(1);
    h.forge.addIssue(2, { labels: ["nightshift", "p1"] });
    h.forge.addIssue(3, { labels: ["nightshift", "P1"] }); // labels are case-insensitive
    h.forge.addIssue(4, { labels: ["nightshift", "urgent"] });
    for (const n of [1, 2, 3, 4]) h.forge.closesOnMerge.set(n * 10, n);
    for (const n of [1, 2, 3, 4]) h.forge.addPr(n * 10);
    const agent = new FakeAgent(
      [4, 2, 3, 1].flatMap((n) => [implement(n * 10), finalized] as const),
    );
    const exit = await start(h, agent).pipeline.run({ signal: new AbortController().signal });
    expect(exit.kind).toBe("done");
    const order = agent.requests
      .filter((r) => r.prompt.includes("Work on GitHub issue"))
      .map((r) => /issue #(\d+)/.exec(r.prompt)?.[1]);
    expect(order).toEqual(["4", "2", "3", "1"]);
  });

  it("posts a blocked question on the issue, keeps the claim, and clears the label on resume", async () => {
    const h = await harness(ISSUES);
    h.forge.addIssue(8);
    h.forge.addPr(80);
    const agent = new FakeAgent([
      {
        structured: {
          status: "blocked",
          item: "#8",
          summary: "unclear",
          question: "Which endpoint should be limited?",
        },
      },
      implement(80),
      finalized,
    ]);
    const { pipeline, state } = start(h, agent);
    const first = await pipeline.run({ signal: new AbortController().signal });
    expect(first.kind).toBe("blocked");

    let issue = await h.forge.issue("acme/app", 8);
    expect(issue.labels).toEqual(["nightshift", "nightshift-in-progress", "nightshift-blocked"]);
    expect(issue.assignees).toEqual(["night-bot"]);
    expect(h.forge.comments).toHaveLength(1);
    expect(h.forge.comments[0]?.body).toContain("**nightshift stopped** on this issue");
    expect(h.forge.comments[0]?.body).toContain(
      "> needs a human: Which endpoint should be limited?",
    );
    expect(h.forge.comments[0]?.body).toContain("nightshift resume --answer");
    expect(state.item?.issue?.flagged).toBe("nightshift-blocked");

    const saved = (await h.store.load()) as RunState;
    const second = await start(h, agent, saved).pipeline.run({
      signal: new AbortController().signal,
      answer: "Only /login",
    });
    expect(second.kind).toBe("done");
    expect(agent.requests[1]?.resumeSessionId).toBe("session-1");
    expect(agent.requests[1]?.prompt).toContain("Answer: Only /login");
    issue = await h.forge.issue("acme/app", 8);
    expect(issue.labels).toEqual(["nightshift"]);
    expect(issue.state).toBe("CLOSED");
    expect(h.forge.comments).toHaveLength(1);
  });

  it("comments once per distinct halt, relabels on each, and survives GitHub failures", async () => {
    const h = await harness(ISSUES);
    h.forge.addIssue(9);
    const failed = {
      structured: { status: "failed", item: "#9", summary: "tests cannot run" },
    };
    const agent = new FakeAgent([failed]);
    const { pipeline, state } = start(h, agent);
    const exit = await pipeline.run({ signal: new AbortController().signal });
    expect(exit.kind).toBe("halted");
    expect(exit.reason).toBe("implement failed: tests cannot run");
    expect(h.forge.comments.map((c) => c.number)).toEqual([9]);
    expect(h.forge.comments[0]?.body).toContain("`nightshift resume` continues");
    expect(state.item?.issue?.noted).toBe("implement failed: tests cannot run");

    // `resume` takes the blocked label off; the same failure again puts it back without a comment.
    let saved = (await h.store.load()) as RunState;
    const again = await start(h, new FakeAgent([failed]), saved).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(again.kind).toBe("halted");
    expect(h.forge.comments).toHaveLength(1);
    expect((await h.forge.issue("acme/app", 9)).labels).toContain("nightshift-blocked");
    expect(
      h.forge.edits.filter((e) => e.edit.removeLabels?.includes("nightshift-blocked")),
    ).toHaveLength(1);

    // GitHub is down when a different stop happens: the stop is still reported, and logged.
    h.forge.issueWriteError = new Error("HTTP 502");
    saved = (await h.store.load()) as RunState;
    const third = await start(
      h,
      new FakeAgent([{ structured: { status: "failed", item: "#9", summary: "disk full" } }]),
      saved,
    ).pipeline.run({ signal: new AbortController().signal });
    expect(third.kind).toBe("halted");
    expect(third.reason).toBe("implement failed: disk full");
    expect(h.forge.comments).toHaveLength(1);
    expect(h.host.logs.some((l) => l.includes("could not") && l.includes("HTTP 502"))).toBe(true);
  });

  it("sets an issue that needs no change aside and goes on with the next one", async () => {
    const h = await harness(ISSUES);
    h.forge.addIssue(1);
    h.forge.addIssue(2);
    h.forge.addPr(20);
    h.forge.closesOnMerge.set(20, 2);
    const agent = new FakeAgent([
      { structured: { status: "all_done", item: "#1", summary: "Already fixed by #12." } },
      implement(20),
      finalized,
    ]);
    const { pipeline, state } = start(h, agent);
    const exit = await pipeline.run({ signal: new AbortController().signal });
    expect(exit.kind).toBe("done");
    expect(state.itemsCompleted).toBe(1);
    expect(state.issues?.skipped).toEqual([1]);

    const one = await h.forge.issue("acme/app", 1);
    expect(one.state).toBe("OPEN");
    expect(one.labels).toEqual(["nightshift", "nightshift-blocked"]);
    expect(one.assignees).toEqual([]); // claim released
    expect(h.forge.comments).toHaveLength(1);
    expect(h.forge.comments[0]?.body).toContain("opened no pull request");
    expect(h.forge.comments[0]?.body).toContain("> Already fixed by #12.");
    expect((await h.forge.issue("acme/app", 2)).state).toBe("CLOSED");
    // Item numbers keep counting across the skipped issue.
    expect(agent.requests[1]?.artifactPath).toContain("item-2");
  });

  it("backs off when another account claims the same issue at the same time", async () => {
    const h = await harness(ISSUES);
    h.forge.addIssue(1);
    h.forge.addIssue(2);
    h.forge.addPr(20);
    h.forge.closesOnMerge.set(20, 2);
    h.forge.afterEdit = (issue) => {
      if (issue.number === 1 && !issue.assignees.includes("rival")) issue.assignees.push("rival");
    };
    const agent = new FakeAgent([implement(20), finalized]);
    const exit = await start(h, agent).pipeline.run({ signal: new AbortController().signal });
    expect(exit.kind).toBe("done");
    expect(agent.requests[0]?.prompt).toContain("GitHub issue #2");
    const one = await h.forge.issue("acme/app", 1);
    expect(one.assignees).toEqual(["rival"]);
    expect(one.labels).toEqual(["nightshift"]);
  });

  it("claims the issue before implementing when nightshift stopped right after picking it", async () => {
    const h = await harness(ISSUES);
    h.forge.addIssue(3);
    h.forge.addPr(30);
    h.forge.closesOnMerge.set(30, 3);
    const state = newIssuesRunState("run-1", h.host.now(), undefined);
    const { pipeline: picker } = start(h, new FakeAgent([]), state);
    // Simulate the crash: pick, then drop the claim as if it never happened.
    h.forge.issueWriteError = new Error("connection reset");
    const crashed = await picker.run({ signal: new AbortController().signal });
    expect(crashed.kind).toBe("halted");
    expect(state.item?.issue?.claimed).toBeUndefined();
    expect(state.item?.issue?.assignee).toBe("night-bot"); // recorded before the edit

    h.forge.issueWriteError = undefined;
    const saved = (await h.store.load()) as RunState;
    const agent = new FakeAgent([
      async (request) => {
        const issue = await h.forge.issue("acme/app", 3);
        expect(issue.labels).toContain("nightshift-in-progress");
        expect(issue.assignees).toEqual(["night-bot"]);
        expect(request.prompt).toContain("GitHub issue #3");
        return implement(30);
      },
      finalized,
    ]);
    const exit = await start(h, agent, saved).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(exit.kind).toBe("done");
    expect(agent.requests).toHaveLength(2);
  });

  it("retries only the closing when it failed after the post-merge work", async () => {
    const h = await harness(ISSUES);
    h.forge.addIssue(4);
    h.forge.addPr(40); // GitHub does not close #4
    const agent = new FakeAgent([
      implement(40),
      async () => {
        h.forge.issueWriteError = new Error("HTTP 403: Resource not accessible");
        return finalized;
      },
    ]);
    const { pipeline } = start(h, agent);
    const exit = await pipeline.run({ signal: new AbortController().signal });
    expect(exit.kind).toBe("halted");
    expect(exit.reason).toContain("HTTP 403");
    expect((await h.forge.issue("acme/app", 4)).state).toBe("OPEN");

    h.forge.issueWriteError = undefined;
    const saved = (await h.store.load()) as RunState;
    expect(saved.item?.phase).toBe("finalize");
    expect(saved.item?.issue?.finalized).toBe(true);
    const resumed = new FakeAgent([]); // no Claude step: post-merge work is already done
    const again = await start(h, resumed, saved).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(again.kind).toBe("done");
    expect(resumed.requests).toHaveLength(0);
    expect(h.forge.closed.map((c) => c.number)).toEqual([4]);
    const issue = await h.forge.issue("acme/app", 4);
    expect(issue.state).toBe("CLOSED");
    expect(issue.labels).toEqual(["nightshift"]);
  });

  it("pauses between issues at the item limit and picks the next one on resume", async () => {
    const h = await harness(ISSUES);
    h.forge.addIssue(1);
    h.forge.addIssue(2);
    h.forge.addPr(10);
    h.forge.addPr(20);
    h.forge.closesOnMerge.set(10, 1);
    h.forge.closesOnMerge.set(20, 2);
    const agent = new FakeAgent([implement(10), finalized, implement(20), finalized]);
    const { pipeline, state } = start(h, agent);
    const first = await pipeline.run({ signal: new AbortController().signal, maxItems: 1 });
    expect(first.kind).toBe("paused");
    expect(state.item).toBeUndefined();
    // Not claimed before the pause.
    expect((await h.forge.issue("acme/app", 2)).labels).toEqual(["nightshift"]);
    expect(h.forge.comments).toEqual([]);

    const saved = (await h.store.load()) as RunState;
    const second = await start(h, agent, saved).pipeline.run({
      signal: new AbortController().signal,
    });
    expect(second.kind).toBe("done");
    expect(saved.itemsCompleted).toBe(2);
  });

  it("only takes issues from tasks.authors when that list is set", async () => {
    const h = await harness(`${ISSUES}authors = ["Alice"]\n`);
    h.forge.addIssue(1, { author: "mallory" });
    h.forge.addIssue(2, { author: "alice" });
    h.forge.addPr(20);
    h.forge.closesOnMerge.set(20, 2);
    const agent = new FakeAgent([implement(20), finalized]);
    expect(
      (await start(h, agent).pipeline.run({ signal: new AbortController().signal })).kind,
    ).toBe("done");
    expect(agent.requests[0]?.prompt).toContain("GitHub issue #2");
    expect((await h.forge.issue("acme/app", 1)).state).toBe("OPEN");
  });
});

describe("issue queue", () => {
  const rules = {
    label: "nightshift",
    priority_labels: [],
    skip_labels: ["blocked"],
    authors: [],
    in_progress_label: "nightshift-in-progress",
    blocked_label: "nightshift-blocked",
  };
  const issue = (number: number, overrides: Partial<Issue> = {}): Issue => ({
    number,
    title: `Issue ${number}`,
    body: "",
    url: `https://github.com/acme/app/issues/${number}`,
    state: "OPEN",
    labels: ["nightshift"],
    assignees: [],
    author: "alice",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });

  it("explains why an issue is not eligible", () => {
    expect(ineligible(issue(1), rules, "bot")).toBeUndefined();
    expect(ineligible(issue(1, { assignees: ["BOT"] }), rules, "bot")).toBeUndefined();
    expect(ineligible(issue(1, { state: "CLOSED" }), rules, "bot")).toBe("closed");
    expect(ineligible(issue(1, { labels: [] }), rules, "bot")).toContain("no longer labelled");
    expect(ineligible(issue(1, { labels: ["nightshift", "Blocked"] }), rules, "bot")).toBe(
      'labelled "blocked"',
    );
    expect(ineligible(issue(1, { assignees: ["bob", "bot"] }), rules, "bot")).toBe(
      "assigned to bob",
    );
    expect(ineligible(issue(1), rules, "bot", new Set([1]))).toContain("set aside");
    expect(
      ineligible(issue(1, { labels: ["nightshift", "nightshift-in-progress"] }), rules, "bot"),
    ).toContain("already claimed");
  });

  it("ranks by priority label, then age, then number; unparsable dates go last", () => {
    const ranked = rankIssues(
      [
        issue(1, { createdAt: "2026-03-01T00:00:00Z" }),
        issue(2, { createdAt: "not a date" }),
        issue(3, { createdAt: "2026-02-01T00:00:00Z" }),
        issue(4, { createdAt: "2026-04-01T00:00:00Z", labels: ["nightshift", "p0"] }),
        issue(5, { createdAt: "2026-02-01T00:00:00Z" }),
        issue(6, { assignees: ["bob"] }),
      ],
      { ...rules, priority_labels: ["p0"] },
      "bot",
    );
    expect(ranked.queue.map((i) => i.number)).toEqual([4, 3, 5, 1, 2]);
    expect(ranked.skipped).toEqual([
      { issue: expect.objectContaining({ number: 6 }), why: "assigned to bob" },
    ]);
  });

  it("describes the queue for doctor and status, and reports failures as values", async () => {
    const config = parseConfig(`[repos]\nmain = "."\n${ISSUES}`, "/w/app");
    const forge = new FakeForge();
    expect(await describeQueue(forge, config)).toEqual({
      ok: true,
      detail: 'GitHub issues labelled "nightshift" in acme/app · 0 ready · next: none',
    });
    forge.addIssue(2, { title: "Second" });
    forge.addIssue(1, { title: "First" });
    forge.addIssue(3, { assignees: ["bob"] });
    expect((await describeQueue(forge, config)).detail).toBe(
      'GitHub issues labelled "nightshift" in acme/app · 2 ready, 1 skipped · next: #1 First',
    );
    forge.listIssues = () => Promise.reject(new Error("issues are disabled"));
    expect(await describeQueue(forge, config)).toEqual({
      ok: false,
      detail: "cannot list issues: issues are disabled",
    });
  });
});

describe("gh issue JSON", () => {
  it("maps gh issue view output", () => {
    expect(
      toIssue({
        number: 12,
        title: "Add rate limiting",
        body: "Limit it.",
        url: "https://github.com/acme/app/issues/12",
        state: "OPEN",
        labels: [
          { id: "LA_1", name: "nightshift", description: "", color: "ededed" },
          { id: "LA_2", name: "p1", description: "", color: "ff0000" },
        ],
        assignees: [{ id: "U_1", login: "night-bot", name: "Night Bot" }],
        author: { id: "U_2", login: "alice", name: "Alice", is_bot: false },
        createdAt: "2026-11-01T10:00:00Z",
      }),
    ).toEqual({
      number: 12,
      title: "Add rate limiting",
      body: "Limit it.",
      url: "https://github.com/acme/app/issues/12",
      state: "OPEN",
      labels: ["nightshift", "p1"],
      assignees: ["night-bot"],
      author: "alice",
      createdAt: "2026-11-01T10:00:00Z",
    });
  });

  it("tolerates missing fields (list output has no body; ghost authors are null)", () => {
    expect(toIssue({ number: 3, state: "CLOSED", author: null, labels: null })).toEqual({
      number: 3,
      title: "",
      body: "",
      url: "",
      state: "CLOSED",
      labels: [],
      assignees: [],
      author: "",
      createdAt: "",
    });
    expect(() => toIssue({ title: "no number" })).toThrow(/valid number/);
  });

  it("builds gh issue edit flags", () => {
    expect(
      issueEditArgs({
        addLabels: ["nightshift-in-progress"],
        removeLabels: ["nightshift-blocked", ""],
        addAssignees: ["night-bot"],
        removeAssignees: [],
      }),
    ).toEqual([
      "--add-label",
      "nightshift-in-progress",
      "--remove-label",
      "nightshift-blocked",
      "--add-assignee",
      "night-bot",
    ]);
    expect(issueEditArgs({ addLabels: ["a", "b"] })).toEqual(["--add-label", "a,b"]);
    expect(issueEditArgs({})).toEqual([]);
  });
});

describe("[tasks] config", () => {
  it("defaults to the handoff source and resolves the issues repo", () => {
    const handoff = parseConfig('[repos]\napi = "."\nweb = "../web"', "/w/api");
    expect(handoff.tasks).toEqual({
      source: "handoff",
      label: "nightshift",
      repo: "api",
      priority_labels: [],
      skip_labels: ["blocked"],
      authors: [],
      assign: true,
      in_progress_label: "nightshift-in-progress",
      blocked_label: "nightshift-blocked",
    });
    const issues = parseConfig(
      '[repos]\napi = "."\nweb = "../web"\n[tasks]\nsource = "github_issues"\nrepo = "web"\nlabel = "agent"',
      "/w/api",
    );
    expect(issues.tasks).toMatchObject({ source: "github_issues", repo: "web", label: "agent" });
  });

  it("rejects settings that cannot work", () => {
    const tasks = (body: string) => () =>
      parseConfig(`[repos]\napi = "."\n[tasks]\nsource = "github_issues"\n${body}`, "/w");
    expect(tasks('repo = "nope"')).toThrow(/repo "nope" is not one of: api/);
    expect(tasks('in_progress_label = "nightshift"')).toThrow(/must differ from label/);
    expect(tasks('blocked_label = "x"\nin_progress_label = "x"')).toThrow(/must differ/);
    expect(tasks('skip_labels = ["nightshift"]')).toThrow(/no issue could be picked/);
    expect(tasks('assign = false\nin_progress_label = ""')).toThrow(/claimed somehow/);
    expect(tasks('label = "a,b"')).toThrow(/commas/);
    expect(tasks('label = ""')).toThrow(ConfigError);
    expect(() => parseConfig('[repos]\napi = "."\n[tasks]\nsource = "jira"', "/w")).toThrow(
      /tasks\.source/,
    );
  });
});
