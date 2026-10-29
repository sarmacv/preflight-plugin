---
id: license-compliance
name: License compliance
category: dependencies-sbom
category_name: Dependencies and SBOM
severity: high
evaluation: deterministic
fixable: false
rules:
  - builtin:
      name: license_compliance
---

## What this checks
No dependency uses a licence our policy forbids. The deny list (`preflight.license.deny`) defaults to AGPL and SSPL; an optional allow list (`preflight.license.allow`) restricts dependencies to approved licences.

## How to evaluate
Read each package's `licenseConcluded` or `licenseDeclared` from the GitHub dependency graph SBOM (default branch only). Evaluate SPDX expressions: `A OR B` is acceptable if either side is; `A AND B` only if both are.

## Pass criteria
Every dependency with licence data is acceptable.

## Fail criteria
At least one dependency's licence is on the deny list, or isn't on a non-empty allow list. If no licence data is available, the check is skipped.

## How to fix
Not fixed by Preflight: replacing a dependency is a design decision. Replace the listed packages with alternatives under an approved licence, or record a legal exception.
