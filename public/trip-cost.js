// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// What a drive costs in fuel, roughly: its length, how much the car uses and this week's pump price (Malaysia's
// official weekly prices, from the server: src/lib/fuel.js). Shown next to the tolls on each route, so the
// toll-free route's real cost is easy to compare. An estimate, and said to be one.

// The fuel a car takes, as this phone's settings call it, and the price list's name for it. The BUDI ones are the
// subsidised prices, for drivers who get the subsidy: who does is up to them, not something A2B can tell.
export const FUELS = [
  ['ron95_budi95', 'RON95 BUDI95'],
  ['ron95', 'RON95'],
  ['ron97', 'RON97'],
  ['diesel', 'Diesel'],
  ['diesel_budi', 'Diesel BUDI'],
  ['ev', 'Electric'],
];
// How much a car of each size uses, litres per 100 km: a Myvi or Axia, a Civic or Vios, an SUV or MPV.
export const SIZES = [
  ['small', 'Small', 6],
  ['medium', 'Medium', 7.5],
  ['large', 'SUV / MPV', 10],
];
export const DEFAULT_FUEL = 'ron95_budi95';
export const DEFAULT_SIZE = 'medium';

const isDiesel = (fuel) => fuel.startsWith('diesel');

// The fuel for a drive of `metres`, in ringgit, or null when there's nothing to estimate (an electric car, or no
// prices yet). A subsidised price missing from the list falls back to the full one of the same fuel.
export function fuelCost(metres, { fuel = DEFAULT_FUEL, size = DEFAULT_SIZE } = {}, prices) {
  if (!prices || fuel === 'ev') return null;
  const price = prices[fuel] ?? prices[isDiesel(fuel) ? 'diesel' : 'ron95'];
  const per100 = (SIZES.find(([id]) => id === size) ?? SIZES[1])[2];
  if (!(price > 0) || !(metres > 0)) return null;
  return (metres / 1000) * (per100 / 100) * price;
}

// "~RM 3.40": to 10 sen, whole ringgit from RM 100.
export function rmLabel(amount) {
  return `~RM ${amount < 100 ? (Math.round(amount * 10) / 10).toFixed(2) : Math.round(amount).toString()}`;
}

// "~RM 3.40 petrol" for a route card, or '' when there's no estimate.
export function fuelLabel(amount, fuel = DEFAULT_FUEL) {
  if (amount == null) return '';
  return `${rmLabel(amount)} ${isDiesel(fuel) ? 'diesel' : 'petrol'}`;
}
