---
id: ci-pipeline-exists
name: CI pipeline exists
category: delivery
severity: high
evaluation: deterministic
fixable: true
fix_pr: fixes
rules:
  - glob_present:
      - .github/workflows/*.yml
      - .github/workflows/*.yaml
      - Jenkinsfile
      - .gitlab-ci.yml
      - azure-pipelines.yml
      - .circleci/config.yml
      - bitbucket-pipelines.yml
fix:
  kind: ai
  path: .github/workflows/ci.yml
context_files:
  - package.json
  - pyproject.toml
  - requirements.txt
  - pom.xml
  - build.gradle
  - go.mod
  - Cargo.toml
  - Makefile
  - README.md
---

## What this checks
Every change is built and tested automatically by a CI pipeline.

## How to evaluate
List the tree for GitHub Actions workflows (`.github/workflows/*.yml`), a `Jenkinsfile`, `.gitlab-ci.yml`, `azure-pipelines.yml`, `.circleci/config.yml` or `bitbucket-pipelines.yml`.

## Pass criteria
At least one CI configuration exists.

## Fail criteria
No CI configuration exists.

## How to fix
Add `.github/workflows/ci.yml` that runs on pull requests and on pushes to the default branch. Detect the stack from the build files and use the matching setup action (Node, Python, Java, Go, Rust), dependency caching, then the repository's own install, lint, build and test commands. Set `permissions: contents: read` and pin every action to a commit SHA.
