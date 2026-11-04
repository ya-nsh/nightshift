# Example: an API and an app in two repos

A common setup: one repository holds the backend and owns the API contract, another holds the
client app that consumes it. Each has its own `todo.md`, and items in one often unblock items in
the other. nightshift drives both from one config: the finalize step chooses `next_repo`, so the
loop can move between the repos as the dependencies require.

## What the repositories' instructions should say

Each repo's `AGENTS.md` (or `CLAUDE.md`) already covers most of what nightshift needs:

- **Before coding:** read the spec, the todo list and the newest handoff-log entries.
- **Picking work:** the first unchecked item, unless it is blocked on the other repo or the other
  repo has an item that unblocks more work. Items marked `⛔ user` need a human.
- **Done means:** tests pass, todo box ticked, handoff-log entry written, docs updated.
- **Contract changes:** bump the spec version, tag `contract-vX.Y.Z` after merge, and tell the other
  repo to sync.
- **Handoff:** finish with a self-contained prompt for the next session.

One rule changes under nightshift, the merge:

> Push your branch and open a PR. nightshift reviews it, waits for CI and merges it with a normal
> merge. Do the post-merge steps (tags, removing your worktree) when the finalize step asks.

The handoff prompt becomes the finalize step's `next_prompt`, and the "which repo next" rule decides
`next_repo`.

## Running it

```bash
cd api
mkdir -p .nightshift && cp path/to/nightshift/examples/api-and-app/config.toml .nightshift/config.toml
nightshift doctor
nightshift run --prompt-file first-task.md --once   # watch one item end to end
nightshift resume                                    # then let it go
```

Items that need a human (creating cloud projects, signing keys, a product decision) come back as
`blocked` with a question; answer with `nightshift resume --answer "…"`.
