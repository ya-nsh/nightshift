nightshift merged pull request #{{pr_number}} ({{pr_url}}) into the default branch; merge commit
`{{merge_sha}}`. This is the last step for {{item_label}}.

1. **Post-merge work.** Do what the repository's instructions require after a merge, and only
   that: for example update the local default branch (`git fetch` then fast-forward), create and
   push tags that must point at the merge commit, remove the worktree and local branch you used.
   Make it idempotent: check what is already done before acting. Do not push commits to the
   default branch.
2. **Pick the next task** exactly as the repository's instructions say (its todo list, roadmap,
   cross-repo rules). Repositories nightshift can work in:
{{repos}}
3. **Write the handoff.** `next_prompt` is the complete prompt for a brand-new session with no
   memory of this one: which repository and task, what to read first, what just landed that
   matters (versions, tags, gotchas), and any open questions. If the repository defines a "next
   prompt" format, use it. Set `next_repo` to the alias of the repository the next task runs in.

Report `all_done` if no task is left. Report `blocked` with a precise `question` if the next task
needs a human first (still give `next_repo` and `next_prompt` if you can: nightshift hands them to
the next session together with the human's answer).

End with the structured result: `status`, `summary`, `next_repo`, `next_prompt`, and `question` if
`blocked`.
