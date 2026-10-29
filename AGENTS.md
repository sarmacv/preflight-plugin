# Agent instructions

Preflight is a VS Code extension (TypeScript) that scans GitHub repositories through the API against
Markdown "skill" checks and opens fix pull requests. Read `README.md` for the product behaviour.

## Build and test

- Install: `npm ci` (Node 22).
- Type-check: `npm run typecheck`.
- Unit tests: `npm test` (Vitest; GitHub and SonarQube are mocked, no network).
- Build: `npm run build` bundles `src/extension.ts` and the webview into `dist/` with esbuild.
- Package: `npm run package` produces `preflight-<version>.vsix`.
- UI without VS Code: `node scripts/harness/serve.mjs`, then open `http://localhost:5178/scripts/harness/`.

## Layout

- `src/skills`: skill parser, loader, rule DSL (`rules/index.ts`) and built-in evaluators (`rules/builtins.ts`).
- `src/engine`: check runner, scan queue, scoring. No `vscode` imports, so it is unit-testable.
- `src/fix`: fix planner, built-in fix generators, branch naming, PR writer.
- `src/ai`: Copilot provider through `vscode.lm`; prompts and parsing live in `prompts.ts`.
- `src/panel` and `src/webview`: the editor-tab UI (Preact) and its message protocol in `src/shared/protocol.ts`.
- `skills/<category>/<id>.md`: the check catalogue. Adding a check must not need engine changes.

## Conventions

- Keep the engine, rules, fixes and Sonar client free of `vscode` imports; inject what they need.
- Every new rule, built-in check or fix needs tests in `test/`, using the fakes in `test/helpers/fakeRepo.ts`.
- UI copy is minimal: icons with tooltips and `aria-label`, no instructional text. Never show model names to users.
- Theme colours come from `--vscode-*` variables; the orange accent is only for the primary action and the logo.

## Guardrails

- Never commit to an existing branch from Preflight code paths; PRs always use a new branch.
- Never log or persist tokens. GitHub auth comes from `vscode.authentication`; the Sonar token from SecretStorage.
- Don't add network calls to tests.
