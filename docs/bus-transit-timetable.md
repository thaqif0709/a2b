# Bus and suburban rail in the ride timetable

## Why

A2B's ride mode currently plans around Rapid Rail (LRT/MRT/Monorail/BRT) and KTM Komuter. Many parts of Malaysia are not on those lines, so "plan by transit" silently leaves them out. Adding buses (and eventually any feeder rail) gives door-to-door transit planning outside rail corridors.

This must happen incrementally. Buses have vastly more stops, lower speed assumptions and road-based dwell, and feed data is larger and less predictable than the rail feeds. The phases below keep each slice checkable before the next.

## Non-goals (for now)

- Replacing train planning with a unified graph (train remains the quality baseline).
- Real-time bus arrival or operator APIs beyond published GTFS.
- Door-to-door bus guidance in `train-guide.js` before trip planning is stable.

## Phase 0 — Data discovery (done)

Phase 0 complete: see "Phase 0 findings (Rapid KL bus feed)" below.

Goal: prove the official bus GTFS feed can support a small, cheap offline slice.

Tasks:
- Check `api.data.gov.my/gtfs-static` (and its discovery docs) for a Rapid Bus feed location, coverage and end date.
- Download one feed without committing it; inspect `routes.txt`, `stop_times.txt`, `trips.txt`, `calendar.txt`, `shapes.txt`.
- Measure feed size, stops, routes, and services for Kuala Lumpur/Petaling/Klang/other target areas.
- Compare bus stop naming and coordinates to existing search/place data, for a later in-app stop search.
- Decide whether buses are grouped by Rapid bus concession (KL, Selangor, Penang, Johor) or by metro region.

Acceptance: a short note (in this doc) of the feed URL(s), expiry date(s), rough stop/route counts, and whether the feed is usable.

## Phase 1 — Isolated bus transit data (done)

Phase 1 complete: `scripts/build-transit-bus.py` now generates `src/lib/bus-transit-data.json` (~606 KB, 139 lines, 4106 stops, 338 patterns). `npm run transit:bus` rebuilds it. Rail `transit-data.json` is untouched.

Goal: barrels bus routes/stops into a separate data file, not touching the rail bundle.

Likely files:
- `scripts/build-transit.py` gains a bus feed entry.
- `src/lib/bus-transit-data.json` as a separate bundle (keeps `transit-data.json` untouched until proven).
- `src/lib/bus-transit.js`, a clone of the patterns-based board/board-plan code in `transit.js`.

Tasks:
- Add a second builder path for bus GTFS, reusing the title/clean station names, Haversine and polyline helpers.
- Store bus stops/lines/services headways separately from rail stops.
- Reuse current service-day helpers, but add bus-oriented defaults for dwell and wait.
- Add `npm run transit:bus` (or extend `npm run transit`) and report sizes in `scripts/check-transit.mjs`.

Acceptance: the builder passes and the produced bundle is size/diff-checkable; `npm run transit` remains green for the rail-only world.

## Phase 2 — Planning integration (in progress)

Phase 2 slice: added `src/lib/bus-transit.js`, a bus-only clone of the train Dijkstra planner plus `test/bus-transit.test.js`. It is isolated (no wiring into app/worker yet).

Goal: add bus-only and rail+bus proposals behind a flag, without changing user-visible ride mode.

Likely files:
- `src/lib/bus-transit.js` gets a Dijkstra planner mirroring `routeTrip` in `transit.js`.
- `src/lib/transit.js` gets a guarded combined search that keeps all train trips plus bus alternatives in an `options` array.
- `test/bus-transit.test.js` to mirror `test/transit.test.js`.

Tasks:
- Graph conversion: boarding stops are nearest stops within a walking radius, same as rail.
- Bus service model: frequency headways from GTFS, or single trips if available.
- Bus trip ranking: count walking more heavily for transfers and avoid extremely slow alternatives.
- Same-day only beyond what `serviceDay` already establishes; no overnight bus suggestion yet.
- Add bus-shaped trip key fields so the Worker and app can distinguish bus legs from train legs.

Acceptance: unit tests find bus trips where rail is absent and still find train trips unchanged; combined search returns at most the existing `MAX_OPTIONS` total sorted by effort.

## Phase 3 — Worker and walking routes

Goal: serve bus trips with the same real-walk replacement as trains.

Tasks:
- Update `requestRoutes` slotting (or create `requestTransitRoute`) so bus legs get real walking routes like rail legs.
- Whichever the Worker returns must mark bus legs so the app can render bus-specific guidance.
- Check Worker payload size and any caching assumptions.

Acceptance: preview by transit shows at least one mixed rail/bus trip end to end, with walking times recalculated.

## Phase 4 — Ride mode on buses

Goal: make following a bus trip feel like a train ride, but with road dwell.

Likely files:
- `public/train-guide.js` becomes `{ train-guide.js, ride-guide.js }` or adds bus-aware movement.
- `public/app.js` chooses guide based on leg mode.

Tasks:
- Model bus stops/locations as points along a road-shaped polyline and snap GPS like train-guide but with slower sane speed.
- Dwell defaults (bus stop wait) and long-delay alerts.
- Voice/alerts and arrival detection for buses, including skipped stops and frequent short hops.
- No tunnel-like dead-reckoning unless explicitly needed; buses don't need tunnel mode, but GPS can still drop.

Acceptance: an in-app bus trip can be followed, and stale GPS doesn't announce arrival incorrectly.

## Phase 5 — UX, search and offline

Goal: make bus options discoverable and useful.

Tasks:
- Show bus mode in trip card and station names in local list.
- Add from-here transit search entry for stops.
- Check service worker bundle and place data for size.
- Document bus coverage in README/notes.

## Buy-in

Buses are a reach-out feature for places that do not have rail access. Keep all steps gated and behind tests so rail quality does not regress.

## Phase 0 findings (Rapid KL bus feed)

- Feed URL: `https://api.data.gov.my/gtfs-static/prasarana?category=rapid-bus-kl`
- Agency: Rapid KL, timezone `Asia/Kuala_Lumpur`.
- Raw zip: ~1.7 MB.
- Counts: 140 routes, 2122 trips, 4107 stops, 88828 stop times, 69577 shape points, 3 calendars (weekday/weekend; both valid from 2020-04-01 to 2027-03-31).
- Calendar route types: all `3` (bus).
- This is substantially smaller than feared and is stable to 2027-03-31.

Implication: Phase 1 should be feasible without a massive bundle if we simplify shapes and combine into an optional file-backed bundle. Start with Rapid KL only, then expand by jurisdiction.

## Tracking

- Base branch for this work: `claude/bus-transit-timetable` off `main`.
- Related memory: monthly GTFS rebuild and train timetables expiry. Refresh this plan when the next transit release lands.