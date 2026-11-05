// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { distance } from '../../public/geo.js';

// Reuse both compiled GTFS networks. A short walk connects bus stops and rail platforms;
// no new data provider, timetable download or routing request is needed to join them.
export function connectTransitNetworks(rail, bus, maxTransferMetres = 400) {
  const offset = rail.stops.length;
  const stops = [...rail.stops, ...bus.stops];
  const nearby = [
    ...rail.nearby.map((row) => row.map(([to, metres]) => [to, metres])),
    ...bus.nearby.map((row) => row.map(([to, metres]) => [to + offset, metres])),
  ];
  // A latitude grid bounds comparisons; longitude is checked by the exact distance below.
  const cell = maxTransferMetres / 111000;
  const grid = new Map();
  bus.stops.forEach((stop, i) => {
    const key = Math.floor(stop[1] / cell);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i + offset);
  });
  rail.stops.forEach((stop, i) => {
    const key = Math.floor(stop[1] / cell);
    for (let row = key - 1; row <= key + 1; row++) for (const j of grid.get(row) ?? []) {
      const other = stops[j];
      const metres = distance([stop[2], stop[1]], [other[2], other[1]]);
      if (metres > maxTransferMetres) continue;
      nearby[i].push([j, metres]);
      nearby[j].push([i, metres]);
    }
  });
  return {
    feeds: { ...rail.feeds, ...bus.feeds },
    services: { ...rail.services, ...bus.services },
    lines: { ...rail.lines, ...bus.lines },
    shapes: { ...rail.shapes, ...bus.shapes },
    stops,
    stopKinds: [...rail.stops.map(() => null), ...bus.stops.map(() => 'Bus')],
    patterns: [...rail.patterns, ...bus.patterns.map((p) => ({ ...p, stops: p.stops.map((i) => i + offset) }))],
    nearby,
  };
}
