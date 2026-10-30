// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const near = [101.7, 3.1];
const index = { release: 'availability-test', area: 0.5, areas: ['6_203'] };
const list = '/places/6_203/files.json?v=availability-test';
const ca = '/places/6_203/ca.json?v=availability-test', caf = '/places/6_203/caf.json?v=availability-test';
const row = (name, lng = 101.7) => [name, lng, 3.1, '', 'cafe'];
const json = (body, status = 200) => Response.json(body, { status });

for (const status of [404, 503]) test(`a failed advertised shard (${status}) preserves other places and retries`, async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = new Map();
  let restored = false, limited = 0;
  globalThis.fetch = async (url) => {
    calls.set(url, (calls.get(url) ?? 0) + 1);
    if (url === '/places/index.json') return json(index);
    if (url === list) return json({ ca: 1, caf: 1 });
    if (url === ca) return json({ p: [row('Cafe One')] });
    if (url === caf) return restored ? json({ p: [row('Cafe Two', 101.701)] }) : json({}, status);
    throw new Error(`Unexpected URL ${url}`);
  };
  const { searchNearby } = await import(`../public/places.js?shard=${status}`);
  const options = { onUnavailable: () => limited++ };
  assert.deepEqual((await searchNearby('ca', near, options)).map((p) => p.name), ['Cafe One']);
  assert.equal(limited, 1);
  restored = true;
  assert.deepEqual((await searchNearby('ca', near, options)).map((p) => p.name), ['Cafe One', 'Cafe Two']);
  assert.equal(limited, 1);
  assert.equal(calls.get(ca), 1, 'successful shards stay cached');
  assert.equal(calls.get(caf), 2, 'the unavailable shard is retried');
});

test('missing optional dataset is quiet but an unavailable index retries', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let limited = 0, calls = 0;
  globalThis.fetch = async () => { calls++; return json({}, 404); };
  const absent = await import('../public/places.js?absent-index');
  const options = { onUnavailable: () => limited++ };
  assert.deepEqual(await absent.searchNearby('cafe', near, options), []);
  assert.deepEqual(await absent.searchNearby('cafe', near, options), []);
  assert.equal(limited, 0);
  assert.equal(calls, 1);
  let online = false;
  globalThis.fetch = async (url) => {
    if (!online) throw new TypeError('Offline');
    return url === '/places/index.json' ? json(index) : url === list ? json({ caf: 1 }) : json({ p: [row('Cafe')] });
  };
  const transient = await import('../public/places.js?transient-index');
  assert.deepEqual(await transient.searchNearby('cafe', near, options), []);
  assert.equal(limited, 1);
  online = true;
  assert.equal((await transient.searchNearby('cafe', near, options))[0].name, 'Cafe');
});

test('a category provider failure retains local results and can recover next search', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => url === '/places/index.json' ? json(index)
    : url === list ? json({ '@ev': 1 }) : json({ p: [row('Local charger')] });
  const { addTypeSource, placesOfType } = await import('../public/places.js?category-availability');
  let online = false, limited = 0;
  addTypeSource('ev', async () => {
    if (!online) throw new Error('Charger service unavailable');
    return [row('Remote charger', 101.71)];
  });
  const options = { onUnavailable: () => limited++ };
  assert.deepEqual((await placesOfType('ev', near, options)).map((p) => p.name), ['Local charger']);
  assert.equal(limited, 1);
  online = true;
  assert.deepEqual((await placesOfType('ev', near, options)).map((p) => p.name), ['Local charger', 'Remote charger']);
  assert.equal(limited, 1);
});

test('approved driver places survive an unavailable index and keep hidden results out after retry', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let online = false, limited = 0;
  globalThis.fetch = async (url) => {
    if (!online) return json({}, 503);
    return url === '/places/index.json' ? json(index) : url === list ? json({ caf: 1 })
      : json({ p: [row('Cafe Closed'), row('Cafe Local', 101.702)] });
  };
  const { setDriverPlaces, searchNearby, mergeResults } = await import('../public/places.js?driver-availability');
  setDriverPlaces([
    { name: 'Cafe Approved', lng: 101.701, lat: 3.1, category: 'cafe' },
    { name: 'Cafe Closed', lng: null, lat: null, hides_name: 'Cafe Closed', hides_lng: 101.7, hides_lat: 3.1 },
  ]);
  const options = { onUnavailable: () => limited++ };
  assert.deepEqual((await searchNearby('cafe', near, options)).map((p) => p.name), ['Cafe Approved']);
  assert.equal(limited, 1, 'index failure still marks the result as partial');
  online = true;
  const found = await searchNearby('cafe', near, options);
  assert.deepEqual(found.map((p) => p.name), ['Cafe Approved', 'Cafe Local']);
  assert.deepEqual(mergeResults([{ name: 'Cafe Closed', lng: 101.7, lat: 3.1 }], found, 'cafe', near).map((p) => p.name),
    ['Cafe Approved', 'Cafe Local'], 'the hidden server copy stays hidden too');
  assert.equal(limited, 1);
});

test('driver category places survive server and file failures, retaining hide rules when they recover', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let online = false, limited = 0;
  globalThis.fetch = async (url) => url === '/places/index.json' ? json(index)
    : url === list ? json({ '@ev': 1 }) : online ? json({ p: [row('Closed charger')] }) : json({}, 503);
  const { setDriverPlaces, addTypeSource, placesOfType } = await import('../public/places.js?driver-category-availability');
  setDriverPlaces([
    { name: 'Approved charger', lng: 101.701, lat: 3.1, category: 'ev' },
    { name: 'Closed charger', lng: null, lat: null, hides_name: 'Closed charger', hides_lng: 101.7, hides_lat: 3.1 },
  ]);
  addTypeSource('ev', async () => {
    if (!online) throw new Error('Synthetic provider unavailable');
    return [row('Closed charger'), row('Remote charger', 101.702)];
  });
  const options = { onUnavailable: () => limited++ };
  assert.deepEqual((await placesOfType('ev', near, options)).map((p) => p.name), ['Approved charger']);
  assert.equal(limited, 2, 'both failed sources report incomplete coverage');
  online = true;
  assert.deepEqual((await placesOfType('ev', near, options)).map((p) => p.name), ['Approved charger', 'Remote charger']);
  assert.equal(limited, 2);
});
