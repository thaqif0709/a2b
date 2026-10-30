# Complete the offline frontend shell

## Review refresh — 30 October 2026

- Merged upstream `7ff9dda` into PR #50 and resolved the shell conflict additively: retain upstream `suggest.js` and this PR's `route-preview.js` / `probe.js`.
- Upstream already uses cache v39, so this updated shell advances to v40.
- `npm test`: exit 0, 193 passed / 0 failed / 0 skipped. Graph: all 26 current local modules covered.
- `npm run test:offline-browser`: exit 0. Fresh installed service worker, ordinary HTTP cache cleared, original page closed, local server stopped, then new offline page: app/menu boot, all 26 local modules and both MapLibre assets from SW, zero page errors and zero requests reaching the stopped origin. New `/api/driver-places` remains network-only and fails offline as expected.
- No prefetch changes from #15 included; pending #58's new local module must be checked by this graph if it lands later. Historical results below refer to the original branch base.

Base: upstream `134045abe40e3fd50f73fb24437c4ef4a2920509`. Independent of partial tile coverage PR #15;
no prefetch, tile-budget or completeness logic from that PR is copied here.

## Changes

- Precache `/route-preview.js` and `/probe.js`, required imports missing from the current shell.
- Advance the shell cache from `a2b-v38` to `a2b-v39` so already installed workers refresh their shell.
- Add a graph check that observes the real service worker install list, discovers HTML module entrypoints,
  parses static imports/re-exports using Node's JavaScript parser, follows literal dynamic local imports,
  checks transitive/cyclic dependencies and fails on missing files or syntax errors.
- Add a default unit regression plus fixtures proving transitive and lazy omissions and syntax errors fail.
- Add an optional portable Chromium cold-start test with real app modules, real MapLibre4.7.1 and the real
  service worker. Development-only Playwright1.62.1 matches #45's test tooling; no runtime framework added.

The graph covers statically identifiable local dependencies. If future code computes a local import URL
at runtime, declare/test its precache requirement explicitly; computed remote Three.js is not silently
claimed as part of the local graph.

## Verification

Windows, Node24.22.1/npm12.2.1. Before the shell change, the new test failed naming exactly
`/route-preview.js` and `/probe.js`. After the change:

- `npm test`: exit0, **181 pass / 0 fail / 0 skip**.
- `node --experimental-vm-modules --no-warnings scripts/check-offline-shell.mjs`: exit0, **25 local modules** parsed and covered.
- `npm run test:offline-browser`: exit0, actual cold offline app/MapLibre boot and menu interaction pass.
- `npm run test:offline-browser -- --baseline`: compares the original upstream v38 worker with the same
  frontend and confirms cold boot fails on the two missing imports. Requires the baseline commit in Git.
- `git diff --check`: exit0.

Install development dependencies using `npm ci`. If needed, install only the optional browser with
`npx playwright install chromium`. The browser fixture downloads two fixed MapLibre JS/CSS files once
from the existing configured CDN and replays them locally; it makes no public tile, route or geocoder
requests. No large generated places download is needed. Artifacts go to ignored `test-results/offline-shell`.

Each run uses a fresh context. A wrapper supplies an empty map style; GPS and APIs are synthetic.
After actual SW installation, the harness clears ordinary HTTP cache, closes the original page,
stops its local server, disables external fixture responses, and sets the context offline. A new page
opens the same origin; no live server or mock response can rescue a missing cache entry.

| Cold-start observation | Original v38 | Fixed v39 |
|---|---|---|
| Shell Cache Storage entries | 27 | 29 |
| Missing local module imports | route-preview.js, probe.js | None |
| Actual frontend + MapLibre boot | Fails | Passes |
| Local JavaScript responses via SW | 22 before failure | All25 |
| MapLibre JS/CSS via SW | Both | Both |
| Local origin requests after shutdown | 0 | 0 |

Scope limits: installed/warmed SW cache only, not a site never visited. Empty fixture map does not prove
tile coverage, offline routing, offline trip restoration or durable cache retention. API/version requests
fail offline as expected. Optional Three.js is blocked; no 3D vehicle claim. Chromium/desktop Chrome
at a phone viewport is not a physical iPhone/PWA/background-GPS test. No deployment or CLA acceptance.

Integration: preserve `/location.js` and `/request-lifecycle.js` additions from the separate M2 PRs when
resolving SHELL conflicts, and rerun the graph/browser checks on the combined tree. #45 adds the same
Playwright version and a separate `test:browser` script; keep both scripts when merging package.json.
