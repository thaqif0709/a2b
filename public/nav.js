// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Turn-by-turn engine: snaps GPS fixes to the route, works out the next turn, ETA and what to say.
// Pure logic (no DOM), so it runs in tests and in the Worker too.

import { distance, bearing, angleDiff, cumulative, projectOnSegment, interpolate, formatDistance } from './geo.js';

const OFF_ROUTE_M = 40;
const OFF_ROUTE_FIXES = 3;
const ARRIVE_M = 30;

// Where along a route (metres from the start) a point sits, and how far off the line it is.
export function pointAlong(coords, cum, p, from = 1, to = coords.length - 1, heading = null) {
  let best = { dist: Infinity, along: 0, seg: from, point: coords[0], score: Infinity };
  for (let i = Math.max(1, from); i <= Math.min(to, coords.length - 1); i++) {
    const s = projectOnSegment(p, coords[i - 1], coords[i]);
    let score = s.dist;
    // When moving, prefer segments heading the same way (stops snapping to the opposite carriageway).
    if (heading != null && distance(coords[i - 1], coords[i]) > 1) {
      if (Math.abs(angleDiff(heading, bearing(coords[i - 1], coords[i]))) > 100) score += 35;
    }
    if (score < best.score) best = { dist: s.dist, along: cum[i - 1] + (cum[i] - cum[i - 1]) * s.t, seg: i, point: s.point, score };
  }
  return best;
}

export function pointAtDistance(coords, cum, d) {
  if (d <= 0) return { point: coords[0], seg: 1 };
  const total = cum[cum.length - 1];
  if (d >= total) return { point: coords.at(-1), seg: coords.length - 1 };
  let lo = 1, hi = coords.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < d) lo = mid + 1;
    else hi = mid;
  }
  const t = (d - cum[lo - 1]) / (cum[lo] - cum[lo - 1] || 1);
  return { point: interpolate(coords[lo - 1], coords[lo], t), seg: lo };
}

// The stretch of route between two distances from the start (metres), with interpolated ends.
export function sliceAlong(coords, cum, d0, d1) {
  const a = pointAtDistance(coords, cum, d0);
  const b = pointAtDistance(coords, cum, d1);
  const out = [a.point];
  for (let i = a.seg; i < b.seg; i++) out.push(coords[i]);
  out.push(b.point);
  return out;
}

// How a roundabout is driven, read from the route's own line: the exit's direction relative to the way in
// (degrees, -180..180, positive = to the right) and whether the route goes round clockwise (as where people drive
// on the left). Null when the step isn't a roundabout with a following exit step.
export function roundaboutTurn(coords, cum, steps, i) {
  const enter = steps[i], exit = steps[i + 1];
  if (enter?.type !== 'roundabout' || !exit) return null;
  const a = cum[enter.begin], b = cum[exit.begin];
  if (!(b > a)) return null;
  const into = sliceAlong(coords, cum, Math.max(0, a - 25), a);
  const out = sliceAlong(coords, cum, b, Math.min(cum.at(-1), b + 25));
  const inBearing = bearing(into[0], into.at(-1));
  const outBearing = bearing(out[0], out.at(-1));
  // Which way the route turns while on the roundabout: summed heading changes, right turns positive.
  const round = sliceAlong(coords, cum, a, b);
  let turning = 0;
  for (let k = 2; k < round.length; k++) {
    if (distance(round[k - 2], round[k - 1]) < 0.5 || distance(round[k - 1], round[k]) < 0.5) continue;
    turning += angleDiff(bearing(round[k - 2], round[k - 1]), bearing(round[k - 1], round[k]));
  }
  return { exitAngle: angleDiff(inBearing, outBearing), clockwise: turning >= 0 };
}

// Reports that sit on the route (within `maxDist` metres of it), sorted by distance from the start.
export function reportsAlong(route, reports, maxDist = 40) {
  const cum = route.cum ?? cumulative(route.coords);
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of route.coords) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  const pad = 0.001; // ~100 m
  const out = [];
  for (const r of reports) {
    if (r.lng < w - pad || r.lng > e + pad || r.lat < s - pad || r.lat > n + pad) continue;
    const hit = pointAlong(route.coords, cum, [r.lng, r.lat]);
    if (hit.dist <= maxDist) out.push({ ...r, at: hit.along });
  }
  return out.sort((a, b) => a.at - b.at);
}

export class Navigator {
  constructor(route, { units = 'metric' } = {}) {
    this.route = route;
    this.coords = route.coords;
    this.cum = route.cum ?? cumulative(route.coords);
    this.total = this.cum[this.cum.length - 1];
    this.steps = route.steps;
    this.units = units;
    this.seg = 1;
    this.along = 0;
    this.offCount = 0;
    this.spoken = new Set();
    this.arrived = false;
    this.estimatedProgress = false;
  }

  stepAt(seg) {
    // The maneuver whose stretch of road contains this segment.
    for (let k = this.steps.length - 1; k >= 0; k--) if (this.steps[k].begin < seg) return k;
    return 0;
  }

  update({ position, heading = null, speed = null, accuracy = 10, estimated = false }) {
    const moving = speed != null && speed > 2;
    // Look near where we were first; fall back to the whole route if that fails (e.g. after a GPS gap).
    let hit = pointAlong(this.coords, this.cum, position, this.seg - 3, this.seg + 80, moving ? heading : null);
    if (hit.dist > OFF_ROUTE_M) {
      const wide = pointAlong(this.coords, this.cum, position, 1, this.coords.length - 1, moving ? heading : null);
      if (wide.score < hit.score) hit = wide;
    }
    const tolerance = Math.max(OFF_ROUTE_M, Math.min(accuracy ?? 0, 80));
    if (!estimated) this.offCount = hit.dist > tolerance ? this.offCount + 1 : 0;
    const offRoute = this.offCount >= OFF_ROUTE_FIXES;
    if (estimated) this.estimatedProgress = true;
    const confirmedOnRoute = !estimated && !offRoute && hit.dist <= tolerance;
    if (confirmedOnRoute) this.estimatedProgress = false;
    // Do not use distance left by an estimate to confirm a stop/arrival. Outside that recovery, retain
    // ordinary real-GPS arrival and stop behavior (including a weak fix just inside a building).
    const confirmedProgress = !estimated && !this.estimatedProgress;
    if (!offRoute && hit.dist <= tolerance) {
      this.seg = hit.seg;
      this.along = hit.along;
    }

    const k = this.stepAt(this.seg);
    const next = this.steps[k + 1] ?? this.steps.at(-1);
    const nextIndex = Math.min(k + 1, this.steps.length - 1);
    const distToNext = Math.max(0, this.cum[next.begin] - this.along);
    const remaining = Math.max(0, this.total - this.along);
    const remainingTime = this.remainingTime(k);
    const toDest = distance(position, this.coords.at(-1));
    if (confirmedProgress && !this.arrived &&
        (remaining < ARRIVE_M || (toDest < ARRIVE_M && remaining < 150))) this.arrived = true;

    return {
      snapped: hit.dist <= tolerance ? hit.point : position,
      along: this.along,
      offRoute,
      confirmedProgress, // estimates need a real on-route recovery before confirming their progress
      offBy: hit.dist,
      stepIndex: k,
      nextIndex,
      next,
      then: this.steps[nextIndex + 1] && this.cum[this.steps[nextIndex + 1].begin] - this.cum[next.begin] < 250 ? this.steps[nextIndex + 1] : null,
      distToNext,
      remaining,
      remainingTime,
      arrived: this.arrived,
      // Keep turn guidance during a gap, but never announce an arrival/stop or consume its real GPS cue.
      prompt: !confirmedProgress && (next.type.startsWith('arrive') || next.type === 'stop')
        ? null : this.prompt(nextIndex, distToNext, speed ?? 0),
      limit: this.limitAt(this.seg - 1),
      routeBearing: bearing(this.coords[this.seg - 1], this.coords[Math.min(this.seg, this.coords.length - 1)]),
    };
  }

  // Posted limit (km/h) on the segment starting at shape index i, from the route's runs.
  limitAt(i) {
    const runs = this.route.limits;
    if (!runs?.length) return null;
    let lo = 0, hi = runs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (runs[mid][0] <= i) lo = mid;
      else hi = mid - 1;
    }
    return runs[lo][0] <= i ? runs[lo][1] : null;
  }

  remainingTime(k) {
    const s = this.steps[k];
    const stepStart = this.cum[s.begin];
    const stepLen = this.cum[s.end] - stepStart || 1;
    const leftInStep = Math.min(1, Math.max(0, (this.cum[s.end] - this.along) / stepLen));
    let t = s.time * leftInStep;
    for (let j = k + 1; j < this.steps.length; j++) t += this.steps[j].time;
    return t + (this.route.delay ?? 0) * (1 - this.along / (this.total || 1));
  }

  // Two cues per turn, like a co-driver: an early heads-up, then "now".
  prompt(j, d, speed) {
    const step = this.steps[j];
    if (!step) return null;
    if (this.along < 5 && !this.spoken.has('depart')) {
      this.spoken.add('depart');
      return this.steps[0].pre;
    }
    const near = Math.max(60, speed * 7);
    const far = Math.min(2000, Math.max(400, speed * 30));
    const prev = this.steps[j - 1];
    const legLen = prev ? this.cum[step.begin] - this.cum[prev.begin] : Infinity;
    if (d <= near && !this.spoken.has(`${j}:near`)) {
      this.spoken.add(`${j}:near`).add(`${j}:far`);
      return step.type.startsWith('arrive') || step.type === 'stop' ? step.pre : step.alert;
    }
    if (d <= far && d > near * 2 && legLen > far * 0.8 && !this.spoken.has(`${j}:far`)) {
      this.spoken.add(`${j}:far`);
      return `In ${spokenDistance(d, this.units)}, ${lowerFirst(step.alert)}`;
    }
    return null;
  }
}

// Rounded the way people say it: "in 400 meters", not "in 390 meters".
function roundForSpeech(m, units) {
  if (units === 'imperial') {
    const ft = m * 3.28084;
    return ft < 1000 ? (Math.round(ft / 100) * 100) / 3.28084 : m;
  }
  if (m >= 1000) return m;
  const step = m >= 200 ? 100 : 50;
  return Math.round(m / step) * step;
}

export function spokenDistance(m, units = 'metric') {
  const rounded = roundForSpeech(m, units);
  const [shown, u] = formatDistance(rounded, units).split(' ');
  const n = shown.replace(/\.0$/, ''); // "1 kilometer", not "1.0 kilometers"
  const word = { m: 'meter', km: 'kilometer', ft: 'feet', mi: 'mile' }[u];
  return `${n} ${word}${n === '1' || u === 'ft' ? '' : 's'}`;
}

// Exit numbers and road codes read digit by digit, as drivers say them: "exit 3108" and "E3108" become
// "three one zero eight" rather than "three thousand one hundred and eight". Short ones like E2 or FT50 stay as
// they are; distances and other plain numbers aren't touched.
const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const digits = (n) => [...n].map((d) => DIGITS[d]).join(' ');
export function spokenCodes(text) {
  return String(text ?? '')
    .replace(/\b(exit|keluar)(\s+)(\d{3,})([A-Z]?)\b/gi, (_, w, sp, n, x) => `${w}${sp}${digits(n)}${x ? ` ${x}` : ''}`)
    .replace(/\b([A-Z]{1,3})(\d{3,})([A-Z]?)\b/g, (_, l, n, x) => `${l} ${digits(n)}${x ? ` ${x}` : ''}`);
}

function lowerFirst(s) {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

// Drives along a route at each step's own speed. For trying the app at a desk.
export class Simulator {
  constructor(route, { speedFactor = 1, tick = 1 } = {}) {
    this.coords = route.coords;
    this.cum = route.cum ?? cumulative(route.coords);
    this.steps = route.steps;
    this.d = 0;
    this.speedFactor = speedFactor;
    this.tick = tick;
  }

  speedAt(seg) {
    let k = 0;
    for (let i = this.steps.length - 1; i >= 0; i--) if (this.steps[i].begin < seg) { k = i; break; }
    const s = this.steps[k];
    return Math.min(36, Math.max(6, s.time ? s.length / s.time : 12));
  }

  next() {
    const total = this.cum[this.cum.length - 1];
    const here = pointAtDistance(this.coords, this.cum, this.d);
    const speed = this.speedAt(here.seg) * this.speedFactor;
    this.d = Math.min(total, this.d + speed * this.tick);
    const at = pointAtDistance(this.coords, this.cum, this.d);
    const ahead = pointAtDistance(this.coords, this.cum, Math.min(total, this.d + 10));
    return {
      position: at.point,
      heading: bearing(at.point, ahead.point === at.point ? this.coords.at(-1) : ahead.point) || 0,
      speed: this.d >= total ? 0 : speed,
      accuracy: 5,
      done: this.d >= total,
    };
  }
}
