{{step_prompt}}

---

## Parallel lanes

nightshift is working on several items at the same time, each in its own Claude session and its own
git worktree of the repository. This item ({{item_label}}) has the worktree `{{work_path}}`, which
nightshift created from the latest `{{base_branch}}` (detached HEAD). This overrides anything above
or in the repository's instructions about where to work:

- Work only in `{{work_path}}`: create this item's branch there (`git switch -c <branch>`). Do not
  create other worktrees, and do not check out branches or edit files in the main checkout
  (`{{repo_path}}`) or in other worktrees: other sessions are using them right now.
- Do not remove this worktree or its branch; nightshift removes both once the item is done.
