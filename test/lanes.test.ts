import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { decide, progress } from "../src/daemon.js";
import { exec } from "../src/exec.js";
import { decideStart, estimateItem } from "../src/forecast.js";
import { newIssuesRunState, newItem, newRunState, Pipeline } from "../src/pipeline.js";
import type { AgentRequest } from "../src/ports.js";
import { buildReport } from "../src/report.js";
import { type RunState, runItems, setRunItems } from "../src/state.js";
import { usageLimits } from "../src/usage.js";
import { describeEvent, renderWatch, summarize } from "../src/watch.js";
import { GitWorktrees } from "../src/worktrees.js";
import {
  deferred,
  FakeWorktrees,
  type Harness,
  harness,
  LaneAgent,
  PASSED,
  SimulatedPlan,
  tempHome,
} from "./fakes.js";

const LANES = '[limits]\nlanes = 2\n[review]\ncommand = ""';

const implement = (pr: number, item = `T${pr}`) => ({
  structured: { status: "pr_opened", item, summary: "implemented", pr_number: pr },
});
const ready = (pushed = false) => ({
  structured: { status: "ready", pushed_changes: pushed, summary: "done" },
});
const handOver = (...tasks: Array<[repo: string, prompt: string]>) => ({
  structured: {
    status: "continue",
    summary: "post-merge done",
    next: tasks.map(([repo, prompt]) => ({ repo, prompt })),
  },
});
const allDone = { structured: { status: "all_done", summary: "nothing left" } };

/** A run that already has two items handed over, TASK-A in `main` and TASK-B in `other`. */
function twoItems(h: Harness): RunState {
  const state = newRunState("run-1", h.host.now(), "main", "TASK-A");
  setRunItems(state, [...runItems(state), newItem(2, "other", "TASK-B")]);
  state.nextIndex = 3;
  return state;
}

function start(
  h: Harness,
  agent: LaneAgent,
  state: RunState = newRunState("run-1", h.host.now(), "main", "SEED"),
  extra: { usage?: SimulatedPlan; worktrees?: FakeWorktrees } = {},
) {
  const worktrees = extra.worktrees ?? new FakeWorktrees();
  const pipeline = new Pipeline(
    {
      config: h.config,
      templates: h.templates,
      agent,
      forge: h.forge,
      reviewer: h.reviewer,
      host: h.host,
      store: h.store,
      worktrees,
      ...(extra.usage ? { usage: extra.usage } : {}),
    },
    state,
  );
  return { pipeline, state, worktrees, signal: new AbortController().signal };
}

/** Holds each caller until `count` callers are waiting, so their steps provably overlap. */
function rendezvous(count: number): () => Promise<void> {
  const all = deferred();
  let arrived = 0;
  return () => {
    arrived += 1;
    if (arrived === count) all.resolve();
    return all.promise;
  };
}

describe("parallel lanes", () => {
  it("runs handed-over items at once, each in its own worktree and session", async () => {
    const h = await harness(LANES);
    for (const n of [10, 11, 12]) h.forge.addPr(n);
    const together = rendezvous(2);
    const agent = new LaneAgent({
      SEED: [implement(10), handOver(["main", "TASK-A"], ["other", "TASK-B"])],
      "TASK-A": [
        async () => {
          await together();
          return implement(11);
        },
        // TASK-B is still in progress, and what is left depends on it: nothing to start now.
        handOver(),
      ],
      "TASK-B": [
        async () => {
          await together();
          return implement(12);
        },
        allDone,
      ],
    });
    const { pipeline, state, worktrees, signal } = start(h, agent);

    const exit = await pipeline.run({ signal });

    expect(exit.kind).toBe("done");
    expect(runItems(state)).toEqual([]);
    expect(state.itemsCompleted).toBe(3);
    expect(h.forge.merges.map((m) => m.number).sort()).toEqual([10, 11, 12]);

    // Each item has its own worktree, from the right repository, and works only there.
    const dirs = worktrees.created.map((c) => c.dir);
    expect(new Set(dirs).size).toBe(3);
    expect(dirs[0]).toBe(path.join(h.config.dir, "worktrees", "run-1", "item-1"));
    expect(worktrees.created[2]?.repoDir.endsWith("other")).toBe(true);
    for (const [key, index] of [
      ["SEED", 1],
      ["TASK-A", 2],
      ["TASK-B", 3],
    ] as const) {
      const requests = agent.of(key);
      expect(requests[0]?.resumeSessionId).toBeUndefined();
      expect(requests[1]?.resumeSessionId).toBe(`session-${key}`);
      for (const r of requests) expect(r.cwd).toMatch(new RegExp(`item-${index}$`));
      expect(requests[0]?.prompt).toContain("## Parallel lanes");
    }
    expect(state.nextIndex).toBe(4);

    // The seed's finalize may fill both lanes; TASK-A's is told what is running beside it.
    const [, seedFinalize] = agent.of("SEED");
    expect(seedFinalize?.schema).toMatchObject({ properties: { next: { maxItems: 2 } } });
    const [, finalizeA] = agent.of("TASK-A");
    expect(finalizeA?.schema).toMatchObject({ properties: { next: { maxItems: 1 } } });
    expect(finalizeA?.prompt).toMatch(/- item 3 \(T12\), repo other, phase finalize, \S+: TASK-B/);

    // Merged items' worktrees and local branches are cleaned up.
    expect(worktrees.removed).toEqual(
      expect.arrayContaining([{ dir: dirs[1], branch: "feature-11" }]),
    );
    expect(worktrees.removed).toHaveLength(3);
    expect(h.host.notifications.map((n) => n.event)).toEqual(["done"]);
  });

  it("merges one PR at a time and re-checks mergeability after a sibling merged", async () => {
    const h = await harness(LANES);
    h.forge.addPr(11);
    h.forge.addPr(12);
    let merging = 0;
    let mostAtOnce = 0;
    const merge = h.forge.merge.bind(h.forge);
    h.forge.merge = async (...args) => {
      merging += 1;
      mostAtOnce = Math.max(mostAtOnce, merging);
      await new Promise((resolve) => setTimeout(resolve, 20));
      try {
        return await merge(...args);
      } finally {
        merging -= 1;
      }
    };
    const together = rendezvous(2);
    const agent = new LaneAgent({
      "TASK-A": [
        async () => {
          await together();
          return implement(11);
        },
        allDone,
      ],
      "TASK-B": [
        async () => {
          await together();
          return implement(12);
        },
        allDone,
      ],
    });
    const { pipeline, signal } = start(h, agent, twoItems(h));

    const exit = await pipeline.run({ signal });

    expect(exit.kind).toBe("done");
    expect(h.forge.merges).toHaveLength(2);
    expect(mostAtOnce).toBe(1);
    expect(h.host.sleeps.filter((ms) => ms === 5_000)).toHaveLength(1);
    expect(h.host.logs.filter((l) => l.includes("another lane merged"))).toHaveLength(1);
  });

  it("resolves a conflict that a sibling's merge caused, then merges the new head", async () => {
    const h = await harness(LANES);
    h.forge.addPr(11);
    h.forge.addPr(12);
    // Once one PR merges, the other conflicts with the new base until its branch is updated.
    let conflicted: { number: number; sha: string } | undefined;
    const merge = h.forge.merge.bind(h.forge);
    h.forge.merge = async (slug, number, ...rest) => {
      await merge(slug, number, ...rest);
      const other = h.forge.prs.get(number === 11 ? 12 : 11);
      if (conflicted === undefined && other !== undefined) {
        conflicted = { number: other.pr.number, sha: other.pr.headSha };
      }
    };
    const read = h.forge.pullRequest.bind(h.forge);
    h.forge.pullRequest = async (slug, number) => {
      const pr = await read(slug, number);
      return conflicted?.number === number && conflicted.sha === pr.headSha
        ? { ...pr, mergeable: "CONFLICTING" }
        : pr;
    };
    const resolveOrFinish = (pr: number) => (request: AgentRequest) => {
      if (!request.prompt.includes("conflicts with its base branch")) return allDone;
      const fake = h.forge.prs.get(pr);
      if (fake) fake.pr = { ...fake.pr, headSha: `sha-${pr}-b` }; // merged the base in and pushed
      return ready(true);
    };
    const together = rendezvous(2);
    const agent = new LaneAgent({
      "TASK-A": [
        async () => {
          await together();
          return implement(11);
        },
        resolveOrFinish(11),
        resolveOrFinish(11),
      ],
      "TASK-B": [
        async () => {
          await together();
          return implement(12);
        },
        resolveOrFinish(12),
        resolveOrFinish(12),
      ],
    });
    const { pipeline, signal } = start(h, agent, twoItems(h));

    const exit = await pipeline.run({ signal });

    expect(exit.kind).toBe("done");
    const second = conflicted?.number;
    expect(second).toBeDefined();
    const resolves = agent.requests.filter((r) =>
      r.request.prompt.includes("conflicts with its base branch"),
    );
    expect(resolves).toHaveLength(1);
    expect(resolves[0]?.key).toBe(second === 11 ? "TASK-A" : "TASK-B");
    expect(h.forge.merges).toHaveLength(2);
    expect(h.forge.merges[1]).toMatchObject({ number: second, headSha: `sha-${second}-b` });
  });

  it("parks a lane that needs a human while the other finishes its item, then resumes both", async () => {
    const h = await harness(LANES);
    h.forge.addPr(11);
    h.forge.addPr(12);
    h.forge.addPr(13);
    const agent = new LaneAgent({
      "TASK-A": [
        {
          structured: {
            status: "blocked",
            item: "T11",
            summary: "needs a decision",
            question: "Which database?",
          },
        },
        implement(11),
        allDone,
      ],
      "TASK-B": [implement(12), handOver(["main", "TASK-C"])],
      "TASK-C": [implement(13), allDone],
    });
    const { pipeline, state, signal } = start(h, agent, twoItems(h));

    const first = await pipeline.run({ signal });

    expect(first.kind).toBe("blocked");
    expect(first.reason).toContain("Which database?");
    // TASK-B finished its item; the item it handed over waits for the next invocation.
    expect(h.forge.merges.map((m) => m.number)).toEqual([12]);
    expect(agent.of("TASK-C")).toHaveLength(0);
    expect(runItems(state).map((i) => i.handoff)).toEqual(["TASK-A", "TASK-C"]);
    expect(state.version).toBe(2);
    expect(runItems(state)[0]).toMatchObject({
      pendingQuestion: "Which database?",
      stopped: { kind: "blocked" },
    });
    expect(h.host.notifications).toHaveLength(1);

    const saved = (await h.store.load()) as RunState;
    const second = await start(h, agent, saved).pipeline.run({ signal, answer: "Postgres" });

    expect(second.kind).toBe("done");
    expect(runItems(second.state)).toEqual([]);
    expect(second.state.version).toBe(1);
    const resumed = agent.of("TASK-A")[1];
    expect(resumed?.resumeSessionId).toBe("session-TASK-A");
    expect(resumed?.prompt).toContain("Answer: Postgres");
    expect(h.forge.merges.map((m) => m.number).sort()).toEqual([11, 12, 13]);
  });

  it("stops every lane at its next step on a run-wide stop", async () => {
    const h = await harness(LANES);
    h.forge.addPr(11);
    h.forge.addPr(12);
    const together = rendezvous(2);
    const agent = new LaneAgent({
      "TASK-A": [
        async () => {
          await together();
          h.host.stop = true; // `nightshift stop` while both steps run
          return implement(11);
        },
      ],
      "TASK-B": [
        async () => {
          await together();
          return implement(12);
        },
      ],
    });
    const { pipeline, state, signal } = start(h, agent, twoItems(h));

    const exit = await pipeline.run({ signal });

    expect(exit.kind).toBe("paused");
    expect(exit.reason).toContain("STOP");
    // Both running steps finished and were recorded; neither lane went on.
    expect(runItems(state).map((i) => i.phase)).toEqual(["checks", "checks"]);
    expect(h.forge.merges).toEqual([]);
  });

  it("shares the invocation budget between lanes", async () => {
    const h = await harness(`${LANES}\n[budget]\nitem_usd = 2\ninvocation_usd = 3`);
    const together = rendezvous(2);
    const blocked = async () => {
      await together();
      return {
        structured: { status: "blocked", item: "x", summary: "s", question: "q?" },
      };
    };
    const agent = new LaneAgent({ "TASK-A": [blocked], "TASK-B": [blocked] });
    const { pipeline, signal } = start(h, agent, twoItems(h));

    await pipeline.run({ signal });

    const budgets = agent.requests.map((r) => r.request.maxBudgetUsd);
    expect(budgets).toEqual([2, 1]);
  });

  it("stops only the lane whose worktree cannot be created", async () => {
    const h = await harness(LANES);
    const worktrees = new FakeWorktrees();
    worktrees.failure = new Error("origin/HEAD is not set");
    const { pipeline, state, signal } = start(h, new LaneAgent({}), twoItems(h), { worktrees });

    const exit = await pipeline.run({ signal });

    expect(exit.kind).toBe("halted");
    expect(exit.reason).toContain("cannot create a worktree: origin/HEAD is not set");
    expect(runItems(state).every((i) => i.stopped?.kind === "halted")).toBe(true);
  });

  it("starts no more items than --max-items allows", async () => {
    const h = await harness(LANES);
    h.forge.addPr(11);
    const agent = new LaneAgent({ "TASK-A": [implement(11), handOver(["main", "TASK-C"])] });
    const { pipeline, state, signal } = start(h, agent, twoItems(h));

    const exit = await pipeline.run({ signal, maxItems: 1 });

    expect(exit.kind).toBe("paused");
    expect(exit.reason).toContain("item limit reached");
    expect(agent.of("TASK-B")).toHaveLength(0);
    expect(runItems(state).map((i) => i.handoff)).toEqual(["TASK-B", "TASK-C"]);
  });

  it("asks which item an answer is for when several wait for one", async () => {
    const h = await harness(LANES);
    const state = twoItems(h);
    for (const item of runItems(state)) item.pendingQuestion = `question ${item.index}?`;
    const agent = new LaneAgent({});
    await expect(
      start(h, agent, state).pipeline.run({ signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow(/waiting for answers/);
    await expect(
      start(h, agent, state).pipeline.run({ signal: AbortSignal.timeout(1000), answer: "yes" }),
    ).rejects.toThrow(/pick one with --item/);
    await expect(
      start(h, agent, state).pipeline.run({
        signal: AbortSignal.timeout(1000),
        answer: "yes",
        answerItem: 7,
      }),
    ).rejects.toThrow(/no item 7/);
  });

  it("counts plan usage once when steps overlap", async () => {
    const h = await harness(`${LANES}\n[usage]\nsession_share = 50`);
    const plan = new SimulatedPlan(h.host);
    const together = rendezvous(2);
    const using = async () => {
      await together();
      plan.use(4); // both steps run while the plan's utilization grows by 4 points each
      return {
        structured: { status: "blocked", item: "x", summary: "s", question: "q?" },
      };
    };
    const agent = new LaneAgent({ "TASK-A": [using], "TASK-B": [using] });
    const { pipeline, state, signal } = start(h, agent, twoItems(h), { usage: plan });

    await pipeline.run({ signal });

    expect(state.usage?.points?.five_hour).toBe(8);
    const perItem = runItems(state).map((i) => i.usagePoints?.five_hour ?? 0);
    expect(perItem.reduce((a, b) => a + b, 0)).toBeCloseTo(8);
  });
});

describe("state with several items", () => {
  it("stays version 1 with one item, and is version 2 while other lanes hold items", async () => {
    const h = await harness();
    const state = newRunState("r", h.host.now(), "main", "do T1");
    expect(state).not.toHaveProperty("moreItems");
    const second = newItem(2, "other", "do T2");
    setRunItems(state, [...runItems(state), second]);
    expect(state).toMatchObject({ version: 2, moreItems: [second] });
    await h.store.save(state);
    const loaded = (await h.store.load()) as RunState;
    expect(runItems(loaded).map((i) => i.index)).toEqual([1, 2]);

    setRunItems(loaded, [second]);
    expect(loaded.version).toBe(1);
    expect(loaded.item).toBe(second);
    expect(loaded).not.toHaveProperty("moreItems");
    setRunItems(loaded, []);
    expect(loaded).not.toHaveProperty("item");
  });

  it("refuses a state version it does not know", async () => {
    const h = await harness();
    await mkdir(h.config.dir, { recursive: true });
    await writeFile(h.store.statePath, JSON.stringify({ version: 3, runId: "r" }));
    await expect(h.store.load()).rejects.toThrow(/unsupported state version 3/);
  });

  it("keeps a single lane in the repository's checkout", async () => {
    const h = await harness();
    h.forge.addPr(11);
    const agent = new LaneAgent({ SEED: [implement(11), ready(), allDone] });
    const { pipeline, worktrees, signal } = start(h, agent);
    expect((await pipeline.run({ signal })).kind).toBe("done");
    expect(worktrees.created).toEqual([]);
    expect(agent.requests[0]?.request.cwd).toBe(h.config.repos.main);
    expect(agent.requests[0]?.request.prompt).not.toContain("Parallel lanes");
    expect(PASSED.state).toBe("passed");
  });
});

describe("git worktrees", () => {
  const git = async (cwd: string, ...args: string[]) => {
    const result = await exec("git", ["-C", cwd, ...args]);
    if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };

  it("creates a detached worktree at the latest default branch, ignored by git status, and removes it", async () => {
    const root = await tempHome();
    const origin = path.join(root, "origin.git");
    const repo = path.join(root, "repo");
    await exec("git", ["init", "--quiet", "--bare", "--initial-branch=trunk", origin]);
    await exec("git", ["clone", "--quiet", origin, repo]);
    await git(
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "one",
    );
    await git(repo, "push", "--quiet", "origin", "HEAD:trunk");
    await git(repo, "remote", "set-head", "origin", "--auto");
    // A commit that lands on the remote after the clone: the worktree must start from it.
    await git(
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "two",
    );
    await git(repo, "push", "--quiet", "origin", "HEAD:trunk");
    await git(repo, "reset", "--quiet", "--hard", "HEAD~1");
    const tip = await git(origin, "rev-parse", "trunk");

    const worktrees = new GitWorktrees();
    const dir = path.join(repo, ".nightshift", "worktrees", "run-1", "item-1");
    const signal = new AbortController().signal;
    await expect(worktrees.create(repo, dir, signal)).resolves.toEqual({ base: "trunk" });
    expect(await git(dir, "rev-parse", "HEAD")).toBe(tip);
    expect(await git(repo, "status", "--porcelain")).toBe("");
    // Created again (a resumed item): the same worktree is kept.
    await git(dir, "switch", "--quiet", "-c", "feature-1");
    await expect(worktrees.create(repo, dir, signal)).resolves.toEqual({ base: "trunk" });
    expect(await git(dir, "branch", "--show-current")).toBe("feature-1");

    await worktrees.remove(repo, dir, "feature-1");
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(path.dirname(dir))).toBe(false);
    expect(await git(repo, "branch", "--list", "feature-1")).toBe("");
    // Removing what is already gone is fine.
    await expect(worktrees.remove(repo, dir, "feature-1")).resolves.toBeUndefined();
  });

  it("explains a repository whose origin/HEAD is not set", async () => {
    const root = await tempHome();
    const repo = path.join(root, "repo");
    await exec("git", ["init", "--quiet", repo]);
    const worktrees = new GitWorktrees();
    const signal = new AbortController().signal;
    await expect(worktrees.create(repo, path.join(root, "wt"), signal)).rejects.toThrow(
      /remote set-head origin --auto/,
    );
  });
});

// ── lanes with the other features ─────────────────────────────────────────

describe("parallel lanes with per-step settings, issues, forecasts and answers", () => {
  it("runs each lane's steps with their [agent.steps] settings", async () => {
    const h = await harness(
      `${LANES}\n[agent]\nmodel = "sonnet"\n[agent.steps.finalize]\nmodel = "haiku"\nmax_turns = 9`,
    );
    h.forge.addPr(11);
    h.forge.addPr(12);
    const agent = new LaneAgent({
      "TASK-A": [implement(11), allDone],
      "TASK-B": [implement(12), allDone],
    });
    const { pipeline, signal } = start(h, agent, twoItems(h));
    expect((await pipeline.run({ signal })).kind).toBe("done");
    for (const key of ["TASK-A", "TASK-B"]) {
      const [impl, fin] = agent.of(key);
      expect(impl).toMatchObject({ model: "sonnet", maxTurns: 200 });
      // finalize-lanes is the finalize step.
      expect(fin?.prompt).toContain("in progress right now");
      expect(fin).toMatchObject({ model: "haiku", maxTurns: 9 });
    }
  });

  it("gives each free lane its own claimed issue, and finishes when the queue is empty", async () => {
    const h = await harness(`${LANES}\n[tasks]\nsource = "github_issues"\n`);
    for (const n of [5, 6, 7]) {
      h.forge.addIssue(n, { title: `Issue ${n}` });
      h.forge.addPr(n * 10);
      h.forge.closesOnMerge.set(n * 10, n);
    }
    const together = rendezvous(2);
    const claimedAtStart = new Map<number, string[]>();
    const work = (n: number, overlap: boolean) => async (request: AgentRequest) => {
      claimedAtStart.set(n, (await h.forge.issue("acme/app", n)).labels);
      expect(request.cwd).toMatch(/item-\d+$/);
      if (overlap) await together();
      return implement(n * 10, `#${n}`);
    };
    const finalized = { structured: { status: "continue", summary: "post-merge done" } };
    const agent = new LaneAgent({
      "issue #5": [work(5, true), finalized],
      "issue #6": [work(6, true), finalized],
      "issue #7": [work(7, false), finalized],
    });
    const state = newIssuesRunState("run-1", h.host.now(), undefined);
    const { pipeline, signal, worktrees } = start(h, agent, state);

    const exit = await pipeline.run({ signal });

    expect(exit.kind).toBe("done");
    expect(exit.reason).toContain("no open issue");
    expect(state.itemsCompleted).toBe(3);
    // #5 and #6 ran at the same time, each claimed before its lane started; #7 took a freed lane.
    for (const n of [5, 6, 7]) {
      expect(claimedAtStart.get(n)).toContain("nightshift-in-progress");
      expect((await h.forge.issue("acme/app", n)).state).toBe("CLOSED");
    }
    const picked = h.forge.edits.filter((e) =>
      e.edit.addLabels?.includes("nightshift-in-progress"),
    );
    expect(picked.map((e) => e.number)).toEqual([5, 6, 7]);
    expect(new Set(worktrees.created.map((c) => c.dir)).size).toBe(3);
    // Issue items finalize without handing over: the queue gives the next one.
    const fin = agent.of("issue #5")[1];
    expect(fin?.prompt).toContain("resolves GitHub issue #5");
    expect(fin?.schema).not.toHaveProperty("properties.next");
  });

  it("asks a lane's question on GitHub and resumes that lane from the reply", async () => {
    const h = await harness(`${LANES}\n[answers]\nvia = "github"`);
    h.forge.addPr(11);
    h.forge.addPr(12);
    const agent = new LaneAgent({
      "TASK-A": [
        {
          structured: { status: "blocked", item: "T11", summary: "s", question: "Which DB?" },
        },
        implement(11),
        allDone,
      ],
      "TASK-B": [implement(12), allDone],
    });
    const { pipeline, state, signal } = start(h, agent, twoItems(h));

    const first = await pipeline.run({ signal });

    expect(first.kind).toBe("blocked");
    expect(state.stop).toMatchObject({ kind: "blocked", cause: "question" });
    const post = runItems(state)[0]?.questionPost;
    expect(post).toMatchObject({ kind: "issue", number: 500 });
    expect(h.host.notifications[0]?.fields.question_url).toBe(post?.url);
    expect(decide(state, h.config, h.host.now().getTime(), undefined)).toMatchObject({
      action: "check_answer",
      post,
    });

    h.forge.reply("acme/app", 500, "night-bot", "Postgres.");
    const second = await start(h, agent, state).pipeline.run({ signal });

    expect(second.kind).toBe("done");
    expect(agent.of("TASK-A")[1]?.prompt).toContain("Answer: Postgres.");
    expect(h.forge.issues.get(500)?.state).toBe("CLOSED");
  });

  it("lets the daemon check every lane's question, and fingerprints every item", async () => {
    const h = await harness(`${LANES}\n[answers]\nvia = "github"`);
    const state = twoItems(h);
    state.status = "halted";
    state.stop = { kind: "blocked", cause: "question", at: h.host.now().toISOString() };
    const [a, b] = runItems(state);
    if (a === undefined || b === undefined) throw new Error("two items expected");
    a.pendingQuestion = "first?";
    b.pendingQuestion = "second?";
    const now = h.host.now().getTime();
    expect(decide(state, h.config, now, undefined).action).toBe("post_question");
    const post = (n: number) => ({
      kind: "issue" as const,
      repoSlug: "acme/app",
      number: n,
      id: n,
      url: `https://github.com/acme/app/issues/${n}`,
      postedAt: h.host.now().toISOString(),
    });
    a.questionPost = post(500);
    b.questionPost = post(501);
    expect(decide(state, h.config, now, undefined)).toMatchObject({
      action: "check_answer",
      post: post(500),
      posts: [post(500), post(501)],
    });
    expect(progress(state)).toBe(`run-1|0|1,2|implement,implement|${(0).toFixed(4)}`);
  });

  it("holds back what the items in progress are still expected to use", () => {
    const estimate = estimateItem(
      Array.from({ length: 5 }, () => ({
        at: "2026-11-01T00:00:00.000Z",
        points: { five_hour: 10 },
        activeMs: 60_000,
        costUsd: 1,
      })) as Parameters<typeof estimateItem>[0],
      50,
    );
    const ctx = {
      estimate,
      limits: usageLimits(parseConfig('[repos]\na = "."\n[usage]\nsession_share = 20', "/h").usage),
      tally: {},
      windows: { five_hour: { utilization: 0, resetsAt: "2026-11-04T05:00:00.000Z" } },
      ranges: [],
      now: new Date("2026-11-04T00:00:00Z"),
    };
    expect(decideStart(ctx).start).toBe(true);
    // Two items under way that used 2 and 4 of their ~10 points: 14 more are coming.
    const held = decideStart({ ...ctx, inProgress: [{ five_hour: 2 }, { five_hour: 4 }] });
    expect(held.start).toBe(false);
    expect(held.reason).toContain("item(s) in progress are expected to use ~14 more");
    expect(decideStart({ ...ctx, inProgress: [{ five_hour: 9 }] }).start).toBe(true);
  });

  it("reports, watches and shows every item in progress", async () => {
    const h = await harness(LANES);
    const state = twoItems(h);
    state.status = "halted";
    state.haltReason = "[T2] needs a human: Which DB?";
    state.stop = { kind: "blocked", cause: "question", at: h.host.now().toISOString() };
    const [a, b] = runItems(state);
    if (a === undefined || b === undefined) throw new Error("two items expected");
    a.label = "T1";
    a.phase = "checks";
    b.label = "T2";
    b.pendingQuestion = "Which DB?";
    b.stopped = { kind: "blocked", reason: "needs a human: Which DB?", cause: "question" };

    const report = buildReport(state, [], h.host.now());
    expect(report).toContain("### 1. T1 · in progress (checks)");
    expect(report).toContain("### 2. T2 · blocked");
    expect(report).toContain("- **Question** (T2): Which DB?");

    const view = {
      state,
      holder: undefined,
      stopRequested: false,
      events: [],
      progress: [],
      limits: usageLimits(h.config.usage),
    };
    const screen = renderWatch(view, { now: h.host.now(), width: 120, color: false }).join("\n");
    expect(screen).toContain("item 1 — T1");
    expect(screen).toContain("item 2 — T2");
    expect(screen).toContain("needs an answer: Which DB?");
    expect(screen).toContain("2 items in progress");
    expect(summarize(view)).toContain("item 1 — T1 · phase checks · item 2 — T2");
    expect(
      describeEvent({
        at: "2026-11-04T00:00:00.000Z",
        type: "lane_stop",
        item: 2,
        kind: "blocked",
        reason: "q?",
      }).text,
    ).toBe("item 2 · lane blocked: q?");
  });
});
