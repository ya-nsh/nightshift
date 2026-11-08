import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILE, NIGHTSHIFT_DIR } from "./config.js";
import { DEFAULT_PROMPTS_DIR } from "./templates.js";

export const GITIGNORE = `# nightshift runtime files
runs/
state.json
lock
STOP
`;

export function configTemplate(alias: string, ejectedPrompts: boolean): string {
  return `# nightshift — see https://github.com/ya-nsh/nightshift#configuration
# Relative paths resolve against the directory that contains .nightshift/.

# Repositories nightshift may work in. Claude picks the next one by alias (finalize step).
[repos]
${alias} = "."
# other = "../other-repo"

# default_repo = "${alias}"        # where \`nightshift run\` starts unless --repo is given

[agent]
backend = "cli"                   # "cli" (claude -p) or "sdk" (@anthropic-ai/claude-agent-sdk)
permission_mode = "auto"          # auto | acceptEdits | dontAsk | bypassPermissions
max_turns = 200                   # per Claude step
# model = "opus"
# allowed_tools = ["Bash(git *)", "Bash(gh *)"]
# add_dirs = [".."]               # extra directories Claude may touch (e.g. sibling worktrees)
# extra_args = []                 # appended to every \`claude -p\` call (cli backend)

[budget]
item_usd = 25                     # ceiling for all Claude steps of one item
invocation_usd = 150              # ceiling for one \`nightshift run\` / \`resume\`

[review]
# Runs after the PR opens; its output goes to Claude, which addresses the comments.
# Placeholders: {pr} {pr_url} {repo_slug} {repo_path} {branch} (shell-quoted). Empty = no review.
command = ""
# command = "~/bin/review-pr --post-comments {pr}"
max_rounds = 2                    # re-review after fixes, at most this many reviews per PR
timeout_minutes = 45
on_failure = "halt"               # "halt" or "skip" when the review command fails

[checks]
wait = true                       # wait for CI before merging
require_checks = false            # true: a PR with no checks at all halts instead of merging
settle_seconds = 90               # how long "no checks reported" must last before merging anyway
poll_seconds = 30
timeout_minutes = 60
max_fix_rounds = 2                # Claude attempts to fix failing checks

[merge]
method = "merge"                  # merge | rebase | squash
delete_branch = true
max_conflict_rounds = 2
when_blocked = "halt"             # branch protection (e.g. a required approval) blocks the merge:
                                  # "halt" and tell you, or "auto" to enable GitHub auto-merge and wait

[limits]
max_items = 0                     # items per invocation; 0 = until done or halted
min_free_disk_gb = 0              # halt before a step when free disk drops below this

[usage]
# Claude subscription limits, read from Claude Code (5-hour "session" window and weekly window).
# *_share: percentage points of each window nightshift itself may use (only what changes while its
#          own steps run counts, not your interactive sessions). \`--usage-share 15\` sets session_share.
# *_max:   don't let the account's total go past this % (leaves headroom for you). 0 = no limit.
session_share = 0
session_max = 0
weekly_share = 0
weekly_max = 0
on_limit = "wait"                 # "wait" for the window to reset, or "halt" (pause; resume later)
check_seconds = 60                # how often usage is re-read while a step runs; a step that
                                  # crosses a limit is stopped and restarted after the reset

[schedule]
# Only start Claude work (steps and reviews) in these local-time ranges; a running step finishes.
# active_hours = ["23:00-07:00"]
outside_hours = "wait"            # "wait" for the next range, or "halt" (pause; resume later)

[tasks]
# Where the next task comes from:
#   "handoff"        the finalize step picks it from the repo's own instructions and writes the
#                    next prompt (the first one comes from \`nightshift run --prompt\`)
#   "github_issues"  open GitHub issues carrying \`label\`, one per item; \`--prompt\` is optional
#                    and adds instructions to every issue
source = "handoff"
label = "nightshift"              # only issues with this label are picked
# repo = "${alias}"               # alias whose GitHub issues are the queue (default: default_repo)
priority_labels = []              # e.g. ["p0", "p1"]: earlier labels first, then oldest first
skip_labels = ["blocked"]         # never pick issues with any of these
# authors = ["you"]               # only issues opened by these logins (issue text goes to Claude)
assign = true                     # claim: assign the issue to the gh account
in_progress_label = "nightshift-in-progress"   # claim label ("" = none); claimed issues are skipped
blocked_label = "nightshift-blocked"           # added when nightshift stops on an issue ("" = none)

[notify]
# Runs on halt/finish with NIGHTSHIFT_EVENT, _KIND, _REASON, _ITEM, _PR, _COST, _RUN in the environment.
command = ""
# command = 'curl -s -d "$NIGHTSHIFT_KIND: $NIGHTSHIFT_REASON" https://ntfy.sh/<your-topic>'
# command = 'terminal-notifier -title nightshift -message "$NIGHTSHIFT_REASON"'

${ejectedPrompts ? '[prompts]\ndir = ".nightshift/prompts"\n' : '# [prompts]\n# dir = ".nightshift/prompts"      # override any of the default prompt templates\n'}`;
}

export interface InitResult {
  created: string[];
  skipped: string[];
}

export async function init(home: string, options: { ejectPrompts: boolean }): Promise<InitResult> {
  const dir = path.join(home, NIGHTSHIFT_DIR);
  await mkdir(dir, { recursive: true });
  const created: string[] = [];
  const skipped: string[] = [];
  const writeOnce = async (file: string, content: string) => {
    if (existsSync(file)) {
      skipped.push(file);
      return;
    }
    await writeFile(file, content);
    created.push(file);
  };
  const alias = path.basename(path.resolve(home)).replace(/[^A-Za-z0-9_.-]/g, "-") || "main";
  await writeOnce(path.join(dir, CONFIG_FILE), configTemplate(alias, options.ejectPrompts));
  await writeOnce(path.join(dir, ".gitignore"), GITIGNORE);
  if (options.ejectPrompts) {
    const target = path.join(dir, "prompts");
    await mkdir(target, { recursive: true });
    for (const file of await readdir(DEFAULT_PROMPTS_DIR)) {
      if (!file.endsWith(".md")) continue;
      const destination = path.join(target, file);
      if (existsSync(destination)) {
        skipped.push(destination);
        continue;
      }
      await copyFile(path.join(DEFAULT_PROMPTS_DIR, file), destination);
      created.push(destination);
    }
  }
  return { created, skipped };
}
