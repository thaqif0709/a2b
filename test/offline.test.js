// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lngLatToTile,
  tileUrl,
  tilesForCoords,
  tileSourceInfo,
  prefetchBudget,
  prefetchRouteTiles,
  offlineMapPrefetchNotice,
  PREFETCH_ZOOMS,
  MAX_CACHED_TILES,
} from '../public/offline.js';

async function withPrefetchMocks(fetchTile, run) {
  const originalFetch = globalThis.fetch;
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  globalThis.caches = { open: async () => ({ keys: async () => [] }) };
  globalThis.fetch = async (url) => {
    if (String(url) === 'https://tiles.example.org/planet') {
      return {
        ok: true,
        json: async () => ({
          tiles: ['https://tiles.example.org/tiles/{z}/{x}/{y}.pbf'],
          minzoom: 0,
          maxzoom: 14,
        }),
      };
    }
    return fetchTile(String(url));
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
    else delete globalThis.caches;
  }
}

const vectorStyle = () => ({ sources: { map: { type: 'vector', url: 'https://tiles.example.org/planet' } } });
const tileResponse = (ok = true) => ({ ok, headers: { get: () => '64' } });

test('lngLatToTile centres the world at low zoom', () => {
  assert.deepEqual(lngLatToTile(0, 0, 0), { z: 0, x: 0, y: 0 });
  assert.deepEqual(lngLatToTile(101.7, 3.15, 14), { z: 14, x: 12820, y: 8048 });
});

test('lngLatToTile clamps poles and antimeridian', () => {
  const t = lngLatToTile(0, 90, 4);
  assert.equal(t.y, 0);
  assert.ok(lngLatToTile(200, 0, 4).x <= 15);
  assert.ok(lngLatToTile(-200, 0, 4).x >= 0);
});

test('tileUrl fills the template', () => {
  assert.equal(
    tileUrl('https://tiles.example.org/planet/20261025_pt/{z}/{x}/{y}.pbf', { z: 14, x: 12820, y: 8048 }),
    'https://tiles.example.org/planet/20261025_pt/14/12820/8048.pbf',
  );
});

test('tilesForCoords dedupes overlapping points and orders low zoom first', () => {
  const tiles = tilesForCoords([[101.7, 3.15], [101.7001, 3.1501]], [14, 12], 0);
  const keys = tiles.map((t) => `${t.z}/${t.x}/${t.y}`);
  assert.equal(keys.length, new Set(keys).size); // no duplicates
  assert.ok(tiles[0].z === 12 && tiles.at(-1).z === 14); // context before detail
});

test('tilesForCoords buffer adds neighbours but stays in range', () => {
  const tiles = tilesForCoords([[179.9, 0]], [2], 1);
  const n = 4;
  assert.ok(tiles.length > 0 && tiles.length <= 9);
  for (const t of tiles) assert.ok(t.x >= 0 && t.y >= 0 && t.x < n && t.y < n);
});

test('a short drive stays within prefetch budget', () => {
  // ~15 km of points every ~100 m, like a route from KL to Putrajaya sampled coarsely.
  const coords = [];
  for (let i = 0; i <= 150; i++) coords.push([101.7 + i * 0.0009, 3.15 - i * 0.0004]);
  const tiles = tilesForCoords(coords, PREFETCH_ZOOMS);
  assert.ok(tiles.length < MAX_CACHED_TILES, `got ${tiles.length} tiles`);
});

test('default zooms stop at the TileJSON maxzoom (z15+ is overzoomed)', () => {
  assert.ok(!PREFETCH_ZOOMS.includes(15) && !PREFETCH_ZOOMS.includes(16));
  assert.ok(Math.max(...PREFETCH_ZOOMS) <= 14);
});

test('tileSourceInfo clamps to the TileJSON zoom range', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ tiles: ['https://tiles.example.org/planet/20261025_pt/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 14 }) });
  try {
    const info = await tileSourceInfo({ sources: { a: { type: 'vector', url: 'https://tiles.example.org/planet' } } });
    assert.deepEqual(info.templates, ['https://tiles.example.org/planet/20261025_pt/{z}/{x}/{y}.pbf']);
    assert.equal(info.maxzoom, 14);
    const tiles = tilesForCoords([[101.7, 3.15]], PREFETCH_ZOOMS.filter((z) => z >= info.minzoom && z <= info.maxzoom));
    assert.ok(tiles.every((t) => t.z <= 14));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('metered connections get a smaller prefetch budget', () => {
  assert.deepEqual(prefetchBudget({ type: 'cellular' }).metered, true);
  assert.ok(prefetchBudget({ type: 'cellular' }).maxTiles < prefetchBudget({ type: 'wifi' }).maxTiles);
  assert.ok(prefetchBudget({ type: 'wifi' }).maxBytes <= 50 * 1024 * 1024);
  assert.ok(prefetchBudget(undefined).maxTiles > 0); // desktops without the API get the full budget
});

test('prefetch reports when the tile budget leaves part of the route unsaved', async () => {
  const result = await withPrefetchMocks(async () => tileResponse(), () =>
    prefetchRouteTiles([[-120, 0], [0, 0], [120, 0]], vectorStyle, {
      zooms: [2],
      maxTiles: 1,
      maxBytes: 10_000,
    }),
  );

  assert.ok(result.total > 1);
  assert.equal(result.fetched, 1);
  assert.equal(result.complete, false);
  assert.match(offlineMapPrefetchNotice(result), /coverage may be incomplete/);
});

test('prefetch reports partial coverage when the byte budget stops the corridor', async () => {
  const result = await withPrefetchMocks(async () => tileResponse(), () =>
    prefetchRouteTiles([[-120, 0], [0, 0], [120, 0]], vectorStyle, {
      zooms: [2],
      maxTiles: 100,
      maxBytes: 64,
    }),
  );

  assert.ok(result.total > 1);
  assert.ok(result.fetched > 0);
  assert.equal(result.complete, false);
  assert.match(offlineMapPrefetchNotice(result), /coverage may be incomplete/);
});

test('prefetch marks a fully fetched route complete and keeps the existing success threshold', async () => {
  const result = await withPrefetchMocks(async () => tileResponse(), () =>
    prefetchRouteTiles([[101.7, 3.15]], vectorStyle, {
      zooms: [0],
      maxTiles: 10,
      maxBytes: 10_000,
    }),
  );

  assert.deepEqual(result, { fetched: 1, total: 1, complete: true });
  assert.equal(offlineMapPrefetchNotice(result), null);
  assert.equal(
    offlineMapPrefetchNotice({ fetched: 51, total: 51, complete: true }),
    'Map tiles were loaded for the full route corridor; browser storage may still limit offline access.',
  );
});

test('prefetch does not claim coverage when tile requests fail', async () => {
  const result = await withPrefetchMocks(async () => tileResponse(false), () =>
    prefetchRouteTiles([[101.7, 3.15]], vectorStyle, {
      zooms: [0],
      maxTiles: 10,
      maxBytes: 10_000,
    }),
  );

  assert.equal(result.complete, false);
  assert.match(offlineMapPrefetchNotice(result), /could not be confirmed/);
});
