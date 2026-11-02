// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './d1-shim.js';
import { readFileSync } from 'node:fs';
import { osmRows, ocmRows, describe, refreshChargers, allChargers } from '../src/lib/chargers.js';

// As Overpass and Open Charge Map return them (trimmed).
const OSM = [
  { type: 'node', id: 1, lat: 3.1579, lon: 101.7119, tags: { amenity: 'charging_station', name: 'Suria KLCC EV', operator: 'Gentari', 'socket:type2_combo': '2', 'socket:type2_combo:output': '60 kW', 'socket:type2': '2', 'socket:type2:output': '22 kW', capacity: '4' } },
  { type: 'way', id: 2, center: { lat: 3.118, lon: 101.677 }, tags: { amenity: 'charging_station', brand: 'ChargEV' } },
  { type: 'node', id: 3, lat: 3.13, lon: 101.68, tags: { amenity: 'charging_station', access: 'private', name: 'Staff only' } },
  { type: 'node', id: 4, lat: 3.14, lon: 101.69, tags: { amenity: 'charging_station', motorcar: 'no', motorcycle: 'yes', name: 'Bike charger' } },
];
const OCM = [
  // The same charger as OSM's Suria KLCC one, 20 m away: shown once, Open Charge Map's.
  { ID: 77, AddressInfo: { Title: 'Gentari @ Suria KLCC', Latitude: 3.15805, Longitude: 101.7119 }, NumberOfPoints: 4, Connections: [{ ConnectionTypeID: 33, PowerKW: 60, Quantity: 2 }, { ConnectionTypeID: 25, PowerKW: 22, Quantity: 2 }] },
  { ID: 78, AddressInfo: { Title: 'DC Handal Seremban', Latitude: 2.72, Longitude: 101.94 }, Connections: [{ ConnectionTypeID: 2, PowerKW: 50 }] },
  { ID: 79, AddressInfo: { Title: 'Broken', Latitude: 3.0, Longitude: 101.5 }, StatusType: { IsOperational: false } },
];

test('a charger’s details: who runs it, its plugs, how fast and how many bays', () => {
  assert.equal(describe({ operator: 'Gentari', plugs: ['CCS2', 'Type 2', 'CCS2'], kw: 60, bays: 4, name: 'Suria KLCC EV' }), 'Gentari · CCS2, Type 2 · up to 60 kW · 4 bays');
  assert.equal(describe({ operator: 'Gentari', name: 'Gentari @ Suria KLCC' }), '', 'the operator once');
});

test('OpenStreetMap chargers, without private or motorcycle-only ones', () => {
  const rows = osmRows(OSM);
  assert.deepEqual(rows.map((r) => r.name), ['Suria KLCC EV', 'ChargEV']);
  assert.equal(rows[0].details, 'Gentari · CCS2, Type 2 · up to 60 kW · 4 bays');
  assert.deepEqual([rows[1].lat, rows[1].lng], [3.118, 101.677], 'a mapped area, at its middle');
});

test('Open Charge Map chargers, without ones that aren’t working', () => {
  const rows = ocmRows(OCM);
  assert.deepEqual(rows.map((r) => r.id), ['ocm:77', 'ocm:78']);
  assert.equal(rows[0].details, 'CCS2, Type 2 · up to 60 kW · 4 bays');
  assert.equal(rows[1].details, 'CHAdeMO · up to 50 kW');
});

// A fresh database with the chargers table, as the migration makes it.
async function freshDb() {
  const db = createD1();
  const sql = readFileSync(new URL('../migrations/0011_chargers.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '');
  await db.batch(sql.split(';').map((x) => x.trim()).filter(Boolean).map((x) => db.prepare(x)));
  return db;
}

function fakeSources({ osm = OSM, ocm = OCM, down = [] } = {}) {
  const asked = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    asked.push(u);
    if (u.startsWith('https://overpass-api.de/')) {
      assert.match(String(init.body), /amenity%22%3D%22charging_station|amenity"="charging_station/);
      return down.includes('osm') ? new Response('busy', { status: 429 }) : Response.json({ elements: osm });
    }
    if (u.startsWith('https://api.openchargemap.io/')) {
      const p = new URL(u).searchParams;
      assert.equal(p.get('countrycode'), 'MY');
      assert.equal(p.get('opendata'), 'true', 'only openly licensed chargers');
      return down.includes('ocm') ? new Response('', { status: 500 }) : Response.json(ocm);
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return asked;
}

test('the nightly job fills the list weekly from both sources, and a charger in both shows once', async () => {
  const db = await freshDb();
  const now = Date.parse('2026-11-02T03:17:00Z');
  let asked = fakeSources();
  assert.deepEqual(await refreshChargers({ DB: db }, { now }), { osm: 2 }, 'no key: OpenStreetMap only');
  assert.equal(asked.length, 1);
  assert.deepEqual((await allChargers(db, { now })).map((r) => r[0]), ['Suria KLCC EV', 'ChargEV']);

  asked = fakeSources();
  assert.deepEqual(await refreshChargers({ DB: db, OCM_KEY: 'k' }, { now: now + 86400_000 }), { ocm: 2 }, 'a key added: Open Charge Map now, OpenStreetMap not again until a week has passed');
  const all = await allChargers(db, { now: now + 86400_000 });
  assert.deepEqual(all.map((r) => r[0]).sort(), ['ChargEV', 'DC Handal Seremban', 'Gentari @ Suria KLCC']);
  assert.deepEqual(all.find((r) => r[0] === 'DC Handal Seremban'), ['DC Handal Seremban', 101.94, 2.72, 'CHAdeMO · up to 50 kW', 'ev_charging_station']);

  asked = fakeSources();
  assert.deepEqual(await refreshChargers({ DB: db, OCM_KEY: 'k' }, { now: now + 2 * 86400_000 }), {}, 'nothing due');
  assert.equal(asked.length, 0);
});

test('a source that’s down, or answers with nothing, keeps last week’s chargers', async () => {
  const db = await freshDb();
  const now = Date.parse('2026-11-02T03:17:00Z');
  fakeSources();
  await refreshChargers({ DB: db }, { now });
  fakeSources({ down: ['osm'] });
  assert.deepEqual(await refreshChargers({ DB: db }, { now: now + 8 * 86400_000 }), { osm: 'failed' });
  fakeSources({ osm: [] });
  assert.deepEqual(await refreshChargers({ DB: db }, { now: now + 8 * 86400_000 }), { osm: 'empty' });
  assert.equal((await allChargers(db, { now: now + 9 * 86400_000 })).length, 2);
  // A week later it works again: the old list is replaced, not added to.
  fakeSources({ osm: OSM.slice(1) });
  assert.deepEqual(await refreshChargers({ DB: db }, { now: now + 9 * 86400_000 }), { osm: 1 });
  assert.deepEqual((await allChargers(db, { now: now + 10 * 86400_000 })).map((r) => r[0]), ['ChargEV']);
});

test('a big list goes in a few statements', async () => {
  const db = await freshDb();
  const many = Array.from({ length: 1000 }, (_, i) => ({ type: 'node', id: i + 1, lat: 1 + i * 0.01, lon: 101, tags: { amenity: 'charging_station', name: `C${i}` } }));
  fakeSources({ osm: many });
  let statements = 0;
  const batch = db.batch.bind(db);
  db.batch = (list) => ((statements += list.length), batch(list));
  await refreshChargers({ DB: db }, { now: 1 });
  assert.equal((await allChargers(db, { now: 1 })).length, 1000);
  assert.ok(statements <= 4, `${statements} statements`);
});
