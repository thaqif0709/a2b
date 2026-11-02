// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distance, cumulative } from '../public/geo.js';
import { Glide } from '../public/motion.js';

// 1 km north, then 500 m east, like the nav tests.
const A = [13.4, 52.5], B = [13.4, 52.509], C = [13.4074, 52.509];
const coords = [];
for (let i = 0; i <= 20; i++) coords.push([A[0], A[1] + (B[1] - A[1]) * (i / 20)]);
for (let i = 1; i <= 10; i++) coords.push([B[0] + (C[0] - B[0]) * (i / 10), B[1]]);
const path = { coords, cum: cumulative(coords) };

test('first fix is shown straight away', () => {
  const g = new Glide();
  g.set({ pos: A, heading: 0 }, 0);
  assert.deepEqual(g.at(0).pos, A);
  assert.ok(g.done(1));
});

test('slides between fixes over the time between them, never jumping', () => {
  const g = new Glide();
  const p1 = [13.4, 52.5009]; // about 100 m north
  g.set({ pos: A, heading: 0 }, 0);
  g.set({ pos: p1, heading: 0 }, 1000);
  const mid = g.at(1600).pos; // the glide takes 1.2 x the 1 s gap
  assert.ok(Math.abs(distance(A, mid) - 50) < 2);
  assert.ok(!g.done(2000), 'still moving when the next fix is due');
  assert.deepEqual(g.at(2200).pos, p1);
  assert.ok(g.done(2200));

  // A new fix mid-glide starts from where the car is drawn, not from the last fix.
  g.set({ pos: [13.4, 52.5018], heading: 0 }, 2500); // 1.5 s gap: glide lasts the 1.5 s cap
  g.set({ pos: [13.4, 52.5027], heading: 0 }, 3000); // a third of the way there
  const g2 = g.at(3000).pos;
  assert.ok(Math.abs(distance(p1, g2) - 33) < 3);
});

test('turns the short way round', () => {
  const g = new Glide();
  g.set({ pos: A, heading: 350 }, 0);
  g.set({ pos: A, heading: 10 }, 1000);
  const h = g.at(1600).heading;
  assert.ok(Math.abs(h) < 1e-9 || Math.abs(h - 360) < 1e-9);
});

test('follows the road round a corner instead of cutting it', () => {
  const g = new Glide();
  const before = { pos: coords[19], along: path.cum[19], path, heading: 0 }; // 50 m before the corner
  const after = { pos: coords[21], along: path.cum[21], path, heading: 90 }; // 50 m after it
  g.set(before, 0);
  g.set(after, 1000);
  const mid = g.at(1600).pos;
  assert.ok(distance(mid, B) < 1, 'halfway is the corner itself');
});

test('picks up the route again after a straight slide', () => {
  const g = new Glide();
  g.set({ pos: [13.40001, 52.5], heading: 0 }, 0); // no place on the route yet (e.g. from the map before a drive)
  for (let i = 1; i <= 4; i++) g.set({ pos: coords[i], along: path.cum[i], path, heading: 0 }, i * 1000);
  const shown = g.at(4500);
  assert.equal(shown.path, path);
  assert.ok(shown.along > path.cum[3] && shown.along < path.cum[4]);
});

test('jumps when the next fix is very far away', () => {
  const g = new Glide();
  const far = [13.45, 52.5]; // about 3.4 km east: back from the background, say
  g.set({ pos: A, heading: 0 }, 0);
  g.set({ pos: far, heading: 0 }, 1000);
  assert.deepEqual(g.at(1000).pos, far);
});

test('eases to a fix a few hundred metres off instead of jumping', () => {
  const g = new Glide();
  const off = [13.4, 52.5036]; // about 400 m north
  g.set({ pos: A, heading: 0 }, 0);
  g.set({ pos: off, heading: 0 }, 1000);
  assert.ok(distance(g.at(1000).pos, A) < 1, 'still where it was the moment the fix lands');
  const early = distance(g.at(1150).pos, A), mid = distance(g.at(1750).pos, A);
  assert.ok(early < 15, `starts gently (${early} m)`);
  assert.ok(Math.abs(mid - 200) < 10, `halfway after half the 1.5 s (${mid} m)`);
  assert.ok(!g.done(2400));
  assert.deepEqual(g.at(2500).pos, off);
});

test('slides back along the road when the car was drawn ahead', () => {
  const g = new Glide();
  // Drawn 50 m past the corner (a tunnel estimate ran ahead); the fix says 50 m before it.
  g.set({ pos: coords[21], along: path.cum[21], path, heading: 90 }, 0);
  g.set({ pos: coords[19], along: path.cum[19], path, heading: 0 }, 1000);
  assert.ok(distance(g.at(1750).pos, B) < 1, 'back round the corner, not across it');
  assert.ok(!g.done(2200), 'over 1.5 s, not the 1.2 s of a normal step');
  assert.deepEqual(g.at(2500).pos, coords[19]);
});
