---
id: dependency-pinning
name: Dependency pinning
category: dependencies-sbom
category_name: Dependencies and SBOM
severity: medium
evaluation: deterministic
fixable: true
fix_pr: fixes
rules:
  - builtin:
      name: dependency_pinning
      params:
        actions_sha: true
        docker_digest: false
fix:
  kind: builtin
  name: pin_actions
---

## What this checks
Builds are reproducible and resistant to supply-chain tampering: every package manifest has a lockfile, GitHub Actions are pinned to full commit SHAs, and container base images don't use floating tags. This follows the OpenSSF Scorecard "Pinned-Dependencies" check.

## How to evaluate
- For each `package.json`, `pyproject.toml`, `Pipfile`, `Cargo.toml`, `go.mod`, `Gemfile` and `composer.json`, look for the matching lockfile in the same folder.
- In `.github/workflows/*.yml` and local `action.yml` files, every `uses:` reference (other than local `./` actions and `docker://` images) must end in a 40-character commit SHA.
- In Dockerfiles, every `FROM` image must have an explicit tag other than `latest`, or a digest.

## Pass criteria
No problems are found.

## Fail criteria
Any manifest lacks a lockfile, any action is referenced by tag or branch, or any base image uses `latest` or no tag. The evidence lists each one.

## How to fix
Pin each GitHub Action to the commit SHA its current tag points to, keeping the tag as a trailing comment (for example `uses: actions/checkout@<sha> # v4.2.2`). Look the SHAs up with `GET /repos/{owner}/{repo}/git/ref/tags/{tag}`. Missing lockfiles and Docker tags need a local build, so list them in the PR description for a maintainer.
