# Bounded GPS estimates and confirmed arrival

Review base: upstream `main` at `134045abe40e3fd50f73fb24437c4ef4a2920509`.

## Problem reproduced

Synthetic tests of the upstream `app.js` and `nav.js` functions reproduced two failures:

- After the 90-second estimate budget ended, the next timer tick started another estimate. At 8 m/s, this happened 92 seconds after the last real fix (including the initial gap). The 2.5 km budget failed the same way at 70 m/s, after 47 seconds.
- An estimated position at the destination announced arrival, changed the app to browse mode and sent `ended: "arrived"` to the shared-trip endpoint.
- Follow-up review found that replacing a route during GPS loss reused its old distance origin. The actual reroute/tunnel fixture at `8895c07` reproduced a jump from more than 5 km along the old route to the endpoint of a new 222 m route. The periodic sharing timer could also publish an estimated `live.snapped` position despite the guard in `driveTick()`.

## Changes for review

- `public/dead-reckoning.js`: keep a GPS outage exhausted after either budget is reached. Later timer ticks cannot restart it. Only a new real measurement with valid coordinates, accuracy at most 80 m and age at most 2.5 seconds clears the outage. Duplicate, stale, future, inaccurate and estimated fixes do not clear it. Ending a drive resets its lifecycle.
- `public/app.js`: retain the original GPS measurement timestamp separately from the movement timestamp used for speed calculation. Apply strict recovery validation only near a tunnel or during an active, exhausted or suspended estimate; ordinary real fixes retain main behavior. Keep the `NO GPS` chip visible with `Waiting for GPS` after exhaustion; resume normal positioning on a suitable real fix.
- `public/app.js`: pass estimated provenance into navigation. Estimated progress can update the arrow, distances and turn guidance, but cannot consume a stop, trigger rerouting, publish a position, finish a drive or end trip sharing.
- Route replacement during active, exhausted or stale GPS suspends the existing episode and clears the old route progress without renewing its budget. The new line can be drawn while the marker waits for a newer accurate fix. A delayed response uses the latest fresh accepted position, never the position captured when the request started.
- The trip-sharing heartbeat also checks freshness and outage state. A replacement route held during GPS loss is sent with the next real recovery fix and retried until the server acknowledges it. Only a newly replaced route bypasses the normal send cadence; retries for the same unacknowledged route follow the existing movement/ETA/heartbeat rules, with no added polling timer. Late acknowledgements cannot mark another sharing session or route as updated.
- `public/nav.js`: estimated positions cannot latch arrival or consume arrival/stop voice cues. While progress is still based on an estimate, off-route recovery fixes cannot confirm or announce the destination or consume a stop, including before the off-route counter reaches its threshold. A real on-route recovery clears that condition. Outside estimate recovery, real GPS retains main's existing stop/arrival behavior.
- `test/dead-reckoning.test.js`, `test/nav.test.js`, `test/gps-lifecycle.test.js`: cover both budgets, continued ticks after exhaustion, invalid/repeated recovery fixes, stationary GPS timestamps, subsequent outages, stop confirmation, arrival voice cues and the actual app path through `arrive()` / `endDrive()` / the shared-trip update. Deferred reroute fixtures cover active/exhausted route replacement, long requests, a newer position arriving while a request is pending, and sharing after recovery. The fixture includes the separate route-lifecycle change's `resetTripRequests` hook for combined validation.

The controller stays in the existing cached `dead-reckoning.js` module; no new service-worker shell dependency is needed. Transit guidance and the shared text-matching import remain in place.

## Validation

- `npm test`: 199 passed, 0 failed on 2026-10-29 after the route-replacement follow-up, including existing transit and search tests. Slow/failed PATCH fixtures with per-second stationary GPS send at 0, 4, 34 and 64 seconds, then send a new route immediately at 65 seconds; failures do not falsely acknowledge the route.
- The new app tests execute the actual app functions with synthetic GPS, a controlled clock, a small DOM substitute and stubbed network effects. Three further minutes after each exhaustion produce no movement. Estimated arrival keeps the trip open; a subsequent real destination fix sends exactly one shared-trip completion.
- Baseline reproduction uses the upstream app/navigation functions with the same synthetic fixtures. No public routing/map endpoints or real trip data are used.
- Chrome 156 component smoke used the actual HTML/CSS, episode controller and `renderTunnelStatus()` function with synthetic GPS states. Estimating, suspended/exhausted waiting and recovered-hidden states passed at 320, 375 and 812 px widths in day/night themes, with no page errors. Reproducible local harness: `work/m1-gps-reroute-browser.mjs`; log: `work/m1-gps-reroute-browser.log`.
- The browser smoke bypasses map/app boot and uses synthetic episode inputs. It does not establish real permission, hardware GPS, background navigation or on-road behavior; those remain untested.

Actual component captures from the same fixture:

![Estimating after GPS loss](../screenshots/gps-estimating-chip.png)

![Waiting for GPS after suspension or exhaustion](../screenshots/gps-waiting-chip.png)

Remaining sharing boundary: the late-acknowledgement guard protects client bookkeeping, not ordering of
overlapping PATCH writes at the server. Ordered/versioned outbound sharing is a separate follow-up;
these tests do not claim to solve that existing race.

Submitted for owner review. No CLA acceptance, merge or deployment was performed.

## Review follow-up — 2026-10-30

- Addressed [review 5709612594](https://github.com/thaqif0709/a2b/pull/44#pullrequestreview-5709612594). Merged upstream `7ff9dda`, retaining landscape, smooth GPS correction, motorcycle, suggestions and train behavior.
- `handleFix` rejects vague/stale/repeated fixes only near a tunnel or during an active, exhausted or suspended estimate. Ordinary Drive, Walk and Motorbike GPS still moves the marker as on main. Fresh measurements still update episode bookkeeping so repeats cannot release a later outage.
- Navigation tracks whether its retained progress came from an estimate. Only that recovery requires a real on-route fix before stop/arrival confirmation; ordinary real-GPS stop cues and arrival keep main's conditions. Estimates still cannot complete a trip, end sharing or reset the outage budget. Sharing and rerouting still reject an actual GPS callback gap and active/exhausted/suspended estimates, while ordinary weak or repeated real callbacks remain usable.
- Added regressions for ordinary weak/stale/repeated fixes in all three travel modes, tunnel-ahead rejection, and main-compatible real stop/arrival behavior. Existing bounded-budget, estimated-arrival, off-route recovery and sharing tests remain intact.
- `npm test`: exit 0, **217 passed, 0 failed, 0 skipped** (Node 24.22.1). App/navigation syntax, `git diff --check` and `git merge-tree --write-tree upstream/main HEAD`: exit 0.
- Chrome 156.0.8078.48 component smoke rerun against current HTML/CSS and status renderer, widths 320/375/812, day/night, estimating/waiting/exhausted/recovered; no page errors. GPS and network effects remain synthetic. This is not a hardware GPS or full-map/on-road verification.

### Reroute and sharing scope correction

A follow-up cross-review reproduced one remaining route into the same freeze: an ordinary weak fix was accepted, but rerouting still applied the strict accuracy threshold globally and suspended the episode. Sharing also silently dropped that ordinary fix.

- `currentGpsUsable()` now checks recent accepted real callback receipt (`lastFixAt`) for ordinary navigation. Strict measurement accuracy/age checks additionally apply near a tunnel. Active, exhausted or suspended estimates and an actual callback gap over 2.5 seconds still block old progress, including before the next timer runs.
- `tunnelFixAt` follows callback time, as on main. A stale/repeated measurement timestamp alone no longer starts a false outage while ordinary real callbacks keep arriving. Recovery during a tunnel/estimate still requires a newer fresh accurate measurement.
- Reroutes use the latest usable real position, never the captured request position. No outage budget is renewed by a route replacement.
- Four added regressions failed before this correction, then passed: ordinary weak Drive/Walk/Motorbike fixes can share, reroute and keep moving; current callbacks carrying old measurement timestamps do not create a false outage. Existing active/exhausted and timer-delayed outage replan/sharing tests still pass.
- Final `npm test`: exit 0, **221 passed, 0 failed, 0 skipped**. App syntax and `git diff --check` pass. Browser scope from the preceding verification remains component-only; this correction changes the tested lifecycle logic, not the rendered UI.
