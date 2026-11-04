import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Config, parseConfig } from "../src/config.js";
import type {
  Agent,
  AgentRequest,
  AgentResult,
  CheckSummary,
  Forge,
  Host,
  PullRequest,
  Reviewer,
  ReviewRequest,
  ReviewResult,
} from "../src/ports.js";
import { StateStore } from "../src/state.js";
import { loadTemplates, type Templates } from "../src/templates.js";

export const PASSED: CheckSummary = { state: "passed", failed: [], pending: [] };
export const PENDING: CheckSummary = { state: "pending", failed: [], pending: ["ci"] };
export const NONE: CheckSummary = { state: "none", failed: [], pending: [] };
export const failedChecks = (...names: string[]): CheckSummary => ({
  state: "failed",
  failed: names,
  pending: [],
});

type Scripted = Partial<AgentResult> | ((request: AgentRequest) => Partial<AgentResult>);

/** Answers Claude steps from a script, in order, and records every request. */
export class FakeAgent implements Agent {
  readonly name = "fake";
  readonly requests: AgentRequest[] = [];
  private sessions = 0;

  constructor(private readonly script: Scripted[]) {}

  run(request: AgentRequest): Promise<AgentResult> {
    this.requests.push(request);
    const next = this.script.shift();
    if (next === undefined) throw new Error(`unexpected agent call #${this.requests.length}`);
    const partial = typeof next === "function" ? next(request) : next;
    const sessionId = request.resumeSessionId ?? `session-${++this.sessions}`;
    return Promise.resolve({
      outcome: "success",
      sessionId,
      costUsd: 0.1,
      structured: undefined,
      detail: "",
      ...partial,
    });
  }
}

export interface FakePr {
  pr: PullRequest;
  /** Check summaries returned by successive pullRequest() calls; the last one repeats. */
  checks: CheckSummary[];
  /** Mergeability values returned by successive calls; the last one repeats. */
  mergeable?: PullRequest["mergeable"][];
}

export class FakeForge implements Forge {
  readonly prs = new Map<number, FakePr>();
  readonly merges: Array<{ number: number; method: string; headSha: string }> = [];
  readonly deletedBranches: string[] = [];
  mergeError: Error | undefined;

  addPr(
    number: number,
    overrides: Partial<PullRequest> = {},
    checks: CheckSummary[] = [PASSED],
  ): FakePr {
    const fake: FakePr = {
      pr: {
        number,
        url: `https://github.com/acme/app/pull/${number}`,
        state: "OPEN",
        isDraft: false,
        headRefName: `feature-${number}`,
        headSha: `sha-${number}-a`,
        baseRefName: "main",
        mergeable: "MERGEABLE",
        mergeCommitSha: undefined,
        checks: PASSED,
        ...overrides,
      },
      checks,
    };
    this.prs.set(number, fake);
    return fake;
  }

  repoSlug(): Promise<string> {
    return Promise.resolve("acme/app");
  }

  pullRequest(_slug: string, number: number): Promise<PullRequest> {
    const fake = this.prs.get(number);
    if (fake === undefined) throw new Error(`no PR #${number}`);
    const checks = fake.checks.length > 1 ? fake.checks.shift() : fake.checks[0];
    const mergeable =
      fake.mergeable && fake.mergeable.length > 1 ? fake.mergeable.shift() : fake.mergeable?.[0];
    fake.pr = { ...fake.pr, checks: checks ?? PASSED, ...(mergeable ? { mergeable } : {}) };
    return Promise.resolve({ ...fake.pr });
  }

  merge(
    _slug: string,
    number: number,
    method: "merge" | "rebase" | "squash",
    headSha: string,
  ): Promise<void> {
    if (this.mergeError) return Promise.reject(this.mergeError);
    const fake = this.prs.get(number);
    if (fake === undefined) throw new Error(`no PR #${number}`);
    if (fake.pr.headSha !== headSha) return Promise.reject(new Error("head moved"));
    this.merges.push({ number, method, headSha });
    fake.pr = { ...fake.pr, state: "MERGED", mergeCommitSha: `merge-${number}` };
    return Promise.resolve();
  }

  deleteBranch(_slug: string, branch: string): Promise<void> {
    this.deletedBranches.push(branch);
    return Promise.resolve();
  }
}

export class FakeReviewer implements Reviewer {
  readonly requests: ReviewRequest[] = [];
  constructor(private readonly results: Partial<ReviewResult>[] = []) {}

  run(request: ReviewRequest): Promise<ReviewResult> {
    this.requests.push(request);
    const next = this.results.shift() ?? {};
    return Promise.resolve({
      exitCode: 0,
      timedOut: false,
      output: "P2: tighten validation",
      ...next,
    });
  }
}

/** A virtual clock: sleep() advances time instantly. */
export class FakeHost implements Host {
  time = new Date("2026-11-04T00:00:00Z");
  stop = false;
  freeGb = 100;
  readonly notifications: Array<{ event: string; fields: Record<string, string> }> = [];
  readonly logs: string[] = [];
  readonly sleeps: number[] = [];

  now(): Date {
    return new Date(this.time);
  }
  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.time = new Date(this.time.getTime() + ms);
    return Promise.resolve();
  }
  freeDiskGb(): Promise<number> {
    return Promise.resolve(this.freeGb);
  }
  stopRequested(): boolean {
    return this.stop;
  }
  clearStop(): void {
    this.stop = false;
  }
  notify(event: "halted" | "done", fields: Record<string, string>): Promise<void> {
    this.notifications.push({ event, fields });
    return Promise.resolve();
  }
  log(message: string): void {
    this.logs.push(message);
  }
}

export async function tempHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "nightshift-test-"));
}

export function testConfig(home: string, extra = ""): Config {
  return parseConfig(
    `
[repos]
main = "."
other = "../other"

${extra.includes("[review]") ? "" : '[review]\ncommand = "review {pr}"'}

${extra}
`,
    home,
  );
}

export interface Harness {
  config: Config;
  templates: Templates;
  store: StateStore;
  forge: FakeForge;
  reviewer: FakeReviewer;
  host: FakeHost;
}

export async function harness(extraConfig = ""): Promise<Harness> {
  const home = await tempHome();
  const config = testConfig(home, extraConfig);
  return {
    config,
    templates: await loadTemplates(undefined),
    store: new StateStore(config.dir),
    forge: new FakeForge(),
    reviewer: new FakeReviewer(),
    host: new FakeHost(),
  };
}
