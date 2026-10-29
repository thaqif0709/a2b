// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entranceRows, entrancesNear, pickEntrance, arrivalStreet, forgetEntrances } from '../src/lib/entrances.js';

const MID_VALLEY = [101.677, 3.118];
// As Overpass returns them (trimmed from the live data around Mid Valley).
const NODES = [
  { type: 'node', id: 1, lat: 3.1172, lon: 101.6762, tags: { amenity: 'parking_entrance', name: 'Mid Valley Car Park Zone C', ref: 'C', fee: 'yes' } },
  { type: 'node', id: 2, lat: 3.1191, lon: 101.6781, tags: { amenity: 'parking_entrance', ref: 'A' } },
  { type: 'node', id: 3, lat: 3.1183, lon: 101.6775, tags: { amenity: 'parking_entrance', access: 'private' } },
  { type: 'node', id: 4, lat: 3.1179, lon: 101.6772, tags: { amenity: 'parking_entrance', access: 'customers' } },
  { type: 'node', id: 5, lat: 3.1185, lon: 101.6760, tags: { amenity: 'parking_entrance', motorcar: 'no', name: 'Motorcycles' } },
];

// The built file, as the Worker's static assets serve it.
function assetsWith(nodes) {
  const calls = { reads: 0 };
  const assets = { fetch: async (req) => {
    calls.reads++;
    assert.equal(new URL(req.url).pathname, '/parking-entrances.json');
    return nodes ? Response.json({ entrances: entranceRows(nodes) }) : new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
  } };
  return { assets, calls };
}

function fakeRouter({ matrix = 'ok' } = {}) {
  const calls = { matrix: 0, bodies: [] };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/sources_to_targets')) {
      calls.matrix++;
      const body = JSON.parse(init.body);
      calls.bodies.push(body);
      if (matrix === 'down') return new Response('', { status: 500 });
      // From the south: Zone C (the southern one) is 3 minutes away, the rest 9.
      return Response.json({ sources_to_targets: [body.targets.map((t, i) => ({ to_index: i, time: t.lat < 3.1175 ? 180 : 540, distance: 1 }))] });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return calls;
}

test('entrances drivers may use: private and motorcycle-only ones left out, customers kept, named by ref', () => {
  assert.deepEqual(entranceRows(NODES).map((r) => r[2]), ['Mid Valley Car Park Zone C', 'Entrance A', '']);
  assert.deepEqual(entranceRows(NODES)[0], [101.6762, 3.1172, 'Mid Valley Car Park Zone C'], 'as the file keeps them: lng, lat, name');
});

test('the quickest entrance to reach from where you are, counting the walk to the place', async () => {
  forgetEntrances();
  const calls = fakeRouter();
  const list = await entrancesNear({ ASSETS: assetsWith(NODES).assets }, MID_VALLEY);
  assert.deepEqual(list.map((e) => e.name), ['', 'Mid Valley Car Park Zone C', 'Entrance A'], 'nearest the place first');
  const best = await pickEntrance({ ROUTING_URL: 'https://routing.test/route' }, [101.67, 3.08], list);
  assert.equal(best.name, 'Mid Valley Car Park Zone C');
  assert.equal(calls.matrix, 1);
  assert.equal(calls.bodies[0].costing, 'auto');
  assert.deepEqual(calls.bodies[0].sources, [{ lat: 3.08, lon: 101.67 }]);
});

test('the router down: the entrance nearest the place', async () => {
  forgetEntrances();
  fakeRouter({ matrix: 'down' });
  const list = await entrancesNear({ ASSETS: assetsWith(NODES).assets }, MID_VALLEY);
  assert.equal(await pickEntrance({ ROUTING_URL: 'https://routing.test/route' }, [101.67, 3.08], list), list[0]);
  assert.equal(await pickEntrance({}, [101.67, 3.08], []), null, 'none there');
});

test('the file is read once; not built yet, the app still routes, and it looks again later', async () => {
  forgetEntrances();
  const missing = assetsWith(null);
  assert.deepEqual(await entrancesNear({ ASSETS: missing.assets }, MID_VALLEY, { now: 0 }), []);
  await entrancesNear({ ASSETS: missing.assets }, MID_VALLEY, { now: 60_000 });
  assert.equal(missing.calls.reads, 1, 'not every route');
  const built = assetsWith(NODES);
  assert.equal((await entrancesNear({ ASSETS: built.assets }, MID_VALLEY, { now: 700_000 })).length, 3, 'ten minutes on, found');
  await entrancesNear({ ASSETS: built.assets }, [101.71, 3.15], { now: 800_000 });
  assert.equal(built.calls.reads, 1, 'then kept');
  assert.deepEqual(await entrancesNear({ ASSETS: built.assets }, [101.71, 3.15]), [], 'none near another place');
});

test('the street the route reaches the entrance on', () => {
  assert.equal(arrivalStreet({ steps: [{ street: 'Jalan Bukit Bintang' }, { street: 'Jalan Raja Chulan' }, { type: 'arrive', street: '' }] }), 'Jalan Raja Chulan');
  assert.equal(arrivalStreet({ steps: [] }), '');
  assert.equal(arrivalStreet({ steps: [{ street: 'Jalan Syed Putra' }, { street: 'To Boulevard Hotel' }, { type: 'arrive' }] }), 'Jalan Syed Putra', 'not a sign');
});
