#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { ClaudeCliAgent } from "./agent/cli.js";
import { ClaudeSdkAgent, loadSdkQuery } from "./agent/sdk.js";
import { type Config, ConfigError, loadConfig } from "./config.js";
import { GhForge } from "./github.js";
import { NodeHost, STOP_FILE } from "./host.js";
import { init } from "./init.js";
import { type Exit, newRunState, Pipeline } from "./pipeline.js";
import type { Agent } from "./ports.js";
import { preflight } from "./preflight.js";
import { ShellReviewer } from "./reviewer.js";
import { Lock, LockedError, lockHolder, newRunId, type RunState, StateStore } from "./state.js";
import { loadTemplates } from "./templates.js";
import {
  ClaudeUsageMeter,
  describeUsage,
  formatTime,
  limitsEnabled,
  type UsageTally,
  type UsageWindow,
  usageLimits,
} from "./usage.js";
import { watch } from "./watch.js";

const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

const HELP = `nightshift ${VERSION} — let Claude Code work through your todo list, one fresh session per item.

Usage:
  nightshift init [--eject-prompts]          create .nightshift/config.toml here
  nightshift doctor                          check gh, claude, repos, review command, disk
  nightshift run (--prompt TEXT | --prompt-file FILE) [--repo ALIAS] [--once] [--max-items N]
                 [--usage-share PCT] [--force]
                                             start a run with the first item's prompt
  nightshift resume [--answer TEXT] [--once] [--max-items N] [--usage-share PCT]
                                             continue a halted or paused run
  nightshift status [--json]                 show the current run
  nightshift watch [--once]                  follow the current run live (q quits; --once prints
                                             one frame)
  nightshift stop                            stop gracefully after the current step

Options:
  --config FILE   use this config instead of the nearest .nightshift/config.toml
  --usage-share PCT
                  let this run use at most PCT points of each 5-hour Claude usage window
                  (overrides [usage] session_share; kept for later resumes; 0 = no share limit)
  --max-items N   stop after N completed items in this invocation (0 = no limit; overrides
                  [limits] max_items)
  -h, --help      show this help
  -v, --version   show the version

Exit codes: 0 done or paused · 1 error · 2 blocked on a question · 3 halted · 130 interrupted
Docs: https://github.com/ya-nsh/nightshift`;

const COMMANDS = new Set(["init", "doctor", "run", "resume", "status", "watch", "stop"]);
const EXIT_CODES: Record<Exit["kind"], number> = { done: 0, paused: 0, blocked: 2, halted: 3 };

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      prompt: { type: "string" },
      "prompt-file": { type: "string" },
      repo: { type: "string" },
      once: { type: "boolean", default: false },
      "max-items": { type: "string" },
      "usage-share": { type: "string" },
      force: { type: "boolean", default: false },
      answer: { type: "string" },
      json: { type: "boolean", default: false },
      "eject-prompts": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  const command = positionals[0];
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  if (values.help || command === undefined || command === "help") {
    console.log(HELP);
    return command === undefined && !values.help ? 1 : 0;
  }
  if (positionals.length > 1) throw new UsageError(`unexpected argument: ${positionals[1]}`);

  if (!COMMANDS.has(command)) throw new UsageError(`unknown command "${command}" (see --help)`);
  const cwd = process.cwd();
  if (command === "init") {
    const result = await init(cwd, { ejectPrompts: values["eject-prompts"] });
    for (const file of result.created) console.log(`created ${path.relative(cwd, file)}`);
    for (const file of result.skipped) console.log(`kept existing ${path.relative(cwd, file)}`);
    console.log("next: edit .nightshift/config.toml, then `nightshift doctor`");
    return 0;
  }

  const config = await loadConfig(values.config, cwd);
  const store = new StateStore(config.dir);
  const maxItems = values.once ? 1 : parseMaxItems(values["max-items"]);
  const usageShare = parseUsageShare(values["usage-share"]);

  switch (command) {
    case "doctor": {
      const state = await store.load();
      const live = state !== undefined && state.status !== "done";
      return (await doctor(
        config,
        usageShare ?? (live ? state.usageShare : undefined),
        live ? state.usage?.tally : undefined,
      ))
        ? 0
        : 1;
    }
    case "status":
      return status(await store.load(), values.json, config);
    case "watch":
      return watch({ dir: config.dir, usage: config.usage, once: values.once });
    case "stop":
      await writeFile(path.join(config.dir, STOP_FILE), `${new Date().toISOString()}\n`);
      console.log("nightshift will stop after the current step");
      return 0;
    case "run": {
      const prompt = await readPrompt(values.prompt, values["prompt-file"], cwd);
      const repo = values.repo ?? config.defaultRepo;
      if (config.repos[repo] === undefined) {
        throw new UsageError(
          `unknown repo "${repo}"; configured: ${Object.keys(config.repos).join(", ")}`,
        );
      }
      return withLock(config, async () => {
        const existing = await store.load();
        if (existing && existing.status !== "done") {
          if (!values.force) {
            throw new UsageError(
              `run ${existing.runId} is ${existing.status}${existing.haltReason ? ` (${existing.haltReason})` : ""}; use \`nightshift resume\`, or --force to abandon it`,
            );
          }
        }
        if (!(await doctor(config, usageShare, undefined))) return 1;
        if (existing) await store.archive(existing);
        const now = new Date();
        const state = newRunState(newRunId(now), now, repo, prompt);
        if (usageShare !== undefined) state.usageShare = usageShare;
        await store.save(state);
        return drive(config, store, state, maxItems, undefined);
      });
    }
    case "resume":
      return withLock(config, async () => {
        const state = await store.load();
        if (state === undefined)
          throw new UsageError("no run to resume; start one with `nightshift run`");
        if (state.status === "done") {
          console.log(`run ${state.runId} is done: ${state.haltReason ?? ""}`);
          return 0;
        }
        if (usageShare !== undefined) {
          state.usageShare = usageShare;
          await store.save(state);
        }
        if (!(await doctor(config, state.usageShare, state.usage?.tally))) return 1;
        return drive(config, store, state, maxItems, values.answer);
      });
    default:
      throw new UsageError(`unknown command "${command}" (see --help)`);
  }
}

async function drive(
  config: Config,
  store: StateStore,
  state: RunState,
  maxItems: number | undefined,
  answer: string | undefined,
): Promise<number> {
  const host = new NodeHost(config.dir, config.notify.command);
  const agent: Agent =
    config.agent.backend === "sdk"
      ? new ClaudeSdkAgent(config.agent, await loadSdkQuery(config.home))
      : new ClaudeCliAgent(config.agent);
  const pipeline = new Pipeline(
    {
      config,
      templates: await loadTemplates(config.promptsDir),
      agent,
      forge: new GhForge(),
      reviewer: new ShellReviewer(),
      host,
      store,
      usage: new ClaudeUsageMeter(config.agent.claude_path, config.home),
    },
    state,
  );

  const controller = new AbortController();
  let interrupts = 0;
  const onSignal = () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    host.log("interrupting: stopping the current step and saving state (Ctrl-C again to force)");
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  host.log(
    `run ${state.runId} · ${agent.name} · state in ${path.relative(process.cwd(), config.dir) || "."}`,
  );
  try {
    const exit = await pipeline.run({
      signal: controller.signal,
      ...(maxItems === undefined ? {} : { maxItems }),
      ...(answer === undefined ? {} : { answer }),
    });
    printExit(exit);
    if (controller.signal.aborted) return 130;
    return EXIT_CODES[exit.kind];
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

function printExit(exit: Exit): void {
  const { state } = exit;
  const lines = [
    "",
    `${exit.kind.toUpperCase()}: ${exit.reason}`,
    `items completed: ${state.itemsCompleted} · total cost: $${state.costUsd.toFixed(2)}${formatPoints(state.usage?.points)}`,
  ];
  if (state.item?.pr) lines.push(`current PR: ${state.item.pr.url}`);
  if (exit.kind === "blocked") lines.push('answer and continue: nightshift resume --answer "…"');
  else if (exit.kind !== "done") lines.push("continue with: nightshift resume");
  console.log(lines.join("\n"));
}

async function doctor(
  config: Config,
  share: number | undefined,
  tally: UsageTally | undefined,
): Promise<boolean> {
  const checks = await preflight(config, {
    ...(share === undefined ? {} : { share }),
    ...(tally === undefined ? {} : { tally }),
  });
  for (const check of checks)
    console.error(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
  return checks.every((check) => check.ok);
}

function status(state: RunState | undefined, json: boolean, config: Config): number {
  if (json) {
    console.log(JSON.stringify(state ?? null, null, 2));
    return 0;
  }
  if (state === undefined) {
    console.log("no run yet");
    return 0;
  }
  const now = new Date();
  const holder = lockHolder(config.dir);
  const running =
    state.status === "running"
      ? holder === undefined
        ? "running according to state.json, but no nightshift process holds the lock (it was killed); `nightshift resume` continues"
        : `running (pid ${holder})`
      : state.status;
  const item = state.item;
  const lines = [
    `run ${state.runId} · ${running}${state.haltReason ? ` (${state.haltReason})` : ""}`,
    `started ${formatTime(state.startedAt, now)} · items completed ${state.itemsCompleted} · cost $${state.costUsd.toFixed(2)}${formatPoints(state.usage?.points)}`,
  ];
  if (item) {
    lines.push(
      `item ${item.index}${item.label ? ` — ${item.label}` : ""} · repo ${item.repo} · phase ${item.phase} · cost $${item.costUsd.toFixed(2)}${formatPoints(item.usagePoints)}`,
    );
    if (item.pr) lines.push(`PR ${item.pr.url}`);
    const activity = item.activity;
    if (activity && holder !== undefined) {
      const last =
        activity.last === undefined
          ? ""
          : ` · last: ${activity.last} (${ago(activity.lastAt ?? activity.since, now)} ago)`;
      lines.push(
        `step ${activity.step} running for ${ago(activity.since, now)} · ${activity.tools} tool call(s)${last}`,
      );
    }
    if (item.pendingQuestion) lines.push(`waiting for an answer: ${item.pendingQuestion}`);
  }
  if (state.waiting !== undefined && holder !== undefined) {
    lines.push(`waiting until ${formatTime(state.waiting.until, now)}: ${state.waiting.reason}`);
  }
  const limits = usageLimits(config.usage, state.usageShare);
  const usage = state.usage;
  if (usage?.last !== undefined) {
    lines.push(
      `usage at ${formatTime(usage.last.at, now)}: ${describeUsage(usage.last.windows, usage.tally, limits, now)}`,
    );
  } else if (limitsEnabled(limits)) {
    lines.push("usage: not read yet");
  }
  console.log(lines.join("\n"));
  return 0;
}

function formatPoints(points: Partial<Record<UsageWindow, number>> | undefined): string {
  const five = points?.five_hour;
  return five === undefined || five <= 0 ? "" : ` · ${five} points of 5-hour usage`;
}

function ago(iso: string, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

async function readPrompt(
  text: string | undefined,
  file: string | undefined,
  cwd: string,
): Promise<string> {
  if ((text === undefined) === (file === undefined)) {
    throw new UsageError("give exactly one of --prompt or --prompt-file");
  }
  const prompt = text ?? (await readFile(path.resolve(cwd, file as string), "utf8"));
  if (prompt.trim() === "") throw new UsageError("the prompt is empty");
  return prompt;
}

function parseMaxItems(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UsageError("--max-items must be a whole number ≥ 0");
  return n;
}

function parseUsageShare(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value.trim().replace(/%$/, ""));
  if (value.trim() === "" || !Number.isFinite(n) || n < 0 || n > 100) {
    throw new UsageError("--usage-share must be a percentage from 0 to 100");
  }
  return n;
}

async function withLock(config: Config, body: () => Promise<number>): Promise<number> {
  const lock = await Lock.acquire(config.dir);
  try {
    return await body();
  } finally {
    await lock.release();
  }
}

class UsageError extends Error {}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const known =
      error instanceof UsageError ||
      error instanceof ConfigError ||
      error instanceof LockedError ||
      String((error as { code?: unknown }).code ?? "").startsWith("ERR_PARSE_ARGS");
    console.error(
      `nightshift: ${known ? (error as Error).message : ((error as Error).stack ?? String(error))}`,
    );
    process.exitCode = 1;
  },
);
