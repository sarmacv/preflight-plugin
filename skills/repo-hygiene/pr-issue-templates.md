---
id: pr-issue-templates
name: PR and issue templates present
category: repo-hygiene
severity: low
evaluation: deterministic
fixable: true
fix_pr: fixes
rules:
  - all_of:
      - glob_present:
          - pull_request_template.md
          - .github/pull_request_template.md
          - docs/pull_request_template.md
          - .github/PULL_REQUEST_TEMPLATE/*.md
          - PULL_REQUEST_TEMPLATE/*.md
      - glob_present:
          - issue_template.md
          - .github/issue_template.md
          - .github/ISSUE_TEMPLATE/*.md
          - .github/ISSUE_TEMPLATE/*.yml
          - .github/ISSUE_TEMPLATE/*.yaml
fix:
  kind: builtin
  name: pr_issue_templates
---

## What this checks
Pull requests and issues start from templates, so reviewers get context and bug reports include reproduction steps.

## How to evaluate
List the tree (case-insensitive) for a pull request template (`pull_request_template.md` in the root, `.github/` or `docs/`, or any Markdown file in a `PULL_REQUEST_TEMPLATE/` folder) and an issue template (`issue_template.md`, or Markdown or YAML forms in `.github/ISSUE_TEMPLATE/`).

## Pass criteria
Both a pull request template and at least one issue template exist.

## Fail criteria
Either is missing. The evidence names which one.

## How to fix
Add whichever is missing:
- `.github/pull_request_template.md` with sections for Summary, Changes, How tested, and a checklist (tests added, docs updated, no secrets).
- `.github/ISSUE_TEMPLATE/bug_report.yml` and `.github/ISSUE_TEMPLATE/feature_request.yml` as GitHub issue forms.
