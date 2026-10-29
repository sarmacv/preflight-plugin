---
id: readme-contributing
name: README and CONTRIBUTING present
category: repo-hygiene
severity: medium
evaluation: deterministic
fixable: true
fix_pr: fixes
rules:
  - all_of:
      - any_file_exists: [README.md, README, README.rst, README.txt, .github/README.md, docs/README.md]
      - any_file_exists: [CONTRIBUTING.md, CONTRIBUTING, .github/CONTRIBUTING.md, docs/CONTRIBUTING.md]
fix:
  kind: ai
context_files:
  - README.md
  - package.json
  - pyproject.toml
  - pom.xml
  - go.mod
  - Makefile
  - .github/workflows/*.yml
---

## What this checks
The repository explains what it is (`README`) and how to contribute to it (`CONTRIBUTING`).

## How to evaluate
List the tree and look for a README in the root, `.github/` or `docs/` (Markdown, reStructuredText or plain text), and a CONTRIBUTING file in the root, `.github/` or `docs/`.

## Pass criteria
Both a README and a CONTRIBUTING file exist.

## Fail criteria
Either file is missing. The evidence names which one.

## How to fix
Create only the missing file or files.
- **README.md:** project name, a short description, prerequisites, how to install, build, test and run, and where to get help. Derive commands from the build files and CI.
- **CONTRIBUTING.md:** how to set up a dev environment, the branch and PR workflow, how to run tests and linters, commit message conventions if any are visible, and code review expectations.
Use only facts from the repository and mark anything uncertain with `TODO:`.
