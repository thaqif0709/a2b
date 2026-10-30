// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// R&Rs and lay-bys along a drive (public/rest-stops.json, from OpenStreetMap: scripts/build-rest-stops.mjs). An
// expressway's R&R serves one direction, with its twin across the road for the other; Malaysia drives on the left,
// so the one for you is on your left. Which one is next, and when to suggest a break, is worked out here; app.js
// shows the chip and adds the stop.

export const REST_AFTER_S = 2 * 3600; // driving this long without a break: suggest one
export const BREAK_S = 15 * 60; // stopped this long counts as a break
export const SOON_M = 3000; // an R&R this close ahead gets a chip anyway, on a long drive
export const REMIND_WITHIN_M = 60_000; // how far ahead a suggested break may be
const OFF_M = 500; // furthest from the road a stop can be and still be on it
const ON_ROAD_M = 40; // closer than this, which side it's on can't be told: counted as yours
const M_PER_DEG = 111_320;

// The rest stops beside this route on your side of the road, in order: { name, kind, lng, lat, at } with `at` the
// metres along the route. `rows` as in rest-stops.json: [lng, lat, name, kind].
export function restStopsAlong(coords, cum, rows) {
  if (coords.length < 2) return [];
  const pad = OFF_M / M_PER_DEG;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of coords) {
    w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
  }
  const found = [];
  for (const [lng, lat, name, kind] of rows) {
    if (lng < w - pad || lng > e + pad || lat < s - pad || lat > n + pad) continue;
    const kx = Math.cos((lat * Math.PI) / 180) * M_PER_DEG;
    let best = null;
    for (let i = 0; i < coords.length - 1; i++) {
      const [ax, ay] = coords[i], [bx, by] = coords[i + 1];
      if (Math.abs(ax - lng) > pad * 3 && Math.abs(bx - lng) > pad * 3) continue;
      // In metres, from the segment's start: the segment (dx, dy) and the stop (px, py).
      const dx = (bx - ax) * kx, dy = (by - ay) * M_PER_DEG, px = (lng - ax) * kx, py = (lat - ay) * M_PER_DEG;
      const len2 = dx * dx + dy * dy;
      const f = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
      const off = Math.hypot(px - f * dx, py - f * dy);
      if (!best || off < best.off) best = { off, at: cum[i] + f * (cum[i + 1] - cum[i]), left: dx * py - dy * px > 0 };
    }
    if (!best || best.off > OFF_M || (!best.left && best.off > ON_ROAD_M)) continue;
    found.push({ name: name || (kind === 's' ? 'R&R' : 'Lay-by'), kind, lng, lat, at: Math.round(best.at) });
  }
  // A big R&R mapped twice (its area and a point) shows once.
  return found.sort((a, b) => a.at - b.at).filter((x, i, all) => !i || x.at - all[i - 1].at > 300 || x.name !== all[i - 1].name);
}

// What to show now, `along` metres into the drive with `sinceBreak` seconds of driving since the last break:
// { stop, ahead, remind } or null. After REST_AFTER_S, the next R&R within REMIND_WITHIN_M (or a lay-by if no R&R
// comes first), as a suggested break; otherwise an R&R coming up within SOON_M, on a drive long enough to need one.
export function nextRestStop(along, list, { sinceBreak = 0, longDrive = true } = {}) {
  const ahead = list.filter((x) => x.at - along > 200 && x.at - along <= REMIND_WITHIN_M);
  if (sinceBreak >= REST_AFTER_S && ahead.length) {
    const stop = ahead.find((x) => x.kind === 's') ?? ahead[0];
    return { stop, ahead: stop.at - along, remind: true };
  }
  const soon = longDrive && ahead.find((x) => x.kind === 's' && x.at - along <= SOON_M);
  return soon ? { stop: soon, ahead: soon.at - along, remind: false } : null;
}

// Seconds driven since the last break, kept up to date from each GPS fix: a stop of BREAK_S or more starts it over.
export class BreakClock {
  constructor(now) {
    this.since = now; // when driving last started after a break
    this.stoppedAt = null;
  }
  update(now, speed) {
    if ((speed ?? 0) < 1) this.stoppedAt ??= now;
    else {
      if (this.stoppedAt != null && now - this.stoppedAt >= BREAK_S * 1000) this.since = now;
      this.stoppedAt = null;
    }
    if (this.stoppedAt != null && now - this.stoppedAt >= BREAK_S * 1000) return 0; // having a break now
    return (now - this.since) / 1000;
  }
}
