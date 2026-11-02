// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Houses and streets from TomTom, for searches that look like an address ("129, BK 5/6, Bandar Kinrara, Puchong,
// 47180") when neither OpenStreetMap nor the Overture files have it: the app only asks when public/address.js says
// so, and so does this. OpenStreetMap has few house numbers in Malaysia; TomTom has most.
//
// Only used when the TOMTOM_KEY secret is set, and at most ADDRESS_LOOKUPS_PER_DAY times a day (counted in
// usage_daily.addresses), so its free Geocoding API allowance (20,000 a month) lasts. TomTom's terms don't allow
// keeping its answers, so nothing here is cached or stored; a slow, failing or capped lookup just finds nothing.

import { addressQuery, isExact, onStreet } from '../../public/address.js';

const API = 'https://api.tomtom.com/search/2/geocode';
const TIMEOUT_MS = 4000;
export const DAILY_LOOKUPS = 600; // about 18,600 in a long month
const KINDS = { 'Point Address': 'address', 'Address Range': 'address', Street: 'street', 'Cross Street': 'street', Geography: 'area' };

// TomTom's addresses for q, the one on the street searched for first. near: [lng, lat] to look around, or null.
// allow(): takes one of today's lookups, false when they're used up.
export async function lookupAddress(env, q, near, allow) {
  const a = addressQuery(q);
  if (!a || !env.TOMTOM_KEY || !(await allow())) return [];
  // Every character encoded, "/" too: TomTom answers 404 for "BK 5/6" with a bare slash.
  const u = new URL(`${API}/${encodeURIComponent(q)}.json`);
  const params = { countrySet: 'MY', limit: '5', key: env.TOMTOM_KEY };
  if (near) Object.assign(params, { lat: near[1].toFixed(2), lon: near[0].toFixed(2) }); // ~1 km is close enough
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const res = await fetch(u, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
  if (!res?.ok) return [];
  const data = await res.json().catch(() => ({}));
  return rankAddresses(data.results ?? [], a);
}

// TomTom's results as places. Its geocoder can rank a near miss first ("BK 5/14" for "BK 5/6"), so the one on the
// street searched for goes first, then others on that street, then the rest, marked as another street.
export function rankAddresses(results, a) {
  const places = results
    .filter((r) => KINDS[r.type] && r.address && Number.isFinite(r.position?.lat) && Number.isFinite(r.position?.lon))
    .map((r) => {
      const ad = r.address;
      const name = [ad.streetNumber, ad.streetName].filter(Boolean).join(' ') || ad.freeformAddress || '';
      // "Bandar Kinrara, 47180 Puchong": the rest of the address, less the street and the state.
      const drop = new Set([ad.streetNumber, ad.streetName, name, ad.countrySubdivision, ad.countrySubdivisionName, ad.country].filter(Boolean));
      const rest = (ad.freeformAddress ?? '').split(', ').filter((x) => !drop.has(x)).join(', ');
      const p = { name, address: rest, lat: r.position.lat, lng: r.position.lon, category: KINDS[r.type], source: 'tomtom' };
      const rank = isExact(p, a) ? 0 : onStreet(p, a) ? 1 : 2;
      if (rank === 2 && a.street && ad.streetName) p.address = ['Different street', rest].filter(Boolean).join(' · ');
      return { p, rank };
    });
  return places.map((x, i) => ({ ...x, i })).sort((x, y) => x.rank - y.rank || x.i - y.i).map(({ p }) => p);
}
