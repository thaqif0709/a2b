# Places search performance plan

Status: Phase 0 landed on `claude/places-phase0-speed`. Phase 1 and 2 are planned only.

## Goal

Search must feel instant on the web and on a future native mobile build (iOS/Android), online or offline:

- First character to results: p95 < 200 ms when online, < 50 ms when data is already on the device.
- No multi-megabyte waits: a search must not fetch more than a few KB beyond what is needed for that query.
- Works with no connectivity once the local index is in place (web PWA after a few searches; native from first install where feasible).
- Keeps the ranking logic in `public/places.js` (`mergeResults`, venue detection, misplaced-place pruning) as the source of truth so results do not regress.

## What is slow today

`public/places.js` downloads a chain of tiny files:

1. `/places/index.json` with `cache: 'no-cache'`.
2. `files.json` for each of the ~9 areas around the user (0.5° cells).
3. Up to `MAX_FILES_PER_WORD` shards per word, for each area.
4. JSON arrays are parsed and filtered client side.

Typical cold search is 10-40 fetches. Parsing is cheap; the RTTs and the tiny-request overhead are not.

## Phase 0 (done): make the existing design reuse what it already downloaded

- `getJson` now keeps an in-memory `inflight` promise cache (unchanged behaviour) **and** a persistent
  `CacheStorage` entry under `a2b-places-data-v1`. Only URLs that are already release-stamped with `?v=`
  (shards and area file lists) are persisted; `index.json` keeps `cache: 'no-cache'` and revalidates.
- The service worker no longer evicts `a2b-places-data-v1` on activate.
- Release-tagged tiles are effectively immutable, so cached shards can be served with no revalidation.

Phase 0 gives: repeat searches are instant in the same tab and survive a refresh/new session without
downloading the same bytes twice. It does not reduce the number of distinct shards needed for a new query
or a quiet area.

## Phase 1: one candidate call instead of a waterfall

Move *candidate retrieval* (which rows might match) behind a single HTTP call and keep *ranking* on the
client initially.

### New endpoint

`GET /api/places/search`

Query parameters:

| param | required | notes |
|---|---|---|
| `q` | yes | free text; trimmed, max 120 chars |
| `lat`, `lng` | yes when online fix exists | WGS84 decimal degrees |
| `limit` | no | default 24, hard cap 50 |
| `kinds` | no | comma list from `TYPES` keys to restrict to category searches |
| `since` | no | unix ms; only rows newer than this are returned, for delta sync |

Response shape (unchanged from what `searchNearby` expects internally):

`{ "places": [ { "name", "address", "lat", "lng", "category", "source": "overture" }, ... ], "release": "2026-xx-xx.0" }`

plus `Cache-Control: public, max-age=300, s-maxage=3600`.

### Storage (D1 first, Turso mirror acceptable)

New migration `migrations/0017_places.sql` (next free number after the current 0016):

```sql
CREATE TABLE places (
  id        TEXT PRIMARY KEY,        -- "{area}_{file}_{i}" or stable Overture id
  name      TEXT NOT NULL,
  category  TEXT NOT NULL,
  lat       REAL NOT NULL,
  lon       REAL NOT NULL,
  geohash   TEXT NOT NULL,           -- length 7 prefix, indexed
  address   TEXT NOT NULL DEFAULT '',
  release   TEXT NOT NULL
);
CREATE INDEX places_geo  ON places (geohash, category);
CREATE INDEX places_name ON places (name);
-- FTS5 over name+address for prefix searches:
CREATE VIRTUAL TABLE places_fts USING fts5(name, address, content='places', content_rowid='rowid');
```

Rules:

- Normalised columns only; no JSON blobs. Target ~6 KB per 100 rows, under the 500 MB D1 free cap by a wide margin.
- `id` stable across rebuilds so `since` delta queries work.
- Seed in batches of 5,000 using a script `scripts/load-places.py`, respecting D1's 100k rows/day on the free plan (full load is ~13 days, or pay $ once for the seed job). Turso's 10M writes/month allows one-shot seeding.

### Query plan (edge, < 50 ms warm)

1. If `q` matches a kind word (`typeQuery`), drop into the category path (`category = ?`).
2. Resolve geohash prefixes covering the search circle: user cell + its eight neighbours.
3. `WHERE geohash IN (prefix list) AND (name MATCH prefix OR address MATCH prefix)`.
4. Haversine filter on the (few hundred) candidates and sort by distance bands (50 / 150 / 400 km), then nearest first.
5. Return `limit` results.

Text-only queries (no lat/lng) fall back to FTS5 `MATCH` with a hard cap of 50, ranked by FTS5 rank + distance to the client (no location) -> just rank.

### Client integration (`public/places.js`)

- Add `remoteSearch(q, near)` that calls `/api/places/search` and caches the resolved promise.
- `searchNearby` becomes: try the in-memory persistent cache first (Phase 0) -> fire `remoteSearch` -> merge server results with driver places through the existing `mergeResults` pipeline.
- Shards stay as a fallback: if the API returns a network error (5xx/timeout) or 503, use the Phase 0 tile path unchanged. `/api/search` failures must never make a search return nothing.
- Response cache: browser `Cache-Control` + Cache API; server sets `s-maxage=3600` so Cloudflare serves warm repeats from the edge.

### Acceptance criteria

- Cold search (no cached shards, area never visited) finishes in < 300 ms on 4G.
- Repeat search after a refresh is served from `a2b-places-data-v1` with no network request.
- All tests in `test/places.test.js` still pass, extended with tests for `remoteSearch` behind a fetch mock and a failure fallback case.
- Day-one deploy keeps `/places/` tiles in place; `scripts/check-places.mjs` remains green.

### Risks and mitigations

- **D1 row-scan billing.** A bad `LIKE %q%` without a geohash bound would burn 5M rows/day. Mitigation: every query path starts from geohash prefixes; FTS5 only runs on that subset.
- **Seeding time on the free plan.** Spreads over ~13 days. Mitigation: run it once before cutover; tiles remain the source of truth until then.
- **Result ordering drift.** Server candidates feed the existing `mergeResults` ranker, so ordering should be identical. Diff test: log both orderings for a sample query list before cutover.

## Phase 2: local-first mobile and offline web

Phase 1 puts fast search on the server; Phase 2 puts it on the device so a search never needs the network.

### Option: Turso embedded replica (preferred)

One libSQL database serves both hosted and on-device copies:

- Hosted DB = Phase 1 storage moved to Turso (same schema, same `?v` release).
- Web (PWA): download a compressed snapshot (~40 MB target for the MY set, or per-region slices) into `Origin Private File System`, opened with libSQL WebAssembly. Reads use the same FTS5 + geohash indexes.
- Native (iOS/Android): ship a read-only snapshot in the app bundle (~40 MB) and sync deltas since the shipped release via `/api/places/since?since=...` after install. Turso's embedded replicas give the sync transport for free within the 3 GB/month budget.
- Queries after first sync are purely local SQLite: 5-15 ms.

### Offline bootstrapping

- App requests `/api/places/snapshot-areas?areas=...` to fetch only the user's current 3x3 area block (<= ~3 MB) until a full background sync completes. Better UX than blocking first launch on a 40 MB download.
- Monthly Overture rebuild produces a release stamp; sync logic compares it and re-validates changed areas (rarely more than a few).

### Shared core strategy

The ranking code (`mergeResults`, markVenues, misplaced-distance pruning, address helper) must not be ported three times.

- Short term: keep the JS ranker in JS; mobile calls into it either via a React Native JS module (web view) or a shared WebView bridge. Acceptable for MVP.
- Medium term: extract the ranker into a small Rust library compiled to WASM (web) and mobile (via UniFFI / Rust bindings). `places` and `mergeResults` become the reference implementation and test corpus; golden fixtures in `test/places.test.js` must pass the Rust port byte-for-byte on ordering.
- Until then, every port must run the golden fixtures; add the fixtures as a separate `test/golden/` set so they can be run from any language.

### Acceptance criteria

- A search with airplane mode on returns results as long as the area was visited once, in < 50 ms.
- Delta sync after a monthly data release transfers less than 5% of the full DB.
- No duplicate or stale rows: verify with a checksum of `count(*)` and `max(updated_at)` per area served at `/api/places/status`.
- Mobile storage budget: < 150 MB total for MY; configurable per region.

## Universal caching contract (all phases)

These rules are carried through Phase 0, 1 and 2 so behaviour stays consistent:

1. **Immutable = cache forever.** Any URL containing a release stamp is immutable and may be cached in `CacheStorage` / HTTP cache with `immutable`.
2. **Mutable pointers are small.** Only `/places/index.json` (or `/api/places/status`) tells the client which release is current; it is small and revalidates every time.
3. **Failure is not an error.** A network failure anywhere in the chain falls back to the previous release's data; it never produces an empty result set unless no data has ever been loaded.
4. **One cache name per release budget.** Cache keys are `{store}-v{release or schema version}` so old data can be evicted by deleting old names.
5. **Ranking stays client side** until the golden fixtures pass against a ported core.

## Milestones + effort

| Phase | Work | Rough size |
|---|---|---|
| 0 (done) | Persistent `CacheStorage`, SW allowlist | 0.5 day |
| 1 | migration 0017, seed script, Worker handler, `remoteSearch`, fallback | 3-4 days |
| 2a | Web PWA snapshot + libSQL WASM queries | 2-3 days |
| 2b | Native sync (delta + shipped DB) | per platform |
| 2c | Golden fixtures + ranking port | 2 days + porting |

## Out of scope

- Replacing Photon / Valhalla (geocoder + router) -- those are a separate latency source and are not part of this plan.
- Server-side ML / vector search. The dataset is structured; geohash + FTS5 is enough.
- Global coverage. The plan assumes per-country (or per-grid) slices; covering more countries is a data problem, not a search one.
