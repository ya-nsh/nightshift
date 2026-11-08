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
  Issue,
  IssueEdit,
  PullRequest,
  Reviewer,
  ReviewRequest,
  ReviewResult,
  UsageMeter,
  UsageReading,
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

type Scripted =
  | Partial<AgentResult>
  | ((request: AgentRequest) => Partial<AgentResult> | Promise<Partial<AgentResult>>);

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
    const complete = (p: Partial<AgentResult>): AgentResult => ({
      outcome: "success",
      sessionId,
      costUsd: 0.1,
      structured: undefined,
      detail: "",
      ...p,
    });
    // Synchronous scripts resolve at once, like a step that finishes before any usage re-check.
    return partial instanceof Promise ? partial.then(complete) : Promise.resolve(complete(partial));
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
  readonly autoMerges: Array<{ number: number; method: string; headSha: string }> = [];
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
    options: { auto?: boolean } = {},
  ): Promise<void> {
    if (this.mergeError) return Promise.reject(this.mergeError);
    const fake = this.prs.get(number);
    if (fake === undefined) throw new Error(`no PR #${number}`);
    if (fake.pr.headSha !== headSha) return Promise.reject(new Error("head moved"));
    if (options.auto) {
      this.autoMerges.push({ number, method, headSha });
      return Promise.resolve();
    }
    this.merges.push({ number, method, headSha });
    fake.pr = { ...fake.pr, state: "MERGED", mergeCommitSha: `merge-${number}` };
    const closes = this.closesOnMerge.get(number);
    const issue = closes === undefined ? undefined : this.issues.get(closes);
    if (issue !== undefined) issue.state = "CLOSED";
    return Promise.resolve();
  }

  deleteBranch(_slug: string, branch: string): Promise<void> {
    this.deletedBranches.push(branch);
    return Promise.resolve();
  }

  // ── issues ──

  readonly issues = new Map<number, Issue>();
  readonly comments: Array<{ number: number; body: string }> = [];
  readonly closed: Array<{ number: number; comment: string }> = [];
  readonly edits: Array<{ number: number; edit: IssueEdit }> = [];
  readonly labelsCreated: string[] = [];
  user = "night-bot";
  /** Runs after every edit, e.g. to simulate another process claiming the same issue. */
  afterEdit: ((issue: Issue) => void) | undefined;
  /** When set, issue writes (edit, comment, close, label) fail with it. */
  issueWriteError: Error | undefined;
  /** Merging a PR closes these issues, like GitHub does for `Closes #N`. */
  readonly closesOnMerge = new Map<number, number>();

  addIssue(number: number, overrides: Partial<Issue> = {}): Issue {
    const issue: Issue = {
      number,
      title: `Issue ${number}`,
      body: `Body of issue ${number}`,
      url: `https://github.com/acme/app/issues/${number}`,
      state: "OPEN",
      labels: ["nightshift"],
      assignees: [],
      author: "alice",
      createdAt: new Date(Date.UTC(2026, 0, number)).toISOString(),
      ...overrides,
    };
    this.issues.set(number, issue);
    return issue;
  }

  currentUser(): Promise<string> {
    return Promise.resolve(this.user);
  }

  listIssues(_slug: string, label: string): Promise<Issue[]> {
    return Promise.resolve(
      [...this.issues.values()]
        .filter((i) => i.state === "OPEN" && i.labels.includes(label))
        .map((i) => ({ ...i, body: "" })),
    );
  }

  issue(_slug: string, number: number): Promise<Issue> {
    const issue = this.issues.get(number);
    if (issue === undefined) return Promise.reject(new Error(`no issue #${number}`));
    return Promise.resolve({
      ...issue,
      labels: [...issue.labels],
      assignees: [...issue.assignees],
    });
  }

  editIssue(_slug: string, number: number, edit: IssueEdit): Promise<void> {
    if (this.issueWriteError) return Promise.reject(this.issueWriteError);
    const issue = this.issues.get(number);
    if (issue === undefined) return Promise.reject(new Error(`no issue #${number}`));
    this.edits.push({ number, edit });
    const without = (list: string[], remove: string[] = []) =>
      list.filter((x) => !remove.includes(x));
    const union = (list: string[], add: string[] = []) => [
      ...list,
      ...add.filter((x) => !list.includes(x)),
    ];
    issue.labels = union(without(issue.labels, edit.removeLabels), edit.addLabels);
    issue.assignees = union(without(issue.assignees, edit.removeAssignees), edit.addAssignees);
    this.afterEdit?.(issue);
    return Promise.resolve();
  }

  commentIssue(_slug: string, number: number, body: string): Promise<void> {
    if (this.issueWriteError) return Promise.reject(this.issueWriteError);
    this.comments.push({ number, body });
    return Promise.resolve();
  }

  closeIssue(_slug: string, number: number, comment: string): Promise<void> {
    if (this.issueWriteError) return Promise.reject(this.issueWriteError);
    const issue = this.issues.get(number);
    if (issue === undefined) return Promise.reject(new Error(`no issue #${number}`));
    issue.state = "CLOSED";
    this.closed.push({ number, comment });
    return Promise.resolve();
  }

  ensureLabel(_slug: string, name: string): Promise<void> {
    if (this.issueWriteError) return Promise.reject(this.issueWriteError);
    if (!this.labelsCreated.includes(name)) this.labelsCreated.push(name);
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

/** Resolves once the step's signal aborts, the way a real Claude process dies on abort. */
export function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export const FIVE_HOURS_MS = 5 * 60 * 60_000;

/**
 * A Claude plan with a 5-hour window on the fake clock: `use()` adds utilization, and the window
 * resets to 0 once the clock passes its reset time. Readings add sub-second jitter to the reset
 * time, like the real API does.
 */
export class SimulatedPlan implements UsageMeter {
  utilization = 0;
  weekly = 0;
  resetsAt: number;
  reads = 0;
  /** When set, every read fails with this detail. */
  failure: string | undefined;

  constructor(private readonly host: FakeHost) {
    this.resetsAt = host.now().getTime() + FIVE_HOURS_MS;
  }

  use(points: number): void {
    this.roll();
    this.utilization += points;
    this.weekly += points / 10;
  }

  read(): Promise<UsageReading> {
    this.reads += 1;
    if (this.failure !== undefined) return Promise.resolve({ ok: false, detail: this.failure });
    this.roll();
    const jitter = this.reads % 1000;
    return Promise.resolve({
      ok: true,
      windows: {
        five_hour: {
          utilization: this.utilization,
          resetsAt: new Date(this.resetsAt + jitter).toISOString(),
        },
        seven_day: { utilization: Math.round(this.weekly), resetsAt: "2026-11-10T00:00:00.000Z" },
      },
    });
  }

  private roll(): void {
    const now = this.host.now().getTime();
    while (now >= this.resetsAt) {
      this.utilization = 0;
      this.resetsAt += FIVE_HOURS_MS;
    }
  }
}
