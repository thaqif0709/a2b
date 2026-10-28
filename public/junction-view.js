// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Junction view: the tricky interchanges (Jalan Duta, Sungai Besi, Kerinchi), where a ramp, a fork and an exit
// come one after another, shown from above before you reach them. Here: which stretches of a route are such
// junctions (the server marks them, from Valhalla's maneuver types), the one instruction for the whole junction,
// and when the view starts and ends. app.js moves the camera and draws the path.

// Valhalla maneuver types that are a choice of way at speed: ramps (17-19), exits (20-21), keeps at a fork (22-24).
const PHRASES = {
  17: 'take the ramp ahead', 18: 'take the ramp on the right', 19: 'take the ramp on the left',
  20: 'exit right', 21: 'exit left',
  22: 'keep straight on', 23: 'keep right', 24: 'keep left',
};
export const WITHIN_M = 800; // decisions this close together are one junction
export const MAX_SPAN_M = 1500; // a junction is never longer than this; a longer run is split
export const ENTER_M = 500; // the view starts this far before the first decision
export const LEAVE_M = 100; // and ends this far after the last
const MAX_PHRASES = 3;
const ROAD_NUMBER = /^[A-Z]{0,2}\d+[A-Z]?$/; // E2, 241, FT3: on the sign, but a place reads better

// The junctions on a route. `maneuvers` in route order: { type (Valhalla's number), length (metres to the next
// maneuver), begin (shape index), toward: [sign texts] }. Returns { from, to, start, end, text }: from/to are
// maneuver (= step) indexes, start/end the shape indexes of the first and last decision.
export function findJunctions(maneuvers) {
  const decisions = maneuvers.map((m, i) => (m.type in PHRASES ? i : -1)).filter((i) => i >= 0);
  const at = [0];
  for (let i = 0; i < maneuvers.length; i++) at.push(at[i] + (maneuvers[i].length || 0)); // metres to each maneuver
  const out = [];
  let run = [];
  const close = () => {
    if (run.length >= 2) out.push({ from: run[0], to: run.at(-1), start: maneuvers[run[0]].begin, end: maneuvers[run.at(-1)].begin, text: junctionText(run.map((i) => maneuvers[i])) });
    run = [];
  };
  for (const i of decisions) {
    if (run.length && (at[i] - at[run.at(-1)] > WITHIN_M || at[i] - at[run[0]] > MAX_SPAN_M)) close();
    run.push(i);
  }
  close();
  return out;
}

// "Keep left, then take the ramp on the right towards Seremban": the junction's decisions in order, the same one
// twice in a row said once, and where the last one leads.
export function junctionText(decisions) {
  const phrases = [];
  for (const m of decisions) {
    const p = PHRASES[m.type];
    if (p && phrases.at(-1) !== p) phrases.push(p);
  }
  const shown = phrases.slice(0, MAX_PHRASES);
  // A place name from the last decision that has one; a road number only if none does.
  const signs = [...decisions].reverse().map((m) => m.toward ?? []);
  const toward = signs.map((t) => t.find((x) => x && !ROAD_NUMBER.test(x))).find(Boolean) ?? signs.map((t) => t.find(Boolean)).find(Boolean);
  const text = shown.join(', then ') + (toward ? ` towards ${toward}` : '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Where the drive is relative to the junctions, `along` metres in (`cum`: metres to each shape point):
// { index, inView, ahead } for the next junction not yet left behind (ahead: metres to its first decision), or null.
export function junctionAt(along, junctions, cum) {
  for (let i = 0; i < (junctions?.length ?? 0); i++) {
    const j = junctions[i];
    const first = cum[j.start], last = cum[j.end];
    if (along > last + LEAVE_M) continue;
    return { index: i, inView: along >= first - ENTER_M, ahead: first - along };
  }
  return null;
}

// The stretch the view frames: from a little before the first decision to a little after the last, in metres.
export function junctionSpan(junction, cum, total) {
  return [Math.max(0, cum[junction.start] - LEAVE_M), Math.min(total, cum[junction.end] + 2 * LEAVE_M)];
}
