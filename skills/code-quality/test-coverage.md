---
id: test-coverage
name: Test coverage meets threshold
category: code-quality
severity: high
evaluation: deterministic
fixable: true
fix_pr: coverage
rules:
  - builtin:
      name: sonar_coverage
fix:
  kind: ai
depends_on: [sonar-onboarded]
---

## What this checks
Overall line coverage reported by SonarQube for the scanned branch meets the configured threshold (`preflight.coverage.threshold`, default 80%).

## How to evaluate
Find the repository's Sonar project: the `sonar.projectKey` in `sonar-project.properties`, otherwise a project whose key equals the repository name, otherwise the project the user picks. Then call `GET /api/measures/component?component=<key>&branch=<branch>&metricKeys=coverage` on the configured SonarQube server.

## Pass criteria
Coverage is at or above the threshold.

## Fail criteria
Coverage is below the threshold, or the project has no coverage measure.

## How to fix
Open a draft Coverage PR with tests only. Fetch the lowest-coverage files with `GET /api/measures/component_tree?component=<key>&qualifiers=FIL&metricKeys=coverage,uncovered_lines&s=metric&metricSort=coverage&asc=true` and take at most `preflight.coverage.maxFiles` of them. For each file, read the source and the existing tests next to it, and write tests in the same framework, style and location. Don't change production code. Preflight can't run the tests, so the PR description must say they are unverified and that CI is the judge.
