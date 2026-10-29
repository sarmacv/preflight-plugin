---
id: agent-instructions-present
name: Agent instructions present
category: ai-readiness
category_name: AI Readiness
severity: medium
evaluation: deterministic
fixable: true
fix_pr: fixes
rules:
  - any_file_exists: [AGENTS.md, CLAUDE.md, .github/AGENTS.md, .claude/CLAUDE.md]
fix:
  kind: ai
  path: AGENTS.md
context_files:
  - README.md
  - CONTRIBUTING.md
  - package.json
  - pyproject.toml
  - pom.xml
  - build.gradle
  - go.mod
  - Makefile
  - .github/workflows/*.yml
---

## What this checks
The repository gives coding agents (Copilot, Claude, Codex and others) instructions in `AGENTS.md` or `CLAUDE.md`, so they build, test and change the code the way the team expects.

## How to evaluate
List the repository tree and look for `AGENTS.md` or `CLAUDE.md` at the root, `.github/AGENTS.md`, or `.claude/CLAUDE.md` (case-insensitive).

## Pass criteria
At least one agent instructions file exists.

## Fail criteria
None of the agent instructions files exist.

## How to fix
Create `AGENTS.md` at the repository root, written from what the repository itself shows (README, build files, CI workflows). Include:
- A one-paragraph overview of what the project does.
- Exact commands to install dependencies, build, lint and run tests, taken from the build files and CI.
- Project layout: the main directories and what lives in each.
- Code conventions visible in the repo (language version, formatter, linter, test framework).
- Rules for agents: run the tests before proposing changes, don't commit secrets, keep changes small.

Do not invent commands or tools that the repository doesn't use. Mark anything uncertain with `TODO:` so a maintainer can confirm it.
