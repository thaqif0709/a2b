// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { laneShiftM, metresExpr, bandPieces, bandRange, camerasInRange, bridgeRuns, LANE_M, BAND_M, AHEAD_M, SHIFT_M } from '../public/junction-3d.js';
import { lanes } from '../src/lib/providers.js';

test('the band moves over to the lanes to use', () => {
  // From Valhalla at the Kerinchi junction: "Keep right to take E11", the right two of four lanes.
  const keepRight = lanes([{ directions: 8 }, { directions: 8 }, { directions: 64, active: 64 }, { directions: 64, active: 64 }]);
  assert.equal(laneShiftM(keepRight), LANE_M, 'one lane right of the middle');
  // "Take exit 222": the left one of three.
  assert.equal(laneShiftM(lanes([{ directions: 18, active: 16 }, { directions: 2 }, { directions: 2 }])), -LANE_M);
  assert.equal(laneShiftM(lanes([{ directions: 2, active: 2 }, { directions: 2, active: 2 }, { directions: 2, active: 2 }])), 0, 'every lane goes on');
  assert.equal(laneShiftM(null), 0, 'no lane data');
  assert.equal(laneShiftM([{ d: 2, use: 0 }, { d: 2, use: 0 }]), 0);
});

test('metres to pixels: the same ground width at every zoom', () => {
  const expr = metresExpr(BAND_M, 3.1);
  assert.deepEqual(expr.slice(0, 3), ['interpolate', ['exponential', 2], ['zoom']]);
  const [, , , z1, px1, z2, px2] = expr;
  assert.equal(z1, 10);
  assert.equal(z2, 22);
  assert.ok(Math.abs(px2 / px1 - 2 ** 12) < 1e-6, 'doubles with each zoom');
  // At zoom 17.5 near KL a metre is ~2.37 px.
  const perM = (px1 * 2 ** 7.5) / BAND_M;
  assert.ok(perM > 2.2 && perM < 2.55, `${perM}`);
  const byFeature = metresExpr(['get', 'shift'], 3.1);
  assert.deepEqual(byFeature[4][0], '/', 'a feature’s own metres, divided per zoom');
});

// A straight 2 km route, a point every 10 m.
const cum = Array.from({ length: 201 }, (_, i) => i * 10);

test('band pieces: plain, then sliding over before a decision with lanes, back after it, lifted on a flyover', () => {
  const steps = [
    { begin: 50, lanes: null }, // a decision without lane data at 500 m: nothing to do
    { begin: 100, lanes: [{ d: 8, use: 0 }, { d: 8, use: 0 }, { d: 64, use: 64 }, { d: 64, use: 64 }] }, // 1000 m: keep right
  ];
  const pieces = bandPieces({ from: 0, to: 1300, cum, steps, bridges: [[110, 115]] });
  assert.equal(pieces[0].a, 0);
  assert.equal(pieces.at(-1).b, 1300);
  for (let i = 1; i < pieces.length; i++) assert.equal(pieces[i].a, pieces[i - 1].b, 'end to end');
  const at = (x) => pieces.find((p) => x >= p.a && x < p.b);
  assert.equal(at(500).shift, 0, 'no lanes, no shift');
  assert.equal(at(1000 - SHIFT_M - 10).shift, 0, 'before the stretch');
  const sliding = pieces.filter((p) => p.a >= 1000 - SHIFT_M && p.b <= 1000 - SHIFT_M + 120).map((p) => p.shift);
  assert.ok(sliding.length >= 3 && sliding.every((s, i) => !i || s >= sliding[i - 1]), `eases over: ${sliding}`);
  assert.equal(at(990).shift, LANE_M, 'over the lanes to use at the decision');
  assert.equal(at(1050).shift, 0, 'after it, on the branch taken');
  assert.equal(at(1120).bridge, true, 'the flyover');
  assert.equal(at(1160).bridge, false);
  assert.deepEqual(bandPieces({ from: 0, to: 300, cum, steps: [] }), [{ a: 0, b: 300, shift: 0, bridge: false }], 'one piece when nothing changes');
  assert.deepEqual(bandPieces({ from: 300, to: 300, cum }), []);
});

test('the band runs from the car to just past the junction, with its cameras', () => {
  const j = { start: 100, end: 130 };
  assert.deepEqual(bandRange(800, j, cum, 2000), [800, 1300 + AHEAD_M]);
  assert.deepEqual(bandRange(800, { start: 190, end: 199 }, cum, 2000), [800, 2000], 'not past the end');
  const cams = [{ at: 20 }, { at: 120 }, { at: 160 }];
  assert.deepEqual(camerasInRange(cams, cum, [800, 1500]), [{ at: 120 }]);
  assert.deepEqual(camerasInRange(undefined, cum, [0, 10]), []);
});

test('flyovers from Valhalla edges: touching bridge edges joined, shifted by the leg', () => {
  // As trace_attributes gave them on the Kerinchi route (a ramp bridge in three edges).
  const edges = [
    { begin_shape_index: 137, end_shape_index: 138, bridge: true },
    { begin_shape_index: 138, end_shape_index: 150 },
    { begin_shape_index: 174, end_shape_index: 176, bridge: true },
    { begin_shape_index: 176, end_shape_index: 177, bridge: true },
    { begin_shape_index: 177, end_shape_index: 179, bridge: true },
    { begin_shape_index: 179, bridge: true }, // no end: skipped
  ];
  assert.deepEqual(bridgeRuns(edges), [[137, 138], [174, 179]]);
  assert.deepEqual(bridgeRuns(edges.slice(0, 1), 40), [[177, 178]]);
  assert.deepEqual(bridgeRuns(null), []);
});
