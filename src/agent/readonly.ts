/**
 * How a read-only session (`AgentRequest.readOnly`, used by `nightshift plan`) is locked down. The
 * built-in tool set is cut to file reading, so no setting, allow rule or prompt can make Claude edit
 * a file or run a command: those tools do not exist in the session.
 */

/** The only built-in tools a read-only session has (`--tools`). */
export const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"] as const;

/** Denied as well, in case a Claude Code version ignores `--tools`. Deny rules beat allow rules. */
export const DENIED_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "Agent", "Task"] as const;

/**
 * `dontAsk` denies anything not pre-approved instead of asking, so the session never waits on a
 * prompt. (`plan` mode is not used: it steers Claude into writing a plan file and calling
 * ExitPlanMode, which fights the structured result.)
 */
export const READ_ONLY_PERMISSION_MODE = "dontAsk";

/**
 * `agent.extra_args` flags that could widen a read-only session: they are dropped, with their
 * values, rather than passed on.
 */
const WIDENING_FLAGS = new Set([
  "permission-mode",
  "dangerously-skip-permissions",
  "allow-dangerously-skip-permissions",
  "allowedTools",
  "allowed-tools",
  "tools",
  "mcp-config",
]);

/** `extra_args` without the flags that could widen a read-only session. */
export function readOnlyExtraArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const name = arg.startsWith("--") ? arg.slice(2).split("=")[0] : undefined;
    if (name === undefined || !WIDENING_FLAGS.has(name)) {
      out.push(arg);
      continue;
    }
    if (arg.includes("=")) continue;
    // Skip the flag's values (some, like --allowedTools, take several).
    while (i + 1 < args.length && !(args[i + 1] as string).startsWith("--")) i++;
  }
  return out;
}
