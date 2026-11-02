// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Builds src/lib/met-towns.json: where each of MET Malaysia's forecast places is (towns, districts, Sarawak and
// Sabah divisions, holiday spots), so the weather on a route can be read from the nearest one. MET Malaysia's
// open forecast (api.data.gov.my) names its places but doesn't say where they are, so each name is looked up once
// with OpenStreetMap's Nominatim, one request a second as its usage policy asks. Run it again if MET Malaysia adds
// places; it reuses positions already found.
//
//   node scripts/build-met-towns.mjs            (or: npm run met-towns)

import { readFileSync, writeFileSync } from 'node:fs';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const FORECAST = 'https://api.data.gov.my/weather/forecast/?limit=10000';
const UA = 'a2b-navigation/0.1 (+https://a2b-beta.pages.dev)';
const OUT = new URL('../src/lib/met-towns.json', import.meta.url);
const PAUSE_MS = 1100; // Nominatim allows one request a second
// What each kind of MET place is on the map, best first. St (whole states) are left out: too big to be "nearest".
const WANT = {
  Tn: ['city', 'town', 'village', 'suburb', 'municipality', 'district', 'county', 'state_district'],
  Ds: ['district', 'county', 'state_district', 'municipality', 'city', 'town', 'village', 'suburb'],
  Dv: ['state_district', 'district', 'county', 'region', 'city', 'town'],
  Rc: [],
};

// Places the name alone finds wrongly (another place of the same name) or not at all: [lat, lng, state].
const FIXED = {
  Dv514: [5.3378, 116.1602, 'Sabah'], // Pedalaman: Sabah's Interior Division, around Keningau
  Dv515: [5.9804, 116.0735, 'Sabah'], // Pantai Barat: Sabah's West Coast Division, around Kota Kinabalu
  Rc004: [5.4246, 100.269, 'Penang'], // Bukit Bendera: Penang Hill
  Rc008: [4.4721, 101.3801, 'Pahang'], // Cameron Highlands, at Tanah Rata
  Rc013: [4.3858, 102.4013, 'Pahang'], // Taman Negara, at Kuala Tahan
  Rc017: [3.4006, 101.8394, 'Pahang'], // Bukit Tinggi, Bentong
  Rc018: [3.5916, 102.143, 'Pahang'], // Kuala Gandah elephant sanctuary
  Rc019: [2.9833, 102.6, 'Pahang'], // Tasik Bera
  Rc511: [5.9886, 115.9958, 'Sabah'], // Tunku Abdul Rahman Park, off Kota Kinabalu
  Tn156: [4.2091, 100.664, 'Perak'], // Bandar Baru Seri Manjung
  Tn164: [3.0237, 101.7165, 'Selangor'], // Serdang, Selangor (Tn023 is Serdang, Kedah)
  Tn175: [5.3283, 100.2716, 'Penang'], // Sungai Ara, Penang
  Tn184: [5.7962, 102.5626, 'Terengganu'], // Kampung Raja, Besut
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30000) }).catch((e) => e);
    if (res.ok) return res.json();
    if (attempt === 4) throw new Error(`${url}: ${res.status ?? res.message}`);
    await sleep(2000 * 2 ** attempt);
  }
}

async function locate(id, name) {
  const u = new URL(NOMINATIM);
  Object.entries({ q: name, countrycodes: 'my', format: 'jsonv2', addressdetails: 1, limit: 10, 'accept-language': 'en' }).forEach(([k, v]) => u.searchParams.set(k, v));
  const found = await json(u);
  const want = WANT[id.slice(0, 2)];
  const rank = (f) => {
    const i = want.indexOf(f.addresstype);
    return (i < 0 ? want.length : i) + (f.name?.toLowerCase() === name.toLowerCase() ? 0 : 10);
  };
  const best = found.sort((a, b) => rank(a) - rank(b))[0];
  if (!best) return null;
  const state = best.address?.state ?? best.address?.city ?? best.address?.territory ?? '';
  return [id, name, +Number(best.lat).toFixed(4), +Number(best.lon).toFixed(4), state];
}

const known = new Map();
try {
  for (const t of JSON.parse(readFileSync(OUT, 'utf8'))) known.set(t[0], t);
} catch {}

const places = new Map();
for (const r of await json(FORECAST)) places.set(r.location.location_id, r.location.location_name);
const towns = [];
const missing = [];
for (const [id, name] of [...places].sort()) {
  if (id.startsWith('St')) continue;
  if (FIXED[id]) {
    towns.push([id, name, ...FIXED[id]]);
    continue;
  }
  const old = known.get(id);
  if (old && old[1] === name) {
    towns.push(old);
    continue;
  }
  const t = await locate(id, name);
  await sleep(PAUSE_MS);
  if (t) towns.push(t);
  else missing.push(`${id} ${name}`);
}
writeFileSync(OUT, `[\n${towns.map((t) => JSON.stringify(t)).join(',\n')}\n]\n`);
console.log(`${towns.length} MET Malaysia places located${missing.length ? `; not found: ${missing.join(', ')}` : ''}`);
