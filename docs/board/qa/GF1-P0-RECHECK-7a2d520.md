# QA recheck: GF1-P0, proof repository bootstrap (fix round 1)

| Field | Value |
| --- | --- |
| Candidate | PR #1, `claude/gf1-p0-bootstrap` → `main` |
| Head reviewed | `7a2d520843edacd28d6ad50daf561e7233587ac6` (`git rev-parse HEAD` confirmed) |
| Previous head / report | `48705c3`, `docs/board/qa/GF1-P0-QA-48705c3.md` on `claude/qa-gf1-p0-48705c3` (FIX REQUIRED: F-1 MAJOR, F-2 to F-7 MINOR) |
| Fix diff | `48705c3..7a2d520`: `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `README.md`, `scripts/build.mjs`, `scripts/smoke.mjs`, `test/scaffold.test.mjs` (6 files; no new files, no dependencies) |
| Reviewer | Independent QA. Review only; the candidate was not modified |
| Toolchain | Node v22.23.4, npm 10.9.9 (same versions as the hosted runner) |
| Date | 2026-11-11 |

## 1. Summary

- **F-1 is fixed.** `ci` now runs the locked scaffold test and the locked build on the clean checkout, before any app-controlled code runs. No attack from `app/**`, `src/**` or a new `test/*.test.mjs` changed the Phase 1 verdict: in 25 emulated scenarios (8 with a deliberately broken app), none turned a broken app green.
- **Phase 3 is defence in depth only.** The post-suite checks (tracked-tree diff and fingerprint/HEAD) catch naive tampering. A test that writes `BASH_ENV` to `$GITHUB_ENV`, or puts fake tools on `$GITHUB_PATH`, can neutralise them. That gains nothing, because the locked verdict was already fixed in Phase 1. See F-9 (INFO).
- **F-2 to F-7 are fixed as asked, with tests.** Mutation testing confirmed that each requested test fails when its control is removed.
- **One safety control has no test.** Strict SHA equality in `smoke.mjs` is correct (own negatives), but no test covers it: a prefix-match mutation survives all 13 tests. See F-8 (MINOR, non-blocking).
- Supply chain, permissions, triggers, secrets, job ids and concurrency are unchanged or tighter. The PR's `ci` check for this head is `success`.

## 2. F-1: evaluator integrity in `ci`

### 2.1 What the new `ci.yml` does

| Phase | Step | Runs app-controlled code? |
| --- | --- | --- |
| 0 | Fingerprint `.github/**` plus `package.json scripts/build.mjs scripts/smoke.mjs test/scaffold.test.mjs` (list in step `env`). Digest and HEAD go to the step's own `GITHUB_OUTPUT` | no |
| 1 | `node --test test/scaffold.test.mjs` | no: the locked file imports only `node:` builtins and spawns only locked scripts |
| 1 | `npm run build` (locked `package.json` → locked `scripts/build.mjs`) | no: `app/**` is copied as data, never executed |
| 2 | `npm test` (`node --test "test/*.test.mjs"`) | **yes** |
| 3 | `git diff --exit-code` and `git status --porcelain --untracked-files=no` is empty | runs after untrusted code |
| 3 | Recompute the fingerprint and HEAD, compare with the Phase 0 step outputs | runs after untrusted code |

Any failing step stops the job, so a red Phase 1 can never be followed by a green job. **The security boundary is the ordering**, not Phase 3.

### 2.2 Method

- Harness: `runci.py` reads `ci.yml` and runs every `run:` step in order, from a fresh clone of `7a2d520` with the scenario committed on top.
- It emulates the runner's file commands: a fresh `GITHUB_OUTPUT`, `GITHUB_ENV` and `GITHUB_PATH` file per step; `GITHUB_ENV` and `GITHUB_PATH` applied to later steps; `NODE_OPTIONS` refused, as the runner does; step `env:` taking precedence; and `${{ steps.locked.outputs.* }}` substitution.
- Shell: the harness used `bash --noprofile --norc -eo pipefail`. The hosted log shows `bash -e {0}`. Every multi-command step sets `set -euo pipefail` itself, so the outcomes are the same.
- Every attack used **only** allowed paths: `app/**`, `src/**` and new `test/*.test.mjs` files.
- "Broken app" means `<main id="app">` was removed from `app/index.html`, so the honest evaluator must fail.
- Limitation: the runs were emulated locally, not executed on a hosted runner (QA must not open PRs, and `ci` does not trigger on other branches). Runner-specific behaviour (`BASH_ENV` honoured from `GITHUB_ENV`, passwordless `sudo`, orphan-process cleanup only at job end) is standard GitHub-hosted behaviour, and none of it affects Phase 1.

### 2.3 Attack table

| # | Attack | Path used | Broken app? | Step that failed | `ci` outcome |
| --- | --- | --- | --- | --- | --- |
| B0 | Baseline, no change | none | no | none | PASS (expected) |
| B1 | Broken app, no attack | `app/index.html` | yes | Locked evaluator tests | **FAIL** ✅ |
| A1 | Test overwrites `scripts/build.mjs` with a build that always emits the marker (the original E2 attack) | `test/aaa-overwrite_build.test.mjs`, `app/index.html` | yes | Locked evaluator tests (the attack test never runs in Phase 1) | **FAIL** ✅ |
| A1b | Same overwrite, good app | `test/…` | no | Full test suite (the tampered build breaks the symlink tests in Phase 2) | **FAIL** ✅ |
| A1c | Test appends a harmless comment to `scripts/build.mjs` | `test/…` | no | Tracked tree is unchanged | **FAIL** ✅ |
| A2a | Tamper, then `git update-index --assume-unchanged scripts/build.mjs`, so `git diff` and `status` look clean | `test/…` | no | Locked evaluator files are unchanged (sha256 is read from disk, not from git) | **FAIL** ✅ |
| A2b | Tamper, `git add`, then `--skip-worktree` | `test/…` | no | Tracked tree is unchanged (porcelain shows the staged change) | **FAIL** ✅ |
| A2c | Tamper, then `git commit -am` (rewrites the index and moves HEAD) | `test/…` | no | Locked evaluator files are unchanged (digest and HEAD) | **FAIL** ✅ |
| A2d | Broken app plus index attack | `app/…`, `test/…` | yes | Locked evaluator tests | **FAIL** ✅ |
| A3a | Test appends to `.github/workflows/ci.yml` | `test/…` | no | Tracked tree is unchanged | **FAIL** ✅ |
| A3b | Test creates an untracked `.github/workflows/extra.yml` | `test/…` | no | Locked evaluator files are unchanged (`find .github -type f` covers untracked files) | **FAIL** ✅ |
| A3c | Broken app plus `.github` edit | `app/…`, `test/…` | yes | Locked evaluator tests | **FAIL** ✅ |
| A4a | Test writes `EXPECTED_DIGEST`, `EXPECTED_HEAD` and `LOCKED_FILES` to `$GITHUB_ENV` | `test/…` | no | Tracked tree is unchanged (step `env:` takes precedence over `GITHUB_ENV`) | **FAIL** ✅ |
| A4b | Test tampers `build.mjs`, then writes `BASH_ENV=/tmp/…/rc.sh` (containing `exit 0`) to `$GITHUB_ENV` | `test/…` | no | none: both Phase 3 steps exit 0 before running | **PASS** ⚠️ Phase 3 bypassed, Phase 1 was already honest (F-9) |
| A4c | Test tampers, then puts fake `git` and `sha256sum` on `$GITHUB_PATH` (they report the committed blob hashes) | `test/…` | no | none | **PASS** ⚠️ Phase 3 bypassed (F-9) |
| A4d | Test writes `digest=` and `head=` to its own `$GITHUB_OUTPUT` | `test/…` | no | Tracked tree is unchanged. The `npm test` step has no id, and `steps.locked.outputs` cannot be rewritten after that step ends | **FAIL** ✅ |
| A4e | **Broken app** plus the `BASH_ENV` bypass | `app/…`, `test/…` | yes | Locked evaluator tests | **FAIL** ✅ |
| A5a | Test tampers and leaves a detached watcher that restores `build.mjs` once `node --test` exits | `test/…` | no | Tracked tree is unchanged in 3/3 runs (the restore lost the race; once it landed just after the check) | **FAIL** locally; could PASS on a slower runner. Harmless either way (F-9) |
| A5b | Detached process edits `build.mjs` 4 s after the step, i.e. after all checks | `test/…` | no | none (the edit landed after the job's last step; the runner kills orphans at job end) | PASS, with no effect on any verdict or on deploy |
| A6a | Test monkeypatches `fetch`, `String.prototype.includes` and `process.exit` | `test/…` | no | none | PASS (expected: nothing is gamed) |
| A6b | Broken app plus that monkeypatch. `scaffold.test.mjs` cannot import it: it imports only `node:` specifiers, it is locked, and `node --test` isolates each file in its own process | `app/…`, `test/…` | yes | Locked evaluator tests | **FAIL** ✅ |
| A7a | App influence: `app/package.json` and `src/package.json` with `"type":"commonjs"` and `"imports"`, a forged `app/version.json`, `src/index.mjs` | `app/**`, `src/**` | yes | Locked evaluator tests. `.mjs` ignores `type`; scripts resolve the root `package.json`; `src/` is never read | **FAIL** ✅ |
| A7b | Marker only in `app/sub/index.html` | `app/**` | yes | Locked evaluator tests | **FAIL** ✅ |
| A7c | Symlink `app/leak.json -> ../package.json` | `app/**` | no | Locked evaluator tests (the build refuses it) | **FAIL** ✅ |
| A7d | Directory symlink `app/s -> ../scripts` | `app/**` | no | Locked evaluator tests | **FAIL** ✅ |

**Result: in every scenario with a broken app, `ci` failed in Phase 1.** Every attack that ended in PASS had a good app, so it gained nothing over an honest run.

### 2.4 Can app code influence Phase 1?

- **Files the build copies:** `app/**` is copied as data and never executed. Symlinks and special files are rejected before the copy (A7c, A7d). `version.json` is written after the copy, so a forged one is overwritten (A7a; also a scaffold test).
- **`package.json` `type` or `imports`:** the locked root `package.json` governs `scripts/` and `test/`, and every locked script is `.mjs`. A nested `app/package.json` or `src/package.json` is never on a resolution path (A7a). Locked files import only `node:` builtins.
- **Module or loader injection:** Phase 1 sets no `NODE_OPTIONS`, `--import` or `--require`. Node 22 reads no config file without an explicit flag, and `.npmrc`/`node_modules` are not allowed paths.
- **Environment:** no app code has run before Phase 1, so `GITHUB_ENV`/`GITHUB_PATH` are still clean.
- **Resource exhaustion** (a huge `app/` file, many files): can only make Phase 1 slow or fail, never pass. Bounded by `timeout-minutes: 15`.
- **Conclusion: no path from `app/**` or `src/**` can make Phase 1 pass, other than shipping the marker, which is the contract.**

### 2.5 Residual notes (not findings against this package)

- `pull_request` runs use the PR's own copy of `ci.yml`, so a PR that edits `.github/**` can rewrite the evaluator. That edit is outside the allowed paths, and **the Board's acceptance gate must reject any later PR that touches a path other than `app/**`, `src/**` or a new `test/*.test.mjs`**. This was already noted in the first report, and CI cannot enforce it by itself.
- Board acceptance tests delivered as `test/*.test.mjs` run only in Phase 2. A sibling test can interfere with them, for example by racing to overwrite the file or by using runner `sudo`. If the Board ever needs a trusted acceptance test, it must be a locked file run in Phase 1, which would mean changing a locked file.
- `setup-node@v7` defaults to `package-manager-cache: true`. No cache is restored, because there is no lockfile and no `packageManager` field (confirmed in the hosted log), so `ci` cannot be cache-poisoned today.

## 3. F-2 to F-7

| ID | QA asked for | Now in `7a2d520` | Test | Mutation check | Status |
| --- | --- | --- | --- | --- | --- |
| F-2 | Reject symlinks in `app/` | `build.mjs` `assertPlainTree()` lstat-walks `app/` (including `app/` itself) before `rm`/`cp`, rejects symlinks and non-regular files, and exits 1 | `build rejects a symlinked file inside app/` (nested; asserts the error message and that nothing was published); `build rejects app/ itself being a symlink` | M1 (check removed): 2 tests fail. M10 (check removed plus `dereference: true`): 2 tests fail | ✅ fixed, tested |
| F-3 | `redirect: 'error'` | `smoke.mjs` `fetchText` uses `redirect: 'error'` | `smoke fails when the index page redirects…` (also asserts the target is **never fetched**); `smoke fails when version.json redirects` | M3 (`redirect: 'follow'`): 2 tests fail | ✅ fixed, tested |
| F-4 | `timeout-minutes` 15 / 10 / 30 | `ci` 15, `deploy` 10, `hosted-smoke` 30 (the smoke worst case is about 25 min, which fits) | n/a (workflow config) | n/a | ✅ fixed |
| F-5 | Pass values via `env:` | `PAGE_URL` and `EXPECTED_SHA` in step `env:`; the `run:` line uses `"$PAGE_URL" "$EXPECTED_SHA"`. No `${{ }}` remains in any `run:` line | n/a | n/a | ✅ fixed |
| F-6a | Non-2xx page with the marker fails | unchanged (`res.ok`) | `smoke fails on a non-2xx index page…` (asserts `HTTP 404`) | M4 (`res.ok` check removed): 1 test fails | ✅ tested |
| F-6b | Build overwrites a forged `app/version.json` | unchanged (written after `cp`) | `build overwrites a forged app/version.json…` (temp fixture, so the real `app/` is untouched) | M2 (write moved before `cp`): 1 test fails | ✅ tested |
| F-6c | Cache-busting query and no-cache headers | unchanged | `smoke sends a cache-busting query and no-cache headers…` (both URLs, a fresh value per attempt, both headers) | M6 (query removed): fails. M5b (`cache:'no-store'` and headers removed): fails. M5 (explicit headers only removed): **passes**, because undici adds `pragma`/`cache-control: no-cache` itself for `cache: 'no-store'`, as the Fetch spec requires. The wire behaviour is unchanged, so this is correct | ✅ tested |
| F-6d | Retry recovers; fails after N | unchanged | `smoke retry recovers after a stale response` (exactly 3 hits, attempt log); `smoke fails after exactly N attempts…` (exactly 3 `version.json` requests) | M7 (N+1 attempts): 2 tests fail. M8 (no retry): 3 tests fail | ✅ tested |
| F-7 | `deploy` only for `refs/heads/main` | job `deploy` has `if: github.ref == 'refs/heads/main'`; `hosted-smoke` `needs: deploy`, so it is skipped too | n/a | n/a | ✅ fixed |
| F-1 | ci ordering plus tree checks | see section 2 | **No automated test** asserts the `ci.yml` step order or the Phase 3 checks. Verified by QA emulation only (section 2.3). Acceptable: `ci.yml` is locked, and any change to it must go back through QA | n/a | ✅ fixed (safety control without an automated test, flagged) |

README: the new text matches the code (symlink rejection, redirect and non-2xx failure, the 4-phase `ci` order, `deploy` only on `refs/heads/main`). One wording nuance is covered by F-9.

## 4. Supply chain

Each tag was re-resolved with `git ls-remote --tags https://github.com/actions/<name> refs/tags/<tag> refs/tags/<tag>^{}`. No `^{}` lines came back, so all five are lightweight tags pointing straight at the commit.

| Action | Version comment | SHA in workflow | Independently resolved | Match | Uses |
| --- | --- | --- | --- | --- | --- |
| actions/checkout | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | ✅ | ci ×1, deploy ×2 |
| actions/setup-node | v7.1.0 | `949feb2413d6458794dcd2491c4babbbce0c15c1` | `949feb2413d6458794dcd2491c4babbbce0c15c1` | ✅ | ci ×1, deploy ×2 |
| actions/configure-pages | v6.0.0 | `45bfe0192ca1faeb007ade9deae92b16b8254a0d` | `45bfe0192ca1faeb007ade9deae92b16b8254a0d` | ✅ | deploy ×1 |
| actions/upload-pages-artifact | v5.0.0 | `fc324d3547104276b827a68afc52ff2a11cc49c9` | `fc324d3547104276b827a68afc52ff2a11cc49c9` | ✅ | deploy ×1 |
| actions/deploy-pages | v5.0.1 | `368f82528645a54fb793d4d04e342629a3f51346` | `368f82528645a54fb793d4d04e342629a3f51346` | ✅ | deploy ×1 |

- All 9 `uses:` lines are `actions/<name>@<40-hex>`.
- **No new actions** since `48705c3`: the same 5 actions at the same SHAs.
- The hosted `ci` log shows the runner downloading checkout and setup-node at exactly these SHAs.

## 5. Permissions, triggers, secrets

| Control | `48705c3` | `7a2d520` | Verdict |
| --- | --- | --- | --- |
| `ci.yml` permissions | `contents: read` | `contents: read` | unchanged ✅ |
| `deploy.yml` top level | `contents: read` | `contents: read` | unchanged ✅ |
| job `deploy` | `contents: read`, `pages: write`, `id-token: write` | same | unchanged ✅ |
| job `hosted-smoke` | `contents: read` | same | unchanged ✅ |
| Triggers | ci: `pull_request`, `push: main`; deploy: `push: main`, `workflow_dispatch` | same | unchanged ✅ |
| `deploy` ref gate | none | `if: github.ref == 'refs/heads/main'` | tighter ✅ |
| `timeout-minutes` | none | 15 / 10 / 30 | tighter ✅ |
| `secrets.` / `vars.` / `pull_request_target` / `workflow_run` / `github.event.*` / `head_ref` | none | none (grep) | ✅ |
| `persist-credentials: false` | 3/3 checkouts | 3/3 | ✅ |
| `${{ }}` inside `run:` | 2 | 0 | tighter ✅ |
| Job ids | `ci`, `deploy`, `hosted-smoke` | same | ✅ |
| Deploy concurrency | `group: pages`, `cancel-in-progress: false` (workflow level) | same | ✅ |
| Dependencies | none | none (`package.json` has no dependency fields; no lockfile) | ✅ |

## 6. Test table

| # | Test | Expected | Result |
| --- | --- | --- | --- |
| T1 | `npm test` on `7a2d520` (Node 22.23.4) | all pass | ✅ 13/13 pass, 0 fail |
| T2 | `npm run build` | `dist/index.html` with the marker, `dist/version.json` = `{"sha":"local"}` | ✅; tree clean afterwards (`git status --porcelain` empty) |
| T3 | `ci.yml` steps by hand, baseline (B0) | all 6 run steps pass | ✅ |
| T4 | `ci.yml` steps with the 24 attack and app scenarios (section 2.3) | broken app always fails | ✅ 0 of 8 broken-app scenarios passed; 2 good-app scenarios bypassed Phase 3 (F-9) |
| T5 | Mutation M1/M10: symlink check removed | tests fail | ✅ 2 fail |
| T6 | Mutation M2: `version.json` written before `cp` | test fails | ✅ 1 fails |
| T7 | Mutation M3: redirects followed | tests fail | ✅ 2 fail |
| T8 | Mutation M4: `res.ok` check removed | test fails | ✅ 1 fails |
| T9 | Mutation M5b/M6: no-cache or bust query removed | test fails | ✅ 1 fails each |
| T10 | Mutation M7/M8: retry count wrong or no retry | tests fail | ✅ 2 / 3 fail |
| T11 | Mutation M9: `sha !== expected` loosened to a 7-char prefix match | a test should fail | ❌ **0 fail; mutation survives** (F-8) |
| T12 | Own negatives on the current `smoke.mjs`: sha as a 7-char prefix, uppercase, trailing space, or array-wrapped | exit 1 | ✅ all exit 1 with `sha mismatch`; the exact sha exits 0 |
| T13 | Hosted `ci` check for the PR at this head | success | ✅ (section 7) |

## 7. CI

- The PR #1 check run **`ci` completed with conclusion `success`**: run 42969560962, job 130354598152, 2026-11-11T06:01:43Z to 06:01:51Z. It is the only check on the PR.
- The runner checked out `07f970c` ("Merge 7a2d520843edacd28d6ad50daf561e7233587ac6 into 28223483…"), so this is the head under review.
- The log shows the new step order. The Phase 0 fingerprints match the local files at `7a2d520` (for example `scripts/build.mjs` `25166b6f…`, `test/scaffold.test.mjs` `f630e707…`).
- Results: Phase 1 13/13, build OK, full suite 13/13, the tracked-tree check passed, and the final step printed `Locked evaluator files unchanged (digest c12efa75…, HEAD 07f970cd…)`.
- `deploy` and `hosted-smoke` cannot run before merge, for the same reason as in the first report. The Board's post-merge checklist from section 6 of the first report still applies.

## 8. Findings

| ID | Severity | Location | Finding | Smallest fix |
| --- | --- | --- | --- | --- |
| F-8 | MINOR, non-blocking (**missing test on a safety control**) | `test/scaffold.test.mjs`; control at `scripts/smoke.mjs` `version?.sha !== expectedSha` | Strict SHA equality is the control that makes `hosted-smoke` require the exact merge commit, and no test covers it. The only negative uses a completely different SHA, so loosening the check to a 7-char prefix (M9) passes all 13 tests. The code is correct today (T12), and because the file will be locked, a regression would need a locked-file change. | Add one test: `version.json` serving `GOOD_SHA.slice(0, 7)` (and/or `GOOD_SHA.toUpperCase()`) must fail with `/sha mismatch/`. |
| F-9 | INFO, non-blocking | `ci.yml` Phase 3 steps and comments; README "CI and deploy" step 4 | After `npm test` has run untrusted code, the Phase 3 checks can be neutralised from a test file: `BASH_ENV` written to `$GITHUB_ENV` (A4b), fake tools on `$GITHUB_PATH` (A4c), a background restore race (A5a), or runner `sudo`. **No verdict is affected**, because Phase 1 has already passed or failed on the clean tree, and `deploy` uses a fresh checkout. The wording ("fails if any tracked file changed") reads as a guarantee rather than a best-effort check. | Optional: one comment line in `ci.yml` and the README, e.g. "Phase 3 is best-effort tamper detection; the trust boundary is that Phase 1 runs before any app-controlled code." No code change is needed. |

Previous findings: F-1 (MAJOR) and F-2 to F-7 (MINOR) are **all closed** (section 3).

Explicitly flagged safety controls without an automated test:
- F-8: strict SHA equality.
- The `ci.yml` phase ordering and Phase 3 checks (verified by QA emulation; locked workflow).
- The special-file branch of `assertPlainTree` (not reachable through git, which cannot store FIFOs or devices).

None of these is a defect in current behaviour.

There are no BLOCKER or MAJOR findings. F-8 is cheap to add and can only be added before the files are locked, so the Board may fold it in if there is another round for any reason. It does not block acceptance, because the control is verified correct and is locked against change.

VERDICT: ACCEPT
