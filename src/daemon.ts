import { spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allowedUsers, findAnswer, postQuestion } from "./answers.js";
import type { Config } from "./config.js";
import type { Forge } from "./ports.js";
import {
  Lock,
  LockedError,
  type QuestionPost,
  type RunState,
  runItems,
  type StateStore,
} from "./state.js";

/**
 * `nightshift daemon`: a long-lived loop that resumes the run when it can make progress without a
 * human (an answer arrived on GitHub, a usage or active-hours pause cleared, the machine rebooted
 * while it ran), and leaves deliberate stops and failures alone.
 */

export const DAEMON_LOG = "daemon.log";
export const DAEMON_LOCK = "daemon.lock";
/** The log is rotated to `daemon.log.1` past this size. */
const MAX_LOG_BYTES = 5_000_000;
/** First retry delay after a resume that made no progress; doubles up to MAX_BACKOFF_MS. */
export const BASE_BACKOFF_MS = 60_000;
export const MAX_BACKOFF_MS = 60 * 60_000;
/** After a resume that made progress, look again this soon. */
const AFTER_RESUME_MS = 5_000;
/** The allowed users are re-read (`gh api user`) at most this often. */
const USERS_TTL_MS = 60 * 60_000;

const PAUSE_LABEL = {
  usage_limit: "usage limit",
  outside_hours: "outside active hours",
  forecast_usage: "forecast: a typical item would not fit the usage limits",
  forecast_hours: "forecast: a typical item would not fit the active hours",
} as const;

export type Decision =
  | { action: "resume"; why: string }
  | { action: "post_question"; why: string }
  | {
      action: "check_answer";
      why: string;
      post: QuestionPost;
      /** With parallel lanes, every open question's post (`post` is the first); any answer resumes. */
      posts?: QuestionPost[];
    }
  | { action: "wait"; why: string; until: number }
  | { action: "idle"; why: string };

/**
 * What the daemon should do about the run, decided only from recorded facts: the run's status,
 * the cause of its stop (never the human-readable reason) and whether a process holds its lock.
 */
export function decide(
  state: RunState | undefined,
  config: Config,
  now: number,
  driver: number | undefined,
): Decision {
  if (state === undefined) return { action: "idle", why: "no run yet" };
  if (driver !== undefined) {
    return { action: "idle", why: `nightshift (pid ${driver}) is driving the run` };
  }
  if (state.status === "done") return { action: "idle", why: `run ${state.runId} is done` };
  if (state.status === "running") {
    return {
      action: "resume",
      why: `run ${state.runId} was running when its process died (crash or reboot)`,
    };
  }
  const stop = state.stop;
  if (stop === undefined) {
    return {
      action: "idle",
      why: "the run stopped without a recorded cause (older nightshift); `nightshift resume` continues it",
    };
  }
  switch (stop.cause) {
    case "usage_limit":
    case "outside_hours":
    case "forecast_usage":
    case "forecast_hours": {
      const what = PAUSE_LABEL[stop.cause];
      const at = stop.resumeAt === undefined ? Number.NaN : Date.parse(stop.resumeAt);
      if (Number.isNaN(at) || at <= now) {
        return { action: "resume", why: `paused (${what}), which has cleared` };
      }
      return { action: "wait", why: `paused (${what}) until ${stop.resumeAt}`, until: at };
    }
    case "terminated":
      return { action: "resume", why: "stopped by SIGTERM (shutdown, logout or service stop)" };
    case "question": {
      // With parallel lanes several items may wait; an answer to any of them lets the run go on.
      const open = runItems(state).filter(
        (i) => i.pendingQuestion !== undefined && i.pendingAnswer === undefined,
      );
      const item = open[0] ?? runItems(state).find((i) => i.pendingQuestion !== undefined);
      if (item?.pendingQuestion === undefined) {
        return { action: "idle", why: "blocked, but no open question is recorded" };
      }
      if (config.answers.via !== "github") {
        return {
          action: "idle",
          why: 'blocked on a question; answer with `nightshift resume --answer "…"` ([answers] via = "terminal")',
        };
      }
      const asked = open.length === 0 ? [item] : open;
      if (asked.some((i) => i.questionPost === undefined)) {
        return { action: "post_question", why: "blocked on a question that is not on GitHub yet" };
      }
      const posts = asked.map((i) => i.questionPost as QuestionPost);
      const [post] = posts as [QuestionPost, ...QuestionPost[]];
      if (posts.length === 1) {
        return { action: "check_answer", why: `blocked on a question: ${post.url}`, post };
      }
      return {
        action: "check_answer",
        why: `blocked on ${posts.length} questions: ${posts.map((p) => p.url).join(", ")}`,
        post,
        posts,
      };
    }
    case "stop_requested":
      return { action: "idle", why: "stopped with `nightshift stop`; resume it by hand" };
    case "item_limit":
      return { action: "idle", why: "paused at the item limit; resume it by hand" };
    case "interrupted":
      return { action: "idle", why: "interrupted (Ctrl-C); resume it by hand" };
    case "failure":
      return { action: "idle", why: "halted on a failure that needs a human" };
    case "done":
      return { action: "idle", why: "the run is done" };
  }
}

/** A cheap fingerprint of how far the run is; unchanged after a resume means no progress. */
export function progress(state: RunState | undefined): string {
  if (state === undefined) return "none";
  const items = runItems(state);
  return [
    state.runId,
    state.itemsCompleted,
    items.length === 0 ? "-" : items.map((i) => i.index).join(","),
    items.length === 0 ? "-" : items.map((i) => i.phase).join(","),
    state.costUsd.toFixed(4),
  ].join("|");
}

export interface DaemonDeps {
  config: Config;
  store: StateStore;
  forge: Forge;
  now(): Date;
  /** The pid driving the run, if any (the run's lock). */
  driver(): number | undefined;
  /** Runs `nightshift resume` to completion and returns its exit code. */
  resume(signal: AbortSignal): Promise<number>;
  log(message: string): void;
}

/** One decision per `tick()`, which returns how long to sleep before the next one. */
export class Daemon {
  private failures = 0;
  private notBefore = 0;
  private answerFailures = 0;
  private nextAnswerCheck = 0;
  private users: { list: string[]; at: number } | undefined;
  private lastWhy: string | undefined;

  constructor(readonly deps: DaemonDeps) {}

  get pollMs(): number {
    return this.deps.config.answers.poll_seconds * 1000;
  }

  async tick(signal: AbortSignal): Promise<number> {
    const now = this.deps.now().getTime();
    let state: RunState | undefined;
    try {
      state = await this.deps.store.load();
    } catch (error) {
      this.note(`cannot read the run state: ${(error as Error).message}`);
      return this.pollMs;
    }
    const decision = decide(state, this.deps.config, now, this.deps.driver());
    switch (decision.action) {
      case "idle":
        this.note(decision.why);
        return this.pollMs;
      case "wait":
        this.note(decision.why);
        return clamp(decision.until - now, 1000, this.pollMs);
      case "post_question":
        this.note(decision.why);
        await this.postQuestion();
        return this.pollMs;
      case "check_answer": {
        this.note(decision.why);
        if (now < this.nextAnswerCheck) return clamp(this.nextAnswerCheck - now, 1000, this.pollMs);
        let found = false;
        for (const post of decision.posts ?? [decision.post]) {
          found = (await this.checkAnswer(post, now)) || found;
          if (found) break;
        }
        if (!found) return this.pollMs;
        return this.resume(state, "an answer arrived on GitHub", signal);
      }
      case "resume":
        return this.resume(state, decision.why, signal);
    }
  }

  private async resume(
    before: RunState | undefined,
    why: string,
    signal: AbortSignal,
  ): Promise<number> {
    const now = this.deps.now().getTime();
    if (now < this.notBefore) {
      this.note(`${why}; retrying after ${new Date(this.notBefore).toISOString()} (backoff)`);
      return clamp(this.notBefore - now, 1000, MAX_BACKOFF_MS);
    }
    this.lastWhy = undefined;
    this.deps.log(`resuming: ${why}`);
    let code: number;
    try {
      code = await this.deps.resume(signal);
    } catch (error) {
      this.deps.log(`could not start \`nightshift resume\`: ${(error as Error).message}`);
      code = 1;
    }
    if (signal.aborted) return 0;
    const after = await this.deps.store.load().catch(() => undefined);
    const advanced = progress(after) !== progress(before);
    this.deps.log(`\`nightshift resume\` exited ${code}${advanced ? "" : " without progress"}`);
    if (advanced && code !== 1) {
      this.failures = 0;
      this.notBefore = 0;
      return AFTER_RESUME_MS;
    }
    this.failures += 1;
    const delay = backoff(this.failures);
    this.notBefore = this.deps.now().getTime() + delay;
    this.deps.log(`backing off ${Math.round(delay / 1000)}s before the next resume`);
    return clamp(delay, 1000, MAX_BACKOFF_MS);
  }

  private async allowed(now: number): Promise<string[]> {
    if (this.users !== undefined && now - this.users.at < USERS_TTL_MS) return this.users.list;
    const list = await allowedUsers(this.deps.config, this.deps.forge);
    this.users = { list, at: now };
    return list;
  }

  private async checkAnswer(post: QuestionPost, now: number): Promise<boolean> {
    try {
      const answer = await findAnswer(this.deps.forge, post, await this.allowed(now));
      this.answerFailures = 0;
      this.nextAnswerCheck = now + this.pollMs;
      if (answer !== undefined) this.deps.log(`answer from @${answer.by.join(", @")}`);
      return answer !== undefined;
    } catch (error) {
      this.answerFailures += 1;
      const delay = Math.max(this.pollMs, backoff(this.answerFailures));
      this.nextAnswerCheck = now + delay;
      this.deps.log(
        `cannot read replies on ${post.url}: ${(error as Error).message}; next check in ${Math.round(delay / 1000)}s`,
      );
      return false;
    }
  }

  /** Posts a question that could not be posted when the run stopped, holding the run's lock. */
  private async postQuestion(): Promise<void> {
    const { store, config, forge } = this.deps;
    let lock: Lock;
    try {
      lock = await Lock.acquire(store.dir);
    } catch (error) {
      if (error instanceof LockedError) return; // someone resumed meanwhile
      throw error;
    }
    try {
      const state = await store.load();
      if (state === undefined) return;
      // With parallel lanes, every item waiting on a question gets it asked.
      for (const item of runItems(state)) {
        if (item.pendingQuestion === undefined || item.questionPost) continue;
        try {
          const dir = config.repos[item.repo];
          if (dir === undefined) throw new Error(`unknown repo alias "${item.repo}"`);
          item.questionPost = await postQuestion(
            forge,
            config,
            state.runId,
            item,
            item.pendingQuestion,
            () => forge.repoSlug(dir),
          );
          await store.save(state);
          await store.event(state.runId, {
            type: "question_posted",
            item: item.index,
            kind: item.questionPost.kind,
            url: item.questionPost.url,
          });
          this.deps.log(`asked on GitHub: ${item.questionPost.url}`);
        } catch (error) {
          this.deps.log(`could not post the question on GitHub: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      this.deps.log(`could not post the question on GitHub: ${(error as Error).message}`);
    } finally {
      await lock.release();
    }
  }

  /** Logs a decision once, not on every poll. */
  private note(why: string): void {
    if (why === this.lastWhy) return;
    this.lastWhy = why;
    this.deps.log(why);
  }
}

export function backoff(failures: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Appends timestamped lines to `.nightshift/daemon.log` (and to stderr on a terminal). */
export function daemonLogger(dir: string): (message: string) => void {
  const file = path.join(dir, DAEMON_LOG);
  return (message: string) => {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    try {
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_BYTES) {
        renameSync(file, `${file}.1`);
      }
      appendFileSync(file, line);
    } catch {
      // logging must never stop the daemon
    }
    if (process.stderr.isTTY) process.stderr.write(line);
  };
}

/** The `cli.js` next to this module, which the daemon and the service run. */
export function cliPath(): string {
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}

/**
 * Runs `nightshift resume --config <file>` with its output appended to the daemon log. Aborting
 * sends it SIGTERM, which it records as "terminated", so the next daemon picks the run up again.
 */
export function spawnResume(
  configFile: string,
  home: string,
  logFile: string,
  signal: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const out = openSync(logFile, "a");
    const child = spawn(process.execPath, [cliPath(), "resume", "--config", configFile], {
      cwd: home,
      stdio: ["ignore", out, out],
      env: process.env,
    });
    const onAbort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      signal.removeEventListener("abort", onAbort);
      closeSync(out);
    };
    child.on("error", (error) => {
      done();
      reject(error);
    });
    child.on("close", (code, killedBy) => {
      done();
      resolve(code ?? (killedBy === null ? 1 : 128 + signalNumber(killedBy)));
    });
  });
}

function signalNumber(name: NodeJS.Signals): number {
  return ({ SIGINT: 2, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[name] ?? 0;
}

/**
 * The daemon's main loop, until `signal` aborts. Only one daemon watches a home: a second one
 * returns false at once.
 */
export async function runDaemon(options: {
  configFile: string;
  load: () => Promise<Config>;
  store: StateStore;
  forge: Forge;
  signal: AbortSignal;
  log: (message: string) => void;
  driver: () => number | undefined;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<boolean> {
  const { store, signal, log } = options;
  let lock: Lock;
  try {
    lock = await Lock.acquire(store.dir, DAEMON_LOCK);
  } catch (error) {
    if (error instanceof LockedError) {
      log(`another nightshift daemon already watches ${store.dir}; exiting`);
      return false;
    }
    throw error;
  }
  const config = await options.load();
  const daemon = new Daemon({
    config,
    store,
    forge: options.forge,
    now: () => new Date(),
    driver: options.driver,
    resume: (s) =>
      spawnResume(options.configFile, config.home, path.join(store.dir, DAEMON_LOG), s),
    log,
  });
  log(`daemon started (pid ${process.pid}) for ${config.home}`);
  try {
    while (!signal.aborted) {
      // Pick up config edits (answers.via, users, poll_seconds) without a restart.
      try {
        daemon.deps.config = await options.load();
      } catch (error) {
        log(`config error, keeping the previous config: ${(error as Error).message}`);
      }
      let delay: number;
      try {
        delay = await daemon.tick(signal);
      } catch (error) {
        log(`error: ${(error as Error).message}`);
        delay = daemon.pollMs;
      }
      await options.sleep(delay, signal);
    }
  } finally {
    log("daemon stopped");
    await lock.release();
  }
  return true;
}
