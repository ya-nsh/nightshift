import { existsSync, rmSync } from "node:fs";
import { statfs } from "node:fs/promises";
import path from "node:path";
import { exec } from "./exec.js";
import type { Host } from "./ports.js";

export const STOP_FILE = "STOP";
const NOTIFY_TIMEOUT_MS = 30_000;

export class NodeHost implements Host {
  constructor(
    private readonly dir: string,
    private readonly notifyCommand: string,
    private readonly write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  ) {}

  now(): Date {
    return new Date();
  }

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
    });
  }

  async freeDiskGb(dir: string): Promise<number> {
    const stats = await statfs(dir);
    return (Number(stats.bavail) * Number(stats.bsize)) / 1e9;
  }

  stopRequested(): boolean {
    return existsSync(path.join(this.dir, STOP_FILE));
  }

  clearStop(): void {
    rmSync(path.join(this.dir, STOP_FILE), { force: true });
  }

  async notify(event: "halted" | "done", fields: Record<string, string>): Promise<void> {
    if (this.notifyCommand.trim() === "") return;
    const env: NodeJS.ProcessEnv = { ...process.env, NIGHTSHIFT_EVENT: event };
    for (const [key, value] of Object.entries(fields))
      env[`NIGHTSHIFT_${key.toUpperCase()}`] = value;
    try {
      const result = await exec("/bin/sh", ["-c", this.notifyCommand], {
        env,
        timeoutMs: NOTIFY_TIMEOUT_MS,
      });
      if (result.code !== 0)
        this.log(`notify command exited ${String(result.code)}: ${result.stderr.trim()}`);
    } catch (error) {
      this.log(`notify command failed: ${(error as Error).message}`);
    }
  }

  log(message: string): void {
    const time = new Date().toTimeString().slice(0, 8);
    this.write(`[nightshift ${time}] ${message}`);
  }
}
