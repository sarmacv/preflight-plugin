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
The repository's test coverage meets the configured threshold (`preflight.coverage.threshold`, default 80%). With SonarQube connected this is measured line coverage; without it, Preflight estimates coverage from the code. Runs only when "Sonar coverage required" says the repository needs coverage, and in the same scan as "Sonar onboarded", so one scan gives the full picture.

## How to evaluate
**Measured (SonarQube connected):** find the repository's Sonar project on the configured server: the `sonar.projectKey` in `sonar-project.properties`, otherwise a project whose key equals the repository name, otherwise the project the user picks. Then call `GET /api/measures/component?component=<key>&branch=<branch>&metricKeys=coverage`.

**Estimated (SonarQube not connected, or no Sonar project yet):** list the application source files (as defined by "Sonar coverage required") and the test files. A source file counts as tested when a test file is named after it: `user.service.spec.ts` covers `user.service.ts`, `test_parser.py` covers `parser.py`, `FooTest.java` covers `Foo.java`, `store_test.go` covers `store.go`. Generic names such as `index` or `main` are matched together with their folder. The estimate is the percentage of source files that are tested. It measures which files have tests, not which lines run, and the result says so.

## Pass criteria
Measured or estimated coverage is at or above the threshold.

## Fail criteria
Measured or estimated coverage is below the threshold, or the Sonar project has no coverage measure. The evidence lists the source files without tests.

## How to fix
Open a draft Coverage PR with tests only. When Sonar has coverage data, fetch the lowest-coverage files with `GET /api/measures/component_tree?component=<key>&qualifiers=FIL&metricKeys=coverage,uncovered_lines&s=metric&metricSort=coverage&asc=true`. When it doesn't, write tests for just enough untested source files to bring the estimate up to the threshold (for example 7 more files when 22 of 36 are tested and the target is 80%), largest files first. There is no limit unless `preflight.coverage.maxFiles` is set. For each, read the source and the existing tests nearby, and write tests in the same framework, style and location, naming the test file after the source file (`foo.test.ts`, `test_foo.py`, `FooTest.java`, `foo_test.go`) so the next scan counts it. Re-run the estimate with the new tests and state the before and after percentages in the PR. Don't change production code. Preflight can't run the tests, so the PR description must say they are unverified and that CI is the judge.
