// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Builds public/rest-stops.json: Malaysia's highway R&Rs (highway=services) and lay-bys (highway=rest_area,
// "Hentian Sebelah") as mapped in OpenStreetMap, so a long drive can suggest the next one on your side of the
// road (public/rest-stops.js). One Overpass request.
//
//   node scripts/build-rest-stops.mjs            (or: npm run rest-stops)

import { writeFileSync } from 'node:fs';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const UA = 'a2b-navigation/0.1 (+https://a2b-beta.pages.dev)';
const QUERY = '[out:json][timeout:120];area["ISO3166-1"="MY"][admin_level=2]->.my;nwr["highway"~"^(services|rest_area)$"](area.my);out center tags;';

// Places tagged as rest areas that aren't: a car workshop's "service centre", a lounge, a swimming hole.
const NOT_REST = /\b(lounge|service cent(er|re)s?|workshop|showroom|swimming|hotel|restaurant|cafe|bistro)\b/i;

// [lng, lat, name, kind]: kind 's' for an R&R (food, fuel, toilets, a surau), 'r' for a lay-by. Unnamed ones are
// kept: the app calls them "R&R" or "Lay-by".
export function restRows(elements) {
  return elements
    .map((e) => {
      const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
      if (lat == null || lng == null) return null;
      const t = e.tags ?? {};
      const name = (t['name:en'] || t.name || t['name:ms'] || t.short_name || '').trim();
      if (NOT_REST.test(name)) return null;
      return [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6, name, t.highway === 'services' ? 's' : 'r'];
    })
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

async function main() {
  const res = await fetch(OVERPASS, { method: 'POST', headers: { 'user-agent': UA }, body: new URLSearchParams({ data: QUERY }), signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`Overpass: ${res.status}`);
  const stops = restRows((await res.json()).elements ?? []);
  const out = { built: new Date().toISOString().slice(0, 10), source: 'OpenStreetMap contributors (ODbL), via Overpass', count: stops.length, fields: ['lng', 'lat', 'name', 'kind'], stops };
  writeFileSync(new URL('../public/rest-stops.json', import.meta.url), `${JSON.stringify(out)}\n`);
  console.log(`Wrote ${stops.length} rest stops to public/rest-stops.json (${stops.filter((s) => s[3] === 's').length} R&Rs, ${stops.filter((s) => s[3] === 'r').length} lay-bys).`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
