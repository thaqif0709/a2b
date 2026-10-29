<div align="center">

<img src="public/icon.svg" alt="A2B logo" width="96" height="96">

# A2B

**Free, open source driving navigation for Malaysia, in your browser.**

Search a place, pick a route, and get spoken turn-by-turn directions, with road reports from the drivers around you.

[![Try the beta](https://img.shields.io/badge/try_the_beta-a2b--beta.pages.dev-751b4f?style=for-the-badge)](https://a2b-beta.pages.dev)

[![Licence: AGPL v3](https://img.shields.io/badge/licence-AGPL_v3-blue)](LICENSE)
[![Pull requests welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)
![Made in Malaysia](https://img.shields.io/badge/made_in-Malaysia-cc0001)

<br>

<img src="docs/screenshots/routes.webp" alt="Three routes to Putrajaya with drive times and toll counts" width="23%">&nbsp;
<img src="docs/screenshots/drive.webp" alt="Driving with the next turn, lane guidance and a 3D car" width="23%">&nbsp;
<img src="docs/screenshots/night.webp" alt="The night map while driving" width="23%">&nbsp;
<img src="docs/screenshots/parking.webp" alt="Car parks near the Petronas Towers" width="23%">

</div>

> [!NOTE]
> A2B is a beta, built in public by one person with an AI coding assistant. It runs on free servers, so it takes
> **50 drivers at a time** (accounts get priority). Feedback and bug reports are very welcome.

## Try it

Open **[a2b-beta.pages.dev](https://a2b-beta.pages.dev)** on your phone. To use it like an app:

- **iPhone:** open it in Safari, tap **Share**, then **Add to Home Screen** (keep **Open as Web App** on).
- **Android:** open it in Chrome, tap **⋮**, then **Add to home screen**.

Keep the screen on while you drive (A2B keeps it awake). Only use it when it's safe and legal.

## Features

| Feature | What it does |
| --- | --- |
| 🔎 **Search** | Places from OpenStreetMap plus shops from Overture Maps, searched near you. Landmarks come first, and paste coordinates (`3.15, 101.71`) to go anywhere. Search a kind of place in English or Malay ("petrol", "stesen minyak", "hospital", "klinik", "balai polis", "convenience store", "ev charger", "pengecas", "petrol near klcc") for the nearest ones. Places you pick are kept as your search history, on the phone without an account (Clear wipes it). |
| ⛽ **On the map** | Petrol stations, EV chargers, hospitals, clinics and convenience stores show on the map when zoomed in. Tap one, or any station (LRT, MRT, KTM, monorail), bus stop, car park or landmark the map shows, named or not, for routes there. |
| 🛣️ **Routes** | Up to three routes with drive time in live traffic (jams coloured on the line), arrival, tolls and reported traffic. Tap a route on the map to pick it; the chosen one starts by itself after 8 seconds. |
| 🟩 **Exit signs** | Expressway exits show their overhead sign on the turn banner, green as on the road: the exit number, the road it leads onto and where it goes ("EXIT 218 · 241 · Seremban / Labu"), and the voice names them too. |
| 🚶 **Walking** | Switch the route options to Walk for footpaths and pedestrian crossings, with the same spoken directions. |
| 🚆 **By train** | Switch a route to Train for trips on the LRT, MRT, Monorail, BRT and KTM Komuter: the walk to the station, which line (in its colour) and which way, how often trains run, where to change and the walk at the end, drawn on the map. Live departure times open in Google Maps. |
| 🚇 **Train guidance** | Start a train trip to be guided through it: the walk to the station, which train, the next station as you go (estimated from the timetable underground, where GPS drops out), "Next stop: Masjid Jamek. Get off here." with a buzz, and where to change. A 3D train in the line's colour shows where you are on the line. Works while A2B is open on screen. |
| 🗣️ **Turn by turn** | Spoken directions, the next turn and the one after, lane guidance, roundabout exits, a turn arrow on the map, and rerouting when you go off route. |
| 🚇 **Tunnel mode** | When the GPS drops out in a tunnel (SMART Tunnel, Penchala Link, KL's underpasses) or anywhere while moving, the car keeps going along the route at its last speed, so the next turn still comes. "No GPS · Estimating" shows until the signal is back, for up to 90 s or 2.5 km. |
| 📸 **Speed cameras** | Fixed AES and AWAS cameras on your route, with a voice warning and the limit about 800 m before each. |
| 💰 **Tolls** | Toll plazas along the route, with the car price and ways to pay (Touch 'n Go, RFID, SmartTAG) where mapped. |
| 🅿️ **Parking** | Car parks near your destination, paid or free, with type and spaces. Pick one and the drive reroutes there. Or search "parking", "parking klcc" or "letak kereta pavilion". |
| 🚧 **Roadworks** | Routes avoid roads that look to be still under construction, and roads drivers report as closed. |
| 🚓 **Reports** | Traffic, police, crashes, hazards, blocked lanes, closures and cameras, with voice alerts ahead and "still there?" checks after. |
| 🚗 **Your car** | A 3D chevron or car in the colour you like, a speedometer that turns red over the limit, and the road you've driven greyed out. |
| 🌙 **Day and night** | Map themes that switch automatically in the evening. |
| 🗺️ **Offline maps** | The map along your route is saved when a drive starts, so tunnels and dead spots show map, not blank. Rerouting still needs signal. |
| 📍 **Share your drive** | A link that shows your car, route and ETA live in any browser, no app or account needed. |
| ⭐ **Accounts** | Home, Work and saved places on every device, points for helpful reports, and a top drivers board. Browsing and driving work without one. |

## What's different

- **Routes listen to drivers.** Roads reported closed are avoided, and reported jams add to the ETA of the routes
  they're on, so you can see why one route is slower. Drivers who share speeds add slow stretches the same way,
  marked as driver speeds rather than reports.
- **Reports fade as they age.** Fresh or confirmed reports are solid, old unconfirmed ones turn see-through, and a
  second report of the same thing confirms the first instead of adding another pin.
- **No ads, and your drives aren't tracked by default.** The server keeps what you save, your reports, a shared drive's latest
  position while you're sharing it, and an anonymous device ID to count how many people are on (for the 50-driver
  limit). It doesn't record where you drive.
- **Optional traffic sharing (off by default).** Switch it on in Settings › Traffic and the app sends a small batch of
  recent fixes every 30 seconds while you drive: your position rounded to about 100 m on your phone, speed,
  direction and time. The server folds them straight into anonymous per-street totals (street block, direction,
  average speed, how many fixes from how many drivers) and never stores your raw trail; totals older than a day
  are deleted every night. Streets where at least three drivers crawl show as slow for everyone. Turn it off any
  time to stop sharing.
- **Open source.** Anyone can read the code, suggest changes, or run their own copy.

## Run it on your computer

You need **Node.js 22.13 or newer**. No accounts or API keys are needed.

```bash
npm install
npm run dev          # http://localhost:8787, with its own local database
npm test             # unit and API tests, no network needed
```

Browsers only share GPS with `https://` or `localhost` pages, so to drive with it, deploy your own copy (below).
[CONTRIBUTING.md](CONTRIBUTING.md) covers the optional extras, such as demo drives and building the shop data.

<details>
<summary><b>Deploy your own copy on Cloudflare (free tier)</b></summary>

1. Create a free account at <https://dash.cloudflare.com/sign-up>, then log in from this folder: `npx wrangler login`.
2. Create a database with `npx wrangler d1 create a2b`, and put the `database_id` it prints into `wrangler.toml`
   in place of the one there.
3. Optional: build the shop search data and the roads under construction list (see below).
4. Deploy with `npm run deploy`. You'll get a URL like `https://a2b.<you>.workers.dev`.

The database tables are created on the first request (or run `npm run db:migrate:remote`). Other settings in
`wrangler.toml`:

- `MAX_ACTIVE` and `MAX_GUESTS`: how many devices can use the app at once, and how many of those can be guests.
- `TESTER_EMAILS` (a secret: `npx wrangler secret put TESTER_EMAILS`): accounts that get the testing tools and the
  usage dashboard.
- `OCM_KEY` (a secret, optional): an [Open Charge Map](https://openchargemap.org/site/develop/api) API key, free, for
  more EV chargers than OpenStreetMap has.

To use your own domain, add it under *Workers & Pages → a2b → Settings → Domains & Routes*.

</details>

<details>
<summary><b>Map, routing, search and data</b></summary>

Everything A2B uses is free and needs no key:

| What | Source | Notes |
| --- | --- | --- |
| Map tiles | [OpenFreeMap](https://openfreemap.org) | Map looks are in `public/map-themes.js`. |
| Routing, speed limits, toll booths | [Valhalla public server](https://valhalla1.openstreetmap.de) (`ROUTING_URL`) | Community-run, fair use. |
| Search | [Photon](https://photon.komoot.io) (`GEOCODER_URL`) | Community-run, fair use. |
| Live traffic (optional) | [TomTom Routing API](https://developer.tomtom.com) (`TOMTOM_KEY` secret) | Times each route with today's traffic; free up to a monthly quota. Without a key, routes use typical speeds. Answers aren't stored. |
| Train timetables (LRT, MRT, Monorail, BRT, KTM Komuter) | [data.gov.my GTFS](https://developer.data.gov.my/realtime-api/gtfs-static) (Prasarana, KTMB) | Built with `npm run transit` into `src/lib/transit-data.json`, kept in git. Each feed runs to an end date the build prints; rebuild before then. Walks to and from stations use the routing server's walking routes. |
| Toll plaza and car park details | [OpenStreetMap API](https://wiki.openstreetmap.org/wiki/API) | Looked up once and cached. |
| Shops and places | [Overture Maps](https://overturemaps.org) | Built into small files the phone searches (`npm run places`). |
| Roads under construction | [Overture Maps](https://overturemaps.org) (OpenStreetMap roads) | Built with `npm run construction`, kept in git. |
| Fixed speed cameras (AES, AWAS) | OpenStreetMap, found through Photon | Built with `npm run cameras` into `public/cameras.json`, kept in git. |
| EV chargers | OpenStreetMap ([Overpass API](https://overpass-api.de)), [Open Charge Map](https://openchargemap.org) (`OCM_KEY` secret, optional), Overture Maps | Kept in the database and refreshed weekly by the nightly job (the first list arrives with its first run after deploying). Open Charge Map's openly licensed chargers (CC BY-SA 4.0) are added when a free key is set (`npx wrangler secret put OCM_KEY`). |

The community servers ask for fair use, which is why the beta caps how many people use it at once. For more
traffic, point `ROUTING_URL` and `GEOCODER_URL` at your own [Valhalla](https://github.com/valhalla/valhalla) and
[Photon](https://github.com/komoot/photon) servers, or a hosted provider such as [Stadia Maps](https://stadiamaps.com).

Overture publishes new data monthly ([calendar](https://docs.overturemaps.org/release-calendar/)). Rebuild with:

```bash
pip install duckdb
npm run places          # shop search data (not kept in git)
npm run construction    # roads under construction
npm run deploy
```

For the live app, a scheduled Claude Code session checks for a new release each month
(`node scripts/overture-release.mjs`) and updates the data.

</details>

<details>
<summary><b>How it's built</b></summary>

A plain web app (no build step, ES modules) served by a Cloudflare Worker with a D1 (SQLite) database.

```
public/                 the web app
  index.html            every screen
  styles.css            day and night themes, phone and desktop layouts
  app.js                map, search, routes, driving, reports, parking, shared drives
  panels.js             menu, sign in, settings, saved places, leaderboard, usage dashboard
  core.js               state, API client, settings, saved places
  nav.js                turn-by-turn engine: GPS snapping, next turn, ETA, voice cues, off route
  motion.js             smooth car movement between GPS fixes
  vehicle3d.js          the 3D chevron and car (three.js)
  voice.js              spoken directions in the Daniel voice (or the phone's best English one)
  places.js, text.js    shop search on the phone, and text matching
  map-themes.js         map colours for day and night
  presence.js           keeping a spot, and the waiting screen when it's full
  welcome.js            launch splash and first-visit welcome
  update.js             noticing a newer version: quiet refresh, or a small "New version ready" pill
  follow.js             watching a shared drive
  sheet-drag.js         bottom sheets that follow the finger
  geo.js, icons.js      maths, formatting, turn arrows and pins
  report-types.js       report types, lifetimes and points (shared with the server)
  sw.js, manifest       installable app, offline shell
src/
  worker.js             the API
  lib/providers.js      search (Photon) and routing (Valhalla), speed limits, reports along a route
  lib/construction.js   spotting roads that are probably still being built
  lib/traffic.js        live traffic for a route (TomTom)
  lib/transit.js        trips by train (LRT, MRT, Monorail, BRT, KTM Komuter)
  lib/cameras.js        fixed speed cameras along a route
  lib/tolls.js          toll plazas and their prices
  lib/parking.js        car parks near a destination
  lib/reports.js        reports, merging, votes, expiry, closures
  lib/presence.js       the cap on drivers at once
  lib/usage.js          usage numbers for the owner's dashboard
  lib/auth.js           password hashes and sessions
  lib/schema.js         database tables (kept in step with migrations/)
scripts/                building the Overture data, app icons
test/                   node --test: the navigation engine and the whole API on an in-memory database
```

**API**

| Area | Endpoints |
| --- | --- |
| Accounts | `POST /api/auth/signup`, `/login`, `/logout` · `POST /api/auth/2fa/setup`, `/enable`, `/disable`, `/verify` · `GET`, `PATCH`, `DELETE /api/me` · `GET /api/config` |
| Saved places | `GET`, `POST /api/places` · `PATCH`, `DELETE /api/places/:id` · `POST /api/places/import` |
| Search and routes | `GET /api/search` · `GET /api/reverse` · `POST /api/route` · `GET /api/parking` |
| Reports | `GET`, `POST /api/reports` · `POST /api/reports/:id/vote` · `GET /api/leaderboard` |
| Shared drives | `POST /api/trips` · `GET`, `PATCH /api/trips/:token` |
| App | `GET /api/health` · `POST /api/presence` · `GET /api/stats` (testers only) |

**Security**

- Passwords are hashed with PBKDF2-SHA256 (100,000 iterations), and repeated wrong passwords are slowed down.
- Sessions are random tokens in HttpOnly, SameSite=Lax cookies; only their hash is stored.
- Writes must be JSON, which blocks cross-site form posts, and a strict Content-Security-Policy is set in
  `public/_headers`.
- Secrets (the Cloudflare token, tester emails) live in Cloudflare, never in the code.
- A daily job clears expired sessions, old shared drives and old usage numbers.

### Two-factor logins (optional, off by default)

Drivers can add a TOTP authenticator-app code at login — no extra service needed. Set
`TWO_FACTOR=off` | `optional` | `required` (in `wrangler.toml`, or `.dev.vars` locally from
`.dev.vars.example`): `optional` lets drivers switch it on in Settings › Account, `required`
enrols existing accounts at their next login. A challenge allows a few wrong codes before it
dies, wrong codes count towards the per-account lockout like wrong passwords, and a used code
can't be replayed. The sign-in screen reads `GET /api/config` to only show what's on.

</details>

## Known limits

- **No CarPlay or Android Auto**, and no navigating in the background: it's a web app, so keep it on screen.
- **Live traffic needs a TomTom key.** With one, drive times and jams come from TomTom; past its free monthly quota (or
  without a key) they fall back to typical road speeds plus the traffic drivers report.
- **Map data gaps.** Roads, tolls, car parks and lanes are only as good as OpenStreetMap's for your area. Fixing a
  spot on [openstreetmap.org](https://www.openstreetmap.org) fixes it for everyone.
- **Shop listings can be noisy.** Some Overture entries are pinned in the wrong place; well-known landmarks are put
  first to work around it.
- **Voices** are your phone's built-in text-to-speech: Daniel on iPhones, iPads and Macs, the best English voice elsewhere.
- **50 drivers at a time** during the beta, because of the free servers.

## Ideas for later

- Hands-free reporting by voice ("report police")
- "Where I parked", dropped automatically when a drive ends
- Photos on closure and hazard reports
- Trust scores, so votes from reliable drivers count for more
- Fuel and EV charging along the route

## Contributing

Ideas, bug reports and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to run A2B, test
a change and send it in. Code contributions need the [Contributor License Agreement](CLA.md): you keep your
copyright, and A2B stays open source.

## Licence and credits

A2B was created by **Thaqif Syarafuddin bin Roslan**.
Copyright © 2026 Thaqif Syarafuddin bin Roslan and the A2B contributors.

A2B is free software under the [GNU Affero General Public License v3.0 or later](LICENSE), with the additional
terms in [NOTICE](NOTICE). You can use, study, change and share it. If you run a changed version for other people,
over the internet included, you must offer them its source code under the same licence, and:

- keep the credit **"Based on A2B by Thaqif Syarafuddin bin Roslan"** with a link to this repository, in your app's
  About screen and in your README
- mark your version as changed, and don't present it as the original A2B
- use your own name and icon: the A2B name and logo aren't licensed for other versions

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL). Places and roads under
construction from the [Overture Maps Foundation](https://overturemaps.org) (see `public/places/NOTICE.txt` once built).
Map tiles by [OpenFreeMap](https://openfreemap.org), routing by [Valhalla](https://github.com/valhalla/valhalla),
search by [Photon](https://github.com/komoot/photon), live traffic by [TomTom](https://www.tomtom.com). Train
timetables from Prasarana and KTMB through [data.gov.my](https://data.gov.my) (CC BY 4.0).
