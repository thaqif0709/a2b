// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filesForWord, searchNearby, mergeResults, typeQuery, placesOfType, placesOfTypesIn, addTypeSource, withoutBaseDuplicates, setDriverPlaces } from '../public/places.js';
import { matchesWordStarts, normalizeText } from '../public/text.js';

const ECO = [101.468, 3.224]; // Eco Grandeur, Puncak Alam

// A tiny fake /places/ tree: one area (0.5° grid, row 6, col 202) with an "nan" file and an "st" file.
const FILES = {
  '/places/index.json': { release: 'test', area: 0.5, areas: ['6_202'] },
  '/places/6_202/files.json?v=test': { n: 1, nan: 2, st: 1, trx: 6, bk: 4, _: 1, '@fuel': 4, '@ev': 2 },
  // Overture's EV chargers here: one the server also lists (30 m away), one only Overture has.
  '/places/6_202/@ev.json?v=test': { p: [
    ['Gentari EV Eco Grandeur', 101.4683, 3.2242, '', 'ev_charging_station'],
    ['Tesla Puncak Alam', 101.475, 3.229, '', 'ev_charging_station'],
  ] },
  '/places/6_202/nan.json?v=test': { p: [["Nando's", 101.45526, 3.2271, 'Lot 30, Ruang Niaga Eco Grandeur, Puncak Alam', 'restaurant'], ["Nando's", 101.518, 3.071, 'Aneka Walk, Shah Alam', 'restaurant']] },
  // A mall and the shops in it (the nearest shop is closer to Eco Grandeur than the mall), plus a copy of the mall
  // pinned 7 km off.
  '/places/6_202/trx.json?v=test': { p: [
    ['The Exchange TRX', 101.475, 3.235, 'Tun Razak Exchange', 'shopping_mall'],
    ['The Exchange TRX', 101.41, 3.2, 'Kuala Lumpur', 'shopping_mall'],
    ['Kanada-Ya - The Exchange TRX', 101.4745, 3.2345, 'Lot L2.53, Level 2, The Exchange TRX', 'restaurant'],
    ['Gucci The Exchange TRX', 101.4755, 3.2352, 'Unit G.56.0', 'fashion_and_apparel_store'],
    ['Swatch', 101.4752, 3.2348, 'Level 1.18, The Exchange TRX', 'fashion_and_apparel_store'],
    ['TRX Seafood Wharf', 101.469, 3.225, 'Jalan Barat', 'restaurant'],
  ] },
  // Places filed under their street's word (scripts/build-places.py street_index_words): two on Jalan BK 5/6, and
  // two on streets whose codes start the same.
  '/places/6_202/bk.json?v=test': { p: [
    ['SRA Bandar Kinrara 5', 101.4665, 3.2244, 'Jalan BK 5/6, Puchong', 'place_of_learning'],
    ['Nasi Tupe Soho', 101.4652, 3.2242, '5 Jalan BK 5/6, Puchong', 'event_or_party_service'],
    ['Kedai Lima Empat Belas', 101.469, 3.225, '5 Jalan BK 5/14, Puchong', 'restaurant'],
    ['BK Laundry', 101.4681, 3.2241, '7 Jalan BK 6/5, Puchong', 'laundromat'],
  ] },
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
  assert.equal(exact[0].source, 'overture');
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

test('the mall the shops around it name comes first ("trx"), once, and not its copy pinned far away', async () => {
  const local = await searchNearby('trx', ECO);
  assert.equal(local[0].name, 'The Exchange TRX');
  assert.equal(local[0].mentions, 3, 'the copy 7 km off has no shops around it');
  const server = [
    { name: 'TRX City Park', address: 'Kuala Lumpur', lat: 3.2353, lng: 101.4745, category: 'park', landmark: 'place' },
    { name: 'The Exchange TRX', address: 'Kuala Lumpur', lat: 3.2364, lng: 101.4772, category: 'mall', landmark: 'place' }, // OpenStreetMap's pin, 280 m off
  ];
  const r = mergeResults(server, local, 'trx', ECO);
  assert.equal(r[0].name, 'The Exchange TRX');
  assert.equal(r.filter((p) => p.name === 'The Exchange TRX').length, 1);
  assert.ok(r.findIndex((p) => p.name === 'TRX Seafood Wharf') > 0, 'the nearer shop comes after the mall');
});

test('several malls of one name all come before the shops in them ("pavilion")', () => {
  const kl = { name: 'Pavilion Kuala Lumpur', address: '', lat: 3.149, lng: 101.713, category: 'shopping_mall', landmark: 'place', mentions: 36 };
  const bj = { name: 'Pavilion Bukit Jalil', address: '', lat: 3.059, lng: 101.676, category: 'shopping_mall', landmark: 'place', mentions: 44 };
  const shop = { name: 'Black Market Pavilion Bukit Jalil', address: '', lat: 3.1335, lng: 101.687, category: 'restaurant' };
  const names = mergeResults([], [shop, bj, kl], 'pavilion', [101.6869, 3.139]).map((p) => p.name);
  assert.deepEqual(names, ['Pavilion Kuala Lumpur', 'Pavilion Bukit Jalil', 'Black Market Pavilion Bukit Jalil']);
});

test('an address finds the places on that street ("jalan bk 5/6"), not on BK 5/14 or BK 6/5, the house first', async () => {
  assert.deepEqual((await searchNearby('Jalan BK 5/6', ECO)).map((p) => p.name).sort(), ['Nasi Tupe Soho', 'SRA Bandar Kinrara 5']);
  assert.deepEqual((await searchNearby('bk 5/6', ECO)).map((p) => p.name).sort(), ['Nasi Tupe Soho', 'SRA Bandar Kinrara 5']);
  // With a house number, the place at that number first, though the other is nearer.
  const at5 = await searchNearby('5, BK 5/6, Bandar Kinrara, Puchong, 47180', ECO);
  assert.deepEqual(at5.map((p) => p.name), ['Nasi Tupe Soho', 'SRA Bandar Kinrara 5']);
  assert.deepEqual((await searchNearby('jalan bk 5/14', ECO)).map((p) => p.name), ['Kedai Lima Empat Belas']);
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

test('places drivers added are searched and ranked like the others, and their fixes hide the wrong place', async () => {
  try {
    setDriverPlaces([
      // Added: a shop nobody had, and a petrol station, found by "petrol" too.
      { id: 1, name: 'Nanas Hardware', address: 'Jalan Eco 3', category: 'shop', lat: 3.2245, lng: 101.4685 },
      { id: 2, name: 'BHP Puncak Alam', address: '', category: 'fuel', lat: 3.226, lng: 101.469 },
      // Moved: the Starbucks is really 200 m east of where Overture has it.
      { id: 3, name: 'Starbucks', address: 'Jalan Keramat', category: 'food', lat: 3.22737, lng: 101.46, hides_name: 'Starbucks', hides_lat: 3.22737, hides_lng: 101.45806 },
      // Gone: the Shell station closed.
      { id: 4, name: 'Shell Puncak Alam', lat: null, lng: null, hides_name: 'Shell Puncak Alam', hides_lat: 3.23, hides_lng: 101.47 },
      // Taken back out by a tester: not searched.
      { id: 5, name: 'Nando’s Fake', address: '', category: 'food', lat: 3.224, lng: 101.468, removed: 1 },
    ]);
    const nan = await searchNearby('nan', ECO);
    assert.deepEqual(nan.map((p) => p.name).sort(), ["Nando's", "Nando's", 'Nanas Hardware'].sort());
    assert.equal(nan.find((p) => p.name === 'Nanas Hardware').source, 'driver');

    const star = await searchNearby('starbucks', ECO);
    assert.deepEqual(star.map((p) => [p.name, p.lng]), [['Starbucks', 101.46]], 'only the moved one');

    // The other search's copy of the wrong one goes too, and the usual order holds: best match, then nearest.
    const merged = mergeResults([{ name: 'Starbucks', address: '', lat: 3.2274, lng: 101.4581 }, { name: 'Nanas Cafe', address: '', lat: 3.3, lng: 101.5 }], nan, 'nan', ECO);
    assert.ok(!merged.some((p) => p.name === 'Starbucks'));
    assert.deepEqual(merged.map((p) => p.name).slice(0, 2), ['Nanas Hardware', "Nando's"], 'nearest first among equal matches, not driver places first');

    const fuel = await placesOfType('fuel', ECO);
    assert.deepEqual(fuel.map((p) => p.name), ['Petronas Eco Grandeur', 'BHP Puncak Alam'], 'the closed Shell is gone, the added BHP is in');
  } finally {
    setDriverPlaces([]);
  }
});
