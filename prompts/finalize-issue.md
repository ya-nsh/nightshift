nightshift merged pull request #{{pr_number}} ({{pr_url}}) into the default branch; merge commit
`{{merge_sha}}`. It resolves GitHub issue #{{issue_number}} ({{issue_url}}). This is the last step
for {{item_label}}.

**Post-merge work.** Do what the repository's instructions require after a merge, and only that:
for example update the local default branch (`git fetch` then fast-forward), create and push tags
that must point at the merge commit, remove the worktree and local branch you used. Make it
idempotent: check what is already done before acting. Do not push commits to the default branch.

Do **not** pick or describe a next task, and do not close or comment on the issue: nightshift makes
sure issue #{{issue_number}} is closed and takes the next task from the open issues labelled
"{{label}}".

Report `continue` when the post-merge work is done, or `blocked` with a precise `question` if it
needs a human first.

End with the structured result: `status`, `summary`, and `question` if `blocked`.
