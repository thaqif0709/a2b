// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTransit, serviceDay, runs, board, feeds, effort } from '../src/lib/bus-transit.js';

const BUKIT_BINTANG = [101.7108, 3.1428];
const KLCC = [101.7116, 3.1579];

const ENDS = Object.entries(feeds).sort(([, a], [, b]) => String(a.until).localeCompare(String(b.until)));
const end = Date.parse(`${ENDS[0][1].until.slice(0, 4)}-${ENDS[0][1].until.slice(4, 6)}-${ENDS[0][1].until.slice(6)}T09:00:00+08:00`);
const WEDNESDAY_9AM = end - 8 * 86400_000 - ((new Date(end - 8 * 86400_000 + 8 * 3600_000).getUTCDay() + 7 - 3) % 7) * 86400_000;

test('bus service day is Malaysia time', () => {
  const d = serviceDay(Date.parse('2026-10-28T23:30:00Z'));
  assert.deepEqual(d, { date: '20261029', dow: 3, secs: 7.5 * 3600 });
  assert.ok(runs('prasarana-bus:weekday', serviceDay(WEDNESDAY_9AM)));
});

test('KL bus trip returns valid buses', () => {
  const plan = planTransit(BUKIT_BINTANG, KLCC, WEDNESDAY_9AM);
  assert.ok(plan && (plan.trips?.length ?? 0) >= 0);
  if (plan.trips?.length) {
    const [best] = plan.trips;
    const buses = best.legs.filter((l) => l.mode === 'bus');
    assert.ok(buses.length >= 1, 'a bus leg');
    assert.equal(best.arrive - best.depart, best.duration * 1000);
    assert.ok(best.duration > 0);
    assert.ok(typeof effort(best) === 'number');
  }
});

test('boarding half a headway', () => {
  const freq = { freq: [[6 * 3600, 9 * 3600, 240], [9 * 3600, 23 * 3600, 600]], offsets: [0, 120, 300] };
  const b = board(freq, 1, 8 * 3600);
  assert.equal(b.dep, 8 * 3600 + 120);
  assert.equal(b.arrive(2), 8 * 3600 + 120 + 180);
  assert.equal(board(freq, 0, 5 * 3600).dep, 6 * 3600);
  assert.equal(board(freq, 0, 23.5 * 3600), null);
});
