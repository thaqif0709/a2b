// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cumulative } from '../public/geo.js';
import { DeadReckoner, shouldEstimate, nearTunnel, pointAt, GIVE_UP_MS, GIVE_UP_M } from '../public/dead-reckoning.js';
import { tunnelRuns } from '../src/lib/providers.js';

// A road heading east along 3.1°N: 0.001° of longitude is ~111 m.
const LINE = Array.from({ length: 41 }, (_, i) => [101.6 + i * 0.001, 3.1]);
const CUM = cumulative(LINE);

test('when to start estimating: the GPS quiet or vague, and the car moving or at a tunnel', () => {
  assert.ok(shouldEstimate({ sinceFixMs: 3000, accuracy: 10, speed: 15 }), 'no fix for 3 s at 54 km/h');
  assert.ok(shouldEstimate({ sinceFixMs: 500, accuracy: 150, speed: 15 }), 'a fix 150 m off is no fix');
  assert.ok(!shouldEstimate({ sinceFixMs: 1000, accuracy: 10, speed: 15 }), 'fixes still coming');
  assert.ok(!shouldEstimate({ sinceFixMs: 5000, accuracy: 10, speed: 0.5 }), 'parked: stays put');
  assert.ok(!shouldEstimate({ sinceFixMs: 5000, accuracy: 10, speed: 3 }), 'crawling, no tunnel');
  assert.ok(shouldEstimate({ sinceFixMs: 5000, accuracy: 10, speed: 3, tunnel: true }), 'crawling into a tunnel');
});

test('in or just before a tunnel on the route', () => {
  const tunnels = [[10, 15]]; // ~1.1 km to ~1.67 km in
  assert.ok(nearTunnel(CUM[10] - 200, CUM, tunnels), '200 m before');
  assert.ok(nearTunnel(CUM[12], CUM, tunnels), 'inside');
  assert.ok(nearTunnel(CUM[15] + 50, CUM, tunnels), 'just out');
  assert.ok(!nearTunnel(CUM[2], CUM, tunnels));
  assert.ok(!nearTunnel(CUM[20], CUM, tunnels));
  assert.ok(!nearTunnel(CUM[12], CUM), 'none known');
});

test('the car keeps going along the route, easing off slowly, never over the limit', () => {
  const t0 = 1_000_000;
  const dr = new DeadReckoner({ along: 500, speed: 20, now: t0 });
  const a = dr.advance(t0 + 10_000);
  assert.ok(a.along > 500 + 175 && a.along < 500 + 200, `${a.along}: ~180 m in 10 s from 72 km/h, easing`);
  assert.ok(a.speed < 20 && a.speed > 17);
  const b = dr.advance(t0 + 20_000, 50); // a 50 km/h tunnel: 13.9 m/s at most
  assert.ok(b.speed <= 50 / 3.6 + 1e-9);
  assert.ok(!b.done);
});

test('gives up after 90 s or 2.5 km', () => {
  const slow = new DeadReckoner({ along: 0, speed: 8, now: 0 });
  assert.ok(!slow.advance(GIVE_UP_MS - 1000).done);
  assert.ok(slow.advance(GIVE_UP_MS).done, 'too long');
  // Very fast (and no limit known): the distance runs out first.
  const fast = new DeadReckoner({ along: 0, speed: 70, now: 0 });
  let t = 0, r;
  do r = fast.advance((t += 1000)); while (!r.done);
  assert.ok(t < GIVE_UP_MS && r.along >= GIVE_UP_M, `gave up at ${t / 1000} s, ${Math.round(r.along)} m`);
});

test('a point along the route, and the way the road runs there', () => {
  const { point, bearing } = pointAt(LINE, CUM, CUM[3] + (CUM[4] - CUM[3]) / 2);
  assert.ok(Math.abs(point[0] - 101.6035) < 1e-9 && point[1] === 3.1);
  assert.ok(Math.abs(bearing - 90) < 0.01, 'east');
  assert.deepEqual(pointAt(LINE, CUM, -5).point, LINE[0]);
  assert.deepEqual(pointAt(LINE, CUM, 1e9).point, LINE.at(-1), 'never past the end');
});

test('tunnel stretches from Valhalla’s edges, a long tunnel’s edges joined', () => {
  const edges = [
    { begin_shape_index: 0, end_shape_index: 4 },
    { begin_shape_index: 4, end_shape_index: 9, tunnel: true },
    { begin_shape_index: 9, end_shape_index: 12, tunnel: true },
    { begin_shape_index: 12, end_shape_index: 20 },
    { begin_shape_index: 20, end_shape_index: 21, tunnel: true },
  ];
  assert.deepEqual(tunnelRuns(edges), [[4, 12], [20, 21]]);
  assert.deepEqual(tunnelRuns(edges, 100), [[104, 112], [120, 121]], 'a later leg, at its offset');
  assert.deepEqual(tunnelRuns([]), []);
});
