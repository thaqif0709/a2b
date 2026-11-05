// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import RAIL from './transit-data.json' with { type: 'json' };
import BUS from './bus-transit-data.json' with { type: 'json' };
import { createTransitPlanner } from './transit-planner.js';
import { connectTransitNetworks } from './transit-network.js';
export { MAX_OPTIONS } from './transit-planner.js';

// Preserve the rail-only API for train reports and existing callers/tests.
const rail = createTransitPlanner(RAIL);
export const { planTransit, walkSeconds, effort, serviceDay, runs, board, aboardAt, rideStations, summarise, lineStations, feeds } = rail;
const connected = createTransitPlanner(connectTransitNetworks(RAIL, BUS), { mixed: true });
export function withRealWalks(env, plan, options) {
  return ('options' in plan ? connected : rail).withRealWalks(env, plan, options);
}

export function planTransitCombined(from, to, at = Date.now(), options = {}) {
  const plan = connected.planTransit(from, to, at, options);
  return { ...plan, options: plan.trips };
}
