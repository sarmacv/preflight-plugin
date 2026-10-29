---
id: stale-branches
name: Stale branches
category: repo-hygiene
severity: low
evaluation: deterministic
fixable: false
rules:
  - builtin:
      name: stale_branches
      params:
        max_stale: 5
---

## What this checks
The repository doesn't accumulate abandoned branches. A branch counts as stale when its latest commit is older than `preflight.staleBranchDays` (default 90 days).

## How to evaluate
Page through every branch with the GraphQL API (`repository.refs(refPrefix: "refs/heads/")`), reading each branch head's `committedDate`. Ignore the default branch.

## Pass criteria
At most 5 branches are stale.

## Fail criteria
More than 5 branches are stale. The evidence lists the oldest ones.

## How to fix
Not fixed by a pull request, because deleting branches is destructive. Review the listed branches with their owners and delete the ones that are merged or abandoned. Consider enabling "Automatically delete head branches" in the repository settings.
