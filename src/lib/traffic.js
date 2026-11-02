// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Live traffic from TomTom, for routes the open router (Valhalla) has already found. Valhalla knows the roads but
// not the traffic, so its times assume empty roads. TomTom is handed each route's own shape as "supporting
// points" so it times that exact route with today's traffic, and says where the jams are. Its time replaces
// Valhalla's: the jams' delays go on the turns where they are, the rest is spread over the trip.
//
// Only used when the TOMTOM_KEY secret is set. TomTom's terms don't allow keeping its answers, so nothing here
// is cached or stored; a slow, failing or over-quota lookup just leaves the route as Valhalla timed it.

import { cumulative } from '../../public/geo.js';

const API = 'https://api.tomtom.com/routing/1/calculateRoute';
const MAX_POINTS = 400; // plenty to pin the route; keeps the request small
const TIMEOUT_MS = 4000;

// TomTom's route timed with live traffic: { duration, delay, jams: [{ from, to, level, delay }] }, from/to being
// fractions of the route's length. Null when there's no key or no answer.
// travel: 'drive' or 'motorcycle', which TomTom times as a motorcycle.
export async function liveTraffic(env, route, travel = 'drive') {
  if (!env.TOMTOM_KEY) return null;
  const { coords } = route;
  const every = Math.max(1, Math.ceil(coords.length / MAX_POINTS));
  const points = coords.filter((_, i) => i % every === 0 || i === coords.length - 1).map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
  const ends = [coords[0], coords.at(-1)].map(([lng, lat]) => `${lat.toFixed(6)},${lng.toFixed(6)}`).join(':'); // stops are in the points
  const u = new URL(`${API}/${ends}/json`);
  Object.entries({ key: env.TOMTOM_KEY, traffic: 'true', sectionType: 'traffic', routeRepresentation: 'polyline', travelMode: travel === 'motorcycle' ? 'motorcycle' : 'car' }).forEach(([k, v]) => u.searchParams.set(k, v));
  const res = await fetch(u, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ supportingPoints: points }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const tt = (await res.json()).routes?.[0];
  if (!tt?.summary) return null;
  // Its own copy of the route, to say how far along each jam starts and ends.
  const line = tt.legs.flatMap((leg, i) => (i ? leg.points.slice(1) : leg.points)).map((p) => [p.longitude, p.latitude]);
  const cum = cumulative(line);
  const total = cum.at(-1) || 1;
  const jams = (tt.sections ?? [])
    .filter((s) => s.sectionType === 'TRAFFIC' && s.endPointIndex > s.startPointIndex)
    .map((s) => ({
      from: round(cum[s.startPointIndex] / total),
      to: round(cum[Math.min(s.endPointIndex, cum.length - 1)] / total),
      level: Math.min(3, Math.max(1, s.magnitudeOfDelay || 1)), // 1 slow, 2 queuing, 3 stationary
      delay: Math.max(0, s.delayInSeconds || 0),
    }));
  return { duration: tt.summary.travelTimeInSeconds, delay: tt.summary.trafficDelayInSeconds ?? 0, jams };
}

// Puts TomTom's timing on a route: its steps' times (which the app counts down while driving) now add up to
// TomTom's time, with each jam's delay on the steps it covers.
export function applyTraffic(route, traffic) {
  if (!traffic || !(traffic.duration > 0)) return route;
  const cum = cumulative(route.coords);
  const total = cum.at(-1) || 1;
  const extra = route.steps.map(() => 0);
  for (const j of traffic.jams) {
    const a = j.from * total, b = j.to * total;
    route.steps.forEach((s, k) => {
      const overlap = Math.min(b, cum[s.end]) - Math.max(a, cum[s.begin]);
      if (overlap > 0) extra[k] += (j.delay * overlap) / (b - a || 1);
    });
  }
  const jammed = extra.reduce((x, y) => x + y, 0);
  const base = route.steps.reduce((x, s) => x + s.time, 0);
  const scale = base > 0 ? Math.max(0, traffic.duration - jammed) / base : 1;
  route.steps.forEach((s, k) => (s.time = s.time * scale + extra[k]));
  route.duration = traffic.duration;
  route.traffic = { delay: traffic.delay, jams: traffic.jams };
  return route;
}

const round = (f) => Math.round(Math.min(1, Math.max(0, f)) * 10000) / 10000;
