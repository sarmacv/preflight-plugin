---
id: ci-runs-tests-and-sonar
name: CI runs tests and Sonar
category: delivery
severity: high
evaluation: deterministic
fixable: true
fix_pr: fixes
rules:
  - all_of:
      - workflow_contains:
          pattern: '\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bpytest\b|\btox\b|\bmvn\b.*\b(test|verify)\b|\bgradlew?\b.*\b(test|check|build)\b|\bgo test\b|\bcargo test\b|\bdotnet test\b|\bjest\b|\bvitest\b|\bmake test\b|\brspec\b'
          description: tests
      - workflow_contains:
          pattern: 'sonar(qube|cloud|-scanner|source|scanner)|SONAR_TOKEN|sonar:sonar|org\.sonarqube'
          description: a Sonar scan
fix:
  kind: ai
context_files:
  - .github/workflows/*.yml
  - .github/workflows/*.yaml
  - package.json
  - pom.xml
  - build.gradle
  - pyproject.toml
  - sonar-project.properties
depends_on: [ci-pipeline-exists]
---

## What this checks
The CI pipeline runs the test suite and a Sonar analysis, so quality gates and coverage are enforced on every change.

## How to evaluate
Search every CI configuration for a test command (`npm test`, `pytest`, `mvn verify`, `gradle test`, `go test`, `cargo test`, `dotnet test`, `jest`, `vitest`, `make test` and similar) and for a Sonar scan (scanner action, `sonar:sonar`, the Gradle Sonar plugin, or `SONAR_TOKEN`).

## Pass criteria
Both a test command and a Sonar scan are present in CI.

## Fail criteria
Either is missing. The evidence names which one.

## How to fix
Edit the existing main CI workflow; don't create a parallel one. Add the repository's test command with coverage output (for example `npm test -- --coverage`, `pytest --cov --cov-report=xml`, `mvn verify` with JaCoCo), then add a SonarQube scan step after the tests using `SONAR_TOKEN` and `SONAR_HOST_URL` secrets, with the coverage report path configured. Pin every action to a commit SHA.
