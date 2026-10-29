// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// A2B's own place search, on the phone: OpenStreetMap, Overture Maps and Foursquare's places merged into files
// (scripts/build-locations.py, into /places/ next to scripts/build-places.py's kinds of place), plus the few changes
// since they were built (drivers' places, places taken out: /api/locations/changes). Only the files for the query's
// rarest word, in the person's area and the areas around it, are downloaded, and the browser keeps them for next time,
// so searching takes no server. With no /places/ data deployed, this quietly finds nothing.

import { distance } from './geo.js';
import { words, matchesWordStarts, normalizeText } from './text.js';

const BASE = '/places';
const MAX_RESULTS = 12;
const RADIUS_KM = 60; // beyond this a place isn't "nearby" (the other search covers the rest)
const MAX_FILES_PER_WORD = 8;
const MAX_LOOKED_AT = 40000; // places one search looks through, at most (~4 MB of files, the first time)

const cache = new Map(); // url -> Promise<json|null>
function getJson(url, init) {
  if (!cache.has(url)) {
    cache.set(url, fetch(url, init).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return cache.get(url);
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

// Words too common to look a place up by (each in over 15,000 names and addresses; "jalan" is in 330,000): the files
// don't list places under them (scripts/build-locations.py COMMON), and they only narrow the other words' matches. A
// search of nothing else ("kuala lumpur") is left to the server's geocoder.
export const COMMON = new Set([
  'jalan', 'jln', 'lorong', 'lrg', 'persiaran', 'taman', 'tmn', 'kampung', 'kg', 'bandar', 'pusat', 'kota', 'bukit',
  'sungai', 'sg', 'batu', 'baru', 'jaya', 'alam', 'indah', 'perdana', 'sri', 'seri', 'kuala', 'lumpur', 'petaling', 'shah',
  'johor', 'bahru', 'ipoh', 'klang', 'kinabalu', 'kuching', 'miri', 'malaysia', 'lot', 'floor', 'ground', 'centre', 'mall',
  'restoran', 'restaurant', 'cafe', 'kedai', 'klinik', 'masjid', 'sdn', 'bhd', 'the', 'and',
]);
// Which sources list a place, added up in a row's 7th field (scripts/build-locations.py SOURCE_BITS).
export const SOURCES = { osm: 1, overture: 2, foursquare: 4, driver: 8 };
// Landmarks people head for: ahead of other landmarks.
const VENUES = new Set([
  'shopping_center', 'shopping_mall', 'mall', 'train_station', 'metro_station', 'rail_station', 'station', 'airport', 'aerodrome',
  'terminal', 'ferry_terminal', 'bus_station', 'hospital', 'university', 'college_university', 'stadium', 'museum', 'zoo',
  'theme_park', 'convention_center', 'tourist_attraction', 'attraction',
]);
const AREAS = new Set(['city', 'town', 'suburb', 'village', 'neighbourhood', 'quarter', 'residential']);
const STATIONS = new Set(['station', 'train_station', 'metro_station', 'rail_station', 'bus_station', 'ferry_terminal']);

// What changed since the files were built (src/lib/locations.js): fetched when the app opens and kept a few minutes.
const CHANGES_MS = 5 * 60 * 1000;
let changes = null; // { at, promise: Promise<{ places, hidden: Set }> }
let fresh = false; // the browser's copy is out of date too
export const forgetChanges = () => ((changes = null), (fresh = true)); // after a suggestion is reviewed, and for tests
export function loadChanges(fetchJson = (u, init) => fetch(u, init).then((r) => (r.ok ? r.json() : null))) {
  if (!changes || Date.now() - changes.at > CHANGES_MS) {
    const promise = fetchJson('/api/locations/changes', fresh ? { cache: 'no-cache' } : undefined)
      .then((d) => ({ places: d?.places ?? [], hidden: new Set(d?.hidden ?? []) }))
      .catch(() => ({ places: [], hidden: new Set() }));
    changes = { at: Date.now(), promise };
    fresh = false;
  }
  return changes.promise;
}

// How well a place answers q (lower is better): how much of the query is in its name and how near the name is to just
// that, a name starting so or named exactly so, a landmark people head for (more sources listing it count), only
// Foursquare listing it (the source with the most check-in pages made up on the spot), and distance. "trx" is The
// Exchange TRX before a "Trx" next to you; "jalan ampang" the road before Ampang Park on it; "kfc" the nearest KFC.
export function score(p, q, near) {
  const all = words(q);
  const nameWords = words(p.name);
  const inName = all.filter((w) => nameWords.some((t) => t.startsWith(w))).length;
  const named = inName === all.length;
  const relevance = -10 * (inName / all.length) - 4 * Math.min(1, all.length / Math.max(1, nameWords.length));
  const starts = normalizeText(p.name).startsWith(normalizeText(q)) ? -2 : 0;
  const exact = nameWords.join(' ') === all.join(' ') ? -1.5 : 0;
  const landmark = p.kind === 'l' && named ? (VENUES.has(p.category) ? -4.5 : -2) : 0;
  const known = p.kind === 'l' && named ? -2 * (bits(p.sources) - 1) : 0;
  const unconfirmed = p.sources === SOURCES.foursquare ? 1.5 : 0;
  return relevance + starts + exact + landmark + known + unconfirmed + Math.log1p(near ? distance(near, [p.lng, p.lat]) / 1000 : 0);
}
const bits = (n) => [1, 2, 4, 8].filter((b) => n & b).length;

// A row of the files, or of the changes, as a place. landmark: as the server's photonToPlace says it, for mergeResults.
function rowPlace([name, lng, lat, address, category, kind, sources, id], near) {
  const landmark = kind !== 'l' ? undefined : AREAS.has(category) ? 'area' : STATIONS.has(category) ? 'station' : 'place';
  return { name, address, lat, lng, category: category || 'place', kind, sources: sources || 0, id, ...(landmark ? { landmark } : {}),
    km: near ? distance(near, [lng, lat]) / 1000 : 0, source: 'a2b' };
}

// A2B's own places for q around near, best first (see score).
export async function searchNearby(q, near) {
  const all = words(q);
  const keyWords = all.filter((w) => (w.length >= 2 || /\d/.test(w)) && !COMMON.has(w) && !/^\d+$/.test(w));
  if (!keyWords.length || !near) return [];
  const [idx, changed] = await Promise.all([loadIndex(), loadChanges()]);
  if (!idx) return [];
  const v = encodeURIComponent(idx.release ?? '');
  const areas = areasAround(near, idx.area, idx.areaSet);
  const lists = await Promise.all(areas.map((a) => getJson(`${BASE}/${a}/files.json?v=${v}`)));

  // The files for each word: a place is filed under the words of its name, and any of the query's may be its address's
  // ("nandos eco grandeur"). The busiest words' files are left out while there's too much to look through, keeping
  // the quietest word's at least.
  const listed = (w) => areas.reduce((n, _, i) => n + filesForWord(w, lists[i] ?? {}).reduce((m, f) => m + (lists[i][f] ?? 0), 0), 0);
  const chosen = keyWords.map((w) => [w, listed(w)]).sort((a, b) => a[1] - b[1]);
  while (chosen.length > 1 && chosen.reduce((n, [, c]) => n + c, 0) > MAX_LOOKED_AT) chosen.pop();
  const urls = new Set();
  for (const [w] of chosen) areas.forEach((area, i) => lists[i] && filesForWord(w, lists[i]).forEach((f) => urls.add(`${BASE}/${area}/${f}.json?v=${v}`)));
  const shards = await Promise.all([...urls].map((u) => getJson(u)));

  const seen = new Set();
  const found = [];
  for (const row of [...shards.flatMap((s) => s?.p ?? []), ...changed.places]) {
    const id = row[7] ?? `${row[0]}|${row[1]}|${row[2]}`;
    if (seen.has(id) || changed.hidden.has(id)) continue;
    seen.add(id);
    if (!matchesWordStarts(`${row[0]} ${row[3]}`, q)) continue;
    const p = rowPlace(row, near);
    if (p.km > RADIUS_KM) continue;
    found.push(p);
  }
  return found
    .map((p) => ({ p, s: score(p, q, near) }))
    .sort((a, b) => a.s - b.s)
    .slice(0, MAX_RESULTS)
    .map(({ p }) => p);
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
export function mergeResults(server, local, q, near, ranked = false) {
  const dup = (a, b) => words(a.name).join(' ') === words(b.name).join(' ') && distance([a.lng, a.lat], [b.lng, b.lat]) < 150;
  const first = words(q)[0] ?? '';
  // A sight or venue before a town of that name, and a town before a station named after it.
  const candidates = server.filter((p) => p.landmark && matchesWordStarts(p.name, first));
  const landmark = ['place', 'area', 'station'].map((k) => candidates.find((p) => p.landmark === k)).find(Boolean);
  const named = landmark ? words(landmark.name).filter((w) => w.length >= 3) : [];
  const reach = landmark?.landmark === 'area' ? 3000 : 1000; // a town is a few km across
  // Where OpenStreetMap has places named like the query ("KLCC Park", "LRT KLCC", "KLCC Convention Centre").
  const anchors = landmark ? server.filter((p) => matchesWordStarts(p.name, q)) : [];
  const within = (l, ps, m) => ps.some((p) => distance([l.lng, l.lat], [p.lng, p.lat]) <= m);
  const misplaced = (l) =>
    (named.length > 0 && named.every((w) => words(l.name).includes(w)) && !within(l, [landmark], reach)) ||
    (anchors.length > 0 && matchesWordStarts(l.name, q) && !within(l, anchors, Math.max(reach, 1500)));
  const extra = local.filter((l) => !server.some((s) => dup(s, l)) && !misplaced(l));
  const all = [...server, ...extra];
  const exact = words(q).join(' ');
  const tier = (p) => {
    if (p === landmark) return -1;
    if (words(p.name).join(' ') === exact) return -0.5; // named just what was typed ("jalan ampang": the road itself)
    const full = matchesWordStarts(`${p.name} ${p.address ?? ''}`, q);
    if (full && matchesWordStarts(p.name, first)) return 0;
    return full ? 1 : 2;
  };
  const km = (p) => (near ? distance(near, [p.lng, p.lat]) / 1000 : 0);
  const order = (list) => list.map((p) => ({ p, t: tier(p), d: km(p) })).sort((a, b) => a.t - b.t || a.d - b.d).map(({ p }) => p);
  // The server ranked A2B's own places (src/lib/locations.js) knowing more than this phone does: keep its order,
  // with the phone's own finds after.
  if (ranked) return [...server, ...order(extra)].slice(0, 12);
  return order(all).slice(0, 12);
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
async function typeRows(type, at) {
  const [server, files] = await Promise.all([sourceRows(type), fileRows(type, at)]);
  if (!server.length) return files;
  return [...server, ...files.filter(([, lng, lat]) => !server.some(([, x, y]) => Math.abs(y - lat) < 0.001 && distance([x, y], [lng, lat]) < 50))];
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

export const attribution = 'Places: © OpenStreetMap contributors, Overture Maps, Foursquare';
