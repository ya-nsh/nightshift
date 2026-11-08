# Changelog

## Unreleased

### Added
- **`nightshift plan`.** A dry run: a fresh, read-only Claude session lists the next N items
  (`-n`, default 5) nightshift would do, from the current run's pending handoff, `--prompt` /
  `--prompt-file`, or the repositories' instructions. Each item has an ID, title, repo, why now,
  rough size, risk, and whether it needs a human (with the question). `--json` prints the
  structured result, `--write` saves `.nightshift/plan.md`. The session has only the Read, Glob
  and Grep tools, runs in `dontAsk` mode without MCP servers, and ignores the configured tool and
  permission settings. It costs at most `[budget] plan_usd` (default $2), refuses to start at a
  `[usage]` limit, and takes no lock, so it is safe next to a live run.

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
