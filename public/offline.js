// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Saving the map along a drive, so tunnels and dead spots don't leave a blank map. The service worker
// (sw.js) keeps every map tile it fetches; this module decides *which* tiles to fetch ahead of time:
// the corridor around the active route, prefetched when a drive starts while still online.

export const TILE_CACHE = 'a2b-tiles-v1'; // keep in step with public/sw.js
export const MAX_CACHED_TILES = 2000; // past this, the oldest entries are dropped to bound phone storage
export const PREFETCH_ZOOMS = [12, 13, 14]; // street detail; z15+ is overzoomed from z14, so fetching it wastes data
const FETCH_AT_ONCE = 6;
// Per-drive prefetch budgets: a full corridor at z12–14 can be ~100 MB on a long drive, so cap it
// and prefetch the start of the route first (tilesForCoords orders low zoom first, and route order
// within each zoom, so a cap keeps context plus the first kilometres in detail).
const PREFETCH_BUDGET_TILES = 800;
const PREFETCH_BUDGET_BYTES = 50 * 1024 * 1024;
// On metered connections fetch just the start of the drive; the full corridor waits for Wi-Fi.
const METERED_BUDGET_TILES = 300;
const METERED_BUDGET_BYTES = 15 * 1024 * 1024;

// ---------- Pure tile maths (unit-tested in test/offline.test.js) ----------

const clampLat = (lat) => Math.max(-85.0511, Math.min(85.0511, lat));

export function lngLatToTile(lng, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan((clampLat(lat) * Math.PI) / 180) + 1 / Math.cos((clampLat(lat) * Math.PI) / 180)) / Math.PI) / 2) * n);
  return { z, x: Math.min(n - 1, Math.max(0, x)), y: Math.min(n - 1, Math.max(0, y)) };
}

export function tileUrl(template, { z, x, y }) {
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

// Every tile the route touches at the given zooms, plus a one-tile margin so the map around the
// road is there too. Low zooms first, so a cap keeps context over detail.
export function tilesForCoords(coords, zooms = PREFETCH_ZOOMS, buffer = 1) {
  const seen = new Set();
  const out = [];
  for (const z of [...zooms].sort((a, b) => a - b)) {
    const n = 2 ** z;
    for (const [lng, lat] of coords) {
      const { x, y } = lngLatToTile(lng, lat, z);
      for (let dx = -buffer; dx <= buffer; dx++) {
        for (let dy = -buffer; dy <= buffer; dy++) {
          const tx = x + dx, ty = y + dy;
          if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
          const key = `${z}/${tx}/${ty}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ z, x: tx, y: ty });
        }
      }
    }
  }
  return out;
}

// ---------- Cache bookkeeping ----------

export async function tileCount() {
  try {
    return (await (await caches.open(TILE_CACHE)).keys()).length;
  } catch {
    return 0;
  }
}

export async function clearOfflineTiles() {
  try {
    await caches.delete(TILE_CACHE);
  } catch {}
}

export async function originUsage() {
  try {
    return (await navigator.storage?.estimate()) ?? null;
  } catch {
    return null;
  }
}

// ---------- Prefetch ----------

// Tile URL templates for the map's vector sources, resolved through their TileJSON so a new tile
// release (OpenFreeMap versions the tile path) is picked up without a code change. Also returns the
// TileJSON zoom range so prefetching can clamp to zooms that exist (MapLibre overzooms z14 for
// z15+, so requesting z15+ tiles would fetch nothing). Raster sources (hillshading) are decorative
// and world-covering at low zoom, so they are left out.
export async function tileTemplates(style) {
  const info = await tileSourceInfo(style);
  return info.templates;
}

export async function tileSourceInfo(style) {
  const urls = [...new Set(Object.values(style?.sources ?? {}).filter((s) => s.type === 'vector' && s.url).map((s) => s.url))];
  const templates = [];
  let minzoom = 0;
  let maxzoom = 22;
  let found = false;
  await Promise.all(urls.map(async (url) => {
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const tj = await res.json();
      for (const t of tj.tiles ?? []) templates.push(t);
      // Clamp to what the source actually serves; TileJSON top-level min/maxzoom is authoritative.
      if (typeof tj.minzoom === 'number' || typeof tj.maxzoom === 'number') {
        if (!found) {
          found = true;
          minzoom = typeof tj.minzoom === 'number' ? tj.minzoom : 0;
          maxzoom = typeof tj.maxzoom === 'number' ? tj.maxzoom : 22;
        } else {
          if (typeof tj.minzoom === 'number') minzoom = Math.max(minzoom, tj.minzoom);
          if (typeof tj.maxzoom === 'number') maxzoom = Math.min(maxzoom, tj.maxzoom);
        }
      }
    } catch {}
  }));
  if (!found) {
    // No zoom info (unreachable TileJSON in a test, or a source without one): fall back to the
    // OpenFreeMap planet range so we still don't request overzoomed tiles.
    minzoom = 0;
    maxzoom = 14;
  }
  return { templates, minzoom, maxzoom };
}

// Which prefetch budget applies right now. Metered (usually cellular) connections and Data Saver
// get a smaller start-of-route budget; Wi-Fi, ethernet, desktops without the API, and unknown
// types get the full corridor budget.
export function prefetchBudget(connection = globalThis.navigator?.connection) {
  const type = connection?.type ?? '';
  const saveData = connection?.saveData === true;
  const metered = saveData || type === 'cellular';
  if (metered) return { maxTiles: METERED_BUDGET_TILES, maxBytes: METERED_BUDGET_BYTES, metered: true };
  return { maxTiles: PREFETCH_BUDGET_TILES, maxBytes: PREFETCH_BUDGET_BYTES, metered: false };
}

// Keep the in-drive message honest when route tiles hit the tile or data budget.
export function offlineMapPrefetchNotice({ fetched = 0, total = 0, complete = false } = {}) {
  if (total <= 0) return null;
  if (!complete) {
    return fetched > 0
      ? 'Map tiles were loaded for part of this route; offline coverage may be incomplete.'
      : 'Offline map coverage for this route could not be confirmed.';
  }
  return fetched > 50
    ? 'Map tiles were loaded for the full route corridor; browser storage may still limit offline access.'
    : null;
}

// Fetch the route corridor into the tile cache. Already-cached tiles are served from cache by the
// worker, so re-driving a familiar road costs almost nothing. Never throws: prefetch is best-effort.
//
// The list is ordered low-zoom-first and route-order within each zoom, so stopping at the budget
// keeps whole-route context plus the FIRST part of the drive in street detail — the part the driver
// needs before the signal plausibly returns. On metered connections the budget is smaller; the rest
// of the corridor is picked up by the worker as the map loads it.
export async function prefetchRouteTiles(coords, getStyle, { zooms = PREFETCH_ZOOMS, maxTiles, maxBytes, onProgress } = {}) {
  try {
    if (!coords?.length || typeof caches === 'undefined') return { fetched: 0, total: 0, complete: false };
    const budget = prefetchBudget();
    const tileCap = maxTiles ?? budget.maxTiles;
    const byteCap = maxBytes ?? budget.maxBytes;
    const { templates, minzoom, maxzoom } = await tileSourceInfo(getStyle());
    if (!templates.length) return { fetched: 0, total: 0, complete: false };
    const clamped = zooms.filter((z) => z >= minzoom && z <= maxzoom);
    if (!clamped.length) return { fetched: 0, total: 0, complete: false };
    const candidates = tilesForCoords(coords, clamped);
    const tiles = candidates.slice(0, tileCap);
    const tileBudgetLimited = tiles.length < candidates.length;
    let fetched = 0;
    let bytes = 0;
    let stopped = false;
    const queue = [...tiles];
    const estimateTileBytes = (z) => (z >= 14 ? 200 * 1024 : z === 13 ? 100 * 1024 : 50 * 1024);
    await Promise.all(Array.from({ length: Math.min(FETCH_AT_ONCE, queue.length) }, async () => {
      while (queue.length && !stopped) {
        const t = queue.shift();
        let tileComplete = true;
        for (const template of templates) {
          if (stopped) {
            tileComplete = false;
            break;
          }
          try {
            const res = await fetch(tileUrl(template, t));
            if (!res.ok) {
              tileComplete = false;
              continue;
            }
            // Track data use so a long drive can't burn ~100 MB unasked: prefer the real size
            // when the header is there, else a per-zoom estimate (cheap; tiles already cached
            // cost nothing but still count, which is fine).
            let size = Number(res.headers?.get?.('content-length'));
            if (!Number.isFinite(size) || size <= 0) size = estimateTileBytes(t.z);
            bytes += size;
            if (bytes >= byteCap) stopped = true;
          } catch {
            tileComplete = false;
          } // went offline mid-prefetch: the tiles so far still count
        }
        if (tileComplete) fetched++;
        onProgress?.(fetched, candidates.length);
      }
    }));
    await trimTileCache();
    // fetched counts complete tile positions; total is the full corridor before the tile cap.
    return {
      fetched,
      total: candidates.length,
      complete: !tileBudgetLimited && fetched === candidates.length,
    };
  } catch {
    return { fetched: 0, total: 0, complete: false };
  }
}

// The tile cache lists keys in insertion order, so trimming from the front drops the oldest tiles.
// (The worker trims at most every 100 writes or 30 s; this post-prefetch trim is the backstop.)
async function trimTileCache() {
  try {
    const cache = await caches.open(TILE_CACHE);
    const keys = await cache.keys();
    if (keys.length > MAX_CACHED_TILES) await Promise.all(keys.slice(0, keys.length - MAX_CACHED_TILES).map((k) => cache.delete(k)));
  } catch {}
}
