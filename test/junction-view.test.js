// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findJunctions, junctionText, junctionAt, junctionSpan, ENTER_M, LEAVE_M } from '../public/junction-view.js';
import { normalizeTrip } from '../src/lib/providers.js';

// Bangsar South to Petaling Jaya by the Kerinchi Link, as Valhalla gives it (types, metres to the next maneuver,
// signs), trimmed.
const KERINCHI = [
  { type: 1, length: 49 }, { type: 27, length: 19 }, { type: 26, length: 34 }, { type: 27, length: 107 },
  { type: 10, length: 643 }, // turn right onto Jalan Kerinchi
  { type: 24, length: 194 }, { type: 24, length: 68 }, { type: 19, length: 42 }, { type: 18, length: 6436 }, // keep left x2, ramps
  { type: 21, length: 219, toward: ['E11', '2'] }, { type: 23, length: 1095, toward: ['E11', '2'] }, // exit 222, keep right
  { type: 24, length: 319, toward: ['Kawasan Perindustrian Bebas', 'SS3'] }, { type: 24, length: 54 }, // exit 1110, fork
  { type: 9, length: 1434 }, { type: 15, length: 213 }, { type: 5, length: 0 },
].map((m, i) => ({ begin: i * 10, toward: [], ...m }));

test('a junction is two or more ramps, exits or forks close together', () => {
  const js = findJunctions(KERINCHI);
  assert.deepEqual(js.map((j) => [j.from, j.to]), [[5, 8], [9, 10], [11, 12]]);
  assert.deepEqual([js[0].start, js[0].end], [50, 80], 'the first and last decision, as shape indexes');
  // Turns in town don't count, however close; one ramp alone isn't a junction.
  assert.deepEqual(findJunctions([{ type: 10, length: 50, begin: 0 }, { type: 15, length: 40, begin: 5 }, { type: 9, length: 30, begin: 8 }]), []);
  assert.deepEqual(findJunctions([{ type: 18, length: 3000, begin: 0 }, { type: 23, length: 100, begin: 50 }]), [], 'too far apart');
});

test('a long run of forks is split, so the view never covers kilometres', () => {
  const run = Array.from({ length: 6 }, (_, i) => ({ type: 23, length: 700, begin: i * 10, toward: [] }));
  const js = findJunctions(run);
  assert.ok(js.length >= 2);
  assert.ok(js.every((j) => (j.to - j.from) * 700 <= 1500));
});

test('one instruction for the whole junction', () => {
  const [kerinchi, e11, ss3] = findJunctions(KERINCHI);
  assert.equal(kerinchi.text, 'Keep left, then take the ramp on the left, then take the ramp on the right');
  assert.equal(e11.text, 'Exit left, then keep right towards E11', 'only road numbers on the signs');
  assert.equal(ss3.text, 'Keep left towards Kawasan Perindustrian Bebas', 'the same keep twice said once');
  assert.equal(junctionText([{ type: 18, toward: ['E23'] }, { type: 23, toward: ['E11', 'Damansara'] }, { type: 23, toward: ['E1', 'E8'] }]), 'Take the ramp on the right, then keep right towards Damansara', 'a place over a road number');
});

test('the view starts 500 m before the first decision and ends 100 m after the last', () => {
  const cum = Array.from({ length: 100 }, (_, i) => i * 50); // a point every 50 m
  const js = [{ start: 40, end: 50 }, { start: 80, end: 85 }]; // 2000-2500 m, 4000-4250 m
  assert.deepEqual(junctionAt(1000, js, cum), { index: 0, inView: false, ahead: 1000 });
  assert.equal(junctionAt(2000 - ENTER_M, js, cum).inView, true);
  assert.equal(junctionAt(2500 + LEAVE_M, js, cum).index, 0);
  assert.deepEqual(junctionAt(2500 + LEAVE_M + 1, js, cum), { index: 1, inView: false, ahead: 1399 });
  assert.equal(junctionAt(4400, js, cum), null);
  assert.deepEqual(junctionSpan(js[0], cum, 4950), [1900, 2700]);
});

// Google's polyline encoding at Valhalla's precision.
function encode(coords, f = 1e6) {
  let out = '', plat = 0, plng = 0;
  for (const [lng, lat] of coords) {
    const ilat = Math.round(lat * f), ilng = Math.round(lng * f);
    for (let d of [ilat - plat, ilng - plng]) {
      let v = d < 0 ? ~(d << 1) : d << 1;
      while (v >= 0x20) {
        out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
        v >>= 5;
      }
      out += String.fromCharCode(v + 63);
    }
    plat = ilat;
    plng = ilng;
  }
  return out;
}

test('routes carry their junctions, steps and shape indexes matching', () => {
  const shape = encode(Array.from({ length: 60 }, (_, i) => [101.6 + i * 0.001, 3.1]));
  const m = (type, begin, length, extra = {}) => ({ type, begin_shape_index: begin, end_shape_index: begin + 10, length: length / 1000, time: 10, instruction: 'x', ...extra });
  const trip = {
    summary: { length: 6, time: 300 },
    legs: [{ shape, maneuvers: [m(1, 0, 1000), m(20, 10, 300, { sign: { exit_toward_elements: [{ text: 'Seremban' }] } }), m(24, 20, 2000), m(4, 59, 0)] }],
  };
  const r = normalizeTrip(trip);
  assert.deepEqual(r.junctions, [{ from: 1, to: 2, start: 10, end: 20, text: 'Exit right, then keep left towards Seremban' }]);
  assert.equal(r.steps[1].begin, 10);
});
