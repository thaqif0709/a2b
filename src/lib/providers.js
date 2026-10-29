// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Place search (Photon) and driving routes (Valhalla), normalised into the shapes the app uses.
// Both default to free public servers; point GEOCODER_URL / ROUTING_URL at your own to scale up.

import { decodePolyline, cumulative, distance, atDistance } from '../../public/geo.js';
import { normalizeText, matches } from '../../public/text.js';

export { normalizeText, matches };
import { pointAlong } from '../../public/nav.js';
import { compactSign, withSign } from '../../public/signs.js';
import { tollIndexes } from './tolls.js';

const UA = 'a2b-navigation/0.1 (+https://a2b-beta.pages.dev)';

export function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

// The free map servers A2B leans on turn people away when they're overloaded (429 or 5xx) or stop answering.
// Say so plainly instead of reporting "no route", since trying again a little later usually works.
export const BUSY_MESSAGE = 'A2B is busy right now (it runs on free map servers during the beta). Try again in a minute.';

async function upstream(url, init) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15000), ...init });
  } catch {
    throw httpError(BUSY_MESSAGE, 503);
  }
  if (res.status === 429 || res.status >= 500) throw httpError(BUSY_MESSAGE, 503);
  return res;
}

// ---------- Search ----------

// Nearby first: one search inside ~50 km; only when that finds too little, a second one everywhere (still
// weighted towards you). With answers in reach, anything further than FAR_KM is dropped, and results are
// ordered in distance bands (50 / 150 / 400 km) so the closest come first.
const LOCAL_KM = 50;
const BANDS_KM = [50, 150, 400];
const ENOUGH = 3;
const FAR_KM = 600;
const AREA_KINDS = new Set([
  'suburb', 'neighbourhood', 'quarter', 'city', 'town', 'village', 'hamlet', 'locality', 'residential', 'district',
  'county', 'state', 'commercial', 'retail', 'mall', 'square', 'island', 'region',
]);

// One search fans out over the public geocoder: nearby, then everywhere, then (for "name area" queries) the
// area plus the name near it. Capped so a single search stays a handful of upstream requests.
const SEARCH_CALLS = 6;

export async function searchPlaces(env, { q, lat, lng, lang = 'en' }, budget = { left: SEARCH_CALLS }) {
  const near = Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : null;
  const call = (args) => (budget.left > 0 ? (budget.left--, photon(env, args)) : Promise.resolve([]));
  if (!near) return { places: dedupe(await call({ q, lang })) };

  let found = await call({ q, lang, near, bbox: boxAround(near, LOCAL_KM) }).catch(() => null);
  if (!found || found.length < ENOUGH) {
    const wide = await call({ q, lang, near }).catch((e) => (found ? [] : Promise.reject(e)));
    found = dedupe([...(found ?? []), ...wide]);
  }

  // "nandos eco grandeur": a name, then the area it's in. Look for the name around that area.
  const split = await nameInArea(env, q, lang, near, found, call).catch(() => ({ places: [] }));
  let places = dedupe([...split.places, ...found]).map((p) => ({ ...p, km: Math.round(distance(near, [p.lng, p.lat]) / 100) / 10 }));
  if (places.some((p) => p.km <= FAR_KM)) places = places.filter((p) => p.km <= FAR_KM);
  const band = (p) => (p.src ? -1 : BANDS_KM.findIndex((km) => p.km <= km) + 1 || BANDS_KM.length + 1);
  places = places.map((p, i) => ({ p, i, b: band(p) })).sort((x, y) => x.b - y.b || x.i - y.i).map(({ p }) => withoutSrc(p));
  return { places: places.slice(0, 10), note: split.note };
}

async function nameInArea(env, q, lang, near, found, call) {
  const words = q.trim().split(/\s+/);
  if (words.length < 2) return { places: [] };
  for (let k = 1; k <= Math.min(3, words.length - 1); k++) {
    const name = words.slice(0, k).join(' ');
    const areaText = words.slice(k).join(' ');
    // Already answered: a result named like the name part that sits in the named area.
    if (found.some((p) => matches(p.name, name) && matches(`${p.name} ${p.address}`, areaText))) return { places: [] };
    const area = (await call({ q: areaText, lang, near, bbox: boxAround(near, BANDS_KM.at(-1)) })).find(
      (p) => AREA_KINDS.has(p.category) && matches(p.name, areaText),
    );
    if (!area) continue;
    const there = [area.lng, area.lat];
    const hits = (await call({ q: name, lang, near: there, bbox: boxAround(there, 8) })).filter((p) => matches(p.name, name));
    if (hits.length) return { places: hits.map((p) => ({ ...p, src: 'area' })) };
    return { places: [], note: `No "${name}" found near ${area.name} in the map data.` };
  }
  return { places: [] };
}

function withoutSrc({ src, ...p }) {
  return p;
}

// A box of roughly `km` in every direction around [lng, lat], as Photon wants it: minLon,minLat,maxLon,maxLat.
export function boxAround([lng, lat], km) {
  const dLat = km / 111;
  const dLng = km / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat].map((v) => v.toFixed(4)).join(',');
}

// A2B is for Malaysia: Photon is asked inside the country's box, and of its answers only those it places in the
// country are kept (the box takes in Singapore and Brunei too). SEARCH_COUNTRY is an ISO code; empty for anywhere.
const COUNTRY_BOXES = { MY: '99.6,0.85,119.3,7.4' };
export const searchCountry = (env) => String(env.SEARCH_COUNTRY ?? 'MY').toUpperCase();

async function photon(env, { q, lang, near, bbox }) {
  const country = searchCountry(env);
  bbox ??= COUNTRY_BOXES[country];
  const base = env.GEOCODER_URL || 'https://photon.komoot.io';
  const u = new URL('/api/', base);
  u.searchParams.set('q', q);
  u.searchParams.set('limit', '10');
  if (['en', 'de', 'fr'].includes(lang)) u.searchParams.set('lang', lang);
  if (near) {
    u.searchParams.set('lat', near[1]);
    u.searchParams.set('lon', near[0]);
  }
  if (bbox) u.searchParams.set('bbox', bbox);
  const data = await getJson(u).catch(async (e) => {
    if (e.status !== 502) throw e;
    await new Promise((r) => setTimeout(r, 400)); // busy public server: one quick retry
    return getJson(u);
  });
  return (data.features ?? []).filter((f) => !country || String(f.properties?.countrycode ?? '').toUpperCase() === country).map(photonToPlace);
}

export async function reverseGeocode(env, { lat, lng }) {
  const base = env.GEOCODER_URL || 'https://photon.komoot.io';
  const u = new URL('/reverse', base);
  u.searchParams.set('lat', lat);
  u.searchParams.set('lon', lng);
  u.searchParams.set('limit', '1');
  const data = await getJson(u);
  const f = data.features?.[0];
  return f ? photonToPlace(f) : { name: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, address: '', lat, lng, category: 'pin' };
}

// Well-known places in OpenStreetMap. The app puts the best of these first, ahead of shop listings that
// merely mention it (see mergeResults in public/places.js).
const LANDMARK_KEYS = new Set(['tourism', 'historic']);
const LANDMARK_VALUES = new Set([
  'leisure:park', 'leisure:stadium', 'leisure:nature_reserve', 'shop:mall', 'amenity:place_of_worship', 'amenity:university',
  'aeroway:aerodrome', 'building:skyscraper', 'man_made:tower', 'landuse:religious',
]);
const STATIONS = new Set(['railway:station', 'railway:stop', 'railway:halt']);
// Towns and suburbs count too, as areas: they're a few km across.
const AREA_LANDMARKS = new Set(['city', 'town', 'village', 'suburb', 'quarter', 'neighbourhood']);
const NOT_LANDMARKS = new Set(['hotel', 'motel', 'hostel', 'guest_house', 'apartment', 'chalet', 'information', 'camp_site']);

export function photonToPlace(f) {
  const p = f.properties ?? {};
  const [lng, lat] = f.geometry.coordinates;
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const name = p.name || street || p.city || p.county || p.state || p.country || 'Dropped pin';
  const parts = [p.name && street && street !== p.name ? street : null, p.district || p.locality, p.city, p.state, p.country]
    .filter(Boolean)
    .filter((x, i, a) => x !== name && a.indexOf(x) === i);
  const kv = `${p.osm_key}:${p.osm_value}`;
  const landmark = p.osm_key === 'place' && AREA_LANDMARKS.has(p.osm_value) ? 'area'
    : STATIONS.has(kv) ? 'station'
    : (LANDMARK_KEYS.has(p.osm_key) && !NOT_LANDMARKS.has(p.osm_value)) || LANDMARK_VALUES.has(kv) ? 'place' : null;
  return { name, address: parts.join(', '), lat, lng, category: p.osm_value || p.type || 'place', ...(landmark && p.name ? { landmark } : {}) };
}

function dedupe(places) {
  const seen = new Set();
  return places.filter((p) => {
    const k = `${p.name}|${p.address}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------- Routing ----------

// Valhalla maneuver type numbers -> the turn arrow the app draws.
const MANEUVER = {
  0: 'straight', 1: 'depart', 2: 'depart', 3: 'depart', 4: 'arrive', 5: 'arrive_right', 6: 'arrive_left', 7: 'straight', 8: 'straight',
  9: 'slight_right', 10: 'right', 11: 'sharp_right', 12: 'uturn_right', 13: 'uturn_left', 14: 'sharp_left', 15: 'left', 16: 'slight_left',
  17: 'straight', 18: 'slight_right', 19: 'slight_left', 20: 'slight_right', 21: 'slight_left', 22: 'straight', 23: 'slight_right',
  24: 'slight_left', 25: 'merge', 26: 'roundabout', 27: 'roundabout_exit', 28: 'ferry', 29: 'ferry', 37: 'merge_right', 38: 'merge_left',
};

export const MAX_EXCLUDE = 50; // the public Valhalla server's limit on avoided spots

// travel: 'drive' (the default) or 'walk', which takes footpaths and pedestrian crossings and ignores one-way streets.
export function buildRouteRequest({ from, to, via = [], avoid = {}, units = 'metric', lang = 'en-US', heading, exclude = [], travel = 'drive' }) {
  const start = { lat: from[1], lon: from[0] };
  if (Number.isFinite(heading)) {
    start.heading = Math.round(heading);
    start.heading_tolerance = 60;
  }
  return {
    locations: [start, ...via.map(([lng, lat]) => ({ lat, lon: lng, type: 'break' })), { lat: to[1], lon: to[0] }],
    ...(travel === 'walk'
      ? { costing: 'pedestrian', costing_options: { pedestrian: { use_ferry: avoid.ferries ? 0 : 0.5 } } }
      : {
          costing: 'auto',
          costing_options: {
            auto: {
              use_tolls: avoid.tolls ? 0 : 0.5,
              use_highways: avoid.highways ? 0 : 1,
              use_ferry: avoid.ferries ? 0 : 0.5,
            },
          },
        }),
    exclude_locations: exclude.slice(0, MAX_EXCLUDE).map(([lng, lat]) => ({ lat, lon: lng })),
    alternates: via.length ? 0 : 2, // Valhalla only offers alternatives between two points
    units: units === 'imperial' ? 'miles' : 'kilometers',
    language: lang,
    directions_options: { units: units === 'imperial' ? 'miles' : 'kilometers', language: lang },
    turn_lanes: true,
  };
}

// { routes, dropped }: dropped is true when no route got round the avoided spots, so they were ignored.
export async function fetchRoutes(env, opts) {
  const body = buildRouteRequest(opts);
  const res = await upstream(env.ROUTING_URL || 'https://valhalla1.openstreetmap.de/route', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Valhalla 442/171 etc: no route. Retrying without closures may still help the driver.
    if (body.exclude_locations.length && opts.exclude?.length) return { ...(await fetchRoutes(env, { ...opts, exclude: [] })), dropped: true };
    throw httpError(data.error || 'No route found between these places.', res.status === 400 ? 404 : 502);
  }
  const trips = [data.trip, ...(data.alternates ?? []).map((a) => a.trip)].filter(Boolean);
  return { routes: trips.map((t) => normalizeTrip(t, opts.units)), dropped: false };
}

// The middle of the road a driver is on, found by the router (heading picks the right road at a junction).
// Avoiding that point avoids the whole stretch between junctions, both ways. Null if no road is near.
export async function roadMidpoint(env, [lng, lat], heading) {
  const loc = { lat, lon: lng };
  if (Number.isFinite(heading)) Object.assign(loc, { heading: Math.round(heading), heading_tolerance: 45 });
  const base = env.ROUTING_URL || 'https://valhalla1.openstreetmap.de/route';
  const res = await fetch(base.replace(/\/route$/, '/locate'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ locations: [loc], costing: 'auto', verbose: true }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) return null;
  const edge = (await res.json())?.[0]?.edges?.find((e) => e.edge_info?.shape && e.distance <= 60);
  if (!edge) return null;
  const line = decodePolyline(edge.edge_info.shape);
  const cum = cumulative(line);
  return atDistance(line, cum, cum.at(-1) / 2);
}

// One continuous route, even with stops: legs are joined end to end and each stop becomes a "stop" step.
export function normalizeTrip(trip, units = 'metric') {
  const unit = units === 'imperial' ? 1609.344 : 1000;
  const coords = [];
  const steps = [];
  const shapes = [];
  trip.legs.forEach((leg, li) => {
    const pts = decodePolyline(leg.shape, 6);
    const offset = Math.max(0, coords.length - 1); // each leg starts where the last one ended
    shapes.push({ shape: leg.shape, offset });
    coords.push(...(li === 0 ? pts : pts.slice(1)));
    const last = li === trip.legs.length - 1;
    for (const m of leg.maneuvers) {
      const arriving = m.type >= 4 && m.type <= 6;
      if (arriving && !last) {
        steps.push({ ...step(m, unit, offset), type: 'stop', alert: 'You will reach your stop.', pre: 'You have reached your stop.' });
      } else steps.push(step(m, unit, offset));
    }
  });
  return {
    coords,
    shapes,
    distance: trip.summary.length * unit,
    duration: trip.summary.time,
    toll: Boolean(trip.summary.has_toll),
    highway: Boolean(trip.summary.has_highway),
    ferry: Boolean(trip.summary.has_ferry),
    stops: trip.legs.length - 1,
    via: viaName(steps),
    steps,
  };
}

// Ramps, exits, forks and merges: the turns that have expressway signs worth showing (see public/signs.js).
const SIGNED = new Set([17, 18, 19, 20, 21, 22, 23, 24, 25, 37, 38]);

function step(m, unit, offset) {
  const sign = SIGNED.has(m.type) ? compactSign(m.sign) : null;
  return {
    type: MANEUVER[m.type] ?? 'straight',
    instruction: m.instruction,
    alert: withSign(m.verbal_transition_alert_instruction || m.verbal_succinct_transition_instruction || m.instruction, sign),
    pre: withSign(m.verbal_pre_transition_instruction || m.instruction, sign),
    post: m.verbal_post_transition_instruction || null,
    street: (m.street_names ?? m.begin_street_names ?? [])[0] || '',
    exit: m.roundabout_exit_count ?? null,
    ...(sign && { sign }),
    lanes: lanes(m.lanes),
    begin: m.begin_shape_index + offset,
    end: m.end_shape_index + offset,
    length: m.length * unit,
    time: m.time,
  };
}

// Lanes at a turn, left to right: `d` = arrows painted on the lane, `use` = the arrows that lead along the route
// (Valhalla's "active" plus "valid" lanes). Bit flags as in Valhalla: 1 none, 2 through, 4 sharp left, 8 left,
// 16 slight left, 32 slight right, 64 right, 128 sharp right, 256 u-turn, 512 merge left, 1024 merge right.
export function lanes(list) {
  if (!Array.isArray(list) || list.length < 2) return null;
  const out = list.map((l) => ({ d: l.directions || 1, use: (l.active ?? 0) | (l.valid ?? 0) }));
  return out.some((l) => l.use) ? out : null;
}

// Posted speed limits, toll booths and tunnels along a route, from OpenStreetMap via Valhalla's trace_attributes.
// limits: runs [[first shape index, km/h or null], ...], one entry per change; tolls: shape indexes of toll plazas;
// tunnels: [[first, last shape index], ...], where GPS drops out (public/dead-reckoning.js keeps the car moving).
export async function fetchRouteAttributes(env, shapes, coords) {
  const perLeg = await Promise.all(shapes.map(({ shape }) => fetchLegEdges(env, shape)));
  const runs = [], tolls = [], tunnels = [];
  perLeg.forEach((edges, i) => {
    for (const [a, b] of tunnelRuns(edges ?? [], shapes[i].offset)) {
      if (tunnels.length && a - tunnels.at(-1)[1] <= 1) tunnels.at(-1)[1] = Math.max(tunnels.at(-1)[1], b);
      else tunnels.push([a, b]);
    }
    for (const [at, v] of (edges && speedLimitRuns(edges)) ?? [[0, null]]) {
      if (!runs.length || runs.at(-1)[1] !== v) runs.push([at + shapes[i].offset, v]);
    }
    for (const at of tollIndexes(edges ?? [], coords, shapes[i].offset)) {
      if (!tolls.length || distance(coords[tolls.at(-1)], coords[at]) > 300) tolls.push(at);
    }
  });
  return { limits: runs.some((r) => r[1] != null) ? runs : null, tolls, tunnels };
}

// Shape index ranges of the tunnel edges, joined where one runs into the next (a long tunnel is several edges).
export function tunnelRuns(edges, offset = 0) {
  const runs = [];
  for (const e of edges) {
    if (!e.tunnel || e.begin_shape_index == null) continue;
    const a = e.begin_shape_index + offset, b = (e.end_shape_index ?? e.begin_shape_index) + offset;
    if (runs.length && a - runs.at(-1)[1] <= 1) runs.at(-1)[1] = Math.max(runs.at(-1)[1], b);
    else runs.push([a, b]);
  }
  return runs;
}

async function fetchLegEdges(env, shape) {
  const base = env.ROUTING_URL || 'https://valhalla1.openstreetmap.de/route';
  const res = await fetch(base.replace(/\/route$/, '/trace_attributes'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({
      encoded_polyline: shape,
      shape_match: 'edge_walk',
      costing: 'auto',
      filters: { attributes: ['edge.speed_limit', 'edge.tunnel', 'edge.begin_shape_index', 'edge.end_shape_index', 'node.type'], action: 'include' },
    }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) return null;
  return (await res.json()).edges ?? [];
}

export function speedLimitRuns(edges) {
  const runs = [];
  for (const e of edges) {
    const v = typeof e.speed_limit === 'number' && e.speed_limit > 0 && e.speed_limit < 200 ? e.speed_limit : null;
    if (!runs.length || runs.at(-1)[1] !== v) runs.push([e.begin_shape_index ?? 0, v]);
  }
  return runs.some((r) => r[1] != null) ? runs : null;
}

// "via Main St": the street the route spends the longest on.
function viaName(steps) {
  const by = new Map();
  for (const s of steps) if (s.street) by.set(s.street, (by.get(s.street) ?? 0) + s.length);
  let best = '', len = 0;
  for (const [k, v] of by) if (v > len) [best, len] = [k, v];
  return best;
}

// Extra minutes a community traffic report adds when it sits on the route.
const JAM_DELAY = { moderate: 90, heavy: 240, standstill: 480 };

// Marks which live reports lie on each route and adds reported jams to the ETA.
export function annotateWithReports(routes, reports) {
  for (const r of routes) {
    const cum = cumulative(r.coords);
    const box = bbox(r.coords, 0.0005);
    const hits = [];
    for (const rep of reports) {
      if (rep.lng < box[0] || rep.lat < box[1] || rep.lng > box[2] || rep.lat > box[3]) continue;
      const best = pointAlong(r.coords, cum, [rep.lng, rep.lat]);
      if (best.dist <= 40) hits.push({ id: rep.id, type: rep.type, subtype: rep.subtype, at: Math.round(best.along) });
    }
    hits.sort((a, b) => a.at - b.at);
    r.reports = hits;
    // Live traffic, when there is some, already sees the jams drivers report.
    r.delay = r.traffic ? 0 : hits.filter((h) => h.type === 'traffic').reduce((s, h) => s + (JAM_DELAY[h.subtype] ?? 120), 0);
    r.duration += r.delay;
  }
  return routes;
}

export function bbox(coords, pad = 0) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of coords) {
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x;
    if (y > b[3]) b[3] = y;
  }
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}

// Reports that matter on a drive sit along it, not just at its ends: sample the straight line through the
// waypoints (the route isn't known yet) so closures in the middle are still avoided. Once the router answers,
// routeReportBox samples the roads actually driven for the pins and delay on each route.
export function corridorBox(pts, pad = 0.1, samples = 12) {
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    for (let k = 0; k <= samples; k++) out.push([pts[i][0] + ((pts[i + 1][0] - pts[i][0]) * k) / samples, pts[i][1] + ((pts[i + 1][1] - pts[i][1]) * k) / samples]);
  }
  return bbox(out.length ? out : pts, pad);
}

export function routeReportBox(routes, extra = [], pad = 0.2) {
  const pts = [...extra];
  for (const r of routes) {
    const c = r.coords ?? [];
    const step = Math.max(1, Math.ceil(c.length / 12));
    for (let i = 0; i < c.length; i += step) pts.push(c[i]);
    if (c.length && pts.at(-1) !== c.at(-1)) pts.push(c.at(-1));
  }
  return bbox(pts, pad);
}

async function getJson(url) {
  const res = await upstream(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw httpError(`Search service error (${res.status}).`, 502);
  return res.json();
}
