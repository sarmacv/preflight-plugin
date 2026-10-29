---
id: required-reviews-status-checks
name: Required reviews and status checks enabled
category: branching-protection
category_name: Branching and Protection
severity: high
evaluation: deterministic
fixable: false
rules:
  - builtin:
      name: branch_rules
      params:
        min_reviews: 1
        require_status_checks: true
depends_on: [default-branch-protected]
---

## What this checks
Changes to the default branch need at least one approving review and passing status checks.

## How to evaluate
Read the rules that apply to the default branch from `GET /repos/{owner}/{repo}/rules/branches/{branch}` (readable with read access): `pull_request.required_approving_review_count` and `required_status_checks`. Merge in classic protection from `GET /repos/{owner}/{repo}/branches/{branch}/protection` when the token has admin access.

## Pass criteria
At least 1 approving review is required and at least one status check is required.

## Fail criteria
Fewer than 1 review is required, or no status checks are required. If neither source can be read, the check reports an error rather than a failure.

## How to fix
Not fixed by a pull request: these are repository settings. In the default branch ruleset, enable "Require a pull request before merging" with at least 1 approval, and "Require status checks to pass" with the CI jobs that build and test the code.
