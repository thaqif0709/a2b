# PR #15 review refresh — 30 October 2026

The existing partial-offline-coverage PR now includes upstream `7ff9dda`, following the maintainer's request to merge current main. The earlier conflict had already been resolved at `474f670`; this refresh merges cleanly and preserves all subsequent upstream features.

The contribution still reports partial/unavailable coverage honestly instead of claiming a fully cached map after a tile limit or failed request. It does not add offline routing or guarantee permanent cache retention. It remains separate from PR #50's shell graph work.

Verification: Windows, Node 24.22.1; `npm test` exit 0, **195 passed / 0 failed / 0 skipped**, including the existing offline regressions. `node --check public/app.js`, `public/offline.js` and `git diff --check` passed. This update changes no visual behavior beyond the already reviewed contribution; no new physical-device/offline-road test is claimed.

CLA confirmation is a personal contributor decision. No agreement, production migration, merge to upstream or deployment was performed by this agent.
