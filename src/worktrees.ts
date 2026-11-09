import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { exec } from "./exec.js";
import type { Worktrees } from "./ports.js";

const GIT_TIMEOUT_MS = 5 * 60_000;
const IGNORE_FILE = ".gitignore";

/**
 * Creates and removes the worktrees parallel lanes work in, with plain `git`. Operations on the same
 * repository run one after another: concurrent `git fetch` / `git worktree add` in one repository
 * contend for the same lock files.
 */
export class GitWorktrees implements Worktrees {
  private readonly queues = new Map<string, Promise<unknown>>();

  create(repoDir: string, dir: string, signal: AbortSignal): Promise<{ base: string }> {
    return this.serial(repoDir, async () => {
      const base = await defaultBranch(repoDir, signal);
      if (existsSync(dir)) {
        if (await sameRepository(repoDir, dir, signal)) return { base };
        throw new Error(`${dir} exists but is not a worktree of ${repoDir}; move it away`);
      }
      await git(repoDir, ["fetch", "--quiet", "origin", base], signal);
      await ignoreAll(path.dirname(dir));
      await git(repoDir, ["worktree", "add", "--detach", dir, `origin/${base}`], signal);
      return { base };
    });
  }

  remove(repoDir: string, dir: string, branch?: string): Promise<void> {
    return this.serial(repoDir, async () => {
      const signal = new AbortController().signal;
      if (existsSync(dir)) await git(repoDir, ["worktree", "remove", "--force", dir], signal);
      await git(repoDir, ["worktree", "prune"], signal);
      if (branch !== undefined) {
        const exists = await exec("git", [
          "-C",
          repoDir,
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/${branch}`,
        ]);
        if (exists.code === 0) await git(repoDir, ["branch", "-D", branch], signal);
      }
      // The directory holding the worktrees goes too once its last worktree is gone.
      const parent = path.dirname(dir);
      const left = await readdir(parent).catch(() => undefined);
      if (left?.every((name) => name === IGNORE_FILE)) {
        await rm(parent, { recursive: true, force: true });
      }
    });
  }

  private serial<T>(repoDir: string, body: () => Promise<T>): Promise<T> {
    const key = path.resolve(repoDir);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(body, body);
    this.queues.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }
}

/** The repository's default branch, as `origin/HEAD` points at it. */
async function defaultBranch(repoDir: string, signal: AbortSignal): Promise<string> {
  const result = await exec(
    "git",
    ["-C", repoDir, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { signal, timeoutMs: GIT_TIMEOUT_MS },
  );
  const ref = result.stdout.trim();
  if (result.code !== 0 || !ref.startsWith("origin/")) {
    throw new Error(
      `cannot tell the default branch of ${repoDir} (origin/HEAD is not set); run \`git -C ${repoDir} remote set-head origin --auto\``,
    );
  }
  return ref.slice("origin/".length);
}

async function sameRepository(repoDir: string, dir: string, signal: AbortSignal): Promise<boolean> {
  const common = async (cwd: string) => {
    const r = await exec(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        signal,
        timeoutMs: GIT_TIMEOUT_MS,
      },
    );
    return r.code === 0 ? realpath(r.stdout.trim()).catch(() => r.stdout.trim()) : undefined;
  };
  const [a, b] = await Promise.all([common(repoDir), common(dir)]);
  return a !== undefined && a === b;
}

/** Keeps the worktrees out of `git status` when they live inside a repository (the default). */
async function ignoreAll(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, IGNORE_FILE);
  if (!existsSync(file)) {
    await writeFile(file, "# git worktrees created by nightshift for parallel lanes\n*\n");
  }
}

async function git(cwd: string, args: string[], signal: AbortSignal): Promise<void> {
  const result = await exec("git", ["-C", cwd, ...args], { signal, timeoutMs: GIT_TIMEOUT_MS });
  if (result.aborted) throw new Error(`git ${args[0]} was interrupted`);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
}
