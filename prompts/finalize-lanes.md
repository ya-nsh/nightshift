nightshift merged pull request #{{pr_number}} ({{pr_url}}) into the default branch; merge commit
`{{merge_sha}}`. This is the last step for {{item_label}}.

nightshift works on up to {{lanes}} items at once, each in its own session, git worktree and pull
request. These items are in progress right now (some may be waiting for a human):
{{running}}

1. **Post-merge work.** Do what the repository's instructions require after a merge, and only
   that: for example create and push tags that must point at the merge commit. Make it idempotent:
   check what is already done before acting. Do not push commits to the default branch. Do not
   remove this item's worktree (`{{work_path}}`) or its branch, and do not touch the other items'
   worktrees: nightshift cleans up after this step.
2. **Pick up to {{max_next}} next task(s)** exactly as the repository's instructions say (its todo
   list, roadmap, cross-repo rules), but only tasks that can run **now, in parallel** with every
   item in progress above and with each other: a task qualifies only if it needs nothing an
   in-progress item will deliver, and would not change the same code (so the pull requests will
   not conflict). Never pick a task that is already in progress. Fewer is fine, and none is fine
   when everything left waits on the items in progress: nightshift asks again when they finish.
   Repositories nightshift can work in:
{{repos}}
3. **Write a handoff for each task.** Its `prompt` is the complete prompt for a brand-new session
   with no memory of this one: which repository and task, what to read first, what just landed
   that matters (versions, tags, gotchas), which items are in progress in parallel (so it stays
   out of their way), and any open questions. If the repository defines a "next prompt" format,
   use it. Set `repo` to the alias of the repository the task runs in.

Report `all_done` only if no task is left at all, apart from the items in progress. Report
`blocked` with a precise `question` if a task needs a human first: put that task first in `next`,
and nightshift hands the human's answer to the session that does it.

End with the structured result: `status`, `summary`, `next` (a list of `repo` and `prompt`), and
`question` if `blocked`.
