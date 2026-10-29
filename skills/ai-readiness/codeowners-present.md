---
id: codeowners-present
name: CODEOWNERS present
category: ai-readiness
category_name: AI Readiness
severity: high
evaluation: deterministic
fixable: true
fix_pr: fixes
rules:
  - any_file_exists: [CODEOWNERS, .github/CODEOWNERS, docs/CODEOWNERS]
fix:
  kind: builtin
  name: codeowners_from_history
---

## What this checks
The repository has a `CODEOWNERS` file so every change has an accountable reviewer. AI agents and humans alike rely on it to know who must approve changes to which paths.

## How to evaluate
List the repository tree for the scanned branch and look for a file named `CODEOWNERS` (case-insensitive) in any of the locations GitHub honours: the repository root, `.github/`, or `docs/`.

## Pass criteria
A `CODEOWNERS` file exists in one of the three supported locations.

## Fail criteria
No `CODEOWNERS` file exists in any supported location.

## How to fix
Add `.github/CODEOWNERS`. Propose owners from the people and teams with the most commits in the last 180 days, mapped to their GitHub logins, and only include users with write access. The user must confirm or edit the owners before the pull request is built. Start with a catch-all `*` rule and add path rules where ownership clearly differs (for example `/infra/` or `/docs/`).
