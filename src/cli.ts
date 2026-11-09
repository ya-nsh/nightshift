#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { ClaudeCliAgent } from "./agent/cli.js";
import { ClaudeSdkAgent, loadSdkQuery } from "./agent/sdk.js";
import { type Config, ConfigError, findConfig, loadConfig, planSettings } from "./config.js";
import { cliPath, DAEMON_LOCK, DAEMON_LOG, daemonLogger, runDaemon } from "./daemon.js";
import { exec } from "./exec.js";
import { describeForecast, estimateItem, readHistory } from "./forecast.js";
import { GhForge } from "./github.js";
import { NodeHost, STOP_FILE } from "./host.js";
import { init } from "./init.js";
import { describeQueue, quote, releaseClaim } from "./issues.js";
import { type Exit, newIssuesRunState, newRunState, Pipeline } from "./pipeline.js";
import { formatPlan, makePlan, PlanError, parsePlanCount, writePlan } from "./plan.js";
import type { Agent } from "./ports.js";
import { preflight } from "./preflight.js";
import { loadReport } from "./report.js";
import { ShellReviewer } from "./reviewer.js";
import {
  installService,
  installWarnings,
  type Runner,
  ServiceError,
  serviceSpec,
  serviceStatus,
  stableNodePath,
  uninstallService,
} from "./service.js";
import {
  Lock,
  LockedError,
  lockHolder,
  newRunId,
  type RunState,
  runItems,
  StateStore,
} from "./state.js";
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
import { GitWorktrees } from "./worktrees.js";

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
                                             start a run with the first item's prompt (with
                                             [tasks] source = "github_issues" the prompt is
                                             optional: extra instructions for every issue)
  nightshift resume [--answer TEXT [--item N]] [--once] [--max-items N] [--usage-share PCT]
                                             continue a halted or paused run
  nightshift plan [-n N] [--prompt TEXT | --prompt-file FILE] [--repo ALIAS] [--json] [--write]
                                             preview the next N items (default 5) in a read-only
                                             Claude session; changes nothing
  nightshift status [--json]                 show the current run
  nightshift watch [--once]                  follow the current run live (q quits; --once prints
                                             one frame)
  nightshift stop                            stop gracefully after the current step
  nightshift report [--run ID]               print the run's report (default: the current run)
  nightshift daemon                          watch the run and resume it when it can continue
                                             by itself (answer on GitHub, limit cleared, reboot)
  nightshift service install|uninstall|status
                                             run the daemon as a launchd agent (macOS) or a
                                             systemd user unit (Linux)

Options:
  --config FILE   use this config instead of the nearest .nightshift/config.toml
  --usage-share PCT
                  let this run use at most PCT points of each 5-hour Claude usage window
                  (overrides [usage] session_share; kept for later resumes; 0 = no share limit)
  --max-items N   stop after N completed items in this invocation (0 = no limit; overrides
                  [limits] max_items)
  --item N        with parallel lanes, the item --answer is for when several wait for one
  -h, --help      show this help
  -v, --version   show the version

Exit codes: 0 done or paused · 1 error · 2 blocked on a question · 3 halted · 130 interrupted
            (with parallel lanes: the worst of the lanes)
Docs: https://github.com/ya-nsh/nightshift`;

const COMMANDS = new Set([
  "init",
  "doctor",
  "run",
  "resume",
  "plan",
  "status",
  "watch",
  "stop",
  "report",
  "daemon",
  "service",
]);
const SERVICE_ACTIONS = new Set(["install", "uninstall", "status"]);
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
      item: { type: "string" },
      run: { type: "string" },
      json: { type: "boolean", default: false },
      count: { type: "string", short: "n" },
      write: { type: "boolean", default: false },
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
  const action = command === "service" ? positionals[1] : undefined;
  if (positionals.length > (command === "service" ? 2 : 1)) {
    throw new UsageError(`unexpected argument: ${positionals[positionals.length - 1]}`);
  }

  if (!COMMANDS.has(command)) throw new UsageError(`unknown command "${command}" (see --help)`);
  if (command === "service" && (action === undefined || !SERVICE_ACTIONS.has(action))) {
    throw new UsageError("usage: nightshift service install|uninstall|status");
  }
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
  const answerItem = parseItem(values.item);
  if (answerItem !== undefined && values.answer === undefined) {
    throw new UsageError("--item goes with --answer");
  }

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
    case "plan": {
      const count = parsePlanCount(values.count);
      if (values.repo !== undefined && config.repos[values.repo] === undefined) {
        throw new UsageError(
          `unknown repo "${values.repo}"; configured: ${Object.keys(config.repos).join(", ")}`,
        );
      }
      const given = values.prompt !== undefined || values["prompt-file"] !== undefined;
      const prompt = given
        ? await readPrompt(values.prompt, values["prompt-file"], cwd)
        : undefined;
      return plan(config, await store.load(), {
        count,
        ...(prompt === undefined ? {} : { prompt }),
        ...(values.repo === undefined ? {} : { repo: values.repo }),
        json: values.json,
        write: values.write,
      });
    }
    case "status":
      return await status(await store.load(), values.json, config);
    case "watch":
      return watch({ dir: config.dir, usage: config.usage, once: values.once });
    case "report": {
      const report = await loadReport(store, values.run, new Date()).catch((error: Error) => {
        throw new UsageError(error.message);
      });
      if (report === undefined) {
        console.log(values.run === undefined ? "no run yet" : `no run ${values.run}`);
        return values.run === undefined ? 0 : 1;
      }
      process.stdout.write(report);
      return 0;
    }
    case "daemon":
      return daemon(config, store, configFile(values.config, cwd));
    case "service":
      return service(action as string, config, configFile(values.config, cwd));
    case "stop":
      await writeFile(path.join(config.dir, STOP_FILE), `${new Date().toISOString()}\n`);
      console.log("nightshift will stop after the current step");
      return 0;
    case "run": {
      const fromIssues = config.tasks.source === "github_issues";
      const prompt = await readPrompt(values.prompt, values["prompt-file"], cwd);
      if (prompt === undefined && !fromIssues) {
        throw new UsageError("give exactly one of --prompt or --prompt-file");
      }
      if (fromIssues && values.repo !== undefined && values.repo !== config.tasks.repo) {
        throw new UsageError(
          `issues come from [tasks] repo = "${config.tasks.repo}"; --repo cannot change that`,
        );
      }
      const repo = values.repo ?? (fromIssues ? config.tasks.repo : config.defaultRepo);
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
        if (existing) {
          if (existing.status !== "done") await releaseAbandonedIssue(existing);
          await store.archive(existing);
        }
        const now = new Date();
        const runId = newRunId(now);
        const state =
          fromIssues || prompt === undefined
            ? newIssuesRunState(runId, now, prompt)
            : newRunState(runId, now, repo, prompt);
        if (usageShare !== undefined) state.usageShare = usageShare;
        await store.save(state);
        return drive(config, store, state, maxItems, undefined, undefined);
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
        return drive(config, store, state, maxItems, values.answer, answerItem);
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
  answerItem: number | undefined,
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
      worktrees: new GitWorktrees(),
    },
    state,
  );

  const controller = new AbortController();
  let interrupts = 0;
  const onSignal = (signal: NodeJS.Signals) => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    host.log("interrupting: stopping the current step and saving state (Ctrl-C again to force)");
    // The pipeline records SIGTERM (shutdown, service stop) apart from Ctrl-C.
    controller.abort(signal);
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
      ...(answerItem === undefined ? {} : { answerItem }),
    });
    printExit(exit);
    if (controller.signal.aborted) return 130;
    return EXIT_CODES[exit.kind];
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/** `run --force` abandons a run: the issue it was working on is free for the next run again. */
async function releaseAbandonedIssue(state: RunState): Promise<void> {
  const forge = new GhForge();
  for (const item of runItems(state)) {
    if (item.issue !== undefined) await releaseIssue(forge, state, item.issue);
  }
}

async function releaseIssue(
  forge: GhForge,
  state: RunState,
  issue: NonNullable<RunState["item"]>["issue"] & {},
): Promise<void> {
  try {
    await forge.commentIssue(
      issue.repoSlug,
      issue.number,
      `**nightshift** abandoned run \`${state.runId}\`, which was working on this issue${state.haltReason ? `:\n\n${quote(state.haltReason)}` : "."}\n\nThe issue is no longer claimed.`,
    );
    await releaseClaim(forge, issue);
    console.error(`released issue #${issue.number} (${issue.url})`);
  } catch (error) {
    console.error(
      `could not release issue #${issue.number} (${issue.url}): ${(error as Error).message}; remove its in-progress label and assignee yourself`,
    );
  }
}

/**
 * `nightshift plan` takes no lock and never writes state.json: it reads the run as it is, so it can
 * run next to a live run without disturbing it.
 */
async function plan(
  config: Config,
  state: RunState | undefined,
  options: { count: number; prompt?: string; repo?: string; json: boolean; write: boolean },
): Promise<number> {
  const holder = lockHolder(config.dir);
  if (holder !== undefined) {
    console.error(
      `note: a run is being driven (pid ${holder}); planning from its state as of now, without touching it`,
    );
  }
  const agent: Agent =
    config.agent.backend === "sdk"
      ? new ClaudeSdkAgent(config.agent, await loadSdkQuery(config.home))
      : new ClaudeCliAgent(config.agent);
  const controller = new AbortController();
  let interrupts = 0;
  const onSignal = () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    console.error(
      `planning the next ${options.count} item(s) · ${agent.name} · model ${planSettings(config.agent).model ?? "default"} · read-only · budget $${config.budget.plan_usd.toFixed(2)}`,
    );
    const outcome = await makePlan(
      {
        config,
        templates: await loadTemplates(config.promptsDir),
        agent,
        usage: new ClaudeUsageMeter(config.agent.claude_path, config.home),
        now: () => new Date(),
        log: (line) => console.error(line),
      },
      state,
      { ...options, signal: controller.signal },
    );
    if (!outcome.ok) {
      const cost = outcome.costUsd > 0 ? ` (cost $${outcome.costUsd.toFixed(2)})` : "";
      console.error(`nightshift plan: ${outcome.reason}${cost}`);
      return outcome.aborted ? 130 : 1;
    }
    if (options.json) console.log(JSON.stringify(outcome.plan, null, 2));
    else console.log(formatPlan(outcome.plan));
    if (options.write) {
      const file = await writePlan(config.dir, outcome.plan);
      console.error(`wrote ${path.relative(process.cwd(), file) || file}`);
    }
    return 0;
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
  const items = runItems(state);
  if (items.length <= 1) {
    if (state.item?.pr) lines.push(`current PR: ${state.item.pr.url}`);
    const post = state.item?.questionPost;
    if (exit.kind === "blocked" && post !== undefined) {
      lines.push(`answer on GitHub: ${post.url} (then \`nightshift resume\`, or let the daemon)`);
    }
    if (exit.kind === "blocked") lines.push('answer and continue: nightshift resume --answer "…"');
    else if (exit.kind !== "done") lines.push("continue with: nightshift resume");
  } else {
    for (const item of items) {
      if (item.pr) lines.push(`${itemName(item)}: ${item.pr.url}`);
    }
    const questions = items.filter((item) => item.pendingQuestion !== undefined);
    for (const item of questions) {
      const post = item.questionPost;
      lines.push(
        `answer ${itemName(item)}: ${post === undefined ? "" : `on GitHub: ${post.url}, or `}nightshift resume --answer "…"${questions.length > 1 ? ` --item ${item.index}` : ""}`,
      );
    }
    if (exit.kind !== "done") lines.push("continue with: nightshift resume");
  }
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

async function status(state: RunState | undefined, json: boolean, config: Config): Promise<number> {
  if (json) {
    console.log(JSON.stringify(state ?? null, null, 2));
    return 0;
  }
  const tasks = await describeTasks(config);
  if (state === undefined) {
    console.log(`no run yet\n${tasks}`);
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
  const lines = [
    `run ${state.runId} · ${running}${state.haltReason ? ` (${state.haltReason})` : ""}`,
    `started ${formatTime(state.startedAt, now)} · items completed ${state.itemsCompleted} · cost $${state.costUsd.toFixed(2)}${formatPoints(state.usage?.points)}`,
  ];
  const items = runItems(state);
  const several = items.length > 1;
  if (config.limits.lanes > 1 || several) {
    lines.push(`lanes: ${config.limits.lanes} · items in progress: ${items.length}`);
  }
  for (const item of items) {
    // One item reads as before; several are listed, each with its details indented.
    const indent = several ? "  " : "";
    lines.push(
      `${several ? "- " : ""}item ${item.index}${item.label ? ` — ${item.label}` : ""} · repo ${item.repo} · phase ${item.phase} · cost $${item.costUsd.toFixed(2)}${formatPoints(item.usagePoints)}`,
    );
    if (item.issue) lines.push(`${indent}issue ${item.issue.url} — ${item.issue.title}`);
    if (item.worktree) lines.push(`${indent}worktree ${item.worktree.path}`);
    if (item.pr) lines.push(`${indent}PR ${item.pr.url}`);
    const activity = item.activity;
    if (activity && holder !== undefined) {
      const last =
        activity.last === undefined
          ? ""
          : ` · last: ${activity.last} (${ago(activity.lastAt ?? activity.since, now)} ago)`;
      lines.push(
        `${indent}step ${activity.step} running for ${ago(activity.since, now)} · ${activity.tools} tool call(s)${last}`,
      );
    }
    if (item.stopped && !item.pendingQuestion) {
      lines.push(`${indent}lane stopped (${item.stopped.kind}): ${item.stopped.reason}`);
    }
    if (item.pendingQuestion) lines.push(`${indent}waiting for an answer: ${item.pendingQuestion}`);
    if (item.pendingQuestion && item.questionPost) {
      lines.push(`${indent}asked on GitHub: ${item.questionPost.url}`);
    }
  }
  if (state.waiting !== undefined && holder !== undefined) {
    lines.push(`waiting until ${formatTime(state.waiting.until, now)}: ${state.waiting.reason}`);
  }
  lines.push(tasks);
  const limits = usageLimits(config.usage, state.usageShare);
  const usage = state.usage;
  if (usage?.last !== undefined) {
    lines.push(
      `usage at ${formatTime(usage.last.at, now)}: ${describeUsage(usage.last.windows, usage.tally, limits, now)}`,
    );
  } else if (limitsEnabled(limits)) {
    lines.push("usage: not read yet");
  }
  const forecast = describeForecast({
    estimate: estimateItem(await readHistory(config.dir), config.usage.forecast_percentile),
    limits,
    tally: usage?.tally ?? {},
    windows: usage?.last?.windows,
    ranges: config.schedule.active_hours,
    now,
  });
  for (const line of forecast) lines.push(`forecast: ${line}`);
  console.log(lines.join("\n"));
  return 0;
}

/** The task source and, for GitHub issues, the queue and the next issue. */
async function describeTasks(config: Config): Promise<string> {
  if (config.tasks.source !== "github_issues") {
    return "tasks: handoff (the finalize step writes the next prompt)";
  }
  const queue = await describeQueue(new GhForge(), config);
  return `tasks: ${queue.detail}`;
}

function itemName(item: NonNullable<RunState["item"]>): string {
  return item.label ?? `item ${item.index}`;
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

/** The absolute path of the config in use, for the daemon and the service to load. */
function configFile(explicit: string | undefined, cwd: string): string {
  const file = explicit ? path.resolve(cwd, explicit) : findConfig(cwd);
  if (file === undefined) throw new UsageError("no config found");
  return file;
}

async function daemon(config: Config, store: StateStore, file: string): Promise<number> {
  const log = daemonLogger(config.dir);
  const controller = new AbortController();
  const onSignal = (signal: NodeJS.Signals) => {
    log(`received ${signal}; stopping (a running resume is sent SIGTERM)`);
    controller.abort(signal);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const host = new NodeHost(config.dir, "");
  try {
    await runDaemon({
      configFile: file,
      load: () => loadConfig(file, config.home),
      store,
      forge: new GhForge(),
      signal: controller.signal,
      log,
      driver: () => lockHolder(config.dir),
      sleep: (ms, signal) => host.sleep(ms, signal),
    });
    // A second daemon exits 0 too, so the service manager does not keep restarting it.
    return 0;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function service(action: string, config: Config, file: string): Promise<number> {
  const userHome = process.env.HOME;
  if (!userHome) throw new UsageError("HOME is not set");
  const cli = cliPath();
  let spec: ReturnType<typeof serviceSpec>;
  try {
    spec = serviceSpec({
      platform: process.platform,
      userHome,
      xdgConfigHome: process.env.XDG_CONFIG_HOME,
      home: config.home,
      dir: config.dir,
      configFile: file,
      nodePath: stableNodePath(process.execPath, process.env.PATH ?? ""),
      cliPath: cli,
      envPath: process.env.PATH ?? "/usr/bin:/bin",
    });
  } catch (error) {
    if (error instanceof ServiceError) throw new UsageError(error.message);
    throw error;
  }
  const run: Runner = async (command, args) => {
    const result = await exec(command, args, { timeoutMs: 30_000 });
    return { code: result.code, output: result.combined };
  };
  const uid = process.getuid?.() ?? 0;
  try {
    if (action === "install") {
      for (const warning of installWarnings(cli)) console.error(`warning: ${warning}`);
      for (const line of await installService(spec, run, uid)) console.log(line);
      if (config.answers.via !== "github") {
        console.log(
          'note: [answers] via = "terminal", so the daemon will not pick up answers from GitHub',
        );
      }
      return 0;
    }
    if (action === "uninstall") {
      for (const line of await uninstallService(spec, run, uid)) console.log(line);
      return 0;
    }
    const st = await serviceStatus(spec, run, uid);
    const daemonPid = lockHolder(config.dir, DAEMON_LOCK);
    console.log(
      [
        `service ${spec.name}: ${st.installed ? "installed" : "not installed"}${st.stale ? " (out of date: run `nightshift service install` again)" : ""} · ${st.loaded ? "loaded" : "not loaded"} · ${st.running ? `running${st.pid ? ` (pid ${st.pid})` : ""}` : "not running"}`,
        `file: ${spec.file}`,
        `daemon: ${daemonPid === undefined ? "not running" : `pid ${daemonPid}`} · log ${path.join(config.dir, DAEMON_LOG)}`,
      ].join("\n"),
    );
    const tail = await readFile(path.join(config.dir, DAEMON_LOG), "utf8").catch(() => "");
    const last = tail.trimEnd().split("\n").slice(-5).join("\n");
    if (last !== "") console.log(`\nlast log lines:\n${last}`);
    return st.installed && st.running ? 0 : 1;
  } catch (error) {
    if (error instanceof ServiceError) throw new UsageError(error.message);
    throw error;
  }
}

/** The prompt from --prompt or --prompt-file; undefined when neither is given. */
async function readPrompt(
  text: string | undefined,
  file: string | undefined,
  cwd: string,
): Promise<string | undefined> {
  if (text !== undefined && file !== undefined) {
    throw new UsageError("give only one of --prompt or --prompt-file");
  }
  if (text === undefined && file === undefined) return undefined;
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

function parseItem(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError("--item must be an item number ≥ 1");
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
      error instanceof PlanError ||
      error instanceof ConfigError ||
      error instanceof LockedError ||
      String((error as { code?: unknown }).code ?? "").startsWith("ERR_PARSE_ARGS");
    console.error(
      `nightshift: ${known ? (error as Error).message : ((error as Error).stack ?? String(error))}`,
    );
    process.exitCode = 1;
  },
);
