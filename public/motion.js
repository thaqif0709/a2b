// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Smooth car movement between GPS fixes. Fixes arrive about once a second; drawing the car only at
// each fix makes it jump. A Glide moves the shown position from where the car is drawn now to the
// newest fix over roughly the time until the next one, along the road when the car is on a route.
// Pure logic (no DOM), so it runs in tests.

import { distance, angleDiff, interpolate } from './geo.js';
import { pointAlong, pointAtDistance } from './nav.js';

const MIN_MS = 200;
const MAX_MS = 1500;
// Glide a bit longer than the gap between fixes, so a slightly late fix doesn't leave the car standing still.
const STRETCH = 1.2;
// A fix behind the car as drawn (GPS catching up with a tunnel estimate, or a late fix) or far from it is a
// correction: the car eases back to where it really is, along the road, over at least this long, not in one jump.
const CORRECT_M = 250;
const CORRECT_MS = 1500;
const JUMP_M = 2000; // further than this (back from the background, a fresh route far away): jump, sliding would mislead
const ON_PATH_M = 8;

export class Glide {
  constructor() {
    this.from = null;
    this.to = null;
    this.start = 0;
    this.duration = 1;
    this.lastSet = 0;
    this.easing = false;
  }

  // pose: { pos: [lng, lat], heading, along?, path? } where path is { coords, cum } and along is metres along it.
  set(pose, now) {
    const gap = this.lastSet ? now - this.lastSet : 0;
    this.lastSet = now;
    const shown = this.to ? this.at(now) : null;
    const apart = shown ? distance(shown.pos, pose.pos) : Infinity;
    if (apart > JUMP_M) {
      this.from = this.to = { ...pose, heading: pose.heading ?? 0 };
      this.duration = 1;
      this.start = now;
      this.easing = false;
      return;
    }
    this.from = ontoPath(shown, pose);
    this.to = { ...pose, heading: pose.heading ?? shown.heading };
    this.start = now;
    this.duration = Math.min(MAX_MS, Math.max(MIN_MS, (gap || 1000) * STRETCH));
    const back = this.from.path === this.to.path && this.from.along != null && this.to.along != null && this.to.along < this.from.along - 1;
    this.easing = back || apart > CORRECT_M;
    if (this.easing) this.duration = Math.max(this.duration, CORRECT_MS);
  }

  done(now) {
    return !this.to || now - this.start >= this.duration;
  }

  at(now) {
    if (!this.to) return null;
    const { from, to } = this;
    const linear = Math.min(1, Math.max(0, (now - this.start) / this.duration));
    const t = this.easing ? linear * linear * (3 - 2 * linear) : linear; // a correction starts and stops gently
    const heading = from.heading + angleDiff(from.heading, to.heading) * t;
    if (t >= 1) return { ...to, heading: norm(to.heading) };
    if (alongPath(from, to)) {
      const along = from.along + (to.along - from.along) * t;
      return { pos: pointAtDistance(to.path.coords, to.path.cum, along).point, heading: norm(heading), along, path: to.path };
    }
    return { pos: interpolate(from.pos, to.pos, t), heading: norm(heading) };
  }
}

// A car that slid in a straight line (it had no place on the route, e.g. at the start of a drive) picks up
// its place along the route again once it is on the line, so it follows the road from then on.
function ontoPath(shown, pose) {
  if (!pose.path || pose.along == null || (shown.path === pose.path && shown.along != null)) return shown;
  const { coords, cum } = pose.path;
  const seg = pointAtDistance(coords, cum, pose.along).seg;
  const hit = pointAlong(coords, cum, shown.pos, seg - 80, seg + 1);
  return hit.dist < ON_PATH_M ? { ...shown, pos: hit.point, along: hit.along, path: pose.path } : shown;
}

// Follow the road (not a straight chord) when both ends sit on the same route, either way: back along it too, when
// the car was drawn ahead of where it really is.
function alongPath(from, to) {
  if (!to.path || from.path !== to.path || from.along == null || to.along == null) return false;
  const { coords, cum } = to.path;
  return distance(pointAtDistance(coords, cum, from.along).point, from.pos) < ON_PATH_M
    && distance(pointAtDistance(coords, cum, to.along).point, to.pos) < ON_PATH_M;
}

const norm = (h) => ((h % 360) + 360) % 360;
