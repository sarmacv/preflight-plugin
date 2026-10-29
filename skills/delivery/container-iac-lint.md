---
id: container-iac-lint
name: Container and IaC lint
category: delivery
severity: medium
evaluation: deterministic
fixable: true
fix_pr: fixes
applies_to:
  any_file: ['**/Dockerfile', '**/*.Dockerfile', '**/*.tf', '**/Chart.yaml']
rules:
  - workflow_contains:
      pattern: 'hadolint|tflint|checkov|tfsec|trivy\s+(config|fs)|kube-linter|kubeconform|helm\s+lint|terraform\s+validate|kics|conftest'
      description: container or IaC linting
fix:
  kind: ai
context_files:
  - .github/workflows/*.yml
  - .github/workflows/*.yaml
depends_on: [ci-pipeline-exists]
---

## What this checks
When the repository contains Dockerfiles, Terraform or Helm charts, CI lints them so misconfigurations are caught before deployment.

## How to evaluate
Applies only if the tree has a Dockerfile, `*.tf` files or a `Chart.yaml`. Search CI configurations for a linter: Hadolint, TFLint, Checkov, tfsec, `trivy config`, kube-linter, kubeconform, `helm lint`, `terraform validate`, KICS or Conftest.

## Pass criteria
At least one relevant linter runs in CI.

## Fail criteria
No container or IaC linter runs in CI.

## How to fix
Add lint steps to the existing CI workflow for each technology present: `hadolint/hadolint-action` for Dockerfiles, `terraform fmt -check`, `terraform validate` and TFLint for Terraform, and `helm lint` for charts. Run them on pull requests and pin each action to a commit SHA.
