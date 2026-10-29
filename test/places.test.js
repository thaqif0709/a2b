// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesForWord, searchNearby, mergeResults, typeQuery, placesOfType, placesOfTypesIn, addTypeSource, withoutBaseDuplicates, forgetChanges } from '../public/places.js';
import { matchesWordStarts, normalizeText } from '../public/text.js';

const ECO = [101.468, 3.224]; // Eco Grandeur, Puncak Alam

// A tiny fake /places/ tree: one area (0.5° grid, row 6, col 202) with an "nan" file and an "st" file.
const FILES = {
  '/places/index.json': { release: 'test', area: 0.5, areas: ['6_202'] },
  '/places/6_202/files.json?v=test': { n: 1, nan: 2, st: 1, _: 1, '@fuel': 4, '@ev': 2 },
  // Overture's EV chargers here: one the server also lists (30 m away), one only Overture has.
  '/places/6_202/@ev.json?v=test': { p: [
    ['Gentari EV Eco Grandeur', 101.4683, 3.2242, '', 'ev_charging_station'],
    ['Tesla Puncak Alam', 101.475, 3.229, '', 'ev_charging_station'],
  ] },
  '/places/6_202/nan.json?v=test': { p: [["Nando's", 101.45526, 3.2271, 'Lot 30, Ruang Niaga Eco Grandeur, Puncak Alam', 'restaurant'], ["Nando's", 101.518, 3.071, 'Aneka Walk, Shah Alam', 'restaurant']] },
  '/places/6_202/st.json?v=test': { p: [['Starbucks', 101.45806, 3.22737, 'Jalan Keramat', 'coffee_shop']] },
  '/places/6_202/n.json?v=test': { p: [] },
  // Petrol stations around Eco Grandeur: two listings of one, and one too far away to be "near".
  '/places/6_202/@fuel.json?v=test': { p: [
    ['Shell Puncak Alam', 101.47, 3.23, 'Jalan Eco', 'gas_station'],
    ['Petronas Eco Grandeur', 101.467, 3.2235, '', 'gas_station'],
    ['Petronas Eco Grandeur', 101.4671, 3.2236, '', 'fueling_station'],
    ['Petronas Far Away', 101.9, 3.4, '', 'gas_station'],
  ] },
};
globalThis.fetch = async (url, init) => {
  // Like browsers, refuse a second argument that isn't an options object.
  if (init !== undefined && (typeof init !== 'object' || init === null)) throw new TypeError('fetch init must be an object');
  const body = FILES[url];
  return { ok: Boolean(body), json: async () => body };
};

test('text matching ignores case, accents and apostrophes', () => {
  assert.equal(normalizeText("Nando's  Café!"), 'nandos cafe');
  assert.ok(matchesWordStarts("Nando's Lot 30, Ruang Niaga Eco Grandeur", 'nando eco grand'));
  assert.ok(!matchesWordStarts("Nando's Shah Alam", 'nandos eco'));
});

test('a word picks the most specific file there is', () => {
  const files = { n: 1, na: 1, nan: 1, nas: 1, s: 1, st: 1, _: 1 };
  assert.deepEqual(filesForWord('nandos', files), ['nan']);
  assert.deepEqual(filesForWord('nasi', files), ['nas']);
  assert.deepEqual(filesForWord('na', files), ['na', 'nan', 'nas'], 'a short word also needs the files under it');
  assert.deepEqual(filesForWord('starbucks', files), ['st']);
  assert.deepEqual(filesForWord('shell', files), ['s']);
  assert.deepEqual(filesForWord('麦当劳', files), ['_']);
  assert.deepEqual(filesForWord('xyz', files), []);
});

test('finds the Nando\'s in Eco Grandeur, nearest first', async () => {
  const both = await searchNearby('nandos', ECO);
  assert.deepEqual(both.map((p) => p.address.split(',')[0]), ['Lot 30', 'Aneka Walk']);
  assert.ok(both[0].km < 2 && both[1].km > 15);
  const exact = await searchNearby('nandos eco grandeur', ECO);
  assert.equal(exact.length, 1, 'the area words must match too');
  assert.equal(exact[0].source, 'a2b');
  assert.deepEqual(await searchNearby('starbucks', ECO).then((r) => r.map((p) => p.name)), ['Starbucks']);
  assert.deepEqual(await searchNearby('nandos', [-0.12, 51.5]), [], 'nothing deployed for London');
});

test('merging: best match first, then nearest, without duplicates', () => {
  const server = [
    { name: 'Eco Grandeur', address: 'Selangor', lat: 3.224, lng: 101.468 },
    { name: "Nando's", address: 'Aneka Walk, Shah Alam', lat: 3.071, lng: 101.518 },
  ];
  const local = [
    { name: "Nando's", address: 'Lot 30, Ruang Niaga Eco Grandeur', lat: 3.2271, lng: 101.45526 },
    { name: 'Nandos', address: 'Aneka Walk', lat: 3.07101, lng: 101.51801 }, // same place the server already has
  ];
  const byLat = (r) => r.map((p) => p.lat);
  assert.deepEqual(byLat(mergeResults(server, local, 'nandos eco grandeur', ECO)), [3.2271, 3.224, 3.071]);
  assert.deepEqual(byLat(mergeResults(server, local, 'nandos', ECO)), [3.2271, 3.071, 3.224], 'nearest Nando\'s first');
  const near = [{ name: 'Starbucks', address: 'Eco Grandeur', lat: 3.2274, lng: 101.458 }];
  const far = [{ name: 'Starbucks', address: 'Rawang', lat: 3.29, lng: 101.53 }];
  assert.equal(mergeResults(near, far, 'starbucks', ECO)[0].address, 'Eco Grandeur', 'a closer server result stays above');
});

test('a landmark comes first, and copies of it pinned far away are dropped', () => {
  const sentral = [101.6869, 3.139];
  const server = [{ name: 'Petronas Towers', address: 'Kuala Lumpur', lat: 3.158, lng: 101.7112, category: 'attraction', landmark: 'place' }];
  const local = [
    { name: 'PETRONAS Cari Gali Sdn Bhd, XTG PETRONAS Twin Towers', address: 'Level 16, Tower 2 KLCC', lat: 3.1395, lng: 101.687 }, // 4 km off, near the driver
    { name: 'Petronas Twin Towers Gift Shop', address: 'Suria KLCC', lat: 3.1581, lng: 101.7113 },
  ];
  const r = mergeResults(server, local, 'petronas twin towers', sentral);
  assert.deepEqual(r.map((p) => p.name), ['Petronas Towers', 'Petronas Twin Towers Gift Shop']);
  // A landmark the query doesn't start with stays where the text match puts it.
  const klcc = [{ name: 'Suria KLCC', address: 'Kuala Lumpur', lat: 3.158, lng: 101.712, landmark: 'place' }];
  const nandos = [{ name: "Nando's", address: 'Suria KLCC', lat: 3.1582, lng: 101.7121 }];
  assert.equal(mergeResults(klcc, nandos, 'nandos klcc', sentral)[0].name, "Nando's");
});

test('a sight beats a town of the same name, and a town beats a station', () => {
  const server = [
    { name: 'Batu Caves', address: '', lat: 3.2378, lng: 101.6812, landmark: 'station' },
    { name: 'Batu Caves', address: 'Gombak', lat: 3.2369, lng: 101.6833, landmark: 'area' },
    { name: 'Batu Caves temple', address: '', lat: 3.2376, lng: 101.6832, landmark: 'place' },
  ];
  const local = [{ name: 'Temple Hindu Batu Caves', address: 'Kuala Lumpur', lat: 3.149, lng: 101.69 }]; // pinned 10 km away
  const r = mergeResults(server, local, 'batu caves', [101.6869, 3.139]);
  assert.equal(r[0].landmark, 'place');
  assert.ok(!r.some((p) => p.name === 'Temple Hindu Batu Caves'));
});

test('places named after a landmark but pinned far from it are dropped ("klcc")', () => {
  const user = [101.6869, 3.139]; // ~3.5 km from KLCC
  const server = [
    { name: 'KLCC Park', address: 'Kampung Cendana', lat: 3.1553, lng: 101.7139, landmark: 'place' },
    { name: 'LRT - KLCC', address: 'Kuala Lumpur', lat: 3.1589, lng: 101.7135, landmark: 'station' },
  ];
  const local = [
    { name: 'Twin Tower , KLCC', address: 'Kuala Lumpur', lat: 3.1415, lng: 101.6887 }, // 350 m from the driver
    { name: 'Suria KLCC Malaysia', address: 'Suria KLCC', lat: 3.1462, lng: 101.6911 },
    { name: "Nando's", address: 'Suria KLCC', lat: 3.1582, lng: 101.7121 }, // really there: kept
  ];
  const names = mergeResults(server, local, 'klcc', user).map((p) => p.name);
  assert.equal(names[0], 'KLCC Park');
  assert.ok(!names.includes('Twin Tower , KLCC') && !names.includes('Suria KLCC Malaysia'));
  assert.ok(mergeResults(server, local, 'nandos klcc', user).some((p) => p.name === "Nando's"));
});

test('searches that name a kind of place are recognised, in English and Malay, with any area', () => {
  const t = (q) => typeQuery(q) && [typeQuery(q).type, typeQuery(q).area];
  assert.deepEqual(t('petrol'), ['fuel', '']);
  assert.deepEqual(t('Petrol Station'), ['fuel', '']);
  assert.deepEqual(t('stesen minyak terdekat'), ['fuel', '']);
  assert.deepEqual(t('petrol near klcc'), ['fuel', 'klcc']);
  assert.deepEqual(t('shell petrol station'), ['fuel', 'shell']);
  assert.deepEqual(t('hospitals in bangsar'), ['hospital', 'bangsar']);
  assert.deepEqual(t('klinik dekat bangsar'), ['clinic', 'bangsar']);
  assert.deepEqual(t('balai polis'), ['police', '']);
  assert.deepEqual(t('nearest police station'), ['police', '']);
  assert.deepEqual(t('kedai serbaneka near me'), ['convenience', '']);
  assert.deepEqual(t('convenience store'), ['convenience', '']);
  assert.deepEqual(t('ev charger'), ['ev', '']);
  assert.deepEqual(t('EV charging station near klcc'), ['ev', 'klcc']);
  assert.deepEqual(t('pengecas ev terdekat'), ['ev', '']);
  assert.deepEqual(t('stesen cas'), ['ev', '']);
  assert.deepEqual(t('charger'), ['ev', '']);
  assert.equal(typeQuery('petronas'), null, 'a brand is a name search');
  assert.equal(typeQuery('7-eleven'), null);
  assert.equal(typeQuery('nandos eco grandeur'), null);
});

test('places of a kind come nearest first, once each, and only nearby', async () => {
  const fuel = await placesOfType('fuel', ECO);
  assert.deepEqual(fuel.map((p) => p.name), ['Petronas Eco Grandeur', 'Shell Puncak Alam']);
  assert.ok(fuel[0].km < fuel[1].km);
  assert.equal(fuel[0].type, 'fuel');
  assert.deepEqual(await placesOfType('police', ECO), [], 'no file for that kind here');
});

test('EV chargers: the server’s list and the files’ together, a charger in both once', async () => {
  let asked = 0;
  addTypeSource('ev', async () => {
    asked++;
    if (asked === 1) throw new Error('offline');
    return [
      ['ChargEV Eco Grandeur', 101.468, 3.224, 'ChargEV · Type 2 · up to 22 kW', 'ev_charging_station'],
      ['DC Handal Seremban', 101.94, 2.72, 'CHAdeMO · up to 50 kW', 'ev_charging_station'],
    ];
  });
  assert.deepEqual((await placesOfType('ev', ECO)).map((p) => p.name), ['Gentari EV Eco Grandeur', 'Tesla Puncak Alam'], 'the server unreachable: the files’ still');
  const ev = await placesOfType('ev', ECO);
  assert.deepEqual(ev.map((p) => p.name), ['ChargEV Eco Grandeur', 'Tesla Puncak Alam'], 'asked again, nearest first, Seremban too far');
  assert.equal(ev[0].address, 'ChargEV · Type 2 · up to 22 kW');
  assert.equal(ev[0].type, 'ev');
  await placesOfType('ev', ECO);
  assert.equal(asked, 2, 'kept once it worked');
  const shown = await placesOfTypesIn(['fuel', 'ev'], [101.46, 3.22, 101.48, 3.235]);
  assert.deepEqual(shown.filter((p) => p.type === 'ev').map((p) => p.name).sort(), ['ChargEV Eco Grandeur', 'Tesla Puncak Alam'], 'on the map as well');
});

test('a place named just what was typed comes before nearer ones only starting so', () => {
  const near = [101.69, 3.14];
  const p = (name, lng, lat) => ({ name, address: 'Kuala Lumpur', lng, lat });
  const out = mergeResults([p('Bangunan Ming Jalan Ampang', 101.70, 3.15), p('Jalan Ampang', 101.72, 3.16), p('Wisma BSN Jalan Ampang', 101.71, 3.15)], [], 'jalan ampang', near);
  assert.equal(out[0].name, 'Jalan Ampang');
});

test('a pin the base map already draws, one place from two sources, shows once', () => {
  const pin = (name, type, lng, lat) => ({ name, type, lng, lat });
  const ours = [
    pin('Petronas Jalan Pusara Aman', 'fuel', 101.7, 3.2), // the base map's "Petronas" 70 m away, on its shop
    pin('Shell', 'fuel', 101.7006, 3.2), // across the road from it: another station
    pin('Klinik Kesihatan Ampang', 'clinic', 101.75, 3.15),
    pin('Klinik Kesihatan Pandan', 'clinic', 101.7505, 3.15), // the base map's is Ampang's, not this one
    pin('Klinik', 'clinic', 101.8, 3.1), // a name with no words of its own: only very close
    pin('Petronas', 'fuel', 101.9, 3.0), // the base map's here is a convenience store, not a station
  ];
  const base = [
    { name: 'Petronas', type: 'fuel', lng: 101.7, lat: 3.2006 },
    { name: 'Klinik Kesihatan Ampang', type: 'clinic', lng: 101.7502, lat: 3.1502 },
    { name: 'Klinik Dr Tan', type: 'clinic', lng: 101.8008, lat: 3.1 },
    { name: 'Petronas', type: 'convenience', lng: 101.9, lat: 3.0 },
  ];
  assert.deepEqual(withoutBaseDuplicates(ours, base).map((p) => p.name), ['Shell', 'Klinik Kesihatan Pandan', 'Klinik', 'Petronas']);
  assert.equal(withoutBaseDuplicates(ours, []).length, ours.length, 'nothing on the base map: all of ours');
});

// ---------- A2B's own places, ranked on the phone (rows as scripts/build-locations.py writes them) ----------
// [name, lng, lat, address, category, kind ('l' landmark, 's' street), sources (1 OpenStreetMap, 2 Overture,
// 4 Foursquare), id]. Around Eco Grandeur, so in the fake area 6_202.
const AREA_FILES = FILES['/places/6_202/files.json?v=test'];
function addFile(prefix, rows) {
  AREA_FILES[prefix] = rows.length;
  FILES[`/places/6_202/${prefix}.json?v=test`] = { p: rows };
}
const asked = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => (asked.push(url), realFetch(url, init));

test('own places: the place named before shops named after it, and before a check-in page next to you', async () => {
  addFile('tr', [
    ['Trx', 101.4685, 3.2245, 'Kuala Lumpur', 'shopping_mall', '', 4, 'f1'], // Foursquare only, 100 m away
    ['TRX City Police Station', 101.49, 3.25, '', 'police', '', 1, 'f2'],
    ['TRX City Park', 101.491, 3.251, 'Level 3, The Exchange TRX', 'park', 'l', 5, 'f3'],
    ['The Exchange TRX', 101.49, 3.25, 'Persiaran TRX, 55188 Kuala Lumpur', 'mall', 'l', 7, 'f4'],
  ]);
  assert.equal((await searchNearby('trx', ECO))[0].name, 'The Exchange TRX');
  addFile('su', [
    ...Array.from({ length: 150 }, (_, i) => [`Shop ${i} Sunway Pyramid`, 101.47, 3.23, '', 'retail', '', 4, `s${i}`]),
    ['Sunway Pyramid', 101.48, 3.24, '3, Jalan PJS 11/15, Bandar Sunway, 47500 Petaling Jaya, Selangor', 'mall', 'l', 7, 'f5'],
  ]);
  assert.equal((await searchNearby('sunway pyramid', ECO))[0].name, 'Sunway Pyramid', 'its long address no matter');
});

test('own places: the road named so before a mall on it, and a chain\'s nearest branch', async () => {
  addFile('am', [
    ['Ampang Park', 101.47, 3.225, 'Jalan Ampang, Kuala Lumpur', 'mall', 'l', 7, 'g1'],
    ['Jalan Ampang Hilir', 101.471, 3.226, '', 'street', 's', 1, 'g2'],
    ['Jalan Ampang', 101.475, 3.23, '', 'street', 's', 1, 'g3'],
  ]);
  assert.deepEqual((await searchNearby('jalan ampang', ECO)).map((p) => p.name), ['Jalan Ampang', 'Jalan Ampang Hilir', 'Ampang Park']);
  addFile('kf', [
    ['KFC', 101.60, 3.30, '', 'fast_food', '', 7, 'k1'], // listed by all three, 17 km away
    ['KFC', 101.469, 3.225, 'Eco Grandeur', 'fast_food', '', 1, 'k2'],
  ]);
  assert.equal((await searchNearby('kfc', ECO))[0].address, 'Eco Grandeur', 'the nearest KFC');
});

test('own places: words too common to look up fetch nothing; the others narrow each other', async () => {
  asked.length = 0;
  assert.deepEqual(await searchNearby('jalan', ECO), []);
  assert.ok(!asked.some((u) => /\/(j|ja|jal)\.json/.test(u)), 'no "jalan" files: there are none');
  assert.deepEqual((await searchNearby('kfc eco', ECO)).map((p) => p.id), ['k2'], '"eco" in its address');
});

test('own places: what changed since the files were built, from the server', async () => {
  FILES['/api/locations/changes'] = { places: [['Warung Pak Abu', 101.4682, 3.2241, 'Jalan Eco', 'restaurant', '', 8, 'd1']], hidden: ['f1'] };
  forgetChanges();
  const found = await searchNearby('trx', ECO);
  assert.ok(!found.some((p) => p.id === 'f1'), 'a place taken out of search');
  assert.deepEqual((await searchNearby('warung', ECO)).map((p) => [p.name, p.id]), [['Warung Pak Abu', 'd1']], 'a driver\'s place');
  delete FILES['/api/locations/changes'];
  forgetChanges();
});
