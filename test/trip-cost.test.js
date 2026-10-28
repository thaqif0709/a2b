// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuelCost, fuelLabel } from '../public/trip-cost.js';
import { fuelPrices, forgetFuelPrices } from '../src/lib/fuel.js';

const PRICES = { date: '2026-10-22', ron95: 4.32, ron95_budi95: 1.99, ron97: 4.8, diesel: 5.07, diesel_eastmsia: 2.15 };
const KL = [101.69, 3.14], KUCHING = [110.34, 1.55];

test('fuel for a drive: its length, what the car uses and the pump price', () => {
  // 100 km in a medium car (7.5 L/100 km) on subsidised RON95: 7.5 L at RM 1.99.
  assert.equal(fuelCost(100_000, {}, PRICES, KL).toFixed(2), '14.93');
  assert.equal(fuelCost(100_000, { fuel: 'ron97', size: 'large' }, PRICES, KL).toFixed(2), '48.00');
  assert.equal(fuelCost(100_000, { fuel: 'ron95', size: 'small' }, PRICES, KL).toFixed(2), '25.92');
});

test('diesel is cheaper in Sabah and Sarawak', () => {
  assert.equal(fuelCost(100_000, { fuel: 'diesel' }, PRICES, KL).toFixed(2), '38.03');
  assert.equal(fuelCost(100_000, { fuel: 'diesel' }, PRICES, KUCHING).toFixed(2), '16.13');
});

test('no estimate for an electric car, or without prices', () => {
  assert.equal(fuelCost(100_000, { fuel: 'ev' }, PRICES, KL), null);
  assert.equal(fuelCost(100_000, {}, null, KL), null);
  assert.equal(fuelLabel(null), '');
});

test('the label: rounded as people say it, and which fuel', () => {
  assert.equal(fuelLabel(3.43), '~RM 3.40 petrol');
  assert.equal(fuelLabel(14.93), '~RM 14.90 petrol');
  assert.equal(fuelLabel(123.4, 'diesel'), '~RM 123 diesel');
});

test('pump prices: the newest week’s, asked for a few times a day, the last ones kept when the service is down', async () => {
  forgetFuelPrices();
  let calls = 0, down = false;
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls++;
    assert.match(String(url), /^https:\/\/api\.data\.gov\.my\/data-catalogue\?id=fuelprice/);
    if (down) return new Response('', { status: 503 });
    return Response.json([
      { date: '2026-10-22', series_type: 'change_weekly', ron95: -0.3, ron97: -0.3 },
      { date: '2026-10-22', series_type: 'level', ron95: 4.32, ron95_budi95: 1.99, ron97: 4.8, diesel: 5.07, diesel_eastmsia: 2.15, ron95_skps: 2.05 },
      { date: '2026-10-15', series_type: 'level', ron95: 4.62, ron97: 5.1, diesel: 5.17 },
    ]);
  };
  try {
    const now = Date.parse('2026-10-28T08:00:00Z');
    assert.deepEqual(await fuelPrices({ now }), PRICES);
    await fuelPrices({ now: now + 3600_000 });
    assert.equal(calls, 1, 'kept for a few hours');
    down = true;
    assert.deepEqual(await fuelPrices({ now: now + 7 * 3600_000 }), PRICES, 'the old prices while it’s down');
    assert.equal(calls, 2);
    await fuelPrices({ now: now + 7 * 3600_000 + 60_000 });
    assert.equal(calls, 2, 'not asked again straight away');
  } finally {
    globalThis.fetch = orig;
  }
});
