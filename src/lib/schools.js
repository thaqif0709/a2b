// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Schools along a route, for the school zone warning at school times (public/school-zones.js). The list is built
// ahead of time by scripts/build-schools.mjs into public/schools.json and read here through the Worker's static
// assets, once per Worker instance.

import { cumulative, projectOnSegment } from '../../public/geo.js';

const NEAR_M = 150; // a school this close to the road: its gate is probably on it
// ~550 m cells, wider than NEAR_M: a school's road passes through its own cell or one next to it. Both the schools
// and each route's segments are filed under them, so a school is only measured against the road near it, not the
// whole route (a long drive has thousands of points and passes hundreds of schools).
const CELL_DEG = 0.005;

const cellOf = (x, y) => [Math.floor(x / CELL_DEG), Math.floor(y / CELL_DEG)];

// Schools ([lng, lat, name] rows) by cell.
export function schoolGrid(rows) {
  const grid = new Map();
  for (const r of rows) {
    const k = cellOf(r[0], r[1]).join(':');
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(r);
  }
  return grid;
}

// The route's segments (by the index of their end point) under every cell they pass through. A segment is sampled
// every half cell, so the cell of a point within NEAR_M of it is never more than one cell from a sampled one.
function segmentGrid(coords) {
  const grid = new Map();
  for (let i = 1; i < coords.length; i++) {
    const [x0, y0] = coords[i - 1], [x1, y1] = coords[i];
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / (CELL_DEG / 2)));
    for (let s = 0; s <= n; s++) {
      const k = cellOf(x0 + ((x1 - x0) * s) / n, y0 + ((y1 - y0) * s) / n).join(':');
      const list = grid.get(k);
      if (!list) grid.set(k, [i]);
      else if (list.at(-1) !== i) list.push(i);
    }
  }
  return grid;
}

const around = ([cx, cy]) => [-1, 0, 1].flatMap((dx) => [-1, 0, 1].map((dy) => `${cx + dx}:${cy + dy}`));

let loaded = null; // Promise of { rows, grid }, kept once it has schools

export async function loadSchools(assets) {
  if (!assets) return { rows: [], grid: new Map() };
  if (loaded) return loaded;
  const p = (async () => {
    const res = await assets.fetch(new Request('https://assets.local/schools.json'));
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return { rows: [], grid: new Map() }; // not built
    const rows = (await res.json()).schools ?? [];
    return { rows, grid: schoolGrid(rows) };
  })();
  loaded = p;
  const got = await p.catch(() => null);
  if (!got?.rows.length) loaded = null; // nothing yet: look again next time
  return got ?? { rows: [], grid: new Map() };
}

// The schools beside a route, in order: { at: index into its coords, name, pos: the school's own [lng, lat] }.
export function schoolsAlong(coords, { grid }) {
  if (!grid?.size || coords.length < 2) return [];
  const segs = segmentGrid(coords);
  const near = new Set(); // cells next to the road, where a school could be within NEAR_M of it
  for (const k of segs.keys()) for (const n of around(k.split(':').map(Number))) near.add(n);
  const cum = cumulative(coords);
  const out = [];
  for (const k of near) {
    for (const [lng, lat, name] of grid.get(k) ?? []) {
      // The nearest point of the road, as pointAlong would find it on the whole route (the first segment on a tie).
      let best = null;
      for (const c of around(cellOf(lng, lat))) {
        for (const i of segs.get(c) ?? []) {
          if (best?.seg === i) continue;
          const s = projectOnSegment([lng, lat], coords[i - 1], coords[i]);
          if (!best || s.dist < best.dist || (s.dist === best.dist && i < best.seg)) best = { dist: s.dist, seg: i, t: s.t };
        }
      }
      if (!best || best.dist > NEAR_M) continue;
      const { seg, t } = best;
      out.push({ at: seg, along: cum[seg - 1] + (cum[seg] - cum[seg - 1]) * t, name: name || null, pos: [lng, lat] });
    }
  }
  out.sort((a, b) => a.along - b.along);
  // Schools side by side (a primary and a secondary sharing a road) are one zone.
  return out.filter((s, i) => i === 0 || s.along - out[i - 1].along > 150).map(({ at, name, pos }) => ({ at, name, pos }));
}
