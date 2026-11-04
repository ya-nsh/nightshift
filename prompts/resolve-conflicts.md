Pull request #{{pr_number}} ({{pr_url}}) conflicts with its base branch, so it cannot be merged.
This is attempt {{round}}.

Bring `{{branch}}` up to date with the base branch: fetch, then merge the base branch into
`{{branch}}` (do not rebase or force-push over reviewed history), resolve every conflict so that
both sides' intent is preserved, run the repository's checks, commit and push. Do not merge the PR.

If a conflict needs a human decision, report `blocked` with a precise question.

End with the structured result: `status`, `pushed_changes`, `summary`, and `question` if `blocked`.
