---
id: branching-strategy-documented
name: Branching strategy documented
category: branching-protection
category_name: Branching and Protection
severity: medium
evaluation: deterministic
fixable: true
fix_pr: fixes
rules:
  - file_contains:
      paths: [CONTRIBUTING.md, .github/CONTRIBUTING.md, docs/CONTRIBUTING.md, README.md, docs/BRANCHING.md, BRANCHING.md, docs/branching-strategy.md]
      globs: ['docs/**/branch*.md']
      pattern: 'branching (strategy|model)|git ?flow|trunk[- ]based|release branch|feature branch|branch naming'
      description: a branching strategy
fix:
  kind: ai
  path: docs/BRANCHING.md
context_files:
  - CONTRIBUTING.md
  - README.md
  - .github/workflows/*.yml
---

## What this checks
Contributors can find how branches are used: which branch is the integration branch, how feature and release branches are named, and how changes are merged.

## How to evaluate
Search `CONTRIBUTING.md` (root, `.github/` or `docs/`), `README.md`, and any `BRANCHING.md` or `docs/**/branch*.md` file for a description of the branching model, such as "branching strategy", "GitFlow", "trunk-based", "release branch", "feature branch" or "branch naming".

## Pass criteria
At least one of those documents describes the branching model.

## Fail criteria
No document describes it.

## How to fix
Add `docs/BRANCHING.md` describing the model the repository already follows. Infer it from the default branch name, the existing branch names, and the branches CI workflows trigger on. Cover the integration branch, branch naming, how to merge (squash or merge commits), and release and hotfix branches if they are used. Link to it from `CONTRIBUTING.md` if that file exists.
