// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Tunnel mode. In the SMART Tunnel, the Penchala Link and KL's underpasses the GPS goes quiet or wanders, so the
// arrow would freeze and the turn just after the tunnel could be missed. When fixes stop (or are far off) while
// the car was moving on its route, or at a tunnel the route passes through (the server marks them: `tunnels`),
// the car keeps going along the route at its last speed, easing off slowly and never faster than the limit, until
// the GPS is back or it has been too long to guess. app.js feeds these estimates to the drive like fixes, but not
// to traffic sharing, trip sharing or off-route checks.

export const LOST_AFTER_MS = 2500; // no fix for this long: the GPS has gone quiet
export const BAD_ACCURACY_M = 80; // a fix this vague is no fix
export const GIVE_UP_MS = 90_000; // guessing longer than this, or further than GIVE_UP_M, is worse than stopping
export const GIVE_UP_M = 2500;
export const MOVING_MPS = 5; // only a car that was moving keeps moving
const TUNNEL_AHEAD_M = 300; // a tunnel this close ahead counts as being in it
const TUNNEL_AFTER_M = 100;
const EASE_PER_S = 0.01; // lose 1% of the speed a second: traffic in a tunnel slows rather than speeds up

// Whether `along` (metres into the route) is in or just before one of the route's tunnels ([[first, last] shape
// index] stretches into `cum`, its cumulative metres).
export function nearTunnel(along, cum, tunnels = []) {
  return tunnels.some(([a, b]) => along >= cum[a] - TUNNEL_AHEAD_M && along <= cum[Math.min(b, cum.length - 1)] + TUNNEL_AFTER_M);
}

// Whether to start estimating: the GPS has gone quiet or vague, and the car was moving or is at a tunnel.
export function shouldEstimate({ sinceFixMs, accuracy, speed, tunnel }) {
  const lost = sinceFixMs >= LOST_AFTER_MS || (accuracy ?? 0) > BAD_ACCURACY_M;
  return lost && ((speed ?? 0) > MOVING_MPS || (tunnel && (speed ?? 0) > 1));
}

// Keeps the car moving along the route from where the last good fix put it.
export class DeadReckoner {
  constructor({ along, speed, now }) {
    this.start = { along, now };
    this.along = along;
    this.speed = speed;
    this.at = now;
  }

  // Where the car probably is now: { along, speed, done } (done: stop guessing, it's been too long or too far).
  advance(now, limitKmh = null) {
    const dt = Math.max(0, (now - this.at) / 1000);
    this.at = now;
    this.speed *= (1 - EASE_PER_S) ** dt;
    if (limitKmh > 0) this.speed = Math.min(this.speed, limitKmh / 3.6);
    this.along += this.speed * dt;
    const done = now - this.start.now >= GIVE_UP_MS || this.along - this.start.along >= GIVE_UP_M;
    return { along: this.along, speed: this.speed, done };
  }
}

// The point `along` metres into a line ([lng, lat] coords with cumulative metres `cum`), and the way it runs there.
export function pointAt(coords, cum, along) {
  const last = coords.length - 1;
  if (along <= 0) return { point: coords[0], bearing: bearingOf(coords[0], coords[1] ?? coords[0]) };
  if (along >= cum[last]) return { point: coords[last], bearing: bearingOf(coords[Math.max(0, last - 1)], coords[last]) };
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= along) lo = mid;
    else hi = mid;
  }
  const f = (along - cum[lo]) / ((cum[hi] - cum[lo]) || 1);
  const [ax, ay] = coords[lo], [bx, by] = coords[hi];
  return { point: [ax + (bx - ax) * f, ay + (by - ay) * f], bearing: bearingOf(coords[lo], coords[hi]) };
}

function bearingOf([x1, y1], [x2, y2]) {
  const r = Math.PI / 180;
  const y = Math.sin((x2 - x1) * r) * Math.cos(y2 * r);
  const x = Math.cos(y1 * r) * Math.sin(y2 * r) - Math.sin(y1 * r) * Math.cos(y2 * r) * Math.cos((x2 - x1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
