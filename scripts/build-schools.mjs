// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Builds public/schools.json: Malaysia's schools as mapped in OpenStreetMap (amenity=school), so a drive at school
// times can warn of school zones on the route (src/lib/schools.js, public/school-zones.js). One Overpass request.
// Kindergartens, tuition centres, colleges, universities and the like are left out by name: they aren't where
// children cross the road at the start and end of the school day.
//
//   node scripts/build-schools.mjs            (or: npm run schools)

import { writeFileSync } from 'node:fs';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const UA = 'a2b-navigation/0.1 (+https://a2b-beta.pages.dev)';
const QUERY = '[out:json][timeout:150];area["ISO3166-1"="MY"][admin_level=2]->.my;nwr["amenity"="school"](area.my);out center tags;';
const NOT_SCHOOL = /\b(tadika|taska|tabika|kindergarten|pre-?school|prasekolah|nursery|tuition|tusyen|kolej|college|universit[iy]|institut[e]?|akademi|academy|politeknik|polytechnic|driving|memandu|daycare|childcare)\b/i;

// [lng, lat, name]: unnamed schools are kept (most are real schools not yet named on the map).
export function schoolRows(elements) {
  const rows = [];
  for (const e of elements) {
    const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
    if (lat == null || lng == null) continue;
    const t = e.tags ?? {};
    const name = (t.name || t['name:ms'] || t['name:en'] || t.short_name || '').trim();
    if (NOT_SCHOOL.test(name) || NOT_SCHOOL.test(t['name:en'] ?? '')) continue;
    rows.push([Math.round(lng * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5, name.slice(0, 60)]);
  }
  return rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

async function main() {
  const res = await fetch(OVERPASS, { method: 'POST', headers: { 'user-agent': UA }, body: new URLSearchParams({ data: QUERY }), signal: AbortSignal.timeout(240000) });
  if (!res.ok) throw new Error(`Overpass: ${res.status}`);
  const schools = schoolRows((await res.json()).elements ?? []);
  const out = { built: new Date().toISOString().slice(0, 10), source: 'OpenStreetMap contributors (ODbL), via Overpass', count: schools.length, fields: ['lng', 'lat', 'name'], schools };
  const body = `${JSON.stringify(out)}\n`;
  writeFileSync(new URL('../public/schools.json', import.meta.url), body);
  console.log(`Wrote ${schools.length} schools to public/schools.json (${Math.round(body.length / 1024)} KB).`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
