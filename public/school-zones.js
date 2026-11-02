// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// School zones: when to warn, and which school on the route is next. The server lists the schools beside each
// route (src/lib/schools.js); app.js speaks and shows the chip.
//
// Only around the school runs, Malaysia time: before school, the end of the morning session and the start of the
// afternoon one, and the end of the afternoon session. School days are Monday to Friday, except in Kedah, Kelantan
// and Terengganu, where the weekend is Friday and Saturday (school Sunday to Thursday). Which state you're in is
// decided by rough boxes, good enough for this but not exact near the borders. School holidays and public holidays
// aren't known, so on those days the warning still comes at school times.

const MYT = 8 * 3600_000;
const H = 3600;
export const SCHOOL_RUNS = [
  [6.5 * H, 7.75 * H], // 6:30 to 7:45
  [12.5 * H, 14.5 * H], // 12:30 to 2:30
  [17.75 * H, 18.75 * H], // 5:45 to 6:45
];
export const WARN_M = 300; // the warning comes this far before a school
export const PAST_M = 100; // and the chip stays until this far past it

// [west, south, east, north], rough. Perlis and Penang (inside Kedah's box) keep a Saturday and Sunday weekend.
const FRI_SAT_WEEKEND = [
  [99.6, 5.08, 101.0, 6.72], // Kedah, with Langkawi
  [101.3, 4.55, 102.7, 6.25], // Kelantan
  [102.35, 4.15, 103.7, 5.9], // Terengganu
];
const SAT_SUN_INSIDE = [
  [100.1, 6.25, 100.45, 6.75], // Perlis
  [100.15, 5.1, 100.56, 5.6], // Penang, island and mainland
];
const inBox = ([lng, lat], [w, s, e, n]) => lng >= w && lng <= e && lat >= s && lat <= n;

// True when `at` (ms) at `pos` ([lng, lat]) is a school day there.
export function isSchoolDay(at, pos) {
  const dow = new Date(at + MYT).getUTCDay(); // Sunday 0
  const friSat = pos && FRI_SAT_WEEKEND.some((b) => inBox(pos, b)) && !SAT_SUN_INSIDE.some((b) => inBox(pos, b));
  return friSat ? dow !== 5 && dow !== 6 : dow !== 0 && dow !== 6;
}

// True during a school run on a school day.
export function isSchoolTime(at, pos) {
  if (!isSchoolDay(at, pos)) return false;
  const d = new Date(at + MYT);
  const secs = d.getUTCHours() * H + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  return SCHOOL_RUNS.some(([from, to]) => secs >= from && secs < to);
}

// The school to warn about at `along` metres into the route: { school, ahead } from WARN_M before it until PAST_M
// past it, or null. `schools` as the server lists them ({ at: index into the route's coords }), `cum` the route's
// cumulative distances.
export function schoolAhead(along, schools, cum) {
  const list = schools ?? [];
  const i = list.findIndex((s) => cum[s.at] - along >= -PAST_M);
  if (i < 0) return null;
  // Just past one with another coming up: the one coming up, so its warning isn't late.
  const next = list[i + 1];
  const pick = cum[list[i].at] < along && next && cum[next.at] - along <= WARN_M ? next : list[i];
  const ahead = cum[pick.at] - along;
  return ahead <= WARN_M ? { school: pick, ahead } : null;
}

// School zones in Malaysia are signed 30 km/h. What the chip and the voice say about it, in the units chosen in
// Settings (20 mph is the nearest round figure).
export const SCHOOL_LIMIT_KMH = 30;
export function schoolLimit(units) {
  return units === 'imperial' ? { chip: '20 mph zone', spoken: 'Slow down to 20.' } : { chip: `${SCHOOL_LIMIT_KMH} km/h zone`, spoken: `Slow down to ${SCHOOL_LIMIT_KMH}.` };
}
