// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// What a drive costs in fuel, roughly: its length, how much the car uses and this week's pump price (Malaysia's
// official weekly prices, from the server: src/lib/fuel.js). Shown next to the tolls on each route, so the
// toll-free route's real cost is easy to compare. An estimate, and said to be one.

// The fuel a car takes, as this phone's settings call it, and the price list's name for it.
export const FUELS = [
  ['ron95_budi95', 'RON95 BUDI95'],
  ['ron95', 'RON95'],
  ['ron97', 'RON97'],
  ['diesel', 'Diesel'],
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
const EAST_LNG = 109; // Sabah and Sarawak: east of here, where diesel has its own (lower) price

// The fuel for a drive of `metres` starting at `from` ([lng, lat]), in ringgit, or null when there's nothing to
// estimate (an electric car, or no prices yet).
export function fuelCost(metres, { fuel = DEFAULT_FUEL, size = DEFAULT_SIZE } = {}, prices, from) {
  if (!prices || fuel === 'ev') return null;
  const key = fuel === 'diesel' && from?.[0] > EAST_LNG && prices.diesel_eastmsia ? 'diesel_eastmsia' : fuel;
  const price = prices[key] ?? prices.ron95;
  const per100 = (SIZES.find(([id]) => id === size) ?? SIZES[1])[2];
  if (!(price > 0) || !(metres > 0)) return null;
  return (metres / 1000) * (per100 / 100) * price;
}

// "~RM 3.40 petrol" for a route card, or '' when there's no estimate: to 10 sen, whole ringgit from RM 100.
export function fuelLabel(amount, fuel = DEFAULT_FUEL) {
  if (amount == null) return '';
  const rm = amount < 100 ? (Math.round(amount * 10) / 10).toFixed(2) : Math.round(amount).toString();
  return `~RM ${rm} ${fuel === 'diesel' ? 'diesel' : 'petrol'}`;
}
