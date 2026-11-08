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
npm install -g @deva00/nightshift
```

This installs the `nightshift` command. Or try it without installing:
`npx @deva00/nightshift doctor`. The latest `main` installs with
`npm install -g github:ya-nsh/nightshift`.

## Quick start

```bash
cd your-repo
nightshift init          # writes .nightshift/config.toml (+ .gitignore for its runtime files)
$EDITOR .nightshift/config.toml
nightshift doctor        # checks gh, claude, repos, review command, disk
nightshift plan --prompt-file first-task.md        # optional: preview the next items, read-only
nightshift run --prompt-file first-task.md --once   # one supervised item first
nightshift run --prompt-file first-task.md          # (or `resume`) then let it run
nightshift run --prompt-file first-task.md --usage-share 15   # use at most 15% of each 5-hour window
```

The first prompt is whatever you would paste into a new chat to start the first item. From then on,
Claude writes each next prompt itself.

Or let your issue tracker be the todo list: with `[tasks] source = "github_issues"`, nightshift works
through the open GitHub issues labelled `nightshift`, one issue per item, and `nightshift run` needs
no prompt. See [GitHub issues](#github-issues).

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
| merge | nightshift | Waits for mergeability, merges pinned to the checked SHA, deletes the branch | branch protection needs an approval (or, with `when_blocked = "auto"`, waits for auto-merge), or anything else rejects it |
| resolve conflicts | Claude, resumed | Merges the base branch in, resolves, pushes | after `merge.max_conflict_rounds` |
| finalize | Claude, resumed | Post-merge steps, picks the next task, writes `next_prompt` and `next_repo` (with [GitHub issues](#github-issues): post-merge steps only; nightshift closes the issue and picks the next one) | it needs you, or nothing is left |

Every Claude step must end with a JSON result that matches a schema
(`--json-schema` / `outputFormat`), which nightshift validates again. A malformed answer halts the
run; it never steers it.

## Stopping, answering, resuming

| Situation | Exit code | What to do |
|---|---|---|
| Nothing left to do | 0 | 🎉 |
| Item limit reached (`--once`, `--max-items`, `limits.max_items`) or `nightshift stop` | 0 | `nightshift resume` |
| Usage limit reached with `on_limit = "halt"` (with `"wait"` it sleeps until the window resets) | 0 | `nightshift resume` after the reset |
| Claude needs a human | 2 | reply on GitHub (`[answers] via = "github"`), or `nightshift resume --answer "…"`: the answer goes into the same session (or into the next item's prompt) |
| Outside `[schedule] active_hours` with `outside_hours = "halt"` | 0 | `nightshift resume` |
| Something failed (budget, CI, merge, review, disk, agent error) | 3 | fix the cause, then `nightshift resume` |
| Ctrl-C | 130 | `nightshift resume` (the interrupted step restarts, and Claude is told to check what it already did) |

`nightshift resume` is a human saying "try again": an answer you gave is kept until the step it
was meant for succeeds, a loop that hit its cap (CI fix rounds, conflict rounds) gets its rounds
back, and a checks timeout starts over.

While a step runs, nightshift logs each tool call Claude makes (`[T12] implement · Bash npm test`).
`nightshift status` shows where the run is: the running step, for how long, its tool calls and the
latest one, any wait, cost and usage, and whether the nightshift process is still alive.

`nightshift watch` follows a run live from any terminal, whoever drives it (another terminal, a
background service): the run's status and whether its process is alive, the current item, phase
and PR, the running step with its elapsed time and a scrolling list of its latest tool calls, cost,
5-hour and weekly usage bars (█ nightshift's points, ▓ the rest of the account, │ the `*_max`
limit) with the reset times, any wait and when it ends, and the last ten events. It only reads
files, so it never disturbs the run; it redraws about once a second and follows the next run when
one starts. `q` or Ctrl-C quits and restores the terminal. Lines are cut to the terminal width,
`NO_COLOR` turns colours off, and when the output is not a terminal (a pipe, a log file) it prints
new events, tool calls and status changes line by line, like `tail -f`. `nightshift watch --once`
prints one frame and exits.
`nightshift stop` finishes the current step and stops. Configure `[notify] command` to get pinged
on every stop (ntfy, `terminal-notifier`, Slack webhook…).

### Answering on GitHub

With `[answers] via = "github"` (what `nightshift init` writes), a question goes where you can answer
it from your phone: a comment on the item's PR; when there is no PR yet, a comment on the issue the
item works on (with `[tasks] source = "github_issues"`), or else a new issue in the item's repo. Each
carries a hidden `<!-- nightshift:question … -->` marker and says how to reply.

Reply with a comment that holds just your answer. Comments from the allowed users (`[answers] users`,
by default the account `gh` is logged in as) posted after the question are the answer; several are
joined in order. Comments from anyone else, from bots, and nightshift's own marked comments are
ignored, and the answer is passed to Claude as data, exactly like `--answer`. `nightshift resume`
(with no `--answer`) picks it up, reacts with 👍 and closes an issue it opened for the question
(never the item's own issue); the background
service does the same within `poll_seconds`. Answering with `--answer` instead closes the GitHub
question too.

```toml
[answers]
via = "github"          # or "terminal": only `nightshift resume --answer`
users = ["your-login"]  # whose replies count; empty = the `gh` login
poll_seconds = 120      # how often the daemon checks for a reply
```

If posting fails (offline, no permission), the run still stops with the question; the next `resume`
or the daemon posts it.

### Background service

`nightshift service install` runs `nightshift daemon` for this config's home as a launchd agent
(macOS, `~/Library/LaunchAgents`) or a systemd user unit (Linux, `~/.config/systemd/user`); `status`
shows whether it runs and its last log lines, `uninstall` removes it. On Linux, run
`loginctl enable-linger` once to keep it running while you are logged out. Re-run `install` after
moving nightshift (or check `status`, which says when the installed file is out of date).

The daemon resumes the run only when it can make progress by itself:

| The run stopped because | The daemon |
|---|---|
| a question was answered on GitHub | resumes with the answer |
| a usage limit (`on_limit = "halt"`), active hours (`outside_hours = "halt"`), or a forecast that a new item would not fit (either of those) | resumes once the window resets or the hours start |
| the machine rebooted or nightshift crashed while it ran, or it got SIGTERM | resumes (the interrupted step restarts) |
| `nightshift stop`, the item limit, Ctrl-C, or a failure (exit 3) | leaves it for you |
| nothing left to do (including no open issue left with the GitHub issues source) | nothing: the run is done |

It never touches a run another nightshift process holds the lock for, retries a resume that made no
progress after 1, 2, 4… minutes (at most an hour), and logs to `.nightshift/daemon.log` (the resumed
run's output included). The decision uses the stop cause recorded in `state.json` (`stop.cause`),
never the message. `nightshift daemon` also runs in the foreground under any other supervisor.

### The morning report

Every stop (done, paused, blocked, halted) writes `.nightshift/runs/<run-id>/report.md` and a copy at
`.nightshift/report.md`: each item with its label, GitHub issue (issues source), PR, merged commit,
Claude's one-line summary, cost, usage points, time per step and active time; what is blocked or
failed and why (with the GitHub link to answer); forecast decisions that held a new item back; and
the run's total cost and usage. `nightshift watch` shows the report's new events (step times, step
results, questions and answers) as they happen.

`nightshift report` prints the current run's report (rebuilt from its journal, so it is current even
mid-run); `nightshift report --run <id>` an earlier run's. The notify command gets its path as
`NIGHTSHIFT_REPORT`:

```toml
[notify]
command = 'curl -s -T "$NIGHTSHIFT_REPORT" -H "Title: nightshift $NIGHTSHIFT_KIND" https://ntfy.sh/<topic>'
```
## Previewing the next items: `nightshift plan`

```sh
nightshift plan                    # the next 5 items, from the current run's pending handoff
nightshift plan -n 3 --write       # also save .nightshift/plan.md
nightshift plan --prompt-file next.md --repo api --json
```

`plan` is a dry run. A fresh Claude session reads the repositories' own instructions (AGENTS.md,
CLAUDE.md, todo lists) and says which items nightshift would do next, in order, without doing any of
them. For each item: its ID and title, the repo, why it comes now, a rough size (S, M, L, XL), its
risk, and whether it needs a human (with the question a run would stop on).

- **Where it starts.** `--prompt` / `--prompt-file` (in `--repo`, else `default_repo`). Without
  one: the current run's next item if it has not started; the items after it if it is under way (a
  pending question is passed on); otherwise the repositories' instructions from the top.
- **Read-only.** The session has only Claude Code's Read, Glob and Grep tools (`--tools`), so it
  cannot edit files, run commands, push or open PRs, whatever your settings allow. It runs in
  `dontAsk` mode (anything else is denied, never asked), without MCP servers, and every configured
  repo is readable (`--add-dir`). `allowed_tools`, `permission_mode` and the permission flags of
  `extra_args` (`--permission-mode`, `--dangerously-skip-permissions`, `--allowedTools`, `--tools`,
  `--mcp-config`) do not apply to it. (Claude Code's `plan` permission mode is not used: it steers
  Claude into writing a plan file instead of answering.)
- **Model.** `[agent.steps.plan]` sets its `model` and `max_turns` (see
  [Models per step](#models-per-step)); otherwise `[agent]` applies.
- **Budget and usage.** One plan costs at most `[budget] plan_usd` (default $2). With `[usage]`
  limits set, `plan` refuses to start at a limit instead of waiting; share limits count the current
  run's tally, and a plan's own usage is not added to it.
- **Next to a live run.** `plan` takes no lock and never writes `state.json`: it plans from the run's
  state as it is when it starts, so it is safe while `nightshift run` is driving. Active hours apply
  to runs only.
- **Output.** Markdown on stdout (progress on stderr); `--json` prints the structured result
  instead; `--write` also saves the Markdown to `.nightshift/plan.md`. The streamed session is kept
  in `.nightshift/plans/`. Exit code 0 on success, 1 on failure, 130 on Ctrl-C.

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

[agent.steps.implement]      # per-step overrides, see "Models per step" below
model = "opus"

[budget]
item_usd = 25                # all Claude steps of one item together
invocation_usd = 150         # one `run` / `resume`
plan_usd = 2                 # one `nightshift plan` (read-only preview)

[usage]                      # Claude plan limits, see "Usage limits" below
session_share = 15           # points of each 5-hour window nightshift may use (or --usage-share 15)
weekly_max = 80              # never push the account's weekly usage past 80%
on_limit = "wait"            # wait for the reset, or "halt"

[review]
command = "~/bin/review-pr {pr}"   # {pr} {pr_url} {repo_slug} {repo_path} {branch}
max_rounds = 2

[checks]
wait = true
max_fix_rounds = 2

[merge]
method = "merge"             # merge | rebase | squash
when_blocked = "halt"        # a required approval blocks the merge: "halt", or "auto" (auto-merge)

[schedule]
active_hours = ["23:00-07:00"]   # start Claude work only in these local-time ranges

[limits]
max_items = 0                # 0 = until done or stopped (`--max-items 0` also means no limit)
min_free_disk_gb = 0
```

Relative paths resolve against the directory that holds `.nightshift/`.

### Usage limits

On a Claude subscription (Pro, Max, Team), nightshift can stay inside a share of your plan's usage
instead of a dollar budget. It reads the same numbers Claude Code's `/usage` shows: the rolling
**5-hour** ("session") window and the **weekly** window, each as a percentage.

| Setting | Meaning |
|---|---|
| `session_share`, `weekly_share` | Percentage points of each window that nightshift itself may use. |
| `session_max`, `weekly_max` | Don't let the account's total go past this percentage, so you keep headroom. |
| `on_limit` | `"wait"` (default): sleep until the window resets, then carry on. `"halt"`: pause the run (exit 0); `resume` after the reset. |
| `check_seconds` | How often usage is re-read while a step runs (default 60). |

`0` means no limit, which is the default for all four. `--usage-share 15` on `run` or `resume` sets
`session_share` for that run, and later `resume`s keep it.

How it works:

- Usage is account-wide, so your interactive Claude Code sessions count toward it too. nightshift
  counts as its own only what changes **while its own steps run** (Claude steps and the review
  command), measured before, during and after each one. Usage in between, such as you working
  while CI runs, is not counted against its share; it does count toward the `*_max` limits.
- Before each step, nightshift checks the limits. During a step it re-reads usage every
  `check_seconds`; if a limit is reached part-way, it stops the step, waits (or pauses), and later
  restarts it with the "you were interrupted, check what you already did" prompt. A step can
  overshoot by whatever it uses within one check interval.
- Usage comes from a `get_usage` request to Claude Code (`claude -p --input-format stream-json`). It
  runs no model turn and costs nothing, but it is not a documented API. If it can't be read while
  limits are set, nightshift halts rather than running unmetered. `nightshift doctor` shows the
  current numbers, and `nightshift status` shows the last reading and any wait.
- Claude's stream also reports usage (`rate_limit_event`), which updates the tally between checks,
  so a step crossing a limit is stopped sooner and fewer checks are needed.
- Points used are tracked per item and per run: `status` and the end-of-run summary show them.
- API-key logins have no usage windows; use `[budget]` there.

### Active hours

`[schedule] active_hours` (one range or a list, local time, may cross midnight) limits when Claude
work starts: outside them nightshift waits for the next range (`outside_hours = "wait"`, the
default) or pauses (`"halt"`). A step that is already running finishes; CI waits and merges carry on
at any time. Combine it with `[usage]` to run only overnight, on a share of your plan.

### Forecasts

nightshift learns what a typical item costs from the items it has finished, in this run and earlier
ones (the `item_done` events in `.nightshift/runs/*/events.jsonl`): points of the 5-hour and weekly
windows, active time (CI waits count; usage and schedule waits and pauses don't) and dollars. It
takes the median of the last 20 items (`forecast_percentile = 75` makes it more cautious) and says
how many items that is based on. With fewer than 3 finished items it says so and holds nothing back.

**Start an item only if it fits.** Before the first step of a new item (not a restart or resume of
one already under way), nightshift checks that a typical item fits in what is left of nightshift's
`session_share`/`weekly_share`, under `session_max`/`weekly_max` (and the plan's own 100%), and
before the active hours end. If it doesn't, it waits for the window to reset or for the next active
range (or pauses, following `on_limit` / `outside_hours`), instead of starting an item that would
be cut half-way. Every decision is logged with its reasoning:

```
[item 4] forecast: a typical item uses ~6 points of the 5-hour window (median of 9 items), but 5 of nightshift's 15-point share left (session_share = 15)
forecast: …; waiting until 17:01 for the 5-hour window to reset before starting a new item
```

An item that could never fit (it needs more than a whole share, or longer than the longest active
range) starts anyway. `[usage] start_item_only_if_it_fits` turns this on or off; by default it is on
when `[usage]` limits or `active_hours` are set.

`nightshift status` and `nightshift doctor` show the forecast:

```
forecast: a typical item: ~6 points of the 5-hour window, ~40 min, ~$2.50 (median of the last 9 items)
forecast: ~3 more items fit in this 5-hour window (resets 03:00) at ~6 points each (median of 9 items)
forecast: active hours end 07:00 — ~2 items of ~40 min (median of 9 items)
```

Runs from nightshift 0.3.0 count too: their points are summed from `usage` events and their active
time is reconstructed from event times.

### Branch protection

nightshift merges the PR itself, so a rule that requires an approving review blocks it. By default
it halts and says so: approve the PR (or merge it yourself), then `nightshift resume`. With
`merge.when_blocked = "auto"` it enables GitHub auto-merge for the checked commit instead and waits
for GitHub to merge once the PR is approved (the repo must allow auto-merge).

### GitHub issues

```toml
[tasks]
source = "github_issues"          # default "handoff"
label = "nightshift"              # the queue: open issues with this label
# repo = "backend"                # alias whose issues are the queue (default: default_repo)
priority_labels = ["p0", "p1"]    # earlier labels first; then oldest first
skip_labels = ["blocked"]         # never pick these
# authors = ["you", "teammate"]   # only issues opened by these logins
assign = true                     # claim by assigning the issue to the gh account…
in_progress_label = "nightshift-in-progress"   # …and/or labelling it ("" = no label)
blocked_label = "nightshift-blocked"           # added when nightshift stops on an issue ("" = none)
```

With `source = "github_issues"` the next task comes from GitHub instead of from Claude's handoff:

- **Picking.** `nightshift run` needs no `--prompt`. nightshift lists the open issues with `label`,
  drops the ones it must not take (assigned to someone else, labelled with a `skip_labels` entry or
  `blocked_label`, already labelled `in_progress_label`, or, with `authors`, opened by someone else),
  and takes the first by `priority_labels`, then oldest first. A `--prompt` you do give is added to
  every issue's prompt as instructions for the run (`--repo` cannot change where issues come from).
- **Claiming.** Before Claude starts, nightshift assigns the issue to the `gh` account and adds
  `in_progress_label` (creating the label if needed), so other runs skip it. The start gates
  (active hours, `[usage]` limits and the forecast that a new item fits) run before the issue is
  picked, so a wait or a pause never holds a claim.
- **Implementing.** The implement prompt is built from the issue (number, title, body, URL, author;
  the [`issue`](prompts/issue.md) template) and asks for `Closes #N` in the PR description. If Claude
  finds nothing to change, it reports `all_done`: nightshift comments the reason on the issue, adds
  `blocked_label`, releases the claim, and goes on with the next issue.
- **Finalizing.** The finalize step ([`finalize-issue`](prompts/finalize-issue.md)) only does the
  post-merge work: it does not pick a task, and its result has no `next_repo` or `next_prompt`.
  nightshift then makes sure the issue is closed (closing it with a comment that links the PR when
  GitHub did not), removes `in_progress_label` (the assignee stays, as a record), and picks the next
  issue. When none is left, the run finishes as done.
- **Stops.** When the run stops on an issue for a human (a question, a failure, CI, budget, a
  blocked merge; not a planned pause or Ctrl-C), nightshift comments the reason on the issue, once
  per distinct reason, and adds `blocked_label`. The claim stays, since `nightshift resume` continues
  the same issue; resuming takes `blocked_label` off again. `nightshift run --force` abandons the
  run: it comments on the issue and releases the claim, and `blocked_label` stays until a human
  removes it.
- **Status.** `nightshift doctor` and `nightshift status` show the task source, how many issues are
  ready, and which one is next; `status` also shows the current item's issue.

The `gh` account needs triage (or write) access to label and assign issues. Two runs under the same
account on one repository can, in a narrow window, claim the same issue; give them different labels.

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

### Models per step

`[agent.steps.<step>]` overrides `model`, `max_turns` and `permission_mode` for one step; anything it
leaves out comes from `[agent]` (and with no `model` anywhere, Claude Code picks its default). The
steps are `implement`, `address`, `fix_checks`, `resolve_conflicts` and `finalize`; any other name,
key or value is a config error. `[agent.steps.plan]` sets `model` and `max_turns` for
[`nightshift plan`](#previewing-the-next-items-nightshift-plan) (a cheap model is often enough);
it takes no `permission_mode`, because a plan session is always read-only.

```toml
[agent]
model = "sonnet"             # every step without its own model

[agent.steps.implement]
model = "opus"               # the hard part
max_turns = 300

[agent.steps.finalize]
model = "haiku"
max_turns = 50
```

The steps of an item still share one Claude session: a step on another model resumes it
(`--resume` with `--model`), and Claude Code carries the conversation over to the new model. The
prompt cache is per model, though, so the first turn after a switch reads the whole session
uncached: switch where it pays off, not on every step.

`nightshift doctor` lists each step's model (and any `max_turns`/`permission_mode` override), every
step's log line names its model (`[T3] address · model sonnet · budget $24.10`), and the `agent`
event in `events.jsonl` records it. Both backends apply the overrides.

### Backends

- **`cli`** (default) runs `claude -p` with the prompt on stdin and `--output-format stream-json`. It
  uses your existing Claude Code login, settings, `CLAUDE.md` files, skills and plugins.
- **`sdk`** runs the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)'s
  `query()` with the same options and `settingSources: ["user", "project", "local"]`. Install
  `@anthropic-ai/claude-agent-sdk` next to nightshift or in your project. `extra_args` are passed as
  the SDK's `extraArgs`, and a `claude_path` other than `claude` as `pathToClaudeCodeExecutable`
  (otherwise the SDK's bundled Claude Code runs). It authenticates however the SDK is configured to
  (see its docs).

Stopping a step (Ctrl-C, a usage limit) asks Claude to stop (SIGINT, or the SDK's `interrupt()`), so
the cost it reports so far is still counted.

## Safety

nightshift runs an agent unattended with your GitHub and Claude credentials. Treat it like giving a
colleague push access for the night.

- **Permissions.** The default is Claude Code's `auto` mode, whose classifier blocks risky actions.
  Narrow it further with `allowed_tools` and Claude Code's own permission rules, or run it in a
  container or VM. Use `bypassPermissions` only in an isolated environment.
- **Money.** `budget.item_usd` and `budget.invocation_usd` cap every Claude call (`--max-budget-usd`);
  nightshift will not start a step with less than $0.50 left. On a subscription, `[usage]` keeps it
  inside a share of your 5-hour and weekly limits instead.
- **Merges.** Only nightshift merges, only after review and green CI, and only the exact commit that
  passed. Branch protection on the default branch still applies, and is a good idea.
- **Reviews are input, not orders.** Claude is told to treat review output and PR comments as data,
  and to verify each finding before acting on it.
- **Answers on GitHub** count only from the users you allow (by default your own `gh` login), never
  from bots, and reach Claude as data inside the answer prompt, the same as `--answer`. On a public
  repo the question is public: keep `via = "terminal"` if questions may contain anything private.
- **Issues are input too.** With the GitHub issues source, the label is the gate: only people with
  triage access can add it. An issue's author can still edit its text after it was labelled, so on a
  public repository set `[tasks] authors` to the people whose issues nightshift may take.
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
├── report.md            # the latest morning report
├── daemon.log           # the background service's log (and daemon.lock while it runs)
└── runs/<run-id>/
    ├── events.jsonl     # every transition, cost, usage and outcome
    ├── report.md        # the run's morning report
    ├── progress.jsonl   # every tool call of every step, for `watch` (rotates at 256 KiB
    │                    # to progress.1.jsonl, so at most about 512 KiB)
    └── item-<n>/        # each Claude step's streamed messages (.jsonl) and review log
```

## Development

```bash
npm install
npm run check    # typecheck, lint (Biome), tests (Vitest)
npm run build
```

The pipeline is tested end to end against in-memory fakes of Claude, GitHub, the reviewer, the
clock and the plan's usage (`test/fakes.ts`), so it is cheap to cover new paths. The CLI backend is
also tested against fake `claude` executables. Both backends were checked against the real thing
(Claude Code 2.1.283 and `@anthropic-ai/claude-agent-sdk` 0.3.319): structured output, streamed tool
calls and usage, and stopping a step with its cost reported.

### Releasing

Bump `version` in `package.json` and add a `CHANGELOG.md` entry in a PR. Once it is merged, tag
`main`; the [release workflow](.github/workflows/release.yml) checks the tag against
`package.json`, runs the checks, publishes to npm with trusted publishing (no token, no 2FA prompt)
and creates a GitHub release from the changelog:

```bash
git fetch origin && git tag v0.3.0 origin/main && git push origin v0.3.0
```

Trusted publishing needs a one-time setup on npmjs.com: the package's Settings → Trusted Publisher
→ GitHub Actions, repository `ya-nsh/nightshift`, workflow `release.yml`.

## License

[MIT](LICENSE) © Deva Annamaraju
