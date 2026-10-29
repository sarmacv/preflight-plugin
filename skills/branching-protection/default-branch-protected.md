---
id: default-branch-protected
name: Default branch protected
category: branching-protection
category_name: Branching and Protection
severity: critical
evaluation: deterministic
fixable: false
rules:
  - builtin:
      name: branch_protected
      params:
        branch: default
---

## What this checks
The default branch is covered by branch protection or a ruleset, so it can't be force-pushed, deleted or changed without review.

## How to evaluate
Call `GET /repos/{owner}/{repo}/branches/{default_branch}` and read the `protected` field. It is true when either classic branch protection or a ruleset applies.

## Pass criteria
`protected` is true.

## Fail criteria
`protected` is false.

## How to fix
Not fixed by a pull request: protection is a repository setting. A repository admin should add a ruleset (Settings → Rules → Rulesets) targeting the default branch that requires pull requests and blocks force pushes and deletion. Prefer an organisation-level ruleset so every repository is covered.
