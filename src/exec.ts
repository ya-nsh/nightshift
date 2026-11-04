import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

export interface ExecOptions {
  cwd?: string;
  /** Written to stdin, which is then closed. Without it stdin is /dev/null. */
  input?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Also stream stdout and stderr, in arrival order, to this file. */
  teeFile?: string;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout and stderr interleaved in arrival order. */
  combined: string;
  timedOut: boolean;
  aborted: boolean;
}

const KILL_GRACE_MS = 10_000;

/**
 * Runs a command in its own process group, so a timeout or abort terminates everything it started
 * (Claude and review tools spawn their own children).
 */
export function exec(
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({ code: null, stdout: "", stderr: "", combined: "", timedOut: false, aborted: true });
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true,
    });
    let tee: ReturnType<typeof createWriteStream> | undefined;
    if (options.teeFile) {
      mkdirSync(path.dirname(options.teeFile), { recursive: true });
      tee = createWriteStream(options.teeFile);
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const all: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;

    const terminate = () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(
        () => child.pid !== undefined && killGroup(child.pid, "SIGKILL"),
        KILL_GRACE_MS,
      );
      killTimer.unref();
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminate();
          }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      out.push(chunk);
      all.push(chunk);
      tee?.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err.push(chunk);
      all.push(chunk);
      tee?.write(chunk);
    });
    child.on("error", (error) => {
      cleanup();
      reject(new Error(`cannot run ${command}: ${error.message}`));
    });
    child.on("close", (code) => {
      cleanup();
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        combined: Buffer.concat(all).toString("utf8"),
        timedOut,
        aborted,
      });
    });
    if (options.input !== undefined) {
      child.stdin?.on("error", () => {}); // the child may exit before reading everything
      child.stdin?.end(options.input);
    }

    function cleanup() {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      tee?.end();
    }
  });
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

/** The last `maxChars` characters, marked when something was cut. */
export function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `[… ${text.length - maxChars} earlier characters omitted …]\n${text.slice(-maxChars)}`;
}

/** Quotes a value for POSIX sh. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
