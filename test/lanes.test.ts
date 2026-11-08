import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exec } from "../src/exec.js";
import { newItem, newRunState, Pipeline } from "../src/pipeline.js";
import type { AgentRequest } from "../src/ports.js";
import { migrateState, type RunState } from "../src/state.js";
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
  state.items.push(newItem(2, "other", "TASK-B"));
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
    expect(state.items).toEqual([]);
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
    expect(state.items.map((i) => i.handoff)).toEqual(["TASK-A", "TASK-C"]);
    expect(state.items[0]).toMatchObject({
      pendingQuestion: "Which database?",
      stopped: { kind: "blocked" },
    });
    expect(h.host.notifications).toHaveLength(1);

    const saved = (await h.store.load()) as RunState;
    const second = await start(h, agent, saved).pipeline.run({ signal, answer: "Postgres" });

    expect(second.kind).toBe("done");
    expect(second.state.items).toEqual([]);
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
    expect(state.items.map((i) => i.phase)).toEqual(["checks", "checks"]);
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
    expect(state.items.every((i) => i.stopped?.kind === "halted")).toBe(true);
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
    expect(state.items.map((i) => i.handoff)).toEqual(["TASK-B", "TASK-C"]);
  });

  it("asks which item an answer is for when several wait for one", async () => {
    const h = await harness(LANES);
    const state = twoItems(h);
    for (const item of state.items) item.pendingQuestion = `question ${item.index}?`;
    const agent = new LaneAgent({});
    await expect(
      start(h, agent, state).pipeline.run({ signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow(/waiting for an answer/);
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
    const perItem = state.items.map((i) => i.usagePoints?.five_hour ?? 0);
    expect(perItem.reduce((a, b) => a + b, 0)).toBeCloseTo(8);
  });
});

describe("state migration", () => {
  it("turns a version 1 state file with one item into a list of items", async () => {
    const h = await harness();
    const v1 = {
      version: 1,
      runId: "r",
      startedAt: "2026-11-01T00:00:00.000Z",
      status: "halted",
      haltReason: "needs a human: x?",
      itemsCompleted: 4,
      costUsd: 12,
      item: { ...newItem(5, "main", "do T5"), phase: "review", pendingQuestion: "x?" },
    };
    await mkdir(h.config.dir, { recursive: true });
    await writeFile(h.store.statePath, JSON.stringify(v1));

    const state = (await h.store.load()) as RunState;

    expect(state.version).toBe(2);
    expect(state).not.toHaveProperty("item");
    expect(state.items).toEqual([v1.item]);
    expect(state.nextIndex).toBe(6);
    expect(state).toMatchObject({ runId: "r", itemsCompleted: 4, costUsd: 12 });
  });

  it("migrates a finished version 1 run to no items, and refuses unknown versions", () => {
    expect(
      migrateState({ version: 1, runId: "r", status: "done", itemsCompleted: 1, costUsd: 0 }),
    ).toMatchObject({ version: 2, items: [], nextIndex: 1 });
    expect(() => migrateState({ version: 3 })).toThrow(/unsupported state version 3/);
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
