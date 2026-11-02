// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cumulative } from '../public/geo.js';
import { restStopsAlong, nextRestStop, BreakClock, REST_AFTER_S, BREAK_S } from '../public/rest-stops.js';
import { restRows } from '../scripts/build-rest-stops.mjs';

// An expressway heading north along 101.7°E, ~55 km, with an R&R each side of it (Malaysia drives on the left,
// so going north yours is on the west), one too far off, a lay-by on the road itself and an R&R mapped twice.
const NORTH = Array.from({ length: 51 }, (_, i) => [101.7, 3 + i * 0.01]);
const ROWS = [
  [101.6985, 3.2, 'Dengkil R&R (Northbound)', 's'], // ~170 m west
  [101.7015, 3.2005, 'Dengkil R&R (Southbound)', 's'], // ~170 m east
  [101.69, 3.25, 'Far Away R&R', 's'], // ~1.1 km off
  [101.7001, 3.1, '', 'r'], // on the road
  [101.6988, 3.4, 'Seremban R&R', 's'],
  [101.6987, 3.4008, 'Seremban R&R', 's'],
  [102.5, 4.5, 'Elsewhere', 's'],
];
const along = (coords) => restStopsAlong(coords, cumulative(coords), ROWS);

test('rest stops beside the route, on your side of the road, in order', () => {
  const north = along(NORTH);
  assert.deepEqual(north.map((x) => x.name), ['Lay-by', 'Dengkil R&R (Northbound)', 'Seremban R&R']);
  assert.ok(Math.abs(north[1].at - 22_264) < 200, `${north[1].at} m along`);
  const south = along([...NORTH].reverse());
  assert.deepEqual(south.map((x) => x.name), ['Dengkil R&R (Southbound)', 'Lay-by'], 'going the other way, the other Dengkil, and not Seremban’s (across the road)');
});

test('what to show: an R&R coming up on a long drive, and after two hours a suggested break', () => {
  const list = along(NORTH);
  const dengkil = list[1];
  assert.equal(nextRestStop(0, list), null, 'nothing close yet');
  assert.equal(nextRestStop(dengkil.at - 2500, list).stop.name, 'Dengkil R&R (Northbound)');
  assert.equal(nextRestStop(dengkil.at - 2500, list).remind, false);
  assert.equal(nextRestStop(dengkil.at - 2500, list, { longDrive: false }), null, 'not on a short drive');
  const due = nextRestStop(0, list, { sinceBreak: REST_AFTER_S });
  assert.deepEqual([due.stop.name, due.remind, Math.round(due.ahead / 1000)], ['Dengkil R&R (Northbound)', true, 22], 'an R&R over the lay-by before it');
  assert.equal(nextRestStop(dengkil.at + 1000, list, { sinceBreak: REST_AFTER_S }).stop.name, 'Seremban R&R');
  assert.equal(nextRestStop(list.at(-1).at, list, { sinceBreak: REST_AFTER_S }), null, 'none left');
  // Only a lay-by ahead: that, rather than nothing.
  const layby = [{ name: 'Lay-by', kind: 'r', at: 30_000 }];
  assert.equal(nextRestStop(0, layby, { sinceBreak: REST_AFTER_S }).stop.name, 'Lay-by');
});

test('the break clock: driving time since the last stop of 15 minutes or more', () => {
  const t0 = Date.parse('2026-11-01T08:00:00+08:00');
  const clock = new BreakClock(t0);
  assert.equal(clock.update(t0 + 3600_000, 25), 3600);
  clock.update(t0 + 3600_000, 0); // a 5 minute stop at traffic lights or a jam doesn't count
  assert.equal(clock.update(t0 + 3900_000, 20), 3900);
  clock.update(t0 + 4000_000, 0);
  assert.equal(clock.update(t0 + 4000_000 + BREAK_S * 1000, 0), 0, 'resting now');
  assert.equal(clock.update(t0 + 4000_000 + BREAK_S * 1000 + 60_000, 25), 0, 'back on the road after a break');
  assert.equal(clock.update(t0 + 4000_000 + BREAK_S * 1000 + 3660_000, 25), 3600);
});

test('the build keeps R&Rs and lay-bys, named or not', () => {
  assert.deepEqual(restRows([
    { type: 'way', id: 1, center: { lat: 2.9, lon: 101.75 }, tags: { highway: 'services', name: 'R&R Dengkil', 'name:en': 'Dengkil R&R' } },
    { type: 'node', id: 2, lat: 3.1, lon: 101.6, tags: { highway: 'rest_area' } },
    { type: 'relation', id: 3, tags: { highway: 'services' } },
    { type: 'node', id: 4, lat: 3.2, lon: 101.7, tags: { highway: 'services', name: 'TCEAS Nissan Service Center' } },
    { type: 'node', id: 5, lat: 3.2, lon: 101.7, tags: { highway: 'rest_area', name: 'Ruby Lounge' } },
  ]), [[101.6, 3.1, '', 'r'], [101.75, 2.9, 'Dengkil R&R', 's']]);
  const built = JSON.parse(readFileSync(new URL('../public/rest-stops.json', import.meta.url), 'utf8'));
  assert.ok(built.stops.length > 300 && built.stops.every((s) => s.length === 4 && ['s', 'r'].includes(s[3])));
});
