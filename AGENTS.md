# Agent instructions

Preflight ("Check. Fix. Ship.") is an internal VS Code extension, written in TypeScript. It scans GitHub repositories through the API, without cloning, against Markdown "skill" checks. It scores each repo and opens fix pull requests after a preview and confirmation. It is distributed as a private VSIX. `README.md` describes the product from a user's point of view; this file is for whoever (human or AI) continues the work.

Current version: see `version` in `package.json` (0.1.13 at the time of writing). Repository: `sarmacv/preflight-plugin`, branch `main`.

## How to work on this project (the owner's preferences)

These come from working sessions with the owner. Follow them.

- **Explain before acting.** Before changing code, state in plain words what is wrong, why, and what you will change. Then do it without waiting for approval, unless the change is a genuine judgement call.
- **Build end to end; don't stop between steps.** Make reasonable decisions from the spec and mention them at the end. Don't ask for confirmation between build steps.
- **Finish with the list of changed files.** Every change ends with a table of the files changed and what changed in each.
- **Push when done.** After a change is tested and packaged, push it to `origin/main`, confirm CI passes, and hand over the new VSIX.
- **Never overwrite GitHub work.** The owner merges Dependabot PRs and may push from another machine. Before pushing, compare `origin/main` with the local tree and pull or merge first. Once, a push from a stale tree silently reverted four merged dependency upgrades.
- **The user should never need a second scan to finish a job.** One scan should give the full picture, and one Fix should complete the work: retry, replace and keep going rather than stopping or saying "re-run".
- **Be transparent in the UI.** Long operations show what is happening per task. Never show model names (gpt-…, claude-…) to users: the UI says "AI" or the provider (Copilot / Claude / Codex). Details go to the "Preflight" output channel.
- **Verify the thing the user will see.** Check UI changes in the harness in light and dark themes, with realistic VS Code colours (the harness uses a blue status bar on purpose). Don't claim something is visible without checking contrast.
- **Talk about value meanings.** Settings and special values (for example `0 = no limit`) are explained in `package.json` descriptions and in code comments.
- **Never use the `gh` CLI or a raw token to scan repos.** The product connects to GitHub only through VS Code's sign-in. `gh` is fine for repo administration: pushing, CI, PRs.

## Build, test, run

- Install: `npm ci` (Node 22).
- Type-check: `npm run typecheck` (TypeScript 7).
- Unit tests: `npm test` (Vitest; GitHub, Sonar and the AI model are faked, so there is no network). About 177 tests.
- Build: `npm run build` bundles `src/extension.ts` and the webview into `dist/` with esbuild.
- Package: `npm run package` produces `preflight-<version>.vsix` (minified, without `node_modules`).
- Run in VS Code: press F5 (Extension Development Host).
- UI without VS Code: run `node scripts/harness/serve.mjs`, then open `http://localhost:5178/scripts/harness/`. Add `?theme=light`, `?auth=out`, `?hold=fix` (stop on the "Preparing fixes" screen) or `?hold=pr` (stop on the "Opening pull requests" screen). `scripts/harness/mock.js`, `scan.js` and `fix.js` fake the host messages; update them when the protocol changes.
- Logo: `npm run icons` regenerates `media/` from `scripts/render-icon.mjs` (the "Inspection seal" design: navy `#13233A`, orange `#F58025`).

## Releasing a change

1. `npm run typecheck && npm test`.
2. Bump `version` in `package.json` (patch). Also update `data-version` in `scripts/harness/index.html` so the harness matches.
3. `npm run package`, and delete the previous `.vsix`.
4. Compare with `origin/main`, then commit and push. CI (`.github/workflows/ci.yml`) runs typecheck, tests, packaging and an SBOM, with SHA-pinned actions.
5. Tell the user to install the VSIX and run **Developer: Reload Window**. Without a reload, VS Code keeps older versions' contributions registered; that once caused three "Open Preflight" buttons. The version shows bottom-right in the Preflight tab.

The owner's home Mac has git blocked by an unaccepted Xcode licence. There, pushes go through the GitHub Git Data API with `gh api`: create blobs for changed files, build a tree on top of main's tree, create a commit, then update `refs/heads/main`. On a machine with working git, use normal git. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Architecture

```
src/extension.ts        Activation and commands. The activity-bar view is only a launcher: showing it opens
                        the editor tab and closes the sidebar (VS Code requires a view behind the icon).
src/settings.ts         Reads preflight.* settings; comments explain every value.
src/auth/github.ts      VS Code GitHub sign-in (scopes repo, read:org, workflow), SSO handling, error → UI text.
src/github/             Octokit with throttling/retry, rate-limit tracking, repo and branch listing,
                        repoContext.ts (one recursive tree listing, lazy blob reads, no cloning).
src/skills/             Skill parser (zod schema), loader (orders prerequisites first), rule DSL
                        (rules/index.ts), built-in evaluators (rules/builtins.ts), dependency inventory
                        (rules/dependencies.ts), technology/test classification (rules/technology.ts).
src/engine/             RepoContext, runCheck (depends_on handling), sequential scan queue, scoring.
src/ai/                 Copilot provider via vscode.lm (lmProvider.ts) with model fallback and retries,
                        prompts and reply parsing (prompts.ts), provider availability (detect.ts).
src/fix/                Fix planner (planner.ts), built-in fixes, branch naming, PR text, PR writer
                        (createCommitOnBranch, step events), test-framework detection (testFramework.ts).
src/sonar/              Optional self-hosted SonarQube client and project resolution.
src/panel/              Webview host (panel.ts), fix and PR flow (fixFlow.ts), skill import dialogs
                        (skillImport.ts), HTML/CSP (html.ts).
src/shared/             Message protocol between host and webview (protocol.ts), line diff (diff.ts).
src/webview/            Preact UI: store.ts (scan state), fixStore.ts (fix/PR state), components/.
skills/<category>/*.md  The check catalogue. Adding a check must not need engine changes.
test/                   Vitest suites; fakes in test/helpers/fakeRepo.ts.
```

Conventions:
- Keep `src/engine`, `src/skills`, `src/fix` and `src/sonar` free of `vscode` imports; inject what they need.
- Every new rule, built-in check or fix needs tests in `test/`, using the fakes.
- UI copy is minimal: icons with tooltips and `aria-label`, and one prominent action per state.
- Colours come from `--vscode-*` variables. The orange accent is only for the primary action and the logo. Don't use `--vscode-statusBar-*` for in-panel text.
- Code style: 2-space indent, single quotes, comments only where they add a "why".

## Product behaviour and decisions (keep consistent)

**UI.**
- **Layout:** one editor tab. A top bar of icons (connection, AI provider, Scan, Stop, Fix, Refresh, Filter, Settings). A left pane with **Repos | Checks** tabs: Checks chooses which checks a scan runs. Results on the right, and a status strip at the bottom with the version.
- **Repos:** an **Organizations** multi-select picker (personal account plus orgs, with repo counts); orgs in the avatar menu are clickable. Repos come from the user's listing merged with each org's listing. Archived and disabled repos are not shown, and there is no add-by-name (owner's decision). Orgs whose OAuth App restrictions hide private repos show "Request access" in the org picker and avatar menu only; there is no badge elsewhere.
- **Checks import:** the **+** icon in the Checks tab imports a `.md` or `.zip` (`src/skills/importer.ts` is pure; `src/panel/skillImport.ts` handles the VS Code dialogs). Imports go to `globalStorageUri/skills/<category>/<id>/SKILL.md` plus resources, and load with `origin: 'imported'`. General agent skills are wrapped as `evaluation: ai` checks with headings demoted two levels; their folder's text files are `skill.resources` and go into prompts as `<skill-resource>` blocks.
- **Import review** (`src/skills/importReview.ts`, pure): `lintDraft` (format errors and style warnings), `findDuplicates` (same ID, name or rules; same rule target files; term similarity of name and "What this checks"; at or above 0.6 means likely duplicate), and an optional `aiReview` through `ModelProvider.complete` that confirms or rejects duplicates and can rewrite a free-form skill into Preflight's format (keeping `original-SKILL.md`). Statuses are ready, style, duplicate or invalid. Invalid skills can't be imported.
- **Branch chip:** editable only when more than one repo is selected (owner's spec).
- **Verdicts:** Passing (no critical or high failures), Failing, or Incomplete (a check couldn't be evaluated). Score is "N/100". Critical failures are pinned to the top.
- **Fixing:** a per-repo **Fix** button on each card, plus the top-bar Fix for all repos. A wand marks fixable failures.

**Checks.**
- **Results** are pass, fail, skipped or error.
- **`depends_on`:** if a prerequisite fails, the dependent is skipped with "Needs X to pass first". If the prerequisite is skipped, the dependent is skipped with the same reason.
- **`after`:** ordering only, with no dependency.
- **Sonar Code Coverage category** (folder `skills/code-quality`):
  1. `sonar-required` decides from the technology whether coverage applies. Docs, config, IaC, Helm, Docker and script repos are "Not required"; `sonar-project.properties` always means required.
  2. `sonar-onboarded` checks for the properties file, CI, the build plugin, or an existing project on the Sonar server.
  3. `sonar-code-coverage` uses measured coverage when SonarQube is connected (optional; the owner does not plan to connect it). Otherwise it uses an **estimate**: the share of application source files that have a test file named after them, compared with `preflight.coverage.threshold` (default 80).
- **Test recognition** (`isTestPath`) and matching (`technology.ts`) are case-correct (Latest.java is not a test) and handle `index`/`main` files by folder.

**AI.**
- **Provider:** Copilot, Claude or Codex, all through `vscode.lm` (Copilot-served). The choice is fixed per scan.
- **Model fallback:** Copilot lists some models extensions can't call ("only available to VS Code core"), so the provider falls back to the next model in the family.
- **Fix answers** come as `<file path="…">…</file>` blocks (JSON is accepted as a fallback). An unusable answer or failed request is retried once.

**Pull requests.**
- **At most two per repo:** Fixes and a draft Coverage PR.
- **Branches:** always a new branch from the template; collisions get a suffix. The PR targets the scanned branch.
- **Commits:** created with `createCommitOnBranch` (signed by GitHub).
- **Label:** `preflight` (`#F58025`), created if missing.
- **Confirmation:** a modal before creating, the only modal in the product.

**Coverage PR.**
- **Goal:** writes tests for exactly as many untested files as the threshold needs, largest first. `preflight.coverage.maxFiles = 0` means no limit.
- **Counting:** a file counts only when the estimate recognises its new test; otherwise the test is kept and another file is used.
- **Speed:** three files at a time. A failing file is replaced, never stops the batch.
- **Framework:** detected from the nearest build file (Vitest, Jest, pytest, JUnit 5, testify, xUnit and others), and the AI is told which to use.
- **Notes:** the PR notes show the estimate before and after.

**Progress screens.**
- "Preparing fixes" lists every task up front with live status, a coverage bar against the target, and counts.
- "Opening pull requests" shows the branch, commit, PR and label steps per PR.

## Known open items

- **Not verified against real services:** GitHub's async SBOM report flow (`exportSbom` in `rules/dependencies.ts`) returned no packages in an early live test; inventory falls back to lockfiles. Measured Sonar coverage paths have no real SonarQube server to test against.
- **Generated tests are never executed:** nothing is cloned, so PR CI is the judge, and the PR body says so.
- **Swift and C/C++ framework detection** is basic (XCTest/Swift Testing, GoogleTest/Catch2).
- **`@types/vscode` must stay at the `engines.vscode` version** (`~1.100`), or vsce refuses to package. Dependabot is told to ignore it.
