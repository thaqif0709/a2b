// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Builds public/parking-entrances.json: Malaysia's car park entrances (amenity=parking_entrance) as mapped in
// OpenStreetMap, so a drive to a mall can end at one (src/lib/entrances.js). One Overpass request; private and
// motorcycle-only entrances are left out.
//
//   node scripts/build-parking-entrances.mjs            (or: npm run parking-entrances)

import { writeFileSync } from 'node:fs';
import { entranceRows } from '../src/lib/entrances.js';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const UA = 'a2b-navigation/0.1 (+https://a2b-beta.pages.dev)';
const QUERY = '[out:json][timeout:180];area["ISO3166-1"="MY"][admin_level=2]->.my;node["amenity"="parking_entrance"](area.my);out body;';

async function main() {
  const res = await fetch(OVERPASS, { method: 'POST', headers: { 'user-agent': UA }, body: new URLSearchParams({ data: QUERY }), signal: AbortSignal.timeout(240000) });
  if (!res.ok) throw new Error(`Overpass: ${res.status}`);
  const entrances = entranceRows((await res.json()).elements ?? []).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = { built: new Date().toISOString().slice(0, 10), source: 'OpenStreetMap contributors (ODbL), via Overpass', count: entrances.length, fields: ['lng', 'lat', 'name'], entrances };
  writeFileSync(new URL('../public/parking-entrances.json', import.meta.url), `${JSON.stringify(out)}\n`);
  console.log(`Wrote ${entrances.length} car park entrances to public/parking-entrances.json (${entrances.filter((e) => e[2]).length} named).`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
