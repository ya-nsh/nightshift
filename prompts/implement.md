{{handoff}}

---

## You are running under nightshift (unattended)

nightshift is driving this session as one step of an automated loop: implement → pull request →
independent review → CI → merge → handoff to a fresh session. Nobody is watching live and nobody
can answer a question mid-session.

Rules for this step, which override anything above or in the repository's instructions:

1. Do the task above completely and to the repository's own standards (read its AGENTS.md /
   CLAUDE.md / contributing docs first), including tests and docs it requires.
2. **nightshift merges, not you.** Commit on a branch (not the default branch), push it, open a
   **ready-for-review** (not draft) pull request against the default branch with `gh pr create`,
   then stop. Do not merge, do not push to the default branch, do not delete the branch, and do
   not tag releases yet, even if the repository's instructions say to: the finalize step does
   post-merge work after nightshift merges.
3. Write the PR description for a reviewer who has not seen this session: what changed, why, how
   it was verified.
4. Do not wait for review or CI; nightshift runs both next and resumes this session with the
   results.
5. If the task needs a human (credentials, accounts, money, a product decision, anything the
   repository marks as needing the user), do not guess, invent values or stub around it. Stop and
   report status `blocked` with one precise question.
6. If there is no task left to do, report `all_done`.

End with the structured result: `status`, `item` (the task's ID and title), `summary`, and
`pr_number` (when `pr_opened`) or `question` (when `blocked`).
