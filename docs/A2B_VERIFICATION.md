# A2B verification record

## Review refresh — 30 October 2026

Current upstream `7ff9dda9114e06e3cfbe4bed87dc9fc99986bea5`. Windows/PowerShell, Node 24.22.1,
npm 12.2.1, existing locked Wrangler 4.151.3 and Playwright 1.62.1. Fresh detached-main baseline:
`npm test` exit 0, **191 pass / 0 fail / 0 skip**. New AGENTS.md and current contributor rules read.
All 59 PRs inventoried; all comments/reviews/inline threads read for #14–#16 and #42–#50.

Each implementation branch below includes that current main. All have `npm test`, changed-JavaScript
`node --check`, `git diff --check` and `git merge-tree --write-tree upstream/main HEAD` passing
(exit 0; fork's `origin/main` is not used as the upstream reference). No assertions removed/skipped.
Counts are independent per branch, not additive; the old combined result below remains historical.

| PR | Reviewed commit | Unit/API pass / fail / skip | Additional evidence |
|---|---|---|---|
| #15 | `d7273be` | 195 / 0 / 0 | Existing partial offline regressions; main integration only |
| #42 | `9c7a0ab` | 192 / 0 / 0 | Real Worker/SQLite component role/revocation tests; local Wrangler full-app boot |
| #43 | `3f751bf` | 197 / 0 / 0 | Actual local Wrangler D1: migration0015, 1 concurrent winner, 3 fault rollback/retry stages |
| #44 | `8fc7f34` | 221 / 0 / 0 | GPS/arrival/reroute/sharing regressions; Chrome status component and final-head local Wrangler boot |
| #45 | `66035ec` | 191 / 0 / 0 | 10 Chromium/WebKit password/DOM component tests, exit0 |
| #47 | `447c06c` | 213 / 0 / 0 | Chromium/WebKit search component smoke, 2 new approved/hidden-place failure regressions |
| #48 | `c65b3b0` (code `2bcb8c7`) | 200 / 0 / 0 | 9 lifecycle cases rerun after final fixture-only update; local Wrangler Search→Drive/Walk/Motorbike/Train |
| #49 | `e6c4a38` | 201 / 0 / 0 | Immediate same-watch tunnel recovery, one-watch/timer bounds; local Wrangler boot |
| #50 | `f0aeeef` | 193 / 0 / 0 | Graph26 modules, actual installed-SW cold offline app/menu boot, exit0 |

The #44 cross-review found ordinary weak GPS could still be frozen after rerouting through a global
quality check. Four new regressions failed before correction and pass afterward: ordinary weak
drive/walk/motorcycle sharing/reroute and current callbacks carrying stale/repeated measurement timestamps.
Actual callback gaps and active/exhausted/suspended estimates still cannot share or reset their budgets.
The full-app boot smoke was rerun on final `8fc7f34`; component/VM regression tests provide behavioral
evidence, not real road/GPS hardware proof. #48's healthy-GPS fixture now supplies the collaborator
introduced by #44, so future composition does not fail merely on an undefined helper.

Full-app local browser scope: actual app/Worker via Wrangler with isolated local D1, Chromium390×844,
real MapLibre fixed JS/CSS fixtures and an empty style, mock GPS. Actual guest account/presence endpoints
ran locally; route/search/transit were synthetic. Public provider traffic blocked, backend provider URLs
overridden to localhost. #48 journey proves late Drive does not replace Walk and current train reports
render. #42/#44/#49 checks boot/map/menu only. Zero page exceptions/unexpected local HTTP failures.
Expected resource errors were recorded for blocked optional Three.js and absent optional place index.
All local servers stopped afterward. Synthetic screenshots and logs are retained in the workspace:
`outputs/pr-review/` and `work/review-*-fullapp.log`; per-theme tracked screenshots remain in their PRs.

#50: HTTP cache cleared, old page closed, server stopped, then new page opened offline. All26 local
modules and both MapLibre assets served by SW, zero page errors/requests reaching the stopped origin.
Network-only APIs fail offline as expected; optional Three.js is blocked. No permanent-cache/full-offline-routing claim.

Read-only live observation: A2B Beta returned HTTP200, title A2B, map canvas present at390px/1280px,
document width matched viewport, zero page exceptions/failed requests in this one observed visit.
No signup, feedback, security probing or routing interaction on production. Web text-fetch was unavailable;
the browser supplied the actual observation. This does not prove all live user journeys.

No new theme/PR, upstream merge, deployment, remote migration or CLA agreement. Existing same-PR
checklists and ready/draft controls were preserved; personal CLA replies on #14/#15/#16 remain for Afham.
Six change-request reviews require the reviewer to re-review; code updates do not self-approve them.
Current branches are checked individually against main, not claimed as a newly verified all-PR combined build.

## Baseline — 29 October 2026

- Repository: `thaqif0709/a2b`, upstream main `134045abe40e3fd50f73fb24437c4ef4a2920509`.
- Node 24.22.1; npm 12.2.1; Windows/PowerShell; repository requires Node >=22.13.
- `git fetch upstream --prune`: exit 0. No reset/clean/overwrite of existing user branch.
- `npm test`: exit 0, **179 pass / 0 fail / 0 skip**; about 1.7 seconds on this machine.
- Existing unit suite needs only built-in Node modules; dependency installs use the committed lockfile
  for Wrangler and any added browser test tooling. No generated Overture download was needed.
- PR inventory: initially 40 total, all inventoried; open PR diffs and relevant discussion checked. #14/#16 merged; #15 open and
  clean at `474f670b624bcfdee360aeb418060efc7d924896`. Historical 183-pass result is not this baseline.

## Evidence and limits

Each implementation PR must include its own `docs/changes/` entry with exact base/result commit,
commands, exit status, test counts, reproduction and known limits. Results from independent branches
must not be added together as though they were one integrated build.

| Area | Evidence at baseline | Outstanding |
|---|---|---|
| Account access | Synthetic unverified allowlisted signup reproduced privileged stats 200; new regression failed before fix. | Verify owner/tester ID provisioning with owner; no real IDs inferred. |
| Recovery | Code read and claim are separate; local concurrency and fault tests under construction. | D1 runtime batch validation, replacement-code browser journey. |
| GPS estimates | Current expiry recreates reckoner; estimated fix can latch arrival. | Deterministic actual app flow and real GPS acceptance tests. |
| Sensitive UI | Origin name uses innerHTML; password uses prompt. | DOM injection, masked forms, failure/pending/focus in Chromium and WebKit. |
| Full app UI | Current code inspected; no completed end-to-end baseline browser journey recorded here. | Actual map/search/drive/train/share/offline/reconnect and deep-link journeys. |
| Performance | Unit-suite elapsed time only; not an app performance metric. | Repeatable first-paint/latency/request/long-task/data measurements. |
| Production | No writes, security/load tests, migrations or deploys performed. | Maintainer review and own deployment process after approval. |

Browser component fixtures use real HTML/CSS/modules, synthetic accounts and local mocked requests;
they do not establish full map navigation correctness. Traces/screenshots must never capture actual
passwords, recovery codes, tokens, feedback content or personal locations. Physical iPhone/Android,
screen readers, real software keyboards and on-road GPS remain manual until explicitly recorded.

No claims of production readiness for all milestones, privacy-law compliance, permanent offline cache,
hard bandwidth cap or measured speed-up are supported by this baseline.

## M1 branch results

| Branch result | Commands / exit codes | Result / actual platform |
|---|---|---|
| Access `99ed819` | `npm test` 0; `git diff --check` 0 | 180 pass/0 fail; Chrome component smoke with real Worker + SQLite fixture |
| Recovery `f397fc2` (code `a366f8d`) | `npm test` 0; `git diff --check` 0; local D1 evidence harness 0 | 185 pass/0 fail; 1 winner and rollback/retry at 3 fault points on Wrangler local D1; synthetic browser recovery |
| GPS `13c64ad` (code `a4ea551`) | `npm test` 0; `git diff --check` 0 | 199 pass/0 fail; actual app functions in mock GPS/DOM/clock fixtures plus Chrome GPS-chip component render; no on-road/browser map proof |
| UI `ecf1ba7` | `npm ci` 0; `npm test` 0; `npm run test:browser` 0; `node --check public/app.js` and `public/panels.js` 0; diff 0 | 179 pass/0 fail unit/API, 10 pass browser component scenarios across Chromium/WebKit; real 390px day/night renders, widths320–1280, landscape, text enlargement |

Each suite has zero skipped tests. Counts are per branch, not additive. M1-UI Playwright1.64.1 initial
launch failed because its browser executables were not installed (8 launch failures, no app assertions
executed); pinning1.62.1 to the available runtime produced the reported successful run. Initial4-case
per-browser run passed8, then review added close/late-failure coverage and the final run passed10.
Chromium screenshot capture reports151.0.7922.34. WebKit emulation is not physical iPhone evidence.

Local recovery D1 command, using the project's installed Wrangler4.151.3:

```sh
npx wrangler dev --local --ip 127.0.0.1 --port 8792 --persist-to .wrangler/recovery-test --log-level warn
```

The synthetic evidence harness invoked against this local server reported four PASS lines: concurrent
winner/loser/session state, then password-update, session-delete and session-insert fault rollback/retry.
The harness was a local audit artifact; persisted regression tests are `test/recovery.test.js` in #43.
No remote D1 binding was executed. One local SQLITE_BUSY from overlapping CLI access was retried with
a bound; this was test-harness contention, not a discarded application assertion.

UI screenshots and precise fixture scope are in #45 `docs/changes/SAFE_ACCOUNT_FORMS.md`.
The npm audit result has3 inherited Wrangler-chain advisories (2 moderate,1 high), also observed on
the recovery branch without Playwright. A dependency update belongs to a separate reviewed change.

## M2 / M3 and combined checkpoint

| Branch head | Actual validation | Scope |
|---|---|---|
| Search `8fb11d7` | `npm test`: 199 pass / 0 fail / 0 skip, exit 0; Chrome/WebKit smoke pass | Deferred old results, rejection/partial data, dedupe, Home/Work/guest recent behavior; before/after synthetic renders |
| Routes `c2d389e` | `npm test`: 188 pass / 0 fail / 0 skip, exit 0; Edge synthetic preview pass | Request identity, timeout/body/cancellation, stale countdown/error/lock, real start/end functions with mocks |
| Location `31a98cd` | `npm test`: 185 pass / 0 fail / 0 skip, exit 0; Chrome component smoke pass | Max 1 watcher and 1 timer; states, stale callbacks and page lifecycle; before/after timeout renders |
| Shell `fa2fd59` | `npm test`: 181 pass / 0 fail / 0 skip, exit 0; graph and portable browser checks exit 0 | 25 local modules; real SW installation, HTTP cache cleared, first page closed, origin stopped, new offline page boot |

Final **combined code**: local branch `claude/phase-integration-check`, commit
`cc15c1ccde36b9955623730ce35a02647b3d3add`, based on upstream `134045a` and the eight implementation
PRs. No #15 or other external feature PR was silently included. This branch is retained locally for
reproducing integration; it has not been submitted as a second aggregate PR.

- `npm ci`: exit 0 (same committed Playwright/Wrangler dependency set).
- `npm test`: exit 0, **243 pass / 0 fail / 0 skip**, approximately 1.8s; suite time is not app latency.
- `npm run test:browser`: exit 0, **10 pass**, Chromium and WebKit component cases; final run about 13.2s.
- `node --experimental-vm-modules --no-warnings scripts/check-offline-shell.mjs`: exit 0, **27 local modules**.
- `npm run test:offline-browser`: exit 0; actual app and MapLibre boot after cold offline reopen;
  all 27 local module responses from SW; zero page errors and zero origin requests after shutdown.
- `node --check public/app.js` and `git diff upstream/main...HEAD --check`: exit 0.

Integration resolutions were additive: retain password-panel cleanup and search invalidation in
`closeScreen`; retain both location-controller and GPS-episode state; retain all four shell imports
(`route-preview`, `probe`, `location`, `request-lifecycle`); retain both npm browser scripts; combine
the reroute request ownership/snapshot guard with GPS suspension/latest-fix handling. Fixture collaborator
updates were committed back to their own PRs. Assertions were not removed or skipped.

The first combined M2 run had five failures caused by missing mock collaborators (`showRouteLoading`
and `resetTripRequests`). After wiring those and subsequent GPS collaborators, the final suite passed.
Independent cross-review also reproduced and fixed an actual route-replacement estimate jump and
unacknowledged full-route retry over-sending; the added regressions remain in #44.

Remaining: hung search sources, backend enrichment deadlines, server ordering of sharing PATCHes,
prefetch/corridor/source/update work, full user journeys, physical devices, CI, broad accessibility/BM
and measured performance. No all-milestone completion or production deployment is claimed.
Afham requested stopping this batch here; resume instructions are in A2B_IMPROVEMENT_PLAN.md.
