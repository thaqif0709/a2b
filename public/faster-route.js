// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// "Faster route found": while driving, now and then ask for routes from where you are, and offer one only when it's
// clearly better: at least 5 minutes and 10% quicker than what's left of yours, and really another way, not the
// same roads. The routing server is volunteer-run, so checks are few: the first after 2 minutes, then 4 minutes on,
// waiting longer after each that finds nothing (6, 8, then 10 minutes), at most 8 a drive, and only with a fair way
// still to go. app.js asks and shows the offer; the rules live here.
// A check sends what's left of the route and its time (checkBody), so the server can answer "nothing faster" after one
// routing request: no traffic lookups or speed limits unless a route is really another way and could be offered.

import { distance } from './geo.js';

export const FIRST_CHECK_MS = 2 * 60_000;
// The wait before the next check, by how many checks in a row have found nothing to offer: 4 minutes after the first
// (or after an offer), then 6, 8, and 10 from then on.
export const CHECK_GAPS_MS = [4, 6, 8, 10].map((m) => m * 60_000);
export const checkGap = (quiet = 0) => CHECK_GAPS_MS[Math.min(Math.max(quiet - 1, 0), CHECK_GAPS_MS.length - 1)];
export const MAX_CHECKS = 8;
export const MIN_LEFT_M = 5000; // not worth it near the end
export const MIN_LEFT_S = 5 * 60;
export const NEAR_STOP_M = 2000; // about to stop anyway
export const MIN_SAVE_S = 5 * 60;
export const MIN_SAVE_SHARE = 0.1;
export const MAX_OVERLAP = 0.7; // more shared road than this, and it's the same way with a different estimate
export const OFFER_FOR_MS = 20_000;
export const KEEP_FOR_MS = 10 * 60_000; // "Keep": don't offer that way again for a while
const NEAR_ROAD_M = 35; // a point this close to the other route counts as on it
const SAMPLE_M = 50;
const CELL_DEG = 0.005; // ~550 m grid cells, for finding nearby segments quickly

// Whether to ask for routes now. `drive`: { now, startedAt, lastCheck, checks, quiet (checks in a row that found
// nothing), left (m), leftTime (s), offRoute, busy, toStop (m to the next stop, or null), demo }.
export function shouldCheck({ now, startedAt, lastCheck = 0, checks = 0, quiet = 0, left, leftTime, offRoute = false, busy = false, toStop = null, demo = false }) {
  if (demo || offRoute || busy || checks >= MAX_CHECKS) return false;
  if (!(left > MIN_LEFT_M) || !(leftTime > MIN_LEFT_S)) return false;
  if (toStop != null && toStop < NEAR_STOP_M) return false;
  if (now - startedAt < FIRST_CHECK_MS) return false;
  return !lastCheck || now - lastCheck >= checkGap(quiet);
}

// A route's time from its start, the way the drive's ETA counts it (nav.js remainingTime): its steps' times, which
// carry live traffic when there is any, plus reported delays.
export function routeTime(route) {
  return route.steps.reduce((t, s) => t + (s.time ?? 0), 0) + (route.delay ?? 0);
}

// How much of route `a` (its coords) runs along route `b`, as a share of a's length: 0 to 1.
export function overlap(a, b) {
  if (a.length < 2 || b.length < 2) return 0;
  const grid = new Map();
  const cell = (x, y) => `${Math.floor(x / CELL_DEG)}:${Math.floor(y / CELL_DEG)}`;
  for (let i = 0; i < b.length - 1; i++) {
    // A segment is filed under every cell it passes through, sampled every half cell (a simplified line, as a check
    // sends, has straights kilometres long), so a point near it is always in a cell next to one it's filed under.
    const [x0, y0] = b[i], [x1, y1] = b[i + 1];
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / (CELL_DEG / 2)));
    const keys = new Set();
    for (let k = 0; k <= n; k++) keys.add(cell(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n));
    for (const k of keys) {
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
  }
  const near = (p) => {
    const cx = Math.floor(p[0] / CELL_DEG), cy = Math.floor(p[1] / CELL_DEG);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const i of grid.get(`${cx + dx}:${cy + dy}`) ?? []) if (toSegment(p, b[i], b[i + 1]) <= NEAR_ROAD_M) return true;
    }
    return false;
  };
  let total = 0, shared = 0;
  for (let i = 0; i < a.length - 1; i++) {
    const len = distance(a[i], a[i + 1]);
    const n = Math.max(1, Math.round(len / SAMPLE_M));
    for (let k = 0; k < n; k++) {
      const f = (k + 0.5) / n;
      const p = [a[i][0] + (a[i + 1][0] - a[i][0]) * f, a[i][1] + (a[i + 1][1] - a[i][1]) * f];
      total += len / n;
      if (near(p)) shared += len / n;
    }
  }
  return total ? shared / total : 0;
}

// Metres from p to the segment a-b, on a local flat projection (fine at these distances).
function toSegment(p, a, b) {
  const kx = Math.cos((p[1] * Math.PI) / 180) * 111_320, ky = 110_540;
  const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky, bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

// The new route worth offering instead of what's left of the current one, or null. `leftTime`: seconds the ETA says
// are left; `rest`: the current route's coords from here on; `kept`: ways turned down lately, as { coords, until }.
export function pickFaster(routes, { leftTime, rest, now = Date.now(), kept = [] }) {
  let best = null;
  for (const r of routes ?? []) {
    const time = routeTime(r);
    if (!best || time < best.time) best = { route: r, time };
  }
  if (!best) return null;
  const saves = leftTime - best.time;
  if (!worthOffering(best.time, leftTime)) return null;
  if (overlap(best.route.coords, rest) >= MAX_OVERLAP) return null;
  if (kept.some((k) => k.until > now && overlap(best.route.coords, k.coords) >= MAX_OVERLAP)) return null;
  return { route: best.route, saves: Math.round(saves) };
}

// Whether a route taking `time` seconds is enough quicker than the `leftTime` the ETA says to offer.
export function worthOffering(time, leftTime) {
  const saves = leftTime - time;
  return saves >= MIN_SAVE_S && saves >= leftTime * MIN_SAVE_SHARE;
}

// A line with the points that change its shape by less than `tolM` metres dropped (Douglas-Peucker).
export function simplify(coords, tolM = 10) {
  if (coords.length < 3) return coords.slice();
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let far = 0, at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = toSegment(coords[i], coords[a], coords[b]);
      if (d > far) (far = d), (at = i);
    }
    if (at >= 0 && far > tolM) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

// What a check sends with its routing request: what's left of the route, simplified (a long drive's thousands of
// points, ~1 m precision), and the seconds the ETA says are left. Null when it would still be too big to send.
export const MAX_REST_CHARS = 40_000;
export function checkBody(rest, leftTime, encode) {
  const line = encode(simplify(rest, 10), 5);
  return line.length > MAX_REST_CHARS ? null : { rest: line, left: Math.round(leftTime) };
}

// "Save 8 min via Jalan Tun Razak" and what to say.
export function offerText(saves, via) {
  const mins = Math.max(1, Math.round(saves / 60));
  return {
    line: `Save ${mins} min${via ? ` via ${via}` : ''}`,
    spoken: `A faster route is available, saving ${mins} minute${mins === 1 ? '' : 's'}. Tap Switch to take it.`,
  };
}
