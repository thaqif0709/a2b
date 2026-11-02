// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// A place the base map draws (its `poi` and airport labels, from OpenStreetMap via OpenFreeMap), as A2B's routes
// need it: a name and what kind of place it is. Tapping one shows the routes there (app.js tapPlaceOnMap).

const KIND_NAMES = {
  rail: 'Train station', railway: 'Train station', subway: 'Station', light_rail: 'LRT station', monorail: 'Monorail station',
  halt: 'Train station', bus: 'Bus stop', bus_station: 'Bus station', bus_stop: 'Bus stop', ferry_terminal: 'Ferry terminal',
  parking: 'Car park', parking_entrance: 'Car park entrance', aerodrome: 'Airport', airport: 'Airport',
};
// Stops, stations and car parks are worth going to even when nobody named them; other unnamed icons aren't.
const UNNAMED_OK = new Set(['rail', 'railway', 'subway', 'light_rail', 'monorail', 'halt', 'bus', 'bus_station', 'bus_stop', 'ferry_terminal', 'parking', 'parking_entrance']);

// { name, address } for a base map feature's properties, or null when it's not a place to go to.
export function mapPlace(p) {
  const kind = KIND_NAMES[p.subclass] ?? KIND_NAMES[p.class] ?? String(p.subclass || p.class || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const name = p['name:latin'] || p.name;
  if (name) return { name, address: kind };
  if (UNNAMED_OK.has(p.subclass) || UNNAMED_OK.has(p.class)) return { name: kind, address: '' };
  return null;
}
