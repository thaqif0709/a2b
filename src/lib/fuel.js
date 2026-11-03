// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// This week's pump prices in Malaysia, from the government's open data (data.gov.my, published every Wednesday),
// for the fuel estimate on each route (public/trip-cost.js). Asked for a few times a day at most; if the service
// is down, the last prices this Worker saw are kept.

const URL_PRICES = 'https://api.data.gov.my/data-catalogue?id=fuelprice&sort=-date&limit=4';
const UA = 'a2b-navigation/0.1 (+https://a2b-beta.pages.dev)';
const FRESH_MS = 6 * 3600_000;
const FIELDS = ['ron95', 'ron95_budi95', 'ron97', 'diesel', 'diesel_eastmsia'];

let kept = null; // { at, prices }

// { date, ron95, ron95_budi95, ron97, diesel, diesel_eastmsia } in ringgit a litre, or null.
export async function fuelPrices({ now = Date.now() } = {}) {
  if (kept && now - kept.at < FRESH_MS) return kept.prices;
  try {
    const res = await fetch(URL_PRICES, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`fuel prices: ${res.status}`);
    // The list mixes the prices with their weekly changes; the newest row of prices is the one.
    const row = (await res.json()).find((r) => r.series_type === 'level');
    if (!row || !(row.ron95 > 0)) throw new Error('fuel prices: no prices');
    const prices = { date: row.date };
    for (const f of FIELDS) if (row[f] > 0) prices[f] = row[f];
    kept = { at: now, prices };
  } catch (e) {
    console.warn(e.message);
    if (kept) kept.at = now - FRESH_MS + 600_000; // try again in 10 minutes, with the old prices meanwhile
  }
  return kept?.prices ?? null;
}

export function forgetFuelPrices() {
  kept = null;
}
