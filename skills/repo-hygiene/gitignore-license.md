---
id: gitignore-license
name: .gitignore and LICENSE present
category: repo-hygiene
severity: medium
evaluation: deterministic
fixable: true
fix_pr: fixes
rules:
  - all_of:
      - file_exists: .gitignore
      - any_file_exists: [LICENSE, LICENSE.md, LICENSE.txt, COPYING, LICENCE, LICENCE.md]
fix:
  kind: builtin
  name: gitignore_license
---

## What this checks
The repository ignores build output and local files (`.gitignore`) and states its licence terms (`LICENSE`). Internal repositories still need a licence file that states they are proprietary.

## How to evaluate
Check the repository root for `.gitignore`, and for `LICENSE`, `LICENSE.md`, `LICENSE.txt`, `COPYING` or the `LICENCE` spellings (case-insensitive).

## Pass criteria
Both `.gitignore` and a licence file exist at the root.

## Fail criteria
Either is missing. The evidence names which one.

## How to fix
- **.gitignore:** generate one from the languages detected in the tree (for example Node, Python, Java, Go, Terraform), plus common editor and OS files.
- **LICENSE:** add the organisation's standard proprietary notice ("Copyright (c) <year> <organisation>. All rights reserved. Internal use only.") unless the repository is public, in which case flag it for a human decision instead of choosing an open source licence.
