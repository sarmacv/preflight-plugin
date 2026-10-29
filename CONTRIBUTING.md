# Contributing

## Set up

```bash
npm ci
```

Press F5 in VS Code to run the extension in an Extension Development Host. See `AGENTS.md` for the full command list and project layout.

## Branching strategy

We use trunk-based development:

- `main` is always releasable. Never push to it directly; every change lands through a pull request.
- Create short-lived feature branches named `feature/<short-description>`, `fix/<short-description>` or `chore/<short-description>`.
- Keep branches small and merge within a few days. Rebase on `main` rather than merging `main` into your branch.
- Pull requests are squash-merged.
- Releases are tagged on `main` as `vX.Y.Z`, matching `version` in `package.json`.

## Pull requests

- CI must pass: type-check, tests and packaging.
- Add or update tests for any change to rules, checks, fixes or the scan engine.
- Adding a check is a new file in `skills/<category>/`; follow the format in the README.
- At least one approving review from a code owner is required.

## Commit messages

Use the imperative mood ("Add stale branch check"), keep the first line under 72 characters, and explain why in the body when it isn't obvious.
