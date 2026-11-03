---
id: sonar-code-coverage
name: Sonar code coverage
category: code-quality
category_name: Sonar Code Coverage
severity: high
evaluation: deterministic
fixable: true
fix_pr: coverage
depends_on: [sonar-required]
after: [sonar-onboarded]
rules:
  - builtin:
      name: sonar_coverage
fix:
  kind: ai
---

## What this checks
Overall line coverage reported by SonarQube for the scanned branch meets the configured threshold (`preflight.coverage.threshold`, default 80%). Runs only when "Sonar coverage required" says the repository needs coverage, and in the same scan as "Sonar onboarded", so one scan gives the full picture.

## How to evaluate
Find the repository's Sonar project on the configured server: the `sonar.projectKey` in `sonar-project.properties`, otherwise a project whose key equals the repository name, otherwise the project the user picks. Then call `GET /api/measures/component?component=<key>&branch=<branch>&metricKeys=coverage`.

## Pass criteria
Coverage is at or above the threshold.

## Fail criteria
Coverage is below the threshold, the project has no coverage measure, or the repository has no Sonar project yet. Skipped only when no SonarQube server is configured.

## How to fix
Open a draft Coverage PR with tests only. When Sonar has coverage data, fetch the lowest-coverage files with `GET /api/measures/component_tree?component=<key>&qualifiers=FIL&metricKeys=coverage,uncovered_lines&s=metric&metricSort=coverage&asc=true`. When it doesn't (no project or no analysis yet), target the largest source files that have no test file at all. Take at most `preflight.coverage.maxFiles` files. For each, read the source and the existing tests nearby, and write tests in the same framework, style and location. Don't change production code. Preflight can't run the tests, so the PR description must say they are unverified and that CI is the judge.
