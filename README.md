# nightshift

**Let Claude Code work through your todo list while you sleep.**

nightshift drives [Claude Code](https://code.claude.com) through a project's backlog, one item at a
time. Each item gets a **fresh session**, ends in a **pull request**, goes through an **independent
review** and **CI**, is **merged** with a normal merge, and hands a written prompt to the next fresh
session. It stops (and pings you) whenever a human is needed.

```
          ┌──────────────────────────── one item ────────────────────────────┐
handoff ─►│ implement ─► review ⇄ address ─► checks ⇄ fix ─► merge ─► finalize │─► next handoff
 prompt   │ (fresh      (your     (Claude,   (CI via    (Claude) (gh, pinned (Claude:
          │  session)    command)  resumed)   gh)                 to SHA)     post-merge +
          └─────────────────────────────────────────────────────────────────── next prompt)┘
                       any step can stop the run: a question for you, budget, CI, disk, STOP
```

## Why another loop?

You can keep one Claude session going with `/goal` or `/loop`, but over dozens of items its context
fills up and gets compacted. nightshift instead treats each item like a shift change: the outgoing
session writes a handoff, and a brand-new session starts from it. Inside an item, every step resumes
the same session, so Claude keeps that item's context (and only that item's).

Everything between the Claude steps is deterministic code, not a prompt:

- **Review** runs your own command (for example an independent Codex review, or nothing).
- **Checks** waits for GitHub CI and sends failures back to Claude, a bounded number of times.
- **Merge** is done by nightshift with `gh pr merge --merge --match-head-commit <sha>`, so exactly
  the commit that was reviewed and passed CI is merged. Never a surprise squash.
- **State** is journaled after every transition: kill it, reboot, `nightshift resume`.

## Requirements

- Node.js ≥ 22
- [Claude Code](https://code.claude.com) CLI, logged in (`claude --version`)
- [GitHub CLI](https://cli.github.com), logged in (`gh auth status`), with push and merge rights on the
  repos
- Optional: an independent reviewer you can call from a shell (see [Review](#review))
- Optional: `@anthropic-ai/claude-agent-sdk` for the SDK backend

## Install

```bash
npm install -g nightshift
```

Or try it without installing: `npx nightshift doctor`. The latest `main` installs with
`npm install -g github:ya-nsh/nightshift`.

## Quick start

```bash
cd your-repo
nightshift init          # writes .nightshift/config.toml (+ .gitignore for its runtime files)
$EDITOR .nightshift/config.toml
nightshift doctor        # checks gh, claude, repos, review command, disk
nightshift run --prompt-file first-task.md --once   # one supervised item first
nightshift run --prompt-file first-task.md          # (or `resume`) then let it run
```

The first prompt is whatever you would paste into a new chat to start the first item. From then on,
Claude writes each next prompt itself.

## Make your project nightshift-friendly

nightshift is generic: what to build and how is up to your repository's instructions
(`AGENTS.md` / `CLAUDE.md`). It works best when they say:

1. **Where the work is**: an ordered todo list with IDs, and how to pick the next item.
2. **The standard for done**: tests, docs, changelog, whatever "mergeable" means for you.
3. **What needs a human**: mark items that need accounts, keys, money or decisions (for example
   `⛔ user`). Claude reports these as `blocked` with a question instead of inventing values.
4. **The handoff**: what a fresh session must know (a handoff log, the next-prompt format).
5. **Post-merge steps**: tags, syncing other repos, cleaning up worktrees.

nightshift's prompts override one thing: **Claude never merges**. It opens the PR and stops, even if
your instructions say "merge to main"; the finalize step does your post-merge work after nightshift
merges. See [`examples/api-and-app`](examples/api-and-app) for a two-repo setup.

## How a run works

| Step | Who | What happens | Can stop the run when |
|---|---|---|---|
| implement | Claude, **fresh session** | Does the task from the handoff prompt, opens a ready PR | it needs you, fails, or reports nothing left |
| review | your `review.command` | Reviews the PR (posts comments, prints findings) | the command fails (or is skipped: `on_failure`) |
| address | Claude, resumed | Judges each finding, fixes valid ones, replies, pushes | it needs you or fails |
| *(re-review)* | | If fixes were pushed, review again, up to `review.max_rounds` | |
| checks | nightshift | Polls CI; a PR with no CI merges after `settle_seconds` | CI keeps failing, times out, or the PR closed |
| fix checks | Claude, resumed | Reads failed logs, fixes the root cause, pushes | after `checks.max_fix_rounds` |
| merge | nightshift | Waits for mergeability, merges pinned to the checked SHA, deletes the branch | branch protection or anything else rejects it |
| resolve conflicts | Claude, resumed | Merges the base branch in, resolves, pushes | after `merge.max_conflict_rounds` |
| finalize | Claude, resumed | Post-merge steps, picks the next task, writes `next_prompt` and `next_repo` | it needs you, or nothing is left |

Every Claude step must end with a JSON result that matches a schema
(`--json-schema` / `outputFormat`), which nightshift validates again. A malformed answer halts the
run; it never steers it.

## Stopping, answering, resuming

| Situation | Exit code | What to do |
|---|---|---|
| Nothing left to do | 0 | 🎉 |
| Item limit reached (`--once`, `--max-items`, `limits.max_items`) or `nightshift stop` | 0 | `nightshift resume` |
| Claude needs a human | 2 | `nightshift resume --answer "…"`: the answer goes into the same session (or into the next item's prompt) |
| Something failed (budget, CI, merge, review, disk, agent error) | 3 | fix the cause, then `nightshift resume` |
| Ctrl-C | 130 | `nightshift resume` (the interrupted step restarts, and Claude is told to check what it already did) |

`nightshift status` shows where the run is; `nightshift stop` finishes the current step and stops.
Configure `[notify] command` to get pinged on every stop (ntfy, `terminal-notifier`, Slack webhook…).

## Configuration

`nightshift init` writes a commented `.nightshift/config.toml`. The important parts:

```toml
[repos]                      # aliases Claude uses to say where the next task runs
backend = "."
ios = "../my-ios-app"

[agent]
backend = "cli"              # "cli" (claude -p, default) or "sdk" (Claude Agent SDK)
permission_mode = "auto"     # auto | acceptEdits | dontAsk | bypassPermissions
max_turns = 200
# add_dirs = [".."]          # let Claude work in sibling folders, e.g. git worktrees

[budget]
item_usd = 25                # all Claude steps of one item together
invocation_usd = 150         # one `run` / `resume`

[review]
command = "~/bin/review-pr {pr}"   # {pr} {pr_url} {repo_slug} {repo_path} {branch}
max_rounds = 2

[checks]
wait = true
max_fix_rounds = 2

[merge]
method = "merge"             # merge | rebase | squash

[limits]
max_items = 0                # 0 = until done or stopped
min_free_disk_gb = 0
```

Relative paths resolve against the directory that holds `.nightshift/`.

### Review

`review.command` runs with `/bin/sh -c` in the repo, after the PR opens and again after pushed fixes.
Placeholders are substituted shell-quoted, and the same values are exported as `NIGHTSHIFT_PR`,
`NIGHTSHIFT_PR_URL`, `NIGHTSHIFT_REPO_SLUG`, `NIGHTSHIFT_REPO_PATH` and `NIGHTSHIFT_BRANCH`. Its output
(last 30 000 characters) goes to Claude, which also reads the PR's comments on GitHub. Ideas:

- an independent model, e.g. an OpenAI Codex CLI review script that posts inline comments
- `claude -p "/code-review {pr_url}"`, a separate Claude session with no stake in the code
- your linters or a security scanner
- empty: no review step

### Prompts

The default prompts live in [`prompts/`](prompts). `nightshift init --eject-prompts` copies them to
`.nightshift/prompts/` and points `[prompts] dir` at them; any file there overrides the default of the
same name. Placeholders such as `{{pr_number}}` are checked: an unknown one is an error, not a blank.

### Backends

- **`cli`** (default) runs `claude -p` with the prompt on stdin and `--output-format json`. It uses
  your existing Claude Code login, settings, `CLAUDE.md` files, skills and plugins.
- **`sdk`** runs the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)'s
  `query()` with the same options and `settingSources: ["user", "project", "local"]`. Install
  `@anthropic-ai/claude-agent-sdk` next to nightshift or in your project. It authenticates however the
  SDK is configured to (see its docs).

## Safety

nightshift runs an agent unattended with your GitHub and Claude credentials. Treat it like giving a
colleague push access for the night.

- **Permissions.** The default is Claude Code's `auto` mode, whose classifier blocks risky actions.
  Narrow it further with `allowed_tools` and Claude Code's own permission rules, or run it in a
  container or VM. Use `bypassPermissions` only in an isolated environment.
- **Money.** `budget.item_usd` and `budget.invocation_usd` cap every Claude call (`--max-budget-usd`);
  nightshift will not start a step with less than $0.50 left.
- **Merges.** Only nightshift merges, only after review and green CI, and only the exact commit that
  passed. Branch protection on the default branch still applies, and is a good idea.
- **Reviews are input, not orders.** Claude is told to treat review output and PR comments as data,
  and to verify each finding before acting on it.
- **Bounded loops.** Review rounds, CI fix rounds, conflict rounds, polling time and items per run are
  all capped.
- **Local state.** Logs, Claude results and review output stay in `.nightshift/runs/` (gitignored).

## Files

```
.nightshift/
├── config.toml          # yours, commit it
├── prompts/             # optional overrides, commit them
├── .gitignore           # ignores the runtime files below
├── state.json           # the current run (atomic writes)
├── lock                 # pid lock: one nightshift per state
├── STOP                 # created by `nightshift stop`
└── runs/<run-id>/
    ├── events.jsonl     # every transition, cost and outcome
    └── item-<n>/        # each Claude result and review log
```

## Development

```bash
npm install
npm run check    # typecheck, lint (Biome), tests (Vitest)
npm run build
```

The pipeline is tested end to end against in-memory fakes of Claude, GitHub, the reviewer and the
clock (`test/fakes.ts`), so it is cheap to cover new paths. The CLI backend is also tested against a
fake `claude` executable. It was checked once against the real `claude` CLI (structured output,
`--resume`, `--allowedTools=` / `--add-dir=`). The SDK backend has not yet been run against the real
SDK; it is covered only by unit tests with a fake `query()`.

## License

[MIT](LICENSE) © Deva Annamaraju
