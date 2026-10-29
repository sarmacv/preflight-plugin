---
id: vulnerable-dependencies
name: Vulnerable dependencies
category: dependencies-sbom
category_name: Dependencies and SBOM
severity: high
evaluation: deterministic
fixable: false
rules:
  - builtin:
      name: vulnerable_dependencies
      params:
        fail_on: [CRITICAL, HIGH]
---

## What this checks
None of the repository's resolved dependency versions match a critical or high advisory in the GitHub Advisory Database. This is a point-in-time check from Preflight and is separate from Dependabot alerts.

## How to evaluate
Build the dependency inventory: GitHub's dependency graph SBOM for the default branch, otherwise lockfiles and manifests fetched from the scanned branch. For each package with an exact version, query the GitHub GraphQL `securityVulnerabilities(ecosystem, package)` connection and test the version against each `vulnerableVersionRange`. Version ranges in manifests without a lockfile can't be resolved and are skipped.

## Pass criteria
No resolved dependency matches a critical or high advisory. Moderate and low matches are listed as evidence.

## Fail criteria
At least one resolved dependency matches a critical or high advisory. The evidence lists the advisory IDs and the first patched versions.

## How to fix
Not fixed by Preflight: upgrades can break builds and need the repository's tests. Upgrade each listed package to its first patched version (or later) and let CI verify it, or let Dependabot open the upgrade PRs.
