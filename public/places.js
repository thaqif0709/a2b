// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Place search on the phone, from Overture Maps data built by scripts/build-places.py into /places/.
// Shops and restaurants that OpenStreetMap lacks (e.g. many in Malaysia) are found here. Only the files
// for the query's words, in the person's area and the areas around it, are downloaded, and the browser
// keeps them for next time. With no /places/ data deployed, this quietly finds nothing.

import { distance } from './geo.js';
import { words, matchesWordStarts } from './text.js';
import { addressQuery, streetIndexWords, onStreet, isExact } from './address.js';

const BASE = '/places';
const MAX_RESULTS = 8;
const RADIUS_KM = 60; // beyond this a place isn't "nearby" (the other search covers the rest)
const MAX_FILES_PER_WORD = 8;

const inflight = new Map(); // url -> Promise<json|null>
const PLACES_CACHE = 'a2b-places-data-v1';

function shouldPersist(init) {
  return init?.cache !== 'no-cache' && init?.cache !== 'no-store';
}

function getJson(url, init) {
  if (inflight.has(url)) return inflight.get(url);
  const persist = shouldPersist(init);
  const promise = (async () => {
    if (persist && typeof caches !== 'undefined' && typeof caches.open === 'function') {
      try {
        const cache = await caches.open(PLACES_CACHE);
        const hit = await cache.match(url);
        if (hit) return await hit.json();
      } catch {}
    }
    try {
      const res = await fetch(url, init);
      if (!res || !res.ok) return null;
      const data = await res.json();
      if (persist && typeof caches !== 'undefined' && typeof caches.open === 'function') {
        try {
          const cache = await caches.open(PLACES_CACHE);
          await cache.put(url, new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }));
        } catch {}
      }
      return data;
    } catch {
      return null;
    }
  })();
  inflight.set(url, promise);
  return promise;
}

let indexPromise = null;
function loadIndex() {
  // The index names the data release, which versions every other file, so always check it is current.
  indexPromise ??= getJson(`${BASE}/index.json`, { cache: 'no-cache' }).then((idx) => (idx ? { ...idx, areaSet: new Set(idx.areas) } : null));
  return indexPromise;
}

const asciiAlnum = /^[a-z0-9]+$/;

// The files that can hold places with a name word starting with `word`: the longest prefix that has its
// own file, or, for a word shorter than the split, its file and the longer ones under it.
export function filesForWord(word, files) {
  if (!asciiAlnum.test(word[0])) return '_' in files ? ['_'] : [];
  for (let n = Math.min(3, word.length); n >= 1; n--) {
    const p = word.slice(0, n);
    if (!asciiAlnum.test(p) || !(p in files)) continue;
    if (n < word.length || n === 3) return [p];
    return [p, ...Object.keys(files).filter((k) => k.length > p.length && k.startsWith(p))].slice(0, MAX_FILES_PER_WORD);
  }
  return [];
}

// Areas of `size` degrees: the one containing `near` and the eight around it.
function areasAround([lng, lat], size, known) {
  const row = Math.floor(lat / size), col = Math.floor(lng / size);
  const out = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) out.push(`${row + dr}_${col + dc}`);
  return out.filter((a) => known.has(a));
}

// ---------- Driver places ----------

// Places drivers suggested and a tester approved (src/lib/suggestions.js), set by app.js from GET /api/driver-places.
// They're searched like the files' places and ranked the same way. A fix (a moved pin, or a place that's gone) also
// hides the wrong place: one with the same name within HIDE_M of where it was, from any source.
const HIDE_M = 300;
let driverPlaces = [];
let hides = [];
export function setDriverPlaces(rows) {
  const live = rows.filter((r) => !r.removed);
  driverPlaces = live.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
  hides = live.filter((r) => r.hides_name).map((r) => ({ name: words(r.hides_name).join(' '), lat: r.hides_lat, lng: r.hides_lng }));
}
export function isHidden(p) {
  if (!hides.length || p.source === 'driver') return false;
  const name = words(p.name).join(' ');
  return hides.some((h) => h.name === name && Math.abs(h.lat - p.lat) < 0.01 && distance([h.lng, h.lat], [p.lng, p.lat]) < HIDE_M);
}
const driverRow = (r) => [r.name, r.lng, r.lat, r.address ?? '', r.category];

export async function searchNearby(q, near) {
  const qWords = words(q).filter((w) => w.length >= 2 || /\d/.test(w));
  if (!qWords.length || !near) return [];
  // An address ("129, BK 5/6, Puchong"): the places on that street, looked up by its street's words, the house
  // searched for first (see address.js). Any other search: places with every word of it.
  const addr = addressQuery(q)?.street ? addressQuery(q) : null;
  const fits = (name, address) => (addr ? onStreet({ name, address }, addr) : matchesWordStarts(`${name} ${address}`, q));
  const inName = (name, address) => (addr ? isExact({ name, address }, addr) : matchesWordStarts(name, q));
  const found = [];
  for (const r of driverPlaces) {
    if (!fits(r.name, r.address ?? '')) continue;
    const km = distance(near, [r.lng, r.lat]) / 1000;
    if (km <= RADIUS_KM) found.push({ name: r.name, address: r.address ?? '', lat: r.lat, lng: r.lng, category: r.category || 'place', km, inName: inName(r.name, r.address ?? ''), source: 'driver' });
  }
  // The venue the query names first (see markVenues), then places matching on their name alone, then nearest.
  const best = () => found.sort((a, b) => (b.mentions ?? 0) - (a.mentions ?? 0) || b.inName - a.inName || a.km - b.km).slice(0, MAX_RESULTS);
  const idx = await loadIndex();
  if (!idx) return best();
  const v = encodeURIComponent(idx.release ?? '');
  const areas = areasAround(near, idx.area, idx.areaSet);
  const lists = await Promise.all(areas.map((a) => getJson(`${BASE}/${a}/files.json?v=${v}`)));

  const urls = new Set();
  areas.forEach((area, i) => {
    const files = lists[i];
    if (!files) return;
    for (const w of addr ? streetIndexWords(addr.street) : qWords) for (const p of filesForWord(w, files)) urls.add(`${BASE}/${area}/${p}.json?v=${v}`);
  });
  const shards = await Promise.all([...urls].map((u) => getJson(u)));

  const seen = new Set(found.map((p) => `${p.name}|${p.lng}|${p.lat}`));
  for (const shard of shards) {
    for (const [name, lng, lat, address, category] of shard?.p ?? []) {
      const key = `${name}|${lng}|${lat}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!fits(name, address)) continue;
      const km = distance(near, [lng, lat]) / 1000;
      if (km > RADIUS_KM) continue;
      const p = { name, address, lat, lng, category: category || 'place', km, inName: inName(name, address), source: 'overture' };
      if (!isHidden(p)) found.push(p);
    }
  }
  markVenues(found);
  return best();
}

// A mall (or stadium) whose name the shops around it carry: "trx" finds 70 places, most of them "... The
// Exchange TRX", and the one they're all in should come first, not whichever shop is nearest. Overture has copies
// of big places pinned in the wrong spot too ("The Exchange TRX" 4 km off), so only shops within VENUE_M count.
const VENUES = new Set(['shopping_mall', 'department_store', 'stadium_arena']);
const VENUE_M = 1000;
const MIN_MENTIONS = 3;
function markVenues(found) {
  const text = (p) => ` ${words(`${p.name} ${p.address}`).join(' ')} `;
  for (const v of found) {
    if (!VENUES.has(v.category) || !v.inName) continue;
    const name = ` ${words(v.name).join(' ')} `;
    const mentions = found.filter((p) => p !== v && Math.abs(p.lat - v.lat) < 0.01 && text(p).includes(name) && distance([v.lng, v.lat], [p.lng, p.lat]) <= VENUE_M).length;
    if (mentions >= MIN_MENTIONS) Object.assign(v, { landmark: 'place', mentions });
  }
}

// Puts nearby Overture places together with the other search's results, dropping duplicates (same name
// within 150 m), then orders them: best text match first, nearest first within that.
//   1. the name starts with the query's first word, and the rest of the query is in the name or address
//      ("nandos eco grandeur" -> Nando's, Ruang Niaga Eco Grandeur)
//   2. all of the query is somewhere in the name or address
//   3. the rest (e.g. the Eco Grandeur suburb itself)
//   Before all of them: OpenStreetMap's best landmark for the query, when its name starts like the query
//   (a sight or venue, else a town, else a station; see photonToPlace). The
//   other search matches a landmark's other names too ("Petronas Towers" for "petronas twin towers").
//   Overture places carrying that landmark's name but pinned more than a kilometre from it (3 km for a town),
//   or named with the query but 1.5 km from everything OpenStreetMap has by that name, are dropped:
//   they're mostly check-in pages people made elsewhere ("Petronas Twin Tower" in Kota Kinabalu).
export function mergeResults(server, local, q, near) {
  server = server.filter((p) => !isHidden(p)); // a place a driver's fix moved or took out
  const dup = (a, b) => words(a.name).join(' ') === words(b.name).join(' ') && distance([a.lng, a.lat], [b.lng, b.lat]) < 150;
  const first = words(q)[0] ?? '';
  // A sight or venue before a town of that name, and a town before a station named after it. Among sights, a
  // mall the shops nearby name (markVenues) beats a park that merely shares a word ("trx"), the nearest mall first.
  const km = (p) => (near ? distance(near, [p.lng, p.lat]) / 1000 : 0);
  const venues = local.filter((p) => p.mentions).sort((a, b) => km(a) - km(b));
  const candidates = [...venues, ...server].filter((p) => p.landmark && matchesWordStarts(p.name, first));
  const landmark = ['place', 'area', 'station'].map((k) => candidates.find((p) => p.landmark === k)).find(Boolean);
  const named = landmark ? words(landmark.name).filter((w) => w.length >= 3) : [];
  const reach = landmark?.landmark === 'area' ? 3000 : 1000; // a town is a few km across
  // Where OpenStreetMap has places named like the query ("KLCC Park", "LRT KLCC", "KLCC Convention Centre").
  const anchors = landmark ? server.filter((p) => matchesWordStarts(p.name, q)) : [];
  const within = (l, ps, m) => ps.some((p) => distance([l.lng, l.lat], [p.lng, p.lat]) <= m);
  const misplaced = (l) =>
    (named.length > 0 && named.every((w) => words(l.name).includes(w)) && !within(l, [landmark], reach)) ||
    (anchors.length > 0 && matchesWordStarts(l.name, q) && !within(l, anchors, Math.max(reach, 1500)));
  // The landmark once: OpenStreetMap and Overture pin a big place a few hundred metres apart.
  const copy = (p) => p !== landmark && words(p.name).join(' ') === words(landmark.name).join(' ') && within(p, [landmark], reach);
  // A marked mall wins over OpenStreetMap's copy of it, so it keeps its place near the top.
  const kept = [...server.filter((s) => !venues.some((v) => dup(s, v))), ...local.filter((l) => venues.includes(l) || (!server.some((s) => dup(s, l)) && !misplaced(l)))];
  const all = landmark ? kept.filter((p) => !copy(p)) : kept;
  const tier = (p) => {
    if (p === landmark) return -1;
    if (venues.includes(p) && matchesWordStarts(p.name, q)) return -0.5; // the other malls of that name ("pavilion")
    const full = matchesWordStarts(`${p.name} ${p.address ?? ''}`, q);
    if (full && matchesWordStarts(p.name, first)) return 0;
    return full ? 1 : 2;
  };
  return all
    .map((p) => ({ p, t: tier(p), d: km(p) }))
    .sort((a, b) => a.t - b.t || a.d - b.d)
    .map(({ p }) => p)
    .slice(0, 12);
}

// ---------- Searching by kind of place ----------

// "petrol", "klinik near bangsar", "balai polis terdekat": searches that name a kind of place, not a place. Most
// petrol stations are just called "Petronas" or "Shell" and many hospitals "… Medical Centre", so searching
// names misses the nearest ones. These read the area's file of that kind (scripts/build-places.py TYPES) instead.
export const TYPES = {
  fuel: { label: 'Petrol stations', words: ['petrol stations?', 'gas stations?', 'fuel stations?', 'petrol pumps?', 'stesen minyak', 'pam minyak', 'isi minyak', 'petrol', 'fuel', 'minyak'] },
  hospital: { label: 'Hospitals', words: ['hospitals?', 'medical cent(?:re|er)s?', 'emergency rooms?', 'emergency', 'kecemasan'] },
  clinic: { label: 'Clinics', words: ['klinik kesihatan', 'clinics?', 'klinik', 'poliklinik', 'polyclinics?', 'doctors?', 'gps?'] },
  police: { label: 'Police stations', words: ['police stations?', 'balai polis', 'ibu pejabat polis', 'police', 'polis', 'ipd'] },
  ev: { label: 'EV chargers', words: ['ev charg(?:ers?|ing(?: stations?)?)', 'electric (?:car |vehicle )?charg(?:ers?|ing)', 'charging stations?', 'chargers?', 'pengecas(?: ev)?', 'stesen (?:cas|pengecas)', 'cas ev', 'ev'] },
  convenience: { label: 'Convenience stores', words: ['convenience stores?', 'convenience shops?', 'kedai serbaneka', 'kedai runcit', 'convenience', 'serbaneka', 'mini ?marts?'] },
};
const TYPE_RES = Object.entries(TYPES).map(([type, t]) => [type, new RegExp(`\\b(?:${t.words.join('|')})\\b`, 'gi')]);
const FILLER = /\b(?:near(?:by|est)?|closest|at|in|around|by|the|a|an|me|my|here|dekat|berdekatan|terdekat|di|kat|sini|yang)\b/gi;
const TYPE_RADIUS_KM = 25;
const TYPE_RESULTS = 12;

// { type, area } when q names a kind of place (area: the rest of the words, '' for "near me"), else null.
export function typeQuery(q) {
  for (const [type, re] of TYPE_RES) {
    if (!q.match(re)) continue;
    const area = q.replace(re, ' ').replace(FILLER, ' ').replace(/[^\p{L}\p{N}'&.-]+/gu, ' ').replace(/\s+/g, ' ').trim();
    return { type, area };
  }
  return null;
}

// Kinds of place with a list from the server too (EV chargers: OpenStreetMap and Open Charge Map, src/lib/chargers.js),
// set by app.js: type -> () => Promise of rows like the files'. Fetched once; a failure is asked again next time.
const sources = new Map();
const fetched = new Map();
export function addTypeSource(type, load) {
  sources.set(type, load);
  fetched.delete(type);
}
function sourceRows(type) {
  if (!sources.has(type)) return Promise.resolve([]);
  if (!fetched.has(type)) {
    fetched.set(type, sources.get(type)().catch(() => {
      fetched.delete(type);
      return [];
    }));
  }
  return fetched.get(type);
}

// Every listed place of a kind in the areas around `at`, as [name, lng, lat, address, category] rows: the server's
// list first where there is one, and a file's place the server also lists (within 50 m) once.
// Driver places of that kind come first, and a place a driver's fix hides is left out.
async function typeRows(type, at) {
  const [server, files] = await Promise.all([sourceRows(type), fileRows(type, at)]);
  const shown = ([name, lng, lat]) => !isHidden({ name, lng, lat });
  const listed = [...driverPlaces.filter((r) => r.category === type).map(driverRow), ...server.filter(shown)];
  const rest = files.filter(shown);
  if (!listed.length) return rest;
  return [...listed, ...rest.filter(([, lng, lat]) => !listed.some(([, x, y]) => Math.abs(y - lat) < 0.001 && distance([x, y], [lng, lat]) < 50))];
}

async function fileRows(type, at) {
  const idx = await loadIndex();
  if (!idx) return [];
  const v = encodeURIComponent(idx.release ?? '');
  const areas = areasAround(at, idx.area, idx.areaSet);
  const lists = await Promise.all(areas.map((a) => getJson(`${BASE}/${a}/files.json?v=${v}`)));
  const shards = await Promise.all(areas.filter((_, i) => lists[i]?.[`@${type}`]).map((a) => getJson(`${BASE}/${a}/@${type}.json?v=${v}`)));
  return shards.flatMap((s) => s?.p ?? []);
}

const toPlace = ([name, lng, lat, address, category], type, at) =>
  ({ name, address, lat, lng, category: category || type, type, km: distance(at, [lng, lat]) / 1000, source: 'overture' });

// The places of a kind nearest to `at` ([lng, lat]), within TYPE_RADIUS_KM, nearest first.
export async function placesOfType(type, at) {
  const found = (await typeRows(type, at)).map((r) => toPlace(r, type, at)).filter((p) => p.km <= TYPE_RADIUS_KM);
  // The same place listed twice (two sources a few metres apart) shows once.
  found.sort((a, b) => a.km - b.km);
  const out = [];
  for (const p of found) {
    if (out.some((o) => words(o.name).join(' ') === words(p.name).join(' ') && distance([o.lng, o.lat], [p.lng, p.lat]) < 80)) continue;
    out.push(p);
    if (out.length === TYPE_RESULTS) break;
  }
  return out;
}

// The places of these kinds inside a map view ([west, south, east, north]), for showing them on the map; at most
// `max`, the ones nearest the middle of the view first.
export async function placesOfTypesIn(types, [w, s, e, n], max = 300) {
  const mid = [(w + e) / 2, (s + n) / 2];
  const lists = await Promise.all(types.map(async (type) => (await typeRows(type, mid))
    .filter(([, lng, lat]) => lng >= w && lng <= e && lat >= s && lat <= n)
    .map((r) => toPlace(r, type, mid))));
  return lists.flat().sort((a, b) => a.km - b.km).slice(0, max);
}

// Words that say what kind of place it is, not which one: "Klinik Kesihatan Ampang" and "Klinik Kesihatan Pandan" are
// two clinics.
const KIND_WORDS = new Set([
  'petrol', 'station', 'stesen', 'minyak', 'fuel', 'klinik', 'clinic', 'poliklinik', 'kesihatan', 'hospital', 'medical',
  'centre', 'center', 'pusat', 'perubatan', 'specialist', 'pakar', 'dental', 'pergigian', 'kedai', 'store', 'mart', 'mini',
  'charger', 'charging', 'sdn', 'bhd', 'the', 'and', 'dan',
]);

// The map's pins of these kinds (placesOfTypesIn) less the ones the base map already draws: the same kind of place
// within 150 m whose name shares a word with ours, so a station listed by both Overture and OpenStreetMap, pinned
// on its shop in one and on its forecourt in the other, shows once. A name with nothing but kind words ("Klinik")
// matches within 60 m. base: [{ type, name, lng, lat }], the base map's places drawn on screen.
export function withoutBaseDuplicates(ours, base) {
  const own = (name) => new Set(words(name).filter((w) => w.length >= 3 && !KIND_WORDS.has(w)));
  const drawn = base.map((b) => ({ ...b, w: own(b.name) }));
  return ours.filter((p) => {
    const w = own(p.name);
    return !drawn.some((b) => {
      if (b.type !== p.type || Math.abs(b.lat - p.lat) > 0.002) return false;
      const named = b.w.size > 0 && w.size > 0;
      if (named && ![...w].some((x) => b.w.has(x))) return false;
      return distance([b.lng, b.lat], [p.lng, p.lat]) < (named ? 150 : 60);
    });
  });
}

export const attribution = 'Places: Overture Maps Foundation';
