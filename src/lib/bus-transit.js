// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import DATA from './bus-transit-data.json' with { type: 'json' };
import { distance } from '../../public/geo.js';
import { createTransitPlanner } from './transit-planner.js';

// Keep the bus-only API without building a second bus graph when the Worker only needs nearby stops.
let planner;
const bus = () => planner ??= createTransitPlanner(DATA, { kind: 'bus' });
export const feeds = DATA.feeds;
export const planTransit = (...args) => bus().planTransit(...args);
export const withRealWalks = (...args) => bus().withRealWalks(...args);
export const serviceDay = (...args) => bus().serviceDay(...args);
export const runs = (...args) => bus().runs(...args);
export const board = (...args) => bus().board(...args);
export const aboardAt = (...args) => bus().aboardAt(...args);
export const rideStations = (...args) => bus().rideStations(...args);
export const summarise = (...args) => bus().summarise(...args);
export const lineStations = (...args) => bus().lineStations(...args);
export const effort = (...args) => bus().effort(...args);
export const walkSeconds = (...args) => bus().walkSeconds(...args);

export function nearestStops(point, limit = 8) {
  return DATA.stops.map(([name, lat, lng, code]) => ({ name, code, lat, lng, metres: Math.round(distance(point, [lng, lat])) }))
    .sort((a, b) => a.metres - b.metres).slice(0, Math.max(1, Math.min(20, limit)));
}
