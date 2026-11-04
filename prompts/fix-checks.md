CI failed on pull request #{{pr_number}} ({{pr_url}}). Failing checks: {{failed_checks}}.
This is fix attempt {{round}} of at most {{max_rounds}}.

1. Find out why: `gh pr checks {{pr_number}} -R {{repo_slug}}`, then
   `gh run view <run-id> -R {{repo_slug}} --log-failed` for each failed run.
2. Fix the root cause in the code or tests. Do not disable, skip or weaken checks or tests to make
   them pass. If a failure is clearly unrelated to this PR and flaky, re-run it
   (`gh run rerun <run-id> --failed -R {{repo_slug}}`) and say so in the summary.
3. Run the relevant checks locally, commit, and push to `{{branch}}`. Do not merge.

If the failure needs a human (missing secret, broken CI infrastructure, a decision), report
`blocked` with a precise question.

End with the structured result: `status`, `pushed_changes`, `summary`, and `question` if `blocked`.
