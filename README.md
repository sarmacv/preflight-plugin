<picture>
  <source media="(prefers-color-scheme: dark)" srcset="media/wordmark-dark.png">
  <img alt="Preflight: Check. Fix. Ship." src="media/wordmark-light.png" width="400">
</picture>

Preflight is an internal VS Code extension that scans GitHub repositories against our engineering standards, shows a pass/fail result with severity for every check, and opens pull requests that fix the failures. It works entirely through the GitHub API: nothing is cloned.

- [Install](#install)
- [Set up](#set-up)
- [Use it](#use-it)
- [How pull requests are created](#how-pull-requests-are-created)
- [Configure branch naming](#configure-branch-naming)
- [Add a new check](#add-a-new-check)
- [Settings reference](#settings-reference)
- [Troubleshooting](#troubleshooting)
- [Develop](#develop)

## Install

Preflight is distributed as a private VSIX.

1. Get `preflight-<version>.vsix` (build it with `npm run package`, see [Develop](#develop)).
2. In VS Code, open the Extensions view, choose **…** › **Install from VSIX…**, and pick the file. Or from a terminal:

   ```bash
   code --install-extension preflight-0.1.0.vsix
   ```

3. Reload VS Code if prompted. A check-mark icon appears in the activity bar.

Requirements: VS Code 1.100 or later. AI checks and fixes need GitHub Copilot (Chat) signed in.

## Set up

### GitHub sign-in (required)

Click the Preflight icon. The panel stays locked until you sign in with **Sign in to GitHub**, which uses VS Code's built-in GitHub account. Preflight never stores a token itself. It requests the `repo`, `read:org` and `workflow` scopes.

After sign-in, Preflight confirms the connection with the API and shows your avatar with a status dot in the top bar. If an organisation uses SAML single sign-on and your session isn't authorised for it, the dot turns amber and that organisation shows **Authorize** in the avatar menu. Authorise, then press **Refresh**.

If your organisation restricts OAuth apps, an org owner must approve the "Visual Studio Code" GitHub OAuth app once.

### AI

Pick Copilot, Claude or Codex in the top bar before scanning; the choice stays fixed for the whole scan.

| Choice | What runs |
| --- | --- |
| Copilot | Copilot's default AI |
| Claude | Claude, served through Copilot |
| Codex | Codex, served through Copilot |

All three go through GitHub Copilot in VS Code, so no extra keys are needed. Only the options your Copilot plan and organisation policy allow are selectable, and Preflight picks a suitable model within that family automatically. VS Code asks for consent the first time Preflight uses AI. Deterministic checks never use AI.

### SonarQube (optional)

Needed for the **Test coverage** check and the coverage PR.

1. Set **Preflight › Sonar: Url** (`preflight.sonar.url`) to your server, for example `https://sonar.example.com`.
2. Run **Preflight: Set Sonar Token** from the Command Palette and paste a SonarQube user token. It is stored in VS Code's secret storage. **Preflight: Clear Sonar Token** removes it.

Preflight finds each repository's Sonar project from `sonar.projectKey` in `sonar-project.properties`, then a project whose key is the repository name. If neither exists, it asks you to pick one and remembers your choice.

## Use it

1. **Select repositories.** Search, filter by organisation, and tick repositories (Space toggles, Ctrl/Cmd+A selects all shown). Each selected repository scans its default branch. Once two or more are selected, click a branch chip to scan a different branch.
2. **Scan** (▶ or Enter). Repositories are scanned one at a time. Stop (■ or Esc) keeps everything already finished.
3. **Read results.** Each repository gets a score out of 100 and is **Passing** (no critical or high severity failures) or **Failing**. Critical failures are pinned to the top. A check whose prerequisite failed is skipped ("Needs … to pass first") so the same problem isn't reported twice. Categories with failures open automatically. Click a check to see its evidence. Hover a category or check to re-run just that part.
4. **Filter** (funnel icon) to show failures only, or to choose which categories and checks the next scan runs.
5. **Fix.** Click **Fix** on a repository card to fix that repository, or the wand in the top bar to fix every scanned repository. A wand next to a failed check means Preflight can fix it. You get a preview first; nothing is written until you confirm.

The bottom strip shows queue progress and the GitHub API rate limit (hover for numbers). When GitHub throttles requests, Preflight waits and retries automatically.

## How pull requests are created

At most two pull requests are opened per repository:

| PR | Contains | State |
| --- | --- | --- |
| Fixes | Deterministic and low-risk fixes: CODEOWNERS, agent instructions, templates, SBOM, Sonar config, pinned actions and similar | Ready for review |
| Coverage | AI-written tests for the lowest-coverage files reported by Sonar (`preflight.coverage.maxFiles` per run) | Draft |

If a repository has no coverage failure, only the Fixes PR is opened.

In the preview you can:

- untick a PR or an individual file;
- open the diff of any file, or edit its content directly (the proposed CODEOWNERS opens in edit mode so you can confirm the owners);
- edit the branch name, which is validated as you type.

**Create PRs** opens a confirmation dialog that lists every branch and PR. After you confirm, for each PR Preflight:

1. creates a **new branch** from the head of the scanned branch (it never commits to an existing branch, and appends `-2`, `-3`, … if the name is taken);
2. adds one commit through GitHub's `createCommitOnBranch` API, so the commit is signed by GitHub;
3. opens the PR **against the scanned branch**;
4. applies the `preflight` label, creating it (orange `#F58025`, "Opened by Preflight") if needed. If labels can't be managed, the PR is still opened and you are told the label is missing.

PR bodies list every check addressed with its ID and severity, what the reviewer should verify, and a "Generated by Preflight" footer. Coverage PRs state that the tests were not run, because nothing is cloned, so CI must validate them. If draft PRs aren't available for the repository, the coverage PR is opened as a regular PR titled `[Draft] …`.

## Configure branch naming

`preflight.branch.template` sets the name of every branch Preflight creates. The default is `preflight/{type}/{date}-{shortid}`.

| Placeholder | Value |
| --- | --- |
| `{user}` | Your GitHub login |
| `{repo}` | Repository name |
| `{check-or-category}` | The check ID if the PR fixes one check, the category if all its checks share one, otherwise `multi` |
| `{date}` | `YYYYMMDD` |
| `{shortid}` | 6 random hex characters |
| `{type}` | `fixes` or `coverage` |

To enforce your organisation's convention, set `preflight.branch.pattern` to a regular expression. Generated and edited names must match it before a PR can be created. For example:

```json
{
  "preflight.branch.template": "chore/{user}/preflight-{type}-{shortid}",
  "preflight.branch.pattern": "^(feature|chore|fix)/[a-z0-9._/-]+$"
}
```

Names are also checked against git's rules (no spaces, `..`, `~`, `^`, `:`, and so on).

## Add a new check

Every check is one Markdown file in `skills/<category>/<check-id>.md`. Adding a check needs no engine change: add the file and rebuild the VSIX. A new folder creates a new category.

```markdown
---
id: security-md-present          # kebab-case, unique
name: SECURITY.md present        # shown in the UI
category: repo-hygiene           # must match the folder name
category_name: Repo Hygiene      # optional display name (defaults to the title-cased folder)
severity: medium                 # critical | high | medium | low
evaluation: deterministic        # deterministic | ai | hybrid
fixable: true
fix_pr: fixes                    # fixes | coverage
applies_to:                      # optional: skip unless a matching file exists
  any_file: ['**/*.py']
depends_on: [readme-contributing] # optional: skip if any of these checks fails
rules:                           # required for deterministic and hybrid
  - any_file_exists: [SECURITY.md, .github/SECURITY.md]
fix:                             # required when fixable
  kind: ai                       # builtin | template | ai
  path: SECURITY.md
context_files: [README.md]       # files sent to the model (secrets are never sent)
---

## What this checks
## How to evaluate
## Pass criteria
## Fail criteria
## How to fix
```

All five body sections are required. The whole file is the prompt for AI evaluation and AI fixes, so write the rubric and fix instructions as you would brief a reviewer.

**Evaluation modes**

- `deterministic`: the `rules` decide. Fast, free and repeatable.
- `ai`: the selected model judges using the body sections and `context_files`.
- `hybrid`: the rules run first. If they fail, that is the result. If they pass, the model judges quality.

**Rules.** All top-level rules must pass.

| Rule | Passes when |
| --- | --- |
| `file_exists: path` | The file exists (case-insensitive) |
| `any_file_exists: [paths]` | Any of the files exists |
| `glob_present: glob \| [globs]` | Any file matches |
| `glob_absent: glob \| [globs]` | No file matches |
| `file_min_content: {paths, min_chars, min_lines, min_headings, reject: [regex]}` | The first existing file meets every threshold and contains no rejected text |
| `file_contains: {paths?, globs?, pattern, flags?, description?}` | Any listed file matches the regex |
| `workflow_contains: pattern \| {pattern, description}` | Any CI configuration (GitHub Actions, Jenkins, GitLab, Azure, CircleCI, Bitbucket) matches |
| `api_field: {endpoint: 'GET /repos/{owner}/{repo}…', field, equals? \| exists? \| gte?}` | A field of a read-only GitHub API response matches |
| `all_of: [rules]`, `any_of: [rules]`, `not: rule` | Combinators |
| `builtin: {name, params}` | A named evaluator passes (see below) |

**Built-in evaluators:** `stale_branches {days?, max_stale}`, `branch_protected {branch: default \| scanned}`, `branch_rules {min_reviews, require_status_checks}`, `vulnerable_dependencies {fail_on: [CRITICAL, HIGH, MODERATE, LOW]}`, `dependency_pinning {actions_sha, docker_digest}`, `license_compliance`, `sonar_coverage`.

**Fix kinds**

- `template`: writes `template` to `path`. Supported placeholders are `{repo}`, `{owner}`, `{branch}`, `{defaultBranch}`, `{year}` and `{sonarUrl}`.
- `builtin`: one of `codeowners_from_history`, `pr_issue_templates`, `gitignore_license`, `generate_sbom`, `pin_actions`.
- `ai`: the model writes the files, following "How to fix". Its output is shown in the preview before anything is committed.

A skill with a mistake (bad YAML, unknown rule, missing section) is skipped and reported in the **Preflight** output channel; the other checks still run.

### Edit the Tech Standards check

`skills/tech-standards/tech-standards.md` is a starter rubric based on the OpenSSF Scorecard, OWASP and the Twelve-Factor App. Edit its "How to evaluate", pass and fail sections to encode your own standards, then rebuild.

## Settings reference

| Setting | Default | Purpose |
| --- | --- | --- |
| `preflight.model.default` | `copilot` | Model preselected in the top bar |
| `preflight.sonar.url` | | SonarQube base URL (token via **Preflight: Set Sonar Token**) |
| `preflight.coverage.threshold` | `80` | Minimum coverage percentage |
| `preflight.coverage.maxFiles` | `5` | Files per coverage PR |
| `preflight.branch.template` | `preflight/{type}/{date}-{shortid}` | Branch naming template |
| `preflight.branch.pattern` | | Regex every branch name must match |
| `preflight.staleBranchDays` | `90` | Age at which a branch counts as stale |
| `preflight.license.allow` | `[]` | SPDX licences dependencies may use (empty means no allow list) |
| `preflight.license.deny` | AGPL, SSPL | SPDX licences that fail licence compliance |

The gear icon in the top bar opens these settings.

## Troubleshooting

- **Claude or Codex is greyed out.** Your Copilot plan or organisation policy doesn't offer it.
- **"AI review isn't available right now."** None of the models in the chosen family accepted the request. The **Preflight** output channel shows which were tried. **Preflight: Probe Models** tests each one.
- **"Required reviews and status checks" shows an error.** Reading classic branch protection needs admin access, and rulesets aren't available on some private-repository plans.
- **Vulnerable dependencies or licence compliance is skipped.** No lockfile with exact versions was found, or the dependency graph isn't enabled. Licence data comes only from the dependency graph, which covers the default branch only.
- **Test coverage is skipped.** `preflight.sonar.url` isn't set, or no token was provided.
- **Commit failed: "Repository rule violations".** A ruleset blocks the branch name or the commit. Adjust `preflight.branch.template` and `preflight.branch.pattern` to match it.
- **Logs.** View › Output › **Preflight**. Secrets are never logged.

## Develop

```bash
npm install
```

```bash
npm run build
```

```bash
npm test
```

```bash
npm run package
```

- Press F5 in VS Code to launch an Extension Development Host with Preflight loaded.
- `npm run watch` rebuilds on change.
- `npm run icons` regenerates the logo set in `media/` from `scripts/render-icon.mjs`.
- To work on the UI without VS Code, run `node scripts/harness/serve.mjs` and open `http://localhost:5178/scripts/harness/`. It renders the webview with mock data; add `?theme=light` or `?auth=out` for other states.

Layout:

```
src/extension.ts      activation, commands
src/auth              GitHub sign-in through VS Code
src/github            Octokit client (throttling, retries), repo listing, repo context
src/skills            skill parser, loader, rule DSL, built-in evaluators
src/engine            check runner, scan queue, scoring
src/ai                Copilot model provider, prompts
src/fix               fix planner, built-in fixes, branch naming, PR writer
src/sonar             SonarQube client and project resolution
src/panel             webview panel host and fix flow
src/webview           Preact UI
skills/               the check catalogue
test/                 Vitest suites (GitHub and Sonar are mocked)
```
