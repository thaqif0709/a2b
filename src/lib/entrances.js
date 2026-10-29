// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Car park entrances at a destination. A route to a mall (Pavilion, Mid Valley, Sunway Pyramid) otherwise ends at
// the middle of the building, often on a road on the wrong side of it. OpenStreetMap maps the entrances
// (amenity=parking_entrance); scripts/build-parking-entrances.mjs builds them into public/parking-entrances.json,
// read here through the Worker's static assets like the speed cameras, so a route never waits on Overpass. The drive
// ends at the one quickest to get to from where you are, counting the walk from it to the place: one Valhalla matrix
// request times the drive to each. Any failure just means no entrance, and the route goes to the place as before.

import { distance } from '../../public/geo.js';

const UA = 'a2b-navigation/0.1 (+https://a2b-beta.pages.dev)';
export const RADIUS_M = 350;
const CANDIDATES = 5; // timed per route request, the nearest to the place
const WALK_MPS = 1.25;
const WALK_DETOUR = 1.3;
const RETRY_MS = 600_000; // the file missing (not built): look again after this
const CLOSED = new Set(['private', 'no', 'permit', 'delivery', 'staff', 'employees']);

let loaded = null; // { at, rows: [[lng, lat, name]] } once read, for this Worker instance

async function allEntrances(assets, now) {
  if (loaded && (loaded.rows.length || now - loaded.at < RETRY_MS)) return loaded.rows;
  let rows = [];
  try {
    const res = await assets?.fetch(new Request('https://assets.local/parking-entrances.json'));
    if (res?.ok && (res.headers.get('content-type') ?? '').includes('json')) rows = (await res.json()).entrances ?? [];
  } catch {}
  loaded = { at: now, rows };
  return rows;
}

// The public car park entrances within RADIUS_M of `to` ([lng, lat]), nearest first: { name, lat, lng, m }.
export async function entrancesNear(env, [lng, lat], { now = Date.now() } = {}) {
  const pad = RADIUS_M / 100_000;
  const near = [];
  for (const [x, y, name] of await allEntrances(env.ASSETS, now)) {
    if (Math.abs(y - lat) > pad || Math.abs(x - lng) > pad * 1.1) continue;
    const m = Math.round(distance([lng, lat], [x, y]));
    if (m <= RADIUS_M) near.push({ name, lat: y, lng: x, m });
  }
  return near.sort((a, b) => a.m - b.m);
}

export function forgetEntrances() {
  loaded = null;
}

// Overpass nodes -> entrances drivers may use, as the build writes them: [lng, lat, name]. Customer-only ones stay:
// that's a mall's own car park.
export function entranceRows(elements) {
  return elements
    .filter((e) => e.lat != null && e.lon != null)
    .filter((e) => !CLOSED.has(e.tags?.access) && e.tags?.motorcar !== 'no' && e.tags?.motor_vehicle !== 'no')
    .map((e) => {
      const t = e.tags ?? {};
      const name = t['name:en'] || t.name || (t.ref ? `Entrance ${t.ref}` : '');
      return [Math.round(e.lon * 1e6) / 1e6, Math.round(e.lat * 1e6) / 1e6, name];
    });
}

// The entrance to drive to from `from`: the least drive time (one sources_to_targets request) plus the walk on to
// the place. If the router can't say, the one nearest the place. Null when there are none.
export async function pickEntrance(env, from, list) {
  const cands = list.slice(0, CANDIDATES);
  if (!cands.length) return null;
  const walk = (e) => (e.m * WALK_DETOUR) / WALK_MPS;
  const times = await driveTimes(env, from, cands).catch(() => null);
  if (!times) return cands[0];
  let best = null, bestCost = Infinity;
  cands.forEach((e, i) => {
    if (times[i] == null) return;
    const cost = times[i] + walk(e);
    if (cost < bestCost) [best, bestCost] = [e, cost];
  });
  return best ?? cands[0];
}

async function driveTimes(env, [lng, lat], targets) {
  const base = env.ROUTING_URL || 'https://valhalla1.openstreetmap.de/route';
  const res = await fetch(base.replace(/\/route$/, '/sources_to_targets'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ sources: [{ lat, lon: lng }], targets: targets.map((e) => ({ lat: e.lat, lon: e.lng })), costing: 'auto' }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const row = (await res.json()).sources_to_targets?.[0];
  if (!Array.isArray(row)) return null;
  const out = targets.map(() => null);
  for (const c of row) if (c && Number.isInteger(c.to_index) && typeof c.time === 'number') out[c.to_index] = c.time;
  return out.some((t) => t != null) ? out : null;
}

// The road the route reaches the entrance on: the street of the last step that names one.
// A step's "street" can be a road sign's destination ("To Boulevard Hotel"), not a road: skipped.
export function arrivalStreet(route) {
  for (let i = (route?.steps?.length ?? 0) - 1; i >= 0; i--) {
    const street = route.steps[i].street;
    if (street && !/^to\s/i.test(street)) return street;
  }
  return '';
}
