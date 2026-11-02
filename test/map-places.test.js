// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPlace } from '../public/map-places.js';

test('named places on the map: their name and what kind they are', () => {
  assert.deepEqual(mapPlace({ class: 'bus', subclass: 'bus_stop', name: 'KLCC (Opp)' }), { name: 'KLCC (Opp)', address: 'Bus stop' });
  assert.deepEqual(mapPlace({ class: 'railway', subclass: 'subway', name: 'KLCC', 'name:latin': 'KLCC' }), { name: 'KLCC', address: 'Station' });
  assert.deepEqual(mapPlace({ class: 'parking', name: 'Suria KLCC Parking' }), { name: 'Suria KLCC Parking', address: 'Car park' });
  assert.deepEqual(mapPlace({ class: 'shop', subclass: 'mall', name: 'Suria KLCC' }), { name: 'Suria KLCC', address: 'Mall' });
});

test('unnamed stops, stations and car parks can be tapped too, named by their kind', () => {
  assert.deepEqual(mapPlace({ class: 'bus', subclass: 'bus_stop' }), { name: 'Bus stop', address: '' });
  assert.deepEqual(mapPlace({ class: 'parking' }), { name: 'Car park', address: '' });
  assert.deepEqual(mapPlace({ class: 'railway', subclass: 'light_rail' }), { name: 'LRT station', address: '' });
  assert.deepEqual(mapPlace({ class: 'railway', subclass: 'monorail' }), { name: 'Monorail station', address: '' });
});

test('other unnamed icons are not places to go to', () => {
  assert.equal(mapPlace({ class: 'shop' }), null);
  assert.equal(mapPlace({ class: 'bench' }), null);
});
