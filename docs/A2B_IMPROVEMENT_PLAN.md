# A2B phased improvement register

Audit date: 29 October 2026. Baseline: upstream `134045abe40e3fd50f73fb24437c4ef4a2920509`.
This is a working register, not a claim that the entire programme is implemented or deployed.
Owner reviews and merges; Afham's personal CLA decision remains required. No production database,
provider load tests, secrets, merges or deployments are part of this work.

## Baseline and architecture

### Current review pass — 30 October 2026

Afham asked to settle the submitted PR reviews before doing anything new. This pass updates only
#15 and #42–#50; it starts no new feature or PR. Current upstream is `7ff9dda`, with **191 baseline
tests passing**. AGENTS.md now exists and was read; README, contributor/licence rules and changed code
were rechecked. All 59 PRs were inventoried, and comments/reviews/inline threads for our 12 PRs were read.
The live website loaded at 390px and 1280px without page errors or horizontal document overflow.

- #42: private inbox/stats remain explicit owner-ID privileges. The reviewer requested retaining
  TESTER_EMAILS for demo/capacity/suggestion moderation and dropping TESTER_USER_IDS. This narrower
  boundary is implemented; unverified-email tester privileges remain a documented limitation of M1-A.
- #43: migration renumbered to **0015_recovery_attempts.sql**, after main's place suggestions/train reports.
- #44: ordinary real GPS behavior is preserved; strict recovery checks remain scoped to tunnel/estimate
  episodes. Estimates still cannot confirm stops/arrival or renew their exhausted budget.
- #45/#47: conflicts resolved while preserving motorcycle auto-start rules, approved driver places,
  hidden-place filtering and failure reporting. #58 remains an explicit search overlap.
- #49: transient GPS errors retain the current watcher; 15-second replacement only before a first position.
- #15/#48/#50: refreshed against current main; route ownership retains train reports, shell retains
  suggest.js and advances to v40. #15 prefetch code remains separate from the shell-only contribution.
- #46: update this register, the inventory and actual verification record. Historical figures below
  describe the previous batch; current results are in A2B_VERIFICATION.md.

No upstream merge, deployment, remote database change or CLA agreement is performed. The already-open
PRs were no longer drafts when this review started; their ready/CLA controls are left untouched.
When these updates are submitted, stop again at owner re-review. Future work still needs Afham's
instruction and a fresh check of main, all PRs and the website.

### Original baseline — 29 October 2026

- HTML/CSS/JavaScript ES modules in `public/`; no framework or bundler. MapLibre GL JS 4.7.1,
  three.js 0.160.0 loaded on demand, device speech synthesis, service worker/PWA.
- Cloudflare Worker (`src/worker.js`), D1/SQLite, Wrangler 4.151.3. Node minimum 22.13;
  audit runtime Node 24.22.1/npm 12.2.1 on Windows. Fresh `npm test`: **179 pass, 0 fail, 0 skip**.
  The previously reported 183-test result belongs to a different historical snapshot including #15.
- Git worktrees isolate each topic. Existing work on `claude/allow-browser-zoom` and
  `claude/offline-prefetch-status` is preserved. Main is never reset to the historical SHA.
- Read contributor rules, README, CLAUDE, package scripts, licence/NOTICE and PR discussions.
  No tracked AGENTS.md was found. Preserve attribution and upstream branding for these contributions.
  A separately hosted public fork needs the NOTICE naming/icon/source requirements.
- `app.js` coordinates browse/preview/drive/ride/watch and owns search, origin, selected route,
  GPS, sharing and timers. `core.js` owns account/settings/places/API state; `panels.js` renders
  account/settings/saved places/feedback. `nav.js`, `dead-reckoning.js`, `train-guide.js` handle progress.
- `offline.js` schedules route tiles; `sw.js` caches shell, map metadata and bounded tiles;
  `update.js` compares version fingerprints. A cached map is not an offline routing engine.
- Worker APIs cover auth/recovery/me, places/import, reports/votes, route/search/reverse,
  transit, parking/chargers, presence/stats, live sharing and feedback. `src/lib/` contains
  auth/schema, routing/providers, transit, traffic/probe, toll, capacity and search logic.
- Migration chain currently ends at `0012_feedback_closed.sql`; lazy schema bootstrap also exists.
  The deployment readiness script warns about generated places/types, construction and cameras.
  Full Overture downloads are not needed for deterministic tests and were not run.
- Existing tests use Node's test runner and SQLite. No PR CI workflow exists at this baseline.
  Browser testing is being introduced with local component fixtures and mocked API responses.

## Original PR dependency audit — 29 October 2026

The initial 40 PRs were inventoried, including closed/merged ones; open PR diffs and relevant reviews
were read. A later refresh found #41 and a substantially revised #11, before starting M2. See
[PR inventory](A2B_PR_INVENTORY.md) for the latest saved numbers/titles/statuses, including this work.
Status is a dated observation and must be refreshed before the next theme.

| PR | Current scope / dependency decision |
|---|---|
| #8 | Open optional TOTP/auth protection. Coordinate recovery/session changes; do not recreate TOTP. Its migration number predates current main and needs reconciliation. |
| #11 / #41 | Open search work revised during this audit. #11 now proposes static merged OSM/Overture/Foursquare plus smaller D1 change/suggestion tables, addressing its earlier bulk D1 capacity concern; head `3287e0ba`. #41 splits out Google last-resort search; head `1fea54cf`. Both overlap search lifecycle and must be reconciled, not cherry-picked implicitly. Cost/source terms still need owner review. |
| #14 / #16 | Merged explicit start on closure fallback / browser zoom. Preserve both regressions. |
| #15 | Open, mergeable and clean; head `474f670b624bcfdee360aeb418060efc7d924896`, fork branch `claude/offline-prefetch-status`. Any offline prefetch extension must visibly depend on this PR. Shell-only work may start from main. |
| #17 / #22 / #23 | Open weather / fuel cost / rest stops. Overlapping rest reminders and stale/missing external data need coordinated review. Do not duplicate UI. |
| #24 / #33 | Open motorcycle routing / model. #33 depends on #24. |
| #25 | Open school zones. Validate source/time rules before claiming a legal limit; do not hardcode assumed school schedules. |
| #26 / #27 | Open parked-car / parking entrances. #27 has maintainer request to resolve main conflicts. |
| #29 | Open faster-route offers. Review closure-fallback handling against #14 before acceptance. |
| #31 | Open 3D junction view. Review inferred guidance and reduced motion rather than add another junction UI. |

Merged features include train and walk (#20, superseding #10/#19), scheduled charger refresh (#21),
traffic opt-in (#6), category search (#18), expressway exit signs (#28), tunnels (#30), unnamed map POIs
(#32), train guidance (#34), guest recents and keyboard changes (#36, incorporating #35), integration
fixes (#38), and feedback close/reopen (#40).
Main already has origin selection, train alternatives/timing, trip resume, POI categories and destination
deep links. Malay search synonyms are not a Malay interface. #38 fixed a duplicate top-level declaration
which unit tests had missed: module syntax and browser smoke coverage are necessary.

## Register conventions

Priority P0 protects private data/account control or prevents a false journey end; P1 protects core
journeys; P2 improves usability/operability. **Confirmed** means current code or a local reproduction
demonstrates the issue. **Risk** needs a targeted reproduction. **Product** is a benefit to implement,
not a defect claim. **Existing/PR** means avoid duplication. `queued` is not done; `in progress` means
an isolated implementation exists but still needs review. Each row states the reproduction/check,
cost effect, approach and acceptance so a maintainer can reproduce the next step.

| ID / priority / kind / status | User problem; evidence and reproduction | Dependency / cost-data | Approach and acceptance |
|---|---|---|---|
| M1-A P0 Confirmed / in progress | Unverified signup email can grant tester access to private stats/inbox. `worker.js:isTester`; synthetic allowlisted email signup returned stats 200 before fix. | Independent of #15; coordinate #8. No new provider; ID env config only. | Explicit owner/tester immutable account IDs; tester demo separate from private management. No auto-promotion by email. Forged-email signup denied; tester denied private endpoints; provisioned owner allowed server-side. Owner must verify the actual IDs. |
| M1-B P0 Confirmed / in progress | Recovery SELECT then UPDATE can accept two concurrent uses; `auth.js:consumeRecoveryCode`, `/api/recover`. Race the same synthetic code. | Coordinate #8; one local migration for account attempts; bounded DB writes, no mail service. | One gated D1 batch changes credential, rotates code, revokes sessions and issues winner session. One winner only; losing request no cookie; injected failure rolls everything back. Regenerated code shown once; per-account attempts do not lock every shared-IP user. |
| M1-C P0 Confirmed / in progress | Origin name interpolated into route-status HTML (`app.js:openPreview`); password uses visible browser prompt (`panels.js:openSettings`); malformed percent cookie throws (`auth.js:readCookie`). Use harmless HTML place text, Settings password action, malformed synthetic cookie. | Coordinate #8/B; local DOM only, no provider cost. | Text node + separate spinner; labelled masked form, confirmation, busy/error/retry/focus; invalid cookie becomes unauthenticated. No injected nodes/handlers; one request per submit; late response cannot reopen panel. |
| M1-D P0 Confirmed / in progress | `tunnelTick/stopReckoning` recreates expired reckoner; `driveTick/Nav.update` lets estimated fix latch arrival. Feed estimates past 90s/2.5km and to endpoint. | Independent; preserve #30/#38. No API cost. | Latch exhausted episode until fresh accurate real GPS. Estimated display/guidance cannot arrive or stop sharing. Real destination fix still arrives; repeated ticks cannot renew budget. |
| M2-A P1 Confirmed / queued | `runSearch/searchSeq` advances on run, not every clear/close/query change; debounce leaves stale responses live. Defer A, clear/close/type B/change target, then resolve A (including Enter). | Preserve `matchesWordStarts`, Home/Work and #36. Cancellation should reduce requests. | Shared generation, cancel/debounce invalidation on all transitions. Old success/error/Enter must not render, save or preview. |
| M2-B P1 Risk / queued | Preview/transit/reroute guards do not snapshot whole journey; `openPreview/showTransit/reroute/endDrive/requestRoutes/api`. Resolve B then A with same destination/different origin; end drive A and start B before reroute A resolves. | Coordinate #29 and #14. Timeout/cancel reduce waste. | Preview generation and drive ID; snapshot origin/destination/mode/preferences, signal/deadline, release locks on abort. A cannot alter B route/voice/ETA/sharing or countdown. |
| M2-C P1 Confirmed / queued | `startLocation` drops watch ID; timeout retry adds watchers; `locationFailed` labels errors as off. Simulate repeated timeout/manual retry. | Coordinate M1-D; local battery/timer improvement. | Idempotent watcher/retry owner. Max one each; denied does not loop; valid fix clears transient status. Distinguish acquiring, inaccurate, timeout and unavailable. |
| M2-D P1 Risk / queued | Combined local/server search and route enrichment can lose useful partial result or stall. Mock one provider reject/stall with other success in `runSearch`, routing libraries. | #11 may change search; existing providers only. Bounded deadlines/backoff. | Preserve/dedupe successful sources, honest limited result; base route survives failed optional enrichment. Measure deadlines with synthetic timing, no public load tests. |
| M3-A P1 Confirmed / queued | `sw.js:SHELL` omits imported `route-preview.js` and `probe.js`. Install clean SW, clear HTTP cache, go offline, reload. | Shell fix independent of #15. Adds two small local modules to existing precache. | Complete local import graph + automated graph and real offline cold-start tests. Previously installed shell opens offline; never claim a never-visited site works offline. |
| M3-B P1 Risk / queued | `prefetchRouteTiles` lacks generation/signal/deadline; stop/disable/clear/reroute can leave old progress. Use stalled mock fetch and route A resolving after B. | Must build on #15, not hide it. Trip-level cap, dedupe, soft byte stop. | Cancel old schedule/progress, reject stale completion, bound workers and share budget across reroutes. Cover stop/disable/clear and hung metadata/tiles. |
| M3-C P1 Confirmed / queued | `tilesForCoords` visits vertices, missing middle of sparse segments; flattened TileJSON templates lose required-source identity. Compare sparse/dense route; fail one vector source. | Stack on #15. Sampling/traversal bounded by same budget, no bulk public downloads. | Ordered corridor traversal, preserve sources vs alternative URLs. Equivalent corridors; missing metadata never complete; all tile/byte/HTTP/reject/stall tests. Complete means known candidate coverage, not durable storage. |
| M3-D P1 Confirmed / queued | `watchUpdates` returns after offline version lookup, so reconnect lifecycle never starts; `refresh` unconditionally reloads. Inspect shared-drive early boot and 503 SW responses. | Independent shell/update theme; extra version lookup only on lifecycle events. | Listeners survive offline boot; loaded-version identity; cached public shell fallback on transient failure, never `/api/*`; no auto reload in drive/train. Test reconnect and active trip. |
| M4-A P1 Confirmed / queued | `auth.js:currentUser` extends database expiry, no corresponding response cookie renewal. Age synthetic cookie/session into sliding window. | Coordinate #8/B; no new service. | Return renewal metadata to response wrapper, same security flags/hard cap. Assert actual Set-Cookie expiry, not DB alone. |
| M4-B P1 Confirmed / queued | Places endpoint shared LIMIT 100 can hide saved places behind recents. Seed 100 saved +20 recent and repeat import. `worker.js` place query. | Existing SQLite only; bounded independent reads. | Separate buckets/limits or pagination; no saved disappearance; communicate limits and idempotent imports. |
| M4-C P1 Confirmed / queued | `core.js:removePlace/renamePlace/setHomeWork` mutate before failed API; panels can show success despite error. Mock failures, mixed clear-history results. | No provider changes. | Confirmed mutation or rollback; failed items remain, errors/retry visible; no false success toast. |
| M4-D P1 Risk / queued | Vote/reward entitlement may repeat through still/gone cycles and race. Alternate votes and race synthetic votes in worker/report logic. | Local DB migration likely; no live reports. | Separate mutable vote from one-time reporter reward, atomic counters/expiry/removal. Repeated same contribution never mints rewards. |
| M4-E P1 Risk / queued | Hard beta capacity and reserved-slot claim may race. Concurrent synthetic presence/admission at limit. | Preserve owner reserved slots and renew/expiry; no production load. | Atomic admission if hard cap advertised; shared-IP-friendly expensive endpoint budget. Prove limit under local concurrency. |
| M4-F P1 Risk / queued | Latest lazy schema + old ALTER migrations can duplicate columns. `schema.js`, `migrations/`. Apply chain to blank/legacy/bootstrapped DB twice. | Reconcile #8/#11 and current numbering first. Local D1. | One authoritative lifecycle and safe upgrade recovery; preserve data. Verify empty, populated, repeated paths; describe rollback limitations honestly. |
| M4-G P1 Confirmed / queued | `readJson` counts string units rather than bytes; nested null/array input may throw; worker catch exposes raw error text. Send multibyte body and invalid shapes locally. | No paid service; early reject reduces work. | Bounded byte reader, shape/range/finite validation, structured 400/413 and sanitized 500. No SQL/stack/secrets in response. |
| M4-H P1 Risk / queued | Deletion/retention and stopped share payload need data map; stable probe identifiers are not necessarily anonymous. Inspect schema, probe, presence, sessions, shares, feedback. | Owner policy choices explicitly pending. No production deletion. | Delete unneeded recovery/session/presence artifacts; test revoked link disclosure; document retention/linkability accurately. Technical cleanup can proceed without legal-compliance claims. |
| M5-A P2 Product / queued | Inconsistent phone focus, semantics and overlap across map/search/preview/drive/train/saved/settings/share/feedback/offline. `index.html/styles.css/panels.js/app.js`. | Keep map dominant and current framework. Local CSS, no paid asset. | Apply DESIGN.md tokens; keyboard routes/results, focus return, meaningful states, 320–1280 widths, landscape/light/night/long names/text zoom. Screens rendered must have synthetic before/after evidence. |
| M5-B P1 Confirmed / queued | Global `window.matchMedia` override masks reduced motion for whole app. `app.js` boot. Emulate reduce and inspect matching plus map motion. | Coordinate #31; no data cost. | Restrict library/component animation config without lying about OS preference; retain browser/text zoom from #16. |
| M5-C P2 Product / queued | UI `lang=en`, voice filters English; Malay category synonyms are not language selection. `index/core/voice/nav`. | Provider language support must be verified; no mandatory translation/TTS service. | Small persistent English/BM dictionaries, correct document.lang, formatting/status/provider requests and honest device voice fallback. Test missing keys, late voiceschanged, off/no synthesis. |
| M6-A P2 Product / queued | Search always prefers current GPS even after map pan; explicit map-area anchor absent. `runSearch`. | Follow M2-A/D; use current search providers and bounds. | Near me/Search this area with clear chosen anchor/ranking; map search uses selected map centre, not silent GPS. |
| M6-B P2 Existing/PR / deferred | Petrol/clinic/hospital etc already supported; parking/EV and R&R have existing APIs/PRs. | #21/#23/#26/#27/#34; no invented datasets. | Add shortcuts only for proven source/pipeline categories; do not advertise unsupported mosque/surau/R&R. |
| M6-C P2 Product / queued | Pre-trip GPS/voice/network/offline readiness scattered. Existing preview and #15 status. | Follow M1/M2/M3; local state only. | Brief status in preview with one Go action; distinguish map coverage from offline routing, no long confirmation ritual. |
| M6-D P2 Product / queued | Destination `/?to=lat,lng&name=` deep link exists, share/copy UI can complement live sharing. | Existing/independent; no server session needed for destination link. | Native share, copy and manual fallback; exact user-chosen destination only. Test unsupported clipboard and rejection. |
| M6-E P1 Risk / queued | Live clipboard/native-share/revoke outcomes may overstate success. `app.js` sharing functions. Reject clipboard, cancel share, fail revoke locally. | Existing share endpoints; no extra recurring calls except retry. | Reflect server session and copy state separately; accessible Stop/retry; cancellation does not silently revoke or lie that link stopped. |
| M6-F P2 Product / queued | Toll unknown vs zero; stale ETA/transit data needs confidence. `tolls`, transit, preview; #20 reviewer requested station-to-station external link. | #17/#22; official current fuel/transit/weather sources required when changing data. | Source/age/estimated/unknown labels, preserve external live-info path; no closed-system toll matrix claim from booth sums. |
| M6-G P2 Product / queued | Feedback already includes app/UA; consent/preview/category should make actual payload clear. `panels.js:openFeedback`, worker feedback. | #40 private inbox access M1-A. Small bounded text only. | User previews consenting metadata; no automatic precise location/route/account secrets; never log submitted content. |
| M7-A P1 Product / in progress | Unit suite does not boot real modules; #38 syntax bug escaped. | Component browser harness starts in M1-C; no production API. Dev-only Playwright. | Unit/API + Chromium/WebKit integration, syntax checks, CI with minimal permissions/no secrets. Full map journey remains separate from component checks. |
| M7-B P2 Product / queued | No reproducible latency/request/long-task baseline yet. | M2/M3; deterministic mock timings only until controlled fixture exists. | Record repeatable first render/search/route requests/watchers/data; no invented Lighthouse or improvement percentages. |
| M7-C P1 Confirmed / queued | `check-places.mjs` warnings allow missing generated data; freshness/resource checks incomplete. | #11 data architecture pending; transit expiry date is feed metadata, not a live-service promise. | Production readiness checks for generated type/places, construction, camera, GTFS expiry, resources; small local fixtures keep dev viable. Do not deploy against owner's production bindings. |

## Original review checkpoint — 29 October 2026

| Theme | Branch / current result | Review |
|---|---|---|
| M1-A trusted access | `claude/trusted-account-access`, `99ed819`; implementation/test complete, owner ID provisioning pending | [Draft #42](https://github.com/thaqif0709/a2b/pull/42), 180 unit/API tests |
| M1-B recovery + malformed cookie | `claude/atomic-account-recovery`, `f397fc2`; implementation/test complete, local D1 validated | [Draft #43](https://github.com/thaqif0709/a2b/pull/43), 185 unit/API tests |
| M1-C safe route text/password form | `claude/safe-account-forms`, `ecf1ba7`; implementation/test complete | [Draft #45](https://github.com/thaqif0709/a2b/pull/45), 179 unit/API + 10 Chromium/WebKit component cases |
| M1-D GPS estimate episode/arrival | `claude/bounded-gps-estimates`, `13c64ad`; includes route-replacement suspension and bounded sharing retries; physical GPS not tested | [Draft #44](https://github.com/thaqif0709/a2b/pull/44), 199 unit/API cases + GPS chip component smoke |
| M2-A / partial M2-D search | `claude/search-request-lifecycle`, `8fb11d7`; stale results and rejected-provider partial results fixed | [Draft #47](https://github.com/thaqif0709/a2b/pull/47), 199 unit/API tests + Chrome/WebKit component smoke; hung-source deadlines remain queued |
| M2-B routes | `claude/route-request-lifecycle`, `c2d389e`; input/trip ownership and browser deadline implemented | [Draft #48](https://github.com/thaqif0709/a2b/pull/48), 188 unit/API tests + Edge synthetic preview; server enrichment deadline remains queued |
| M2-C geolocation | `claude/geolocation-lifecycle`, `31a98cd`; one watcher/retry and distinct states | [Draft #49](https://github.com/thaqif0709/a2b/pull/49), 185 unit/API tests + Chrome component smoke |
| M3-A shell graph | `claude/offline-shell-graph`, `fa2fd59`; both missing imports precached and guarded | [Draft #50](https://github.com/thaqif0709/a2b/pull/50), 181 unit/API tests + actual cold offline browser boot |

M1 rows marked in progress above refer to the overall review/rollout gate: code is complete in the
listed PRs, not deployed. They are not claims that every broader account/navigation issue is fixed.
M2-D remains partial: failed-source results survive, but hung search sources and server enrichment still
need deadlines. M3-B/C/D (trip prefetch budgets/cancellation, corridor/source completeness and update
recovery), M4–M7 overall remain queued except the explicitly recorded browser testing/design baseline.

### Stop/resume checkpoint

Afham requested stopping after the work already in progress, to conserve usage. No new theme or PR is
to be started in this batch. Nine draft PRs (#42–#50) are submitted; none is merged or deployed by this work.
The integrated local verification branch `claude/phase-integration-check` at
`cc15c1ccde36b9955623730ce35a02647b3d3add` passed 243 unit/API tests, 10 Chromium/WebKit component
tests and the cold offline browser check (27 local modules from SW). It is a test composition, not
another PR or a bulk merge recommendation. Individual PR branches remain focused on their own themes.

Resume order after the usage limit resets and Afham asks to continue:

1. Before choosing any new work, inventory **all current PRs** (open, newly merged and closed), read new
   diffs/reviews/dependencies, fetch current main, reread changed project rules and inspect local user changes.
   Inspect the current A2B Beta website at https://a2b-beta.pages.dev/ as well as the current repository;
   keep live observation read-only and use local/synthetic fixtures for testing. Do not assume today's
   heads, features, defects or priorities persist. Afham explicitly reiterated this requirement at the stop checkpoint.
2. Address review findings/conflicts in the submitted PRs first. Preserve the integration resolution notes
   in A2B_VERIFICATION.md; do not recreate any of the already submitted changes.
3. Only after that fresh review, select still-relevant work that is not already covered by someone else's PR.
   The provisional next item is hung-source search and server enrichment deadlines (M2-D), with partial-result tests.
4. Then extend offline prefetch visibly on #15 if still open (M3-B/C), followed by update/reconnect (M3-D).
5. M4 data/backend, M5 broader accessibility/BM, M6 remaining product flows and M7 CI/performance/readiness
   remain future work, not implemented milestones.

Additional known sharing boundary: client acknowledgement guards and retry cadence do not serialize
overlapping server PATCH writes. Versioned/ordered live-sharing updates remain a separate M6 follow-up.

## Working sequence and boundaries

1. M0 documentation is reviewable independently. M1 access, atomic recovery, safe account/route text,
   and bounded GPS use separate topic branches based on audited main. Overlapping edits to panels,
   worker/auth and tests require an integration check after owner chooses merge order; do not bulk merge.
2. M2 race/watcher work follows safety fixes. M3 shell graph can be independent; tile-prefetch work
   visibly stacks on #15 until it merges. M4 is split by domain, migrations coordinated before numbering.
3. M5 language and navigation UI follow lifecycle stability. M6 adds only genuinely missing flows.
   M7 checks accompany each change, then cover combined journeys, performance and readiness.
4. Not yet claimed: physical iPhone/on-road testing, full offline routing, guaranteed background GPS,
   national live traffic, CarPlay/Android Auto, compliance certification, hard bandwidth cap, permanent
   browser cache retention, or any production change.

Provider checks: [D1 batch atomicity](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[service-worker lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers),
[WCAG 2.2 target minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html),
[OpenFreeMap](https://openfreemap.org/), [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill).
OpenFreeMap's public offer does not establish unlimited capacity for D1, routing, geocoding, transit or
other providers. Inspect their official current policies when those integrations are changed.
