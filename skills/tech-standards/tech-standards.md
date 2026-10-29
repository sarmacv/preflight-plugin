---
id: tech-standards
name: Engineering standards
category: tech-standards
severity: medium
evaluation: ai
fixable: false
context_files:
  - README.md
  - CONTRIBUTING.md
  - SECURITY.md
  - Dockerfile
  - '**/Dockerfile'
  - docker-compose.yml
  - package.json
  - pyproject.toml
  - pom.xml
  - build.gradle
  - go.mod
  - .github/workflows/*.yml
  - .github/dependabot.yml
  - .env.example
  - config/*.yml
  - config/*.yaml
---

<!-- This is a starter skill. Edit the rubric below to encode your organisation's own standards. -->

## What this checks
The repository follows our baseline engineering standards, drawn from the OpenSSF Scorecard, the OWASP secure-development guidance and the Twelve-Factor App.

## How to evaluate
Read the provided files and score each item as met, not met, or not applicable. Cite the file that supports each judgment.

**Supply chain and process (OpenSSF Scorecard)**
1. CI workflows declare least-privilege `permissions:` instead of relying on defaults.
2. Workflows don't use `pull_request_target` with a checkout of untrusted code.
3. A `SECURITY.md` explains how to report vulnerabilities.
4. Dependency updates are automated (Dependabot or Renovate configuration present).

**Secure development (OWASP)**
5. No credentials, tokens or private keys appear in the provided files.
6. Containers run as a non-root user (`USER` set in Dockerfiles).
7. Input validation or a validation library is evident for externally facing services.

**Twelve-Factor**
8. Configuration comes from the environment, not hard-coded per-environment values (an `.env.example` or documented variables is a good sign).
9. Dependencies are declared explicitly in a manifest.
10. Logs go to stdout and stderr, not to local files.
11. Build, release and run stages are separate (CI builds an artifact that is deployed unchanged).

## Pass criteria
No "not met" on items 1, 2, 5 or 6, and at least 70% of the applicable items are met.

## Fail criteria
Any of items 1, 2, 5 or 6 is not met, or fewer than 70% of the applicable items are met. List each unmet item with its file.

## How to fix
Not fixed automatically: these items need judgment. Address each unmet item listed in the evidence, starting with items 1, 2, 5 and 6.
