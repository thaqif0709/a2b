// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Odometer, logDriven, fuelSummary, dayKey } from '../public/fuel-log.js';
import { rmLabel, fuelLabel } from '../public/trip-cost.js';

// Going north from KL: 0.001° of latitude is about 111 m.
const at = (n, { t = n * 5000, accuracy = 8 } = {}) => ({ lngLat: [101.7, 3.1 + n * 0.001], accuracy, time: t });
// A time on the phone's own clock: day(3) is Tuesday 3 November 2026, noon.
const day = (d, h = 12, month = 11, year = 2026) => new Date(year, month - 1, d, h).getTime();

test('the odometer adds up the distance between fixes', () => {
  const odo = new Odometer();
  for (let n = 0; n <= 10; n++) odo.add(at(n));
  assert.ok(Math.abs(odo.metres - 1112) < 5, `${odo.metres}`);
  assert.ok(Math.abs(odo.take() - 1112) < 5);
  assert.equal(odo.metres, 0, 'taken');
  odo.add(at(11));
  assert.ok(Math.abs(odo.metres - 111) < 2, 'carries on from the last fix');
});

test('standing still, the GPS wobbling is not counted', () => {
  const odo = new Odometer();
  for (let i = 0; i < 100; i++) odo.add({ lngLat: [101.7 + (i % 2) * 0.0001, 3.1], accuracy: 10, time: i * 1000 }); // 11 m back and forth
  assert.equal(odo.metres, 0);
});

test('a vague fix, or the GPS jumping, is not counted', () => {
  const odo = new Odometer();
  odo.add(at(0));
  odo.add(at(1, { accuracy: 200 }));
  odo.add({ lngLat: [101.8, 3.1], accuracy: 8, time: 6000 }); // 11 km away a second later
  odo.add(at(2, { t: 7000 })); // and back
  assert.equal(odo.metres, 0);
  odo.add(at(3, { t: 12_000 }));
  assert.ok(Math.abs(odo.metres - 111) < 2, 'driving again');
});

test('the log keeps a total per day, and older days as one total', () => {
  let log = logDriven(null, 10_000, 1.5, day(3));
  log = logDriven(log, 5000, 0.75, day(3, 18));
  log = logDriven(log, 2000, null, day(4)); // an electric car: no fuel
  assert.deepEqual(log.days, { '2026-11-03': { m: 15_000, rm: 2.25 }, '2026-11-04': { m: 2000, rm: 0 } });
  assert.deepEqual(log.before, { m: 0, rm: 0 });
  log = logDriven(log, 1000, 0.2, day(10, 12, 1, 2027)); // 10 January 2027: November is long gone
  assert.deepEqual(Object.keys(log.days), ['2027-01-10']);
  assert.deepEqual(log.before, { m: 17_000, rm: 2.25 });
});

test('this week from Monday, this month from the 1st, and all time', () => {
  let log = null;
  log = logDriven(log, 40_000, 6, day(10, 12, 10)); // 10 October
  log = logDriven(log, 20_000, 3, day(1)); // Sunday 1 November: this month, last week
  log = logDriven(log, 10_000, 1.5, day(2)); // Monday
  log = logDriven(log, 5000, 0.75, day(3, 8)); // Tuesday morning
  const s = fuelSummary(log, day(3, 20));
  assert.deepEqual(s.week, { m: 15_000, rm: 2.25 });
  assert.deepEqual(s.month, { m: 35_000, rm: 5.25 });
  assert.deepEqual(s.all, { m: 75_000, rm: 11.25 });
  assert.deepEqual(fuelSummary(null, day(3)), { week: { m: 0, rm: 0 }, month: { m: 0, rm: 0 }, all: { m: 0, rm: 0 } }, 'nothing driven yet');
  // Older days folded away still count for all time.
  const later = logDriven(log, 1000, 0.15, day(20, 12, 3, 2027)); // 20 March 2027
  assert.deepEqual(fuelSummary(later, day(20, 13, 3, 2027)).all, { m: 76_000, rm: 11.4 });
  assert.equal(dayKey(day(9, 0, 1)), '2026-01-09');
});

test('ringgit to 10 sen, whole ringgit from RM 100', () => {
  assert.equal(rmLabel(0), '~RM 0.00');
  assert.equal(rmLabel(3.42), '~RM 3.40');
  assert.equal(rmLabel(123.4), '~RM 123');
  assert.equal(fuelLabel(3.42, 'diesel'), '~RM 3.40 diesel');
});

// Only real drives by car: not walks, motorbikes, trains or demo drives; logged as it goes and when the drive ends.
test('the app logs what real drives by car cover', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const body = (name) => app.slice(app.indexOf(`function ${name}(`), app.indexOf('\n}\n', app.indexOf(`function ${name}(`)));
  assert.match(app, /if \(mode === 'drive' && travel === 'drive' && !sim\) noteDriven\(fix\)/);
  assert.match(body('startDrive'), /odometer = new Odometer\(\)/);
  assert.match(body('endDrive'), /logFuel\(true\);\s*odometer = null;/);
  assert.match(body('logFuel'), /local\.set\('fuelLog', logDriven\(/);
  const sw = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /'\/fuel-log\.js'/, 'in the offline shell');
});
