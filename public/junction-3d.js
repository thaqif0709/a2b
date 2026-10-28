// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// The junction view's look, a "lite" take on the lane-level 3D view some navigation apps have (they draw every lane
// from their own surveyed maps; open data doesn't have lanes, so this works with what OpenStreetMap does give).
// Through a tricky interchange (junction-view.js finds them) the camera follows the car lower and closer, the base
// map dims, and the way ahead is a wide glowing band about a lane wide. Before a decision with lane data, the band
// slides towards the lanes to use; on a flyover it lifts off the road with a shadow beneath. Here: the plain maths;
// app.js draws it.

export const PITCH = 65;
export const ZOOM = 17.5;
export const LANE_M = 3.5; // a Malaysian expressway lane
export const BAND_M = 8; // the band: about two lanes wide, like AMAP's, so it reads at a glance and covers the route line
export const AHEAD_M = 200; // the band runs this far past the junction's last decision
export const SHIFT_M = 300; // before a decision with lane data, the band moves over across this stretch
const RAMP_M = 120; // ...sliding across in its first part
const PIECE_M = 10; // ...in steps this long (short, so the band's edge looks smooth, not stepped)
const EARTH_M = 40075016.686;
const TILE_PX = 512;

// How far the band should sit from the road's centre line to be over the lanes to use, in metres (positive: to the
// right). `lanes` left to right as the app keeps them: { d: arrows painted, use: the arrows that lead on }.
export function laneShiftM(lanes) {
  if (!Array.isArray(lanes) || lanes.length < 2) return 0;
  const used = lanes.map((l, i) => (l.use ? i : -1)).filter((i) => i >= 0);
  if (!used.length || used.length === lanes.length) return 0;
  const mid = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return (mid(used) - (lanes.length - 1) / 2) * LANE_M;
}

// Metres on the ground to screen pixels at `lat`, as a MapLibre zoom expression: exact at every zoom, since a
// metre doubles in pixels with each zoom level. `value` may itself be an expression (a feature's own metres).
export function metresExpr(value, lat) {
  const perPx = (z) => (EARTH_M * Math.cos((lat * Math.PI) / 180)) / (TILE_PX * 2 ** z);
  const at = (z) => (typeof value === 'number' ? value / perPx(z) : ['/', value, perPx(z)]);
  return ['interpolate', ['exponential', 2], ['zoom'], 10, at(10), 22, at(22)];
}

// The band from `from` to `to` metres along the route, as pieces { a, b, shift (metres right), bridge }. Before each
// decision with lane data (steps: the route's steps with `begin` shape indexes and `lanes`), the shift eases from
// none to the lanes to use over RAMP_M, holds to the decision, and is gone after it (the band follows the branch
// taken). `bridges`: [[first, last shape index], ...] of flyover stretches; pieces are cut at their ends.
export function bandPieces({ from, to, cum, steps = [], bridges = [] }) {
  if (!(to > from)) return [];
  const cuts = new Set([from, to]);
  const shifts = []; // [start, decision, full shift]
  for (const s of steps) {
    const at = cum[s.begin];
    const full = laneShiftM(s.lanes);
    if (!full || at == null || at <= from || at - SHIFT_M >= to) continue;
    const start = at - SHIFT_M;
    shifts.push([start, at, full]);
    for (let x = start; x < Math.min(at, start + RAMP_M); x += PIECE_M) cuts.add(x);
    cuts.add(Math.min(at, start + RAMP_M));
    cuts.add(at);
  }
  const spans = bridges.map(([a, b]) => [cum[a], cum[b]]).filter(([a, b]) => b > from && a < to);
  for (const [a, b] of spans) cuts.add(a).add(b);
  const xs = [...cuts].filter((x) => x >= from && x <= to).sort((a, b) => a - b);
  const pieces = [];
  for (let i = 1; i < xs.length; i++) {
    const [a, b] = [xs[i - 1], xs[i]];
    if (b - a < 0.5) continue;
    const mid = (a + b) / 2;
    let shift = 0;
    for (const [start, at, full] of shifts) if (mid >= start && mid < at) shift = full * Math.min(1, (mid - start) / RAMP_M);
    const bridge = spans.some(([s, e]) => mid >= s && mid <= e);
    const last = pieces.at(-1);
    if (last && last.shift === shift && last.bridge === bridge) last.b = b; // joined: fewer, longer pieces
    else pieces.push({ a, b, shift: Math.round(shift * 100) / 100, bridge });
  }
  return pieces;
}

// Where the band runs: from the car to AHEAD_M past the junction's last decision.
export function bandRange(along, junction, cum, total) {
  return [Math.max(0, along), Math.min(total, cum[junction.end] + AHEAD_M)];
}

// The speed cameras worth standing up on the band: those (route.cameras, `at` = shape index) within its range.
export function camerasInRange(cameras, cum, [from, to]) {
  return (cameras ?? []).filter((c) => cum[c.at] >= from && cum[c.at] <= to);
}

// Flyover stretches of a route from Valhalla trace_attributes edges: [[first, last shape index], ...], touching or
// overlapping bridge edges joined into one.
export function bridgeRuns(edges, offset = 0) {
  const runs = [];
  for (const e of edges ?? []) {
    if (!e.bridge || typeof e.begin_shape_index !== 'number' || typeof e.end_shape_index !== 'number') continue;
    const [a, b] = [e.begin_shape_index + offset, e.end_shape_index + offset];
    const last = runs.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else runs.push([a, b]);
  }
  return runs;
}
