---
id: copilot-instructions-present
name: Copilot instructions present
category: ai-readiness
category_name: AI Readiness
severity: low
evaluation: deterministic
fixable: true
fix_pr: fixes
rules:
  - file_exists: .github/copilot-instructions.md
fix:
  kind: ai
  path: .github/copilot-instructions.md
context_files:
  - AGENTS.md
  - CLAUDE.md
  - README.md
  - package.json
  - pyproject.toml
  - pom.xml
  - go.mod
---

## What this checks
The repository has `.github/copilot-instructions.md`, which GitHub Copilot reads automatically for repository-specific guidance in chat, code review and the coding agent.

## How to evaluate
Check whether `.github/copilot-instructions.md` exists on the scanned branch (case-insensitive).

## Pass criteria
The file exists.

## Fail criteria
The file doesn't exist.

## How to fix
Create `.github/copilot-instructions.md`. If `AGENTS.md` or `CLAUDE.md` exists, summarise it and link to it rather than duplicating it. Otherwise describe the project, its build and test commands, and its coding conventions, using only facts from the repository. Keep it under about 100 lines.
