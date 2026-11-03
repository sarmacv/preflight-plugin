---
id: sonar-required
name: Sonar coverage required
category: code-quality
severity: low
evaluation: deterministic
fixable: false
rules:
  - builtin:
      name: sonar_required
      params:
        min_source_files: 5
---

## What this checks
Whether this repository needs SonarQube analysis and code coverage at all, judged from its technology. Documentation, configuration and infrastructure-as-code repositories have no application code to cover, so the Sonar checks don't apply to them.

## How to evaluate
Classify every file in the tree, ignoring vendored, generated and build-output folders (`node_modules/`, `vendor/`, `dist/`, `build/`, `target/` and similar):
- **Application source** in a language with meaningful line coverage: TypeScript, JavaScript, Python, Java, Kotlin, Scala, Groovy, Go, C#, VB.NET, F#, Ruby, PHP, Swift, Objective-C, C, C++, Rust and Dart. Test files, type declarations, minified files and tool configuration written in code (`*.config.js`, `.eslintrc.js`, `setup.py`, `conftest.py`) don't count.
- **Everything else:** docs (Markdown, reStructuredText, AsciiDoc), configuration (YAML, JSON, TOML, XML), Terraform and other IaC, Helm charts, Dockerfiles, shell scripts, SQL and static HTML/CSS.

## Pass criteria
Coverage is required when the repository has at least `min_source_files` (default 5) application source files, or when it already has `sonar-project.properties`.

## Fail criteria
This check never fails. When coverage isn't required it is reported as skipped with the reason (for example "Not required: no application code; repo is Docs 40, Config 6 files"), and "Sonar onboarded" and "Sonar code coverage" are skipped for the same reason.

## How to fix
Nothing to fix. To change where the line is drawn, edit `min_source_files` in this skill. Adding `sonar-project.properties` to a repository always makes coverage required.
