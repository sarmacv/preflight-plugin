---
id: agent-instructions-quality
name: Agent instructions have real content
category: ai-readiness
category_name: AI Readiness
severity: medium
evaluation: hybrid
fixable: true
fix_pr: fixes
rules:
  - file_min_content:
      paths: [AGENTS.md, CLAUDE.md, .github/AGENTS.md, .claude/CLAUDE.md]
      min_chars: 400
      min_lines: 10
      min_headings: 2
      reject: ['lorem ipsum', '^\s*TODO\s*$', 'coming soon', '^\s*TBD\s*$']
fix:
  kind: ai
  path: AGENTS.md
context_files:
  - AGENTS.md
  - CLAUDE.md
  - .github/AGENTS.md
  - .claude/CLAUDE.md
  - README.md
  - package.json
  - pyproject.toml
  - pom.xml
  - build.gradle
  - go.mod
  - Makefile
  - .github/workflows/*.yml
depends_on: [agent-instructions-present]
---

## What this checks
The agent instructions file is genuinely useful to a coding agent, not a stub or a copy of the README.

## How to evaluate
First, the deterministic gate: the first existing file among `AGENTS.md`, `CLAUDE.md`, `.github/AGENTS.md` and `.claude/CLAUDE.md` must have at least 400 characters, 10 non-empty lines and 2 headings, and must not contain placeholder text.

Then judge the content against this rubric, using the build files and CI workflows as ground truth:
1. **Commands:** gives exact build, test and lint commands, and they match what the build files and CI actually run.
2. **Layout:** explains where the main code, tests and configuration live.
3. **Conventions:** states language versions, style or formatting rules, and testing expectations.
4. **Guardrails:** tells agents what not to do (for example secrets, generated files, protected paths).
5. **Accuracy:** nothing in the file contradicts the repository.

## Pass criteria
The deterministic gate passes, and the file satisfies at least 4 of the 5 rubric items with no accuracy problems.

## Fail criteria
The gate fails, or fewer than 4 rubric items are satisfied, or the file states commands or paths that don't exist in the repository. Name each missing or wrong item in the evidence.

## How to fix
Rewrite the agent instructions file in place, keeping every accurate statement the team already wrote. Fill each missing rubric item using only facts from the repository. Correct any command or path that doesn't match the build files or CI. Mark anything you can't confirm with `TODO:`.
