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

[limits]
max_items = 0                     # items per invocation; 0 = until done or halted
min_free_disk_gb = 0              # halt before a step when free disk drops below this

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
