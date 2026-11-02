// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Keeps the app shell available offline and fast to open, and keeps map tiles around: every tile
// the map loads is cached, and drives prefetch their corridor (see offline.js), so tunnels and dead
// spots show map instead of blank background. API calls always go to the network.
//
// Two map caches: small long-lived files (map library, style, TileJSON, fonts, sprites) live in
// MAPS and are never trimmed, so trimming and "Clear offline maps" can't evict the library or the
// labels. Only versioned vector tiles live in TILES, which is trimmed to MAX_TILES.
const CACHE = 'a2b-v43';
const TILES = 'a2b-tiles-v1'; // versioned tiles only; kept across activates; cleared from Settings › Offline maps
const MAPS = 'a2b-maps-v1'; // library, style, TileJSON, fonts, sprites; never trimmed
const MAX_TILES = 2000; // bound phone storage; iOS can evict a PWA's whole storage when it gets large
const SHELL = ['/', '/styles.css', '/app.js', '/core.js', '/panels.js', '/nav.js', '/motion.js', '/voice.js', '/vehicle3d.js', '/geo.js', '/icons.js', '/report-types.js', '/map-themes.js', '/places.js', '/text.js', '/sheet-drag.js', '/follow.js', '/presence.js', '/welcome.js', '/update.js', '/offline.js', '/train-guide.js', '/signs.js', '/dead-reckoning.js', '/map-places.js', '/suggest.js', '/school-zones.js', '/faster-route.js', '/route-preview.js', '/address.js', '/probe.js', '/i18n.js', '/i18n-ms.js', '/i18n-zh.js', '/icon.svg', '/manifest.webmanifest'];
// Served from our own domain (public/vendor/), so a network that blocks or stalls a CDN can't stop the app.
const MAPLIBRE = ['/vendor/maplibre-gl-4.7.1/maplibre-gl.js', '/vendor/maplibre-gl-4.7.1/maplibre-gl.css'];
const VENDOR = [...MAPLIBRE, '/vendor/three-0.160.0/three.module.js']; // every library file the app loads; three.js on first use

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    await c.addAll(SHELL);
    // The map library goes in the never-trimmed maps cache, so it outlives app updates (its URL changes only
    // with its version). Best-effort: a missing copy is fetched and cached on first use.
    const maps = await caches.open(MAPS);
    await Promise.all(MAPLIBRE.map((u) => maps.match(u).then((hit) => hit ?? fetch(u).then((res) => res.ok ? maps.put(u, res) : null)).catch(() => null)));
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== TILES && k !== MAPS).map((k) => caches.delete(k))))
    .then(() => caches.open(MAPS)).then(dropRetiredLibs)
    .then(() => self.clients.claim()));
});

// Versioned vector tiles (/planet/<release>/…) are cache-first: a new tile release is new URLs.
// The style JSON (/styles/*) and the TileJSON it points to (/planet) have FIXED URLs whose content
// changes with each OpenFreeMap release, so they are network-first with the cached copy as the
// offline fallback — otherwise a phone would keep requesting a retired tile release forever.
// Fonts and sprites are versioned and small, so they are cache-first in the never-trimmed cache.
function isTile(url) {
  return url.host === 'tiles.openfreemap.org' && url.pathname.includes('/planet/');
}

function isFontOrSprite(url) {
  return url.host === 'tiles.openfreemap.org' &&
    (url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/sprites/'));
}

function isMapMetadata(url) {
  return url.host === 'tiles.openfreemap.org' &&
    (url.pathname.startsWith('/styles/') || url.pathname === '/planet');
}

// The maps cache is never trimmed, so library copies from before an upgrade (or from the CDN the app used to load
// them from) would stay on the phone for good: keep only the ones the app still loads.
function dropRetiredLibs(cache) {
  return cache.keys().then((keys) => Promise.all(keys.filter((k) => {
    const url = new URL(k.url);
    return url.host === 'unpkg.com' || (isVendor(url) && !VENDOR.includes(url.pathname));
  }).map((k) => cache.delete(k)))).catch(() => {});
}

// Third-party libraries in public/vendor/<name>-<version>/: a new version is a new URL. (No '@' in the folder name:
// Cloudflare redirects it to %40, an extra round trip per file.)
function isVendor(url) {
  return url.origin === location.origin && url.pathname.startsWith('/vendor/');
}

// The Cache API lists keys in insertion order, so trimming from the front drops the oldest entries.
function trimTiles(cache, keys) {
  if (keys.length > MAX_TILES) {
    return Promise.all(keys.slice(0, keys.length - MAX_TILES).map((k) => cache.delete(k))).then(() => {});
  }
  return Promise.resolve();
}

// Listing the whole tile cache on every write keeps phones hot: panning fires dozens of writes a
// second, and each keys() call materialises up to MAX_TILES Requests. Trim at most every 100 writes
// or 30 s (plus the trim that runs after each prefetch), so storage overshoots by at most one batch.
let tileWrites = 0;
let lastTrimAt = 0;
const TRIM_EVERY_WRITES = 100;
const TRIM_EVERY_MS = 30_000;

function scheduleTileTrim(event, cache) {
  tileWrites++;
  const now = Date.now();
  if (tileWrites % TRIM_EVERY_WRITES !== 0 && now - lastTrimAt < TRIM_EVERY_MS) return;
  lastTrimAt = now;
  event.waitUntil(cache.keys().then((keys) => trimTiles(cache, keys)).catch(() => {}));
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (isMapMetadata(url)) {
    // Network first: a new release must replace the cached style/TileJSON; cache is offline fallback.
    e.respondWith(networkFirst(e, MAPS, e.request));
    return;
  }
  if (isVendor(url) || isFontOrSprite(url)) {
    // Small and long-lived: cache-first in the never-trimmed cache, so the library and labels
    // survive trims, "Clear offline maps", and offline cold starts (e.g. a basement car park).
    e.respondWith(caches.open(MAPS).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) e.waitUntil(c.put(e.request, res.clone()).catch(() => {}));
      return res;
    }).catch(() => caches.match(e.request)));
    return;
  }
  if (isTile(url)) {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) {
        // Trim at most every 100 writes or 30 s — never on every write — so panning the map
        // doesn't keep the phone hot listing the whole cache. Puts are held open so a worker
        // shutdown straight after the response can't lose the write.
        e.waitUntil(c.put(e.request, res.clone()).catch(() => {}));
        scheduleTileTrim(e, c);
      }
      return res;
    }).catch(() => caches.match(e.request)));
    return;
  }
  // Place data is versioned and kept by the browser's own cache; keeping it here too would only grow.
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/places/') || url.pathname === '/version.json') return;
  // Network first so new deploys show up straight away; the cache is the fallback when offline.
  const key = e.request.mode === 'navigate' ? '/' : e.request;
  e.respondWith(networkFirst(e, CACHE, key));
});

// Network first, but on a connection that is up yet barely works (weak WiFi, a captive portal), don't wait for
// it: after NETWORK_WAIT_MS the cached copy is served instead, if there is one. The network answer still
// lands in the cache when it comes, so the next launch is fresh. Once one request has had to fall back, the
// rest go straight to the cache for SLOW_HOLD_MS: the app's modules load in a chain of imports, and waiting at
// every link would add up to many seconds.
const NETWORK_WAIT_MS = 3000;
const SLOW_HOLD_MS = 30_000;
let slowUntil = 0;

function networkFirst(e, cacheName, key) {
  let saved;
  e.waitUntil(new Promise((resolve) => (saved = resolve))); // keeps the worker alive for a late cache write
  const network = fetch(e.request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(cacheName).then((c) => c.put(key, copy)).catch(() => {}).finally(saved);
    } else saved();
    return res;
  }, (err) => {
    saved();
    throw err;
  });
  let answered = false;
  network.then(() => {
    answered = true;
    slowUntil = 0;
  }, () => (answered = true));
  const wait = Date.now() < slowUntil ? 0 : NETWORK_WAIT_MS;
  const cachedAfterWait = new Promise((r) => setTimeout(r, wait))
    .then(() => (answered ? null : caches.match(key)))
    .then((hit) => {
      if (!hit) return network;
      slowUntil = Date.now() + SLOW_HOLD_MS;
      return hit;
    });
  return Promise.race([network, cachedAfterWait]).catch(() => caches.match(key));
}
