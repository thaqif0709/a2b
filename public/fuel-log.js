// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// What the driving done with A2B has cost in fuel, roughly: the distance actually driven (from the GPS, on real
// drives by car: not walks, trains, motorbikes or demo drives), priced at that week's pump price as it's driven
// (trip-cost.js). Kept on this phone, a total per day, so Settings can say this week, this month and all time.

import { distance } from './geo.js';

const MIN_STEP_M = 20; // closer fixes are mostly the GPS wobbling: wait until the car has really moved
const MAX_ACCURACY_M = 50; // vaguer fixes aren't counted
const MAX_SPEED = 70; // m/s, about 250 km/h: faster than that between two fixes is the GPS jumping, not the car
const KEEP_DAYS = 62; // days kept one by one (enough for this month); older ones are added into one total

// Adds up the distance between GPS fixes. `metres` is what's been driven since it was last taken.
export class Odometer {
  constructor() {
    this.last = null;
    this.metres = 0;
  }

  add({ lngLat, accuracy, time }) {
    if ((accuracy ?? 0) > MAX_ACCURACY_M) return;
    if (!this.last) {
      this.last = { lngLat, time };
      return;
    }
    const d = distance(this.last.lngLat, lngLat);
    if (d < MIN_STEP_M) return;
    const dt = (time - this.last.time) / 1000;
    this.last = { lngLat, time };
    if (!(dt > 0 && d / dt > MAX_SPEED)) this.metres += d;
  }

  take() {
    const m = this.metres;
    this.metres = 0;
    return m;
  }
}

// The phone's own date, as '2026-11-03'.
export function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The log with a stretch driven today added: `rm` is its fuel (null for an electric car, or with no price). The log
// is { days: { '2026-11-03': { m, rm } }, before: { m, rm } }, `before` being the days too old to keep one by one.
export function logDriven(log, metres, rm, now = Date.now()) {
  const days = { ...log?.days };
  const before = { m: 0, rm: 0, ...log?.before };
  const today = days[dayKey(now)] ?? { m: 0, rm: 0 };
  days[dayKey(now)] = { m: today.m + metres, rm: today.rm + (rm ?? 0) };
  const oldest = dayKey(now - KEEP_DAYS * 86400_000);
  for (const [day, v] of Object.entries(days)) {
    if (day >= oldest) continue;
    before.m += v.m;
    before.rm += v.rm;
    delete days[day];
  }
  return { days, before };
}

// { week, month, all }, each { m, rm }: the week from Monday, the month from the 1st.
export function fuelSummary(log, now = Date.now()) {
  const d = new Date(now);
  const monday = dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime());
  const first = dayKey(new Date(d.getFullYear(), d.getMonth(), 1).getTime());
  const since = (from, start = { m: 0, rm: 0 }) => Object.entries(log?.days ?? {})
    .filter(([day]) => day >= from)
    .reduce((sum, [, v]) => ({ m: sum.m + v.m, rm: sum.rm + v.rm }), start);
  return { week: since(monday), month: since(first), all: since('', { m: 0, rm: 0, ...log?.before }) };
}
