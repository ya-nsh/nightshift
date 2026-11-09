# Changelog

## 0.4.0 — 2026-11-09

### Added
- **Answer from GitHub.** With `[answers] via = "github"`, a question is posted as a comment on the
  item's PR; with no PR yet, on the item's own issue (GitHub issues source) or else in a new issue,
  with a hidden marker and reply instructions.
  A later comment from an allowed user (`[answers] users`, default: the `gh` login) is the answer:
  `nightshift resume` with no `--answer` picks it up, reacts with 👍 and closes an issue it opened
  for the question (never the item's own issue). Bots,
  other users and nightshift's own comments are ignored; the reply is data for Claude, like `--answer`.
- **Background service.** `nightshift service install|uninstall|status` runs the new
  `nightshift daemon` as a launchd agent (macOS) or systemd user unit (Linux). It resumes a run when
  an answer arrives on GitHub, when a usage-limit, active-hours or forecast pause clears, and after a
  reboot, crash or SIGTERM; it leaves `nightshift stop`, the item limit, Ctrl-C and failures to you
  (and a run with no task or issue left is done), respects the run's lock, backs off, and logs to
  `.nightshift/daemon.log`.
- **Morning report.** Every stop writes `.nightshift/runs/<run-id>/report.md` (copied to
  `.nightshift/report.md`): items with PR, merged commit, Claude's summary, cost, usage points and
  time per step (and active time), the GitHub issue an item came from, forecast decisions that held
  an item back, plus what is blocked or failed and why. `nightshift report [--run ID]` prints it,
  and the notify command gets its path as `NIGHTSHIFT_REPORT` (and `NIGHTSHIFT_QUESTION_URL`).
- `state.json` records why the run stopped (`stop.cause`, and `stop.resumeAt` when it clears by
  itself); SIGTERM is recorded as `terminated`, apart from Ctrl-C. Events gain `phase` (time per
  phase) and `result` (each step's summary), shown by `nightshift watch`.
- **GitHub issues as the task source.** `[tasks] source = "github_issues"` takes each item from the
  open issues labelled `[tasks] label` (default `nightshift`) instead of from Claude's handoff:
  oldest first, after any `priority_labels`; issues assigned to someone else, labelled with a
  `skip_labels` entry, already claimed or opened by someone outside `authors` are skipped.
  nightshift claims the issue (assignee and `in_progress_label`), builds the implement prompt from
  it (new `issue` template, asking for `Closes #N`), and after the merge makes sure the issue is
  closed, closing it with a comment linking the PR when GitHub did not. The finalize step then only
  does post-merge work (new `finalize-issue` template; no `next_prompt`), and the run finishes when
  no issue is left. A stop that needs a human comments on the issue and adds `blocked_label`;
  `resume` removes the label, and `run --force` releases the claim. `nightshift run` needs no
  `--prompt` with this source (one given adds instructions to every issue), and `doctor` and
  `status` show the task source and the next issue.
- **Models per step.** `[agent.steps.<step>]` (`implement`, `address`, `fix_checks`,
  `resolve_conflicts`, `finalize`) overrides `model`, `max_turns` and `permission_mode` for that
  step, falling back to `[agent]`; e.g. `implement` on opus, `address` and `fix_checks` on sonnet.
  Unknown steps and bad values are config errors. Both backends apply them, `nightshift doctor`
  lists each step's model, step log lines name the model, and `agent` events record it.
- **`nightshift watch`.** A live terminal view of a run driven elsewhere (another terminal, a
  background service): run status and whether its process is alive, the current item, phase and
  PR, the running step with elapsed time, tool count and its latest tool calls, cost, 5-hour and
  weekly usage bars with nightshift's share and reset times, any wait, and the last ten events.
  It only reads `.nightshift/`, cuts lines to the terminal width, respects `NO_COLOR`, prints
  line by line when the output is not a terminal, and quits on `q` / Ctrl-C. `--once` prints one
  frame. Each tool call is now also appended to `.nightshift/runs/<run-id>/progress.jsonl`
  (rotated at 256 KiB, one older file kept).
- **`nightshift plan`.** A dry run: a fresh, read-only Claude session lists the next N items
  (`-n`, default 5) nightshift would do, from the current run's pending handoff, `--prompt` /
  `--prompt-file`, or the repositories' instructions. Each item has an ID, title, repo, why now,
  rough size, risk, and whether it needs a human (with the question). `--json` prints the
  structured result, `--write` saves `.nightshift/plan.md`. The session has only the Read, Glob
  and Grep tools, runs in `dontAsk` mode without MCP servers, and ignores the configured tool and
  permission settings. `[agent.steps.plan]` sets its `model` and `max_turns` (its permission
  mode is always read-only). It costs at most `[budget] plan_usd` (default $2), refuses to start
  at a `[usage]` limit, and takes no lock, so it is safe next to a live run.
- **Forecasts.** From finished items (this run's and earlier runs' `item_done` events), nightshift
  estimates a typical item's usage points, active time and cost (median of the last 20 items by
  default, `[usage] forecast_percentile`; at least 3 items). Before starting a new item it checks
  that one fits in what is left of the `[usage]` shares and maxima and of the active hours, and
  otherwise waits for the reset or the next active range (or pauses, per `on_limit` /
  `outside_hours`) instead of starting an item that would be cut half-way, logging why.
  `[usage] start_item_only_if_it_fits` (default: on when limits or active hours are set).
  `nightshift status` and `doctor` show how many more items fit. `item_done` events now record
  `usagePoints` and `activeMs`.
- **Parallel lanes.** `[limits] lanes = N` works on up to N items at once, each in a git worktree
  nightshift creates (under `[limits] worktree_dir`) with its own Claude session, and removes once
  the item is done. Finalize hands over up to as many next items as lanes are free (a `next` list),
  told to pick only tasks independent of the items in progress; with `[tasks] source =
  "github_issues"`, each free lane claims its own issue instead, after the same gates. Merges are
  serialized, and a PR re-checks mergeability (resolving conflicts, or catching up when protection
  requires it) after a sibling merged. Budget, usage limits, active hours and STOP apply across
  lanes; forecasts hold back what the items in progress are still expected to use, and usage is
  measured once for all running steps. Each lane keeps its `[agent.steps]` settings. A question or
  failure parks only its lane (a question is asked on GitHub for that item) while the others finish
  their current item; the exit code is the worst lane's. `status`, `watch`, the report and the
  daemon understand several items, `resume --answer … --item N` picks which question to answer,
  and `doctor` checks that `origin/HEAD` is set. `lanes = 1` (the default) works as before.

### Changed
- A run with more than one item in progress (parallel lanes) keeps the others in `state.json`'s
  new `moreItems` and is version 2, which older nightshift versions refuse rather than lose items.
  With one lane the file is unchanged (version 1).

## 0.3.0 — 2026-11-08

### Added
- **Live progress.** Claude steps now stream (`--output-format stream-json`): every tool call is
  logged as it happens (`[T12] implement · Bash npm test`), and `nightshift status` shows the
  running step, how long it has run, its tool count and the latest call. Step artifacts are now
  `<step>-<n>.jsonl` with every streamed message.
- **Active hours.** `[schedule] active_hours = ["23:00-07:00"]` starts Claude work only in those
  local-time ranges (a running step finishes); `outside_hours = "wait"` or `"halt"`.
- **Merges under branch protection.** A PR that needs an approving review now halts with a clear
  message, or with `merge.when_blocked = "auto"` nightshift enables GitHub auto-merge and waits.
- **Usage per item.** Points of the 5-hour and weekly windows used are tracked per item and per
  run, shown by `status` and in the run summary, and recorded in `item_done` events.
- **Usage from the stream.** The `rate_limit_event`s Claude streams update the usage tally between
  checks, so a step crossing a `[usage]` limit is stopped sooner and with fewer checks.
- **Release workflow.** Pushing a `v*` tag publishes to npm with trusted publishing and creates a
  GitHub release from this changelog.

### Fixed
- A human's answer is kept until the step it was given to succeeds; a failed or interrupted step
  gets it again on `resume` instead of losing it.
- `resume` after the CI-fix or conflict cap grants that loop fresh rounds, and a checks timeout
  restarts on `resume`, instead of halting again at once.
- Stopping a step (Ctrl-C, a usage limit) asks Claude to stop with SIGINT (the SDK: `interrupt()`),
  so the cost it reports is counted. A stop during Claude's very first API call may still report
  nothing.
- A second nightshift on the same run prints one line instead of a stack trace; `status` tells a
  live run from one whose process was killed.
- `doctor` checks a relative review command in each repo, where it actually runs.
- `--max-items 0` means no limit, overriding `[limits] max_items` (documented).
- SDK backend: `agent.extra_args` is passed as the SDK's `extraArgs`, and a non-default
  `agent.claude_path` as `pathToClaudeCodeExecutable`; `doctor` validates both. Checked against
  the real `@anthropic-ai/claude-agent-sdk` 0.3.319.
- State saves are serialized, so progress and usage updates during a step cannot interleave.

## 0.2.0 — 2026-11-08

### Added
- `[usage]` limits and `--usage-share`: keep nightshift inside a share of the Claude plan's 5-hour
  and weekly windows (wait for the reset, or halt), measured before, during and after each step.

## 0.1.0 — 2026-11-07

First release: one fresh Claude Code session per todo item, a PR, an independent review, green CI,
a normal merge pinned to the checked commit, and a handoff to the next session.
