// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { distance } from '../public/geo.js';
import { shouldSave, parkedCar, parkedLabel, pickedUp } from '../public/parked.js';

const PAVILION = [101.7137, 3.1488];

test('only a real drive parks the car', () => {
  const drive = { travel: 'drive', simulated: false, driven: 5000, at: PAVILION };
  assert.equal(shouldSave(drive), true);
  assert.equal(shouldSave({ ...drive, travel: 'walk' }), false, 'a walk');
  assert.equal(shouldSave({ ...drive, travel: 'transit' }), false, 'a train trip');
  assert.equal(shouldSave({ ...drive, simulated: true }), false, 'a demo drive');
  assert.equal(shouldSave({ ...drive, driven: 120 }), false, 'started and stopped straight away');
  assert.equal(shouldSave({ ...drive, at: null }), false, 'no GPS fix');
});

test('the label says how long ago and near where', () => {
  const now = Date.parse('2026-10-28T15:00:00+08:00');
  const car = parkedCar(PAVILION, 'Pavilion Kuala Lumpur', now);
  assert.deepEqual(car, { lng: 101.7137, lat: 3.1488, at: now, near: 'Pavilion Kuala Lumpur', note: '' });
  assert.equal(parkedLabel(car, now + 20_000), 'Parked just now near Pavilion Kuala Lumpur');
  assert.equal(parkedLabel(car, now + 25 * 60_000), 'Parked 25 min ago near Pavilion Kuala Lumpur');
  assert.equal(parkedLabel(car, now + 2 * 3600_000), 'Parked 2 h ago near Pavilion Kuala Lumpur');
  assert.equal(parkedLabel({ ...car, near: '' }, now + 3 * 86400_000), 'Parked 3 days ago');
});

test('driving off from beside the car picks it up; from elsewhere it stays', () => {
  const car = parkedCar(PAVILION, 'Pavilion', 0);
  assert.equal(pickedUp(car, [101.7139, 3.1489], distance), true, '~25 m away');
  assert.equal(pickedUp(car, [101.7116, 3.1579], distance), false, 'KLCC, a kilometre off');
  assert.equal(pickedUp(null, PAVILION, distance), false);
});

test('the app keeps it on this phone only, and works offline', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const sw = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(app, /local\.set\('parkedCar'/);
  assert.doesNotMatch(app, /api\([^)]*park(ed)?Car/i, 'never sent to the server');
  assert.match(sw, /'\/parked\.js'/);
});
