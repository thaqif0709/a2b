import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRoutes } from '../src/lib/providers.js';
import { encodePolyline } from '../public/geo.js';

const from = [101.69, 3.13], to = [101.75, 3.2];
const via = [[101.73, 3.18], [101.7, 3.14], [101.72, 3.16]];
const fakeTrip = (order) => ({
  locations: [0, ...order.map((i) => i + 1), 4].map((original_index) => ({ original_index })),
  summary: { length: 6, time: 900 },
  legs: [from, ...order.map((i) => via[i])].map((start, i) => ({
    shape: encodePolyline([start, [...order.map((i) => via[i]), to][i]], 6),
    maneuvers: [{ type: 1, begin_shape_index: 0, end_shape_index: 1, length: 2, time: 300 }, { type: 4, begin_shape_index: 1, end_shape_index: 1, length: 0, time: 0 }],
  })),
});

test('multi-stop route uses one road-optimization request with fixed endpoints', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++;
    assert.equal(url, 'https://router.example/optimized_route');
    const body = JSON.parse(init.body);
    assert.deepEqual(body.locations.map((p) => [p.lon, p.lat]), [from, ...via, to]);
    assert.equal(body.alternates, 0);
    assert.equal(body.costing_options.auto.use_tolls, 0);
    return Response.json({ trip: fakeTrip([1, 2, 0]) });
  });
  const result = await fetchRoutes({ ROUTING_URL: 'https://router.example/route' }, { from, to, via, optimize: true, avoid: { tolls: true } });
  assert.equal(calls, 1);
  assert.deepEqual(result.routes[0].stopOrder, [1, 2, 0]);
  assert.equal(result.routes[0].stops, 3);
  assert.equal(result.routes[0].steps.filter((s) => s.type === 'stop').length, 3);
});

test('ordinary reroutes preserve the established waypoint order', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, 'https://router.example/route');
    return Response.json({ trip: fakeTrip([0, 1, 2]) });
  });
  const result = await fetchRoutes({ ROUTING_URL: 'https://router.example/route' }, { from, to, via });
  assert.equal(result.routes[0].stopOrder, undefined);
});

test('invalid optimization order is rejected instead of losing a stop', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ trip: fakeTrip([0, 0, 2]) }));
  await assert.rejects(fetchRoutes({}, { from, to, via, optimize: true }), /could not order/);
});
