# orch-proof-unit-converter
Disposable proof project for testing autonomous software development with ORCH.

## Purpose

This repository is a disposable proof project used to test autonomous software
development with an orchestrator. The orchestrator will build a small unit
converter here through its own governed work packages. The current app is a
placeholder.

- No backend: the site is static HTML served by GitHub Pages.
- No data: nothing is collected, stored or sent anywhere.
- No secrets: no credentials, tokens or repository variables are used.
- No dependencies: `package.json` has no dependencies or devDependencies; only
  Node.js 22 built-ins are used.

## Layout

| Path | Role |
| --- | --- |
| `app/` | Static site source, copied verbatim into `dist/` by the build. |
| `scripts/build.mjs` | Empties and recreates `dist/`, copies `app/`, writes `dist/version.json` = `{"sha": GITHUB_SHA or "local"}`. |
| `scripts/smoke.mjs` | `node scripts/smoke.mjs <url> <sha>`: checks that `<url>/version.json` reports `<sha>` and `<url>/` contains `<main id="app">`, with bounded retries. |
| `test/` | `node:test` suites, run with `npm test`. |

Local commands (Node.js 22 or newer, no install step):

```sh
npm test
npm run build
npm run smoke -- <url> <sha>   # SMOKE_ATTEMPTS / SMOKE_DELAY_MS override retries (default 20 x 15000 ms)
```

## CI and deploy

- **`ci`** (`.github/workflows/ci.yml`): runs on every pull request and on
  pushes to `main`. One job, `ci`, runs `npm test` and `npm run build`.
- **`deploy`** (`.github/workflows/deploy.yml`): runs on pushes to `main` (and
  manually). Job `deploy` builds `dist/` with the commit SHA and publishes it to
  GitHub Pages (source: "GitHub Actions"). Job `hosted-smoke` then runs
  `scripts/smoke.mjs` against the published URL and fails unless the live site
  serves exactly that commit's `version.json` and the `<main id="app">` marker.

Every action is pinned to a full commit SHA. Workflows use least-privilege
permissions; only the `deploy` job gets `pages: write` and `id-token: write`.

## Evaluator files

These files form the evaluator and pipeline. They are locked: orchestrator work
packages must not modify them.

- `.github/**`
- `package.json`
- `scripts/build.mjs`
- `scripts/smoke.mjs`
- `test/scaffold.test.mjs`

Orchestrator packages may only add or change `app/**`, `src/**` and new
`test/*.test.mjs` files.
