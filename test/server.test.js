// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { createD1 } from './d1-shim.js';
import { hashPassword, verifyPassword, normalizeEmail } from '../src/lib/auth.js';
import { extendedExpiry, shouldRemove } from '../src/lib/reports.js';
import { buildRouteRequest, photonToPlace, lanes, searchPlaces, corridorBox, routeReportBox } from '../src/lib/providers.js';
import { applyTraffic } from '../src/lib/traffic.js';
import { camerasAlong } from '../src/lib/cameras.js';
import { parkingQuery } from '../src/lib/parking.js';
import { cameraBearing } from '../scripts/build-cameras.mjs';
import { REPORT_TYPES } from '../public/report-types.js';
import { encodePolyline as encode, decodePolyline } from '../public/geo.js';

// ---------- Fake upstream services ----------
const LINE = Array.from({ length: 21 }, (_, i) => [13.4, 52.5 + 0.00045 * i]); // ~1 km north
let lastRouteBody = null;
let routingDown = false;
let construction = null; // a road under construction for the fake Overpass, as [[lng, lat], ...]
let detourTime = 150;
let failWithExcludes = false;
let lastLocateBody = null;
const DETOUR = LINE.map(([lng, lat]) => [lng + 0.003, lat]); // a parallel street ~200 m east
let osmLookups = 0;
let tomtomDown = false;
let cameras = null; // the built speed camera list, as in public/cameras.json
let tomtomCalls = 0;

function fakeTrip(coords, time) {
  return {
    summary: { length: 1, time, has_toll: false, has_highway: false, has_ferry: false },
    legs: [{
      shape: encode(coords),
      maneuvers: [
        { type: 1, instruction: 'Drive north on Test Street.', verbal_pre_transition_instruction: 'Drive north on Test Street.', street_names: ['Test Street'], begin_shape_index: 0, end_shape_index: coords.length - 1, length: 1, time },
        { type: 4, instruction: 'You have arrived.', verbal_pre_transition_instruction: 'You have arrived at your destination.', begin_shape_index: coords.length - 1, end_shape_index: coords.length - 1, length: 0, time: 0 },
      ],
    }],
  };
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('api.tomtom.com')) {
    tomtomCalls++;
    if (tomtomDown) return Response.json({ error: 'over quota' }, { status: 403 });
    // Follows the route it's given; the full route has a jam over its third quarter.
    const points = JSON.parse(init.body).supportingPoints;
    const full = points.length === 21;
    return Response.json({ routes: [{
      summary: { travelTimeInSeconds: full ? 600 : 100, trafficDelayInSeconds: full ? 300 : 0 },
      legs: [{ points }],
      sections: full ? [{ sectionType: 'TRAFFIC', startPointIndex: 10, endPointIndex: 15, magnitudeOfDelay: 2, delayInSeconds: 300 }] : undefined,
    }] });
  }
  if (u.includes('/locate')) {
    lastLocateBody = JSON.parse(init.body);
    const { lat, lon } = lastLocateBody.locations[0];
    return Response.json([{ edges: [{ distance: 4, edge_info: { shape: encode([[lon, lat - 0.001], [lon, lat + 0.003]]) } }] }]);
  }
  if (u.includes('/route')) {
    if (routingDown) return new Response('Too Many Requests', { status: 429 });
    lastRouteBody = JSON.parse(init.body);
    const ex = lastRouteBody.exclude_locations;
    if (failWithExcludes && ex.length) return Response.json({ error: 'No path could be found for input' }, { status: 400 });
    if (ex.some((l) => Math.abs(l.lon - 13.4) < 0.0003 && l.lat > 52.5 && l.lat < 52.509)) return Response.json({ trip: fakeTrip(DETOUR, detourTime) });
    if (lastRouteBody.locations.length === 3) {
      const a = fakeTrip(LINE.slice(0, 11), 60), b = fakeTrip(LINE.slice(10), 60);
      return Response.json({ trip: { summary: { length: 2, time: 120 }, legs: [a.legs[0], b.legs[0]] } });
    }
    return Response.json({ trip: fakeTrip(LINE, 120), alternates: [{ trip: fakeTrip(LINE.slice(0, 15), 90) }] });
  }
  if (u.includes('/trace_attributes')) {
    return Response.json({ edges: [{ begin_shape_index: 0, speed_limit: 50 }, { begin_shape_index: 5, end_shape_index: 10, speed_limit: 50, end_node: { type: 'toll_booth' } }, { begin_shape_index: 10, speed_limit: 30 }, { begin_shape_index: 15 }] });
  }
  if (u.includes('openstreetmap.org/api/0.6/map')) {
    osmLookups++;
    const [w, s, e, n] = new URL(u).searchParams.get('bbox').split(',').map(Number);
    return new Response(`<osm><node id="1" lat="${(s + n) / 2 + 0.0001}" lon="${(w + e) / 2}"><tag k="barrier" v="toll_booth"/><tag k="name" v="Plaza Tol Ujian"/>`
      + '<tag k="charge" v="2.10 MYR/motorcar;1.10 MYR/taxi"/><tag k="payment:touchngo" v="yes"/><tag k="payment:touchngo_smarttag" v="yes"/><tag k="payment:touchngo_rfid" v="yes"/></node>'
      + `<node id="2" lat="${s}" lon="${w}"><tag k="barrier" v="toll_booth"/><tag k="name" v="Far booth"/></node></osm>`);
  }
  if (u.startsWith('https://api.data.gov.my/data-catalogue?id=fuelprice')) {
    return Response.json([{ date: '2026-10-22', series_type: 'level', ron95: 4.32, ron95_budi95: 1.99, ron97: 4.8, diesel: 5.07, diesel_eastmsia: 2.15 }]);
  }
  if (u.includes('/reverse') && u.includes('osm_tag=amenity')) {
    return Response.json({ features: [
      { geometry: { coordinates: [13.4012, 52.5021] }, properties: { osm_type: 'W', osm_id: 11, name: 'Far Garage', street: 'Test Street' } },
      { geometry: { coordinates: [13.4001, 52.5001] }, properties: { osm_type: 'W', osm_id: 12, street: 'Test Street' } },
      { geometry: { coordinates: [13.4002, 52.5002] }, properties: { osm_type: 'N', osm_id: 13, name: 'Staff only' } },
    ] });
  }
  if (u.includes('openstreetmap.org/api/0.6/ways.json')) {
    return Response.json({ elements: [
      { id: 11, tags: { amenity: 'parking', parking: 'multi-storey', fee: 'yes', capacity: '400' } },
      { id: 12, tags: { amenity: 'parking', fee: 'no' } },
    ] });
  }
  if (u.includes('openstreetmap.org/api/0.6/nodes.json')) return Response.json({ elements: [{ id: 13, tags: { amenity: 'parking', access: 'private' } }] });
  if (u.includes('/reverse')) return Response.json({ features: [{ geometry: { coordinates: [13.4, 52.5] }, properties: { name: 'Somewhere', city: 'Berlin', country: 'Germany' } }] });
  if (u.includes('/api/')) {
    // A few Malaysian places for the nearby-search tests; any other query gets the default answer below.
    const params = new URL(u).searchParams;
    const feat = (name, lng, lat, osm_value = 'restaurant', extra = {}) => ({ geometry: { coordinates: [lng, lat] }, properties: { name, osm_value, country: 'Malaysia', ...extra } });
    const q = params.get('q');
    if (q === 'eco grandeur') return Response.json({ features: [feat('Eco Grandeur', 101.468, 3.224, 'suburb')] });
    if (q === 'nandos' && params.get('lat') === '3.224') return Response.json({ features: [feat("Nando's", 101.469, 3.225, 'restaurant', { street: 'Jalan Eco 1' })] });
    if (q === 'nandos') return Response.json({ features: [feat("Nando's", 101.518, 3.071), feat("Nando's", -0.12, 51.5, 'restaurant', { country: 'UK' })] });
    if (q === 'nandos eco grandeur') return Response.json({ features: [] });
  }
  if (u.includes('/api/')) return Response.json({ features: [{ geometry: { coordinates: [13.41, 52.52] }, properties: { name: 'Alexanderplatz', city: 'Berlin', country: 'Germany', osm_value: 'square' } }] });
  throw new Error(`unexpected fetch ${u}`);
};

// ---------- Tiny client over the Worker ----------
// The app's static files, as far as the Worker reads them: the construction road tiles.
const ASSETS = {
  async fetch(req) {
    if (new URL(req.url).pathname === '/cameras.json' && cameras) return Response.json({ cameras });
    const name = new URL(req.url).pathname.replace('/construction/', '');
    const key = construction && `${Math.floor(construction[0][0] / 0.05)}_${Math.floor(construction[0][1] / 0.05)}`;
    if (name === 'index.json') return Response.json({ tiles: key ? [key] : [] });
    if (construction && name === `${key}.json`) return Response.json([construction]);
    return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
  },
};
const env = { DB: createD1(), ASSETS, ROUTING_URL: 'https://routing.test/route', GEOCODER_URL: 'https://geo.test' };

let nextDevice = 0;
function client(device) {
  let cookie = '';
  // The app checks in on launch and sends its device id with every request; clients without an explicit device
  // do the same, so they get a fresh id and check in before their first gated call.
  const auto = device === undefined;
  if (auto) device = `test-device-${++nextDevice}`;
  const raw = async (method, path, body) => {
    const headers = { 'x-a2b-device': device };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await worker.fetch(new Request(`https://a2b.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json(), cookie: set };
  };
  return async (method, path, body) => {
    // Before every gated call: tables are wiped between tests, and the app itself checks in on launch.
    if (auto && needsSpot(method, path)) await raw('POST', '/api/presence');
    return raw(method, path, body);
  };
}

// Search, routing, reverse and parking need a checked-in spot; feedback needs only a valid device id (it stays
// open even when A2B is full). Everything else (accounts, places, reports, trips) doesn't.
function needsSpot(method, path) {
  if (path === '/api/presence') return false;
  if (method === 'GET' && (path.startsWith('/api/search') || path.startsWith('/api/reverse') || path.startsWith('/api/parking') || path.startsWith('/api/fuel'))) return true;
  return method === 'POST' && (path === '/api/route' || path === '/api/transit');
}

let alice, bob;
before(async () => {
  alice = client();
  bob = client();
});

// ---------- Pure helpers ----------
test('passwords hash and verify', async () => {
  const { hash, salt } = await hashPassword('correct horse');
  assert.ok(await verifyPassword('correct horse', hash, salt));
  assert.ok(!(await verifyPassword('wrong horse', hash, salt)));
  assert.equal(normalizeEmail('  Me@Example.COM '), 'me@example.com');
  assert.equal(normalizeEmail('nope'), null);
});

test('report lifetimes and removal rules', () => {
  const now = 1_000_000;
  const life = REPORT_TYPES.police.life * 60_000;
  assert.equal(extendedExpiry('police', now + life, now), now + life * 1.25);
  assert.equal(extendedExpiry('police', now + life * 3, now), now + life * 2, 'capped at two lifetimes');
  assert.ok(!shouldRemove({ still: 0, gone: 1 }));
  assert.ok(shouldRemove({ still: 0, gone: 2 }));
  assert.ok(!shouldRemove({ still: 2, gone: 3 }));
});

test('route requests carry avoid options, heading and closures', () => {
  const body = buildRouteRequest({ from: [1, 2], to: [3, 4], avoid: { tolls: true, highways: true }, heading: 91.6, exclude: [[5, 6]], units: 'imperial' });
  assert.equal(body.costing_options.auto.use_tolls, 0);
  assert.equal(body.costing_options.auto.use_highways, 0);
  assert.equal(body.locations[0].heading, 92);
  assert.deepEqual(body.exclude_locations, [{ lat: 6, lon: 5 }]);
  assert.equal(body.units, 'miles');
});

test('walking routes ask Valhalla for a pedestrian route', () => {
  const body = buildRouteRequest({ from: [1, 2], to: [3, 4], travel: 'walk', avoid: { tolls: true } });
  assert.equal(body.costing, 'pedestrian');
  assert.equal(body.costing_options.auto, undefined, 'no car options on foot');
  assert.equal(buildRouteRequest({ from: [1, 2], to: [3, 4] }).costing, 'auto', 'driving stays the default');
});

test('turn lanes keep only junctions with a lane to follow', () => {
  assert.deepEqual(lanes([{ directions: 8, active: 8 }, { directions: 66 }]), [{ d: 8, use: 8 }, { d: 66, use: 0 }]);
  assert.deepEqual(lanes([{ directions: 2, valid: 2 }, { directions: 64, active: 64 }]), [{ d: 2, use: 2 }, { d: 64, use: 64 }]);
  assert.equal(lanes([{ directions: 2 }, { directions: 2 }]), null, 'no lane marked: nothing to show');
  assert.equal(lanes([{ directions: 2, active: 2 }]), null, 'a single lane is not guidance');
  assert.equal(lanes(undefined), null);
  assert.equal(buildRouteRequest({ from: [1, 2], to: [3, 4] }).turn_lanes, true);
});

test('search results get a readable name and address', () => {
  const p = photonToPlace({ geometry: { coordinates: [1, 2] }, properties: { street: 'Main St', housenumber: '5', city: 'Springfield', country: 'USA' } });
  assert.deepEqual(p, { name: 'Main St 5', address: 'Springfield, USA', lat: 2, lng: 1, category: 'place' });
});

// ---------- Worker routes ----------
test('sign up, log in, sessions', async () => {
  let r = await alice('POST', '/api/auth/signup', { email: 'alice@test.com', password: 'password1', name: 'Alice' });
  assert.equal(r.status, 201);
  assert.match(r.cookie, /HttpOnly; SameSite=Lax/);
  assert.match(r.cookie, /Secure/);
  r = await alice('GET', '/api/me');
  assert.equal(r.body.user.name, 'Alice');

  assert.equal((await bob('POST', '/api/auth/signup', { email: 'alice@test.com', password: 'password1' })).status, 409);
  assert.equal((await bob('POST', '/api/auth/signup', { email: 'bob@test.com', password: 'short' })).status, 400);
  assert.equal((await bob('POST', '/api/auth/signup', { email: 'bob@test.com', password: 'password2', name: 'Bob' })).status, 201);
  assert.equal((await client()('POST', '/api/auth/login', { email: 'bob@test.com', password: 'nope-nope' })).status, 401);

  const carol = client();
  assert.equal((await carol('POST', '/api/auth/login', { email: 'BOB@test.com', password: 'password2' })).status, 200);
  assert.equal((await carol('GET', '/api/me')).body.user.name, 'Bob');
  await carol('POST', '/api/auth/logout', {});
  assert.equal((await carol('GET', '/api/me')).body.user, null);
});

test('repeated wrong passwords are throttled', async () => {
  const c = client();
  await c('POST', '/api/auth/signup', { email: 'dave@test.com', password: 'password4', name: 'Dave' });
  for (let i = 0; i < 8; i++) assert.equal((await c('POST', '/api/auth/login', { email: 'dave@test.com', password: 'guess' + i })).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { email: 'dave@test.com', password: 'password4' })).status, 429);
  await worker.scheduled({}, env); // housekeeping only clears failures older than the window
  assert.equal((await c('POST', '/api/auth/login', { email: 'dave@test.com', password: 'password4' })).status, 429);
});

test('JSON is required for writes (blocks cross-site form posts)', async () => {
  const res = await worker.fetch(new Request('https://a2b.test/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a&password=b' }), env);
  assert.equal(res.status, 415);
});

test('profile: home, work and settings', async () => {
  const r = await alice('PATCH', '/api/me', { home: { name: 'Home', address: '1 Road', lat: 52.5, lng: 13.4 }, settings: { units: 'imperial', voice: false, bogus: 1, theme: 'purple' } });
  assert.deepEqual(r.body.user.home, { name: 'Home', address: '1 Road', lat: 52.5, lng: 13.4 });
  assert.deepEqual(r.body.user.settings, { units: 'imperial', voice: false });
  assert.equal((await alice('PATCH', '/api/me', { password: 'newpassword', current_password: 'wrong' })).status, 403);
});

test('saved and recent places', async () => {
  await alice('POST', '/api/places', { kind: 'recent', name: 'Cafe', lat: 52.51, lng: 13.41 });
  await alice('POST', '/api/places', { kind: 'recent', name: 'Cafe again', lat: 52.51, lng: 13.41 });
  const saved = await alice('POST', '/api/places', { kind: 'saved', name: 'Gym', lat: 52.49, lng: 13.39 });
  let r = await alice('GET', '/api/places');
  assert.equal(r.body.recent.length, 1, 'same spot is merged');
  assert.equal(r.body.recent[0].name, 'Cafe again');
  assert.equal(r.body.saved[0].name, 'Gym');
  await alice('PATCH', `/api/places/${saved.body.place.id}`, { name: 'My gym' });
  assert.equal((await bob('DELETE', `/api/places/${saved.body.place.id}`)).status, 200);
  r = await alice('GET', '/api/places');
  assert.equal(r.body.saved[0].name, 'My gym', "Bob can't delete Alice's place");
  assert.equal((await client()('GET', '/api/places')).status, 401);
});

test('reports: create, merge, thank, dismiss', async () => {
  assert.equal((await client()('POST', '/api/reports', { type: 'police', lat: 52.505, lng: 13.4 })).status, 401);
  assert.equal((await alice('POST', '/api/reports', { type: 'unicorn', lat: 52.505, lng: 13.4 })).status, 400);

  const made = await alice('POST', '/api/reports', { type: 'police', subtype: 'hidden', lat: 52.505, lng: 13.4, comment: '  behind the bridge ' });
  assert.equal(made.status, 201);
  assert.equal(made.body.points, REPORT_TYPES.police.points);
  assert.equal(made.body.report.comment, 'behind the bridge');
  const id = made.body.report.id;

  // Bob reports the same thing 50 m away: it thanks Alice instead of adding a pin (a duplicate no longer
  // inflates "still there", which used to make reports nearly impossible to remove).
  const dup = await bob('POST', '/api/reports', { type: 'police', lat: 52.5054, lng: 13.4 });
  assert.equal(dup.body.merged, true);
  assert.equal(dup.body.report.id, id);
  assert.equal(dup.body.report.thanks, 1);
  assert.equal(dup.body.report.expires_at, made.body.report.expires_at, 'a duplicate thanks without extending the report');

  const thanked = await bob('POST', `/api/reports/${id}/vote`, { vote: 'thanks' });
  assert.equal(thanked.body.report.thanks, 1);
  assert.equal((await bob('POST', `/api/reports/${id}/vote`, { vote: 'thanks' })).body.report.thanks, 1, 'one thanks per driver');

  let list = await client()('GET', '/api/reports?bbox=13.3,52.4,13.5,52.6');
  assert.equal(list.body.reports.length, 1);
  assert.equal(list.body.reports[0].by, 'Alice');

  const me = await alice('GET', '/api/me');
  assert.equal(me.body.user.points, REPORT_TYPES.police.points + 1, 'reporter earns from the duplicate thanks');
  assert.deepEqual([me.body.stats.reports, me.body.stats.thanks], [1, 1]);

  // Alice says it's gone: her own report disappears.
  const gone = await alice('POST', `/api/reports/${id}/vote`, { vote: 'gone' });
  assert.equal(gone.body.removed, true);
  list = await client()('GET', '/api/reports?bbox=13.3,52.4,13.5,52.6');
  assert.equal(list.body.reports.length, 0);
});

test('routes avoid reported closures and account for reported traffic', async () => {
  await bob('POST', '/api/reports', { type: 'closure', lat: 52.52, lng: 13.43 }); // inside the search area, off the line
  const carol = client();
  await carol('POST', '/api/auth/signup', { email: 'carol@test.com', password: 'password3', name: 'Carol' });
  const jam = await carol('POST', '/api/reports', { type: 'traffic', subtype: 'heavy', lat: 52.5072, lng: 13.4001 });
  assert.equal(jam.status, 201);
  const r = await alice('POST', '/api/route', { from: [13.4, 52.5], to: [13.4, 52.509], avoid: { tolls: true } });
  assert.equal(r.status, 200);
  assert.equal(r.body.closures_avoided, 1);
  assert.equal(lastRouteBody.exclude_locations.length, 1);
  assert.equal(lastRouteBody.costing_options.auto.use_tolls, 0);
  assert.equal(r.body.routes.length, 2);
  // The full route passes the jam (+4 min); the shorter alternate ends before it.
  const full = r.body.routes.find((x) => x.coords.length === 21);
  assert.equal(full.delay, 240);
  assert.equal(full.duration, 120 + 240);
  assert.deepEqual(full.reports.map((x) => x.type), ['traffic']);
  assert.equal(r.body.routes[0].duration, 90, 'fastest first');
  assert.equal(full.steps[0].street, 'Test Street');
  assert.deepEqual(full.limits, [[0, 50], [10, 30], [15, null]]);
  assert.equal(full.shapes, undefined, 'encoded shapes stay on the server');
});

test('walking routes skip closures, reported traffic and the driving extras', async () => {
  const r = await alice('POST', '/api/route', { from: [13.4, 52.5], to: [13.4, 52.509], travel: 'walk' });
  assert.equal(r.status, 200);
  assert.equal(lastRouteBody.costing, 'pedestrian');
  assert.equal(lastRouteBody.exclude_locations.length, 0, 'road closures are for cars');
  assert.equal(r.body.closures_avoided, 0);
  for (const route of r.body.routes) {
    assert.equal(route.travel, 'walk');
    assert.equal(route.delay, 0, 'traffic reports add no time on foot');
    assert.deepEqual([route.tolls, route.cameras, route.reports, route.limits], [[], [], [], null]);
    assert.equal(route.shapes, undefined);
  }
});

test('live traffic from TomTom times each route and marks its jams, and is skipped when TomTom fails', async () => {
  env.TOMTOM_KEY = 'test-key';
  try {
    tomtomCalls = 0;
    const r = await alice('POST', '/api/route', { from: [13.4, 52.5], to: [13.4, 52.509] });
    assert.equal(tomtomCalls, 2, 'one lookup per route');
    const full = r.body.routes.find((x) => x.coords.length === 21);
    assert.equal(full.duration, 600);
    assert.equal(full.delay, 0, "drivers' jam reports aren't added on top of live traffic");
    assert.deepEqual(full.traffic, { delay: 300, jams: [{ from: 0.5, to: 0.75, level: 2, delay: 300 }] });
    assert.equal(full.steps.reduce((t, s) => t + s.time, 0), 600, 'the countdown while driving uses the live time');
    assert.equal(r.body.routes[0].duration, 100, 'fastest in traffic first');

    tomtomDown = true;
    const again = await alice('POST', '/api/route', { from: [13.4, 52.5], to: [13.4, 52.509] });
    const plain = again.body.routes.find((x) => x.coords.length === 21);
    assert.equal(plain.traffic, undefined);
    assert.equal(plain.duration, 120 + 240, 'back to the router and the reported jam');
  } finally {
    delete env.TOMTOM_KEY;
    tomtomDown = false;
  }
});

test("live traffic puts each jam's delay on the turns it covers", () => {
  const coords = Array.from({ length: 11 }, (_, i) => [0, i * 0.001]);
  const steps = [{ begin: 0, end: 5, time: 50 }, { begin: 5, end: 10, time: 50 }, { begin: 10, end: 10, time: 0 }];
  const r = applyTraffic({ coords, steps, duration: 100 }, { duration: 260, delay: 120, jams: [{ from: 0.6, to: 0.8, level: 3, delay: 120 }] });
  assert.equal(r.duration, 260);
  assert.equal(Math.round(r.steps[0].time), 70, 'the free-flowing part takes 140 s, spread by the router\'s times');
  assert.equal(Math.round(r.steps[1].time), 190, '70 s plus the whole jam');
  assert.equal(r.steps[2].time, 0);
});

test('routes list the fixed speed cameras on them, not the ones across a divided road', async () => {
  // LINE runs north from 52.5 to 52.509 along 13.4; 0.0003° of longitude is about 20 m here.
  cameras = [
    [13.4, 52.5045, 'AES Test Road - Northbound', 0, 60], // on the road
    [13.4003, 52.506, 'AES Test Road - Southbound', 180, 60], // 20 m off, for the other way: the other carriageway
    [13.4, 52.5072, 'AES Test Road (SB)', 180, null], // right on the road: named the other way, still warned about
    [13.4003, 52.508, null, null, null], // 20 m off, says nothing: the other carriageway
    [13.4003, 52.5085, 'AES Test Road (NB)', 0, null], // 20 m off, named for this way: beside the road
    [13.43, 52.52, 'Far away', null, 80],
  ];
  try {
    const r = await alice('POST', '/api/route', { from: [13.4, 52.5], to: [13.4, 52.509] });
    const full = r.body.routes.find((x) => x.coords.length === 21);
    assert.deepEqual(full.cameras.map((c) => [c.at, c.name, c.limit]), [[10, 'AES Test Road - Northbound', 60], [16, 'AES Test Road (SB)', null], [19, 'AES Test Road (NB)', null]]);
  } finally {
    cameras = null;
  }
  const none = await alice('POST', '/api/route', { from: [13.4, 52.5], to: [13.4, 52.509] });
  assert.deepEqual(none.body.routes[0].cameras, [], 'no list built: no cameras');
});

test('a camera mapped twice is warned about once', () => {
  const coords = Array.from({ length: 11 }, (_, i) => [0, i * 0.001]);
  assert.equal(camerasAlong(coords, [[0, 0.005, 'A', 0, 90], [0, 0.0052, 'A', 0, 90], [0, 0.008, 'B', 0, 90]]).length, 2);
});

test('which way a camera checks, from its name', () => {
  assert.equal(cameraBearing('AWAS ELITE Highway - Southbound'), 180);
  assert.equal(cameraBearing('KM 214.4 Lebuhraya PLUS, Alor Gajah (NB)'), 0);
  assert.equal(cameraBearing('AES Exit Chukai Eastbound'), 90);
  assert.equal(cameraBearing('Kamera AES Arah Utara'), 0);
  assert.equal(cameraBearing('AES KM D7.9 Sungai Besi (South)'), null);
  assert.equal(cameraBearing('AES Jalan Ipoh'), null);
  assert.equal(cameraBearing(null), null);
});

test('a stop splits the drive into legs but stays one route', async () => {
  const r = await alice('POST', '/api/route', { from: [13.4, 52.5], to: [13.4, 52.509], via: [[13.4, 52.5045]] });
  assert.equal(lastRouteBody.locations.length, 3);
  assert.equal(lastRouteBody.locations[1].type, 'break');
  assert.equal(lastRouteBody.alternates, 0);
  const [route] = r.body.routes;
  assert.equal(route.coords.length, 21, 'shared point between legs appears once');
  assert.equal(route.stops, 1);
  assert.deepEqual(route.steps.map((s) => s.type), ['depart', 'stop', 'depart', 'arrive']);
  assert.deepEqual(route.steps.map((s) => s.begin), [0, 10, 10, 20]);
  // The fake service answers every leg the same way; the second leg's runs are shifted by its offset (10).
  assert.deepEqual(route.limits, [[0, 50], [10, 30], [15, null], [10, 50], [20, 30], [25, null]]);
});

test('polylines round-trip', () => {
  assert.deepEqual(decodePolyline(encode(LINE)), LINE);
});

test('search looks nearby first, drops far-away results, and understands "name area"', async () => {
  const near = await client()('GET', '/api/search?q=nandos&lat=3.22&lng=101.47');
  assert.deepEqual(near.body.places.map((p) => p.lat), [3.071], 'the London one is dropped while one nearby exists');
  const combo = await client()('GET', '/api/search?q=nandos%20eco%20grandeur&lat=3.22&lng=101.47');
  assert.equal(combo.body.places[0].name, "Nando's");
  assert.equal(combo.body.places[0].lat, 3.225, 'the one in Eco Grandeur comes first');
});

test('search text matching ignores case, accents and apostrophes', async () => {
  const { matches, boxAround } = await import('../src/lib/providers.js');
  assert.ok(matches("Nando's", 'nandos'));
  assert.ok(matches('Café Mutiara', 'cafe'));
  assert.ok(!matches('McDonald\'s', 'nandos'));
  assert.deepEqual(boxAround([101.5, 3.2], 50).split(',').map(Number).map(Math.round), [101, 3, 102, 4]);
});

test('search and reverse geocoding', async () => {
  const s = await client()('GET', '/api/search?q=alex&lat=52.5&lng=13.4');
  assert.equal(s.body.places[0].name, 'Alexanderplatz');
  assert.equal((await client()('GET', '/api/search?q=a')).body.places.length, 0);
  const rev = await client()('GET', '/api/reverse?lat=52.5&lng=13.4');
  assert.equal(rev.body.place.name, 'Somewhere');
});

test('searching for parking lists the car parks around you, or around the place named', async () => {
  const near = await client()('GET', '/api/search?q=parking&lat=52.5&lng=13.4');
  assert.deepEqual(near.body.parking, { lng: 13.4, lat: 52.5, from: null }, 'searched around you');
  assert.deepEqual(near.body.places.map((p) => [p.name, p.address, p.category]), [
    ['Car park on Test Street', 'Free', 'parking'],
    ['Far Garage', 'Paid · Multi-storey · 400 spaces', 'parking'],
  ], 'nearest first, private ones left out');
  const there = await client()('GET', '/api/search?q=car%20park%20near%20alexanderplatz&lat=52.5&lng=13.4');
  assert.deepEqual(there.body.parking, { lng: 13.41, lat: 52.52, from: 'Alexanderplatz' });
  assert.match(there.body.places[0].address, /from Alexanderplatz$/);
  assert.equal((await client()('GET', '/api/search?q=alex&lat=52.5&lng=13.4')).body.parking, undefined, 'other searches as before');
});

test('which searches are for parking', () => {
  assert.equal(parkingQuery('parking'), '');
  assert.equal(parkingQuery('Car Park'), '');
  assert.equal(parkingQuery('parking klcc'), 'klcc');
  assert.equal(parkingQuery('mid valley parking'), 'mid valley');
  assert.equal(parkingQuery('carpark near Pavilion'), 'Pavilion');
  assert.equal(parkingQuery('tempat letak kereta di Sunway Pyramid'), 'Sunway Pyramid');
  assert.equal(parkingQuery('nandos'), null);
  assert.equal(parkingQuery('Parkson'), null);
});

test('shared drives: owner updates, anyone with the link can watch', async () => {
  const made = await alice('POST', '/api/trips', { destination: { name: 'Work', lat: 52.509, lng: 13.4 }, eta: Date.now() + 600_000, route: LINE });
  assert.equal(made.status, 201);
  const { token } = made.body;
  assert.match(made.body.url, new RegExp(`/drive/${token}$`));
  assert.equal((await bob('PATCH', `/api/trips/${token}`, { position: [13.4, 52.501] })).status, 404, 'only the driver can update');
  await alice('PATCH', `/api/trips/${token}`, { position: [13.4, 52.503], heading: 2 });
  const view = await client()('GET', `/api/trips/${token}`);
  assert.equal(view.body.driver, 'Alice');
  assert.deepEqual(view.body.position, { lat: 52.503, lng: 13.4, heading: 2 });
  assert.equal(view.body.route.length, 21);
  await alice('PATCH', `/api/trips/${token}`, { ended: true });
  assert.equal((await client()('GET', `/api/trips/${token}`)).body.ended, true);

  // Stopping sharing mid-drive: viewers keep the link but no longer see where the driver is.
  const second = await alice('POST', '/api/trips', { destination: { name: 'Gym', lat: 52.509, lng: 13.4 }, route: LINE });
  const t2 = second.body.token;
  await alice('PATCH', `/api/trips/${t2}`, { position: [13.4, 52.503], heading: 2 });
  await alice('PATCH', `/api/trips/${t2}`, { ended: 'stopped' });
  const stopped = (await client()('GET', `/api/trips/${t2}`)).body;
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.position, null);
  assert.deepEqual(stopped.route, []);
  assert.equal((await alice('PATCH', `/api/trips/${t2}`, { position: [13.4, 52.505] })).status, 404, 'no updates after stopping');
});

test('leaderboard and account deletion', async () => {
  const lb = await bob('GET', '/api/leaderboard');
  const pts = lb.body.leaders.map((l) => l.points);
  assert.deepEqual(pts, [...pts].sort((a, b) => b - a));
  assert.ok(lb.body.leaders.some((l) => l.me && l.name === 'Bob'));
  assert.equal((await bob('DELETE', '/api/me')).status, 200);
  assert.equal((await bob('GET', '/api/me')).body.user, null);
  assert.equal((await client()('POST', '/api/auth/login', { email: 'bob@test.com', password: 'password2' })).status, 401);
  assert.ok(!(await alice('GET', '/api/leaderboard')).body.leaders.some((l) => l.name === 'Bob'));
});

test('routes list toll plazas with name, car price and ways to pay, looked up once', async () => {
  const before = osmLookups;
  const r = await alice('POST', '/api/route', { from: [13.4, 52.5], to: [13.4, 52.509] });
  assert.equal(r.status, 200);
  const [full] = r.body.routes.filter((x) => x.coords.length === 21);
  assert.deepEqual(full.tolls, [{ at: 10, name: 'Plaza Tol Ujian', price: { amount: 2.1, currency: 'MYR' }, pay: ["Touch 'n Go", 'RFID', 'SmartTAG'] }]);
  const looked = osmLookups - before; // earlier route tests may already have cached this plaza
  await alice('POST', '/api/route', { from: [13.4, 52.5], to: [13.4, 52.509] });
  assert.equal(osmLookups - before, looked, 'a repeat request uses the cached plaza');
  assert.ok(osmLookups >= 1);
});

test('toll booth tags and booth points', async () => {
  const { describeBooth, tollIndexes } = await import('../src/lib/tolls.js');
  assert.deepEqual(describeBooth({ name: 'Plaza Tol A', 'name:en': 'A Toll Plaza', charge: '5.00 MYR', 'payment:cash': 'yes', 'payment:touchngo': 'no' }),
    { name: 'A Toll Plaza', price: { amount: 5, currency: 'MYR' }, pay: ['Cash'] });
  assert.deepEqual(describeBooth(null), {});
  const coords = Array.from({ length: 30 }, (_, i) => [13.4, 52.5 + 0.0009 * i]); // ~100 m apart
  const edges = [9, 10, 25].map((i) => ({ end_shape_index: i, end_node: { type: 'toll_booth' } })).concat([{ end_shape_index: 12, end_node: { type: 'gate' } }]);
  assert.deepEqual(tollIndexes(edges, coords), [9, 25], 'neighbouring booths are one plaza');
});

test('a new account takes over the places a guest saved on the device', async () => {
  const dan = client();
  await dan('POST', '/api/auth/signup', { email: 'dan@test.com', password: 'password4', name: 'Dan' });
  const guest = {
    saved: [
      { name: 'Gym', address: 'Jalan 1', lat: 3.1, lng: 101.6, used_at: 3000 },
      { name: 'Gym again', lat: 3.10001, lng: 101.60001, used_at: 2000 }, // same spot: kept once
      { name: 'Broken', lat: 'nope', lng: 200 }, // malformed: skipped, the rest still comes over
      { name: 'Park', lat: 3.2, lng: 101.7, used_at: 1000 },
    ],
    recent: Array.from({ length: 25 }, (_, i) => ({ name: `Stop ${i}`, lat: 3 + i * 0.01, lng: 101.5, used_at: 100000 - i })),
  };
  const r = await dan('POST', '/api/places/import', guest);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.saved.map((p) => p.name), ['Gym', 'Park']);
  assert.equal(r.body.recent.length, 20, 'recents keep their usual cap');
  assert.equal(r.body.recent[0].name, 'Stop 0', 'newest first, as on the device');
  const again = await dan('POST', '/api/places/import', guest);
  assert.equal(again.body.imported, 0, 'importing twice adds nothing');
  const list = await dan('GET', '/api/places');
  assert.deepEqual(list.body.saved.map((p) => p.name), ['Gym', 'Park']);
  assert.equal((await client()('POST', '/api/places/import', guest)).status, 401);
});

test('testing tools are flagged only for accounts in TESTER_EMAILS', async () => {
  const tess = client();
  await tess('POST', '/api/auth/signup', { email: 'Tess@Test.com', password: 'password5', name: 'Tess' });
  const other = client();
  await other('POST', '/api/auth/signup', { email: 'olly@test.com', password: 'password6', name: 'Olly' });
  assert.equal((await tess('GET', '/api/me')).body.tester, false, 'no secret set: nobody is a tester');
  env.TESTER_EMAILS = ' someone@else.com, tess@test.com ';
  try {
    assert.equal((await tess('GET', '/api/me')).body.tester, true);
    assert.equal((await other('GET', '/api/me')).body.tester, false);
    assert.equal((await client()('GET', '/api/me')).body.tester, undefined, 'guests get no flag');
  } finally {
    delete env.TESTER_EMAILS;
  }
});

test('feedback: anyone can send it, only the owner can read it and mark it done', async () => {
  const guest = client('feedback-guest-1');
  await guest('POST', '/api/presence');
  assert.equal((await guest('POST', '/api/feedback', { message: ' ' })).status, 400, 'empty feedback is refused');
  assert.equal((await guest('POST', '/api/feedback', { message: 'Route to KLCC took a closed road', app: 'abc123' })).status, 201);
  const fran = client('feedback-fran-1');
  await fran('POST', '/api/auth/signup', { email: 'fran@test.com', password: 'password8', name: 'Fran' });
  await fran('POST', '/api/presence');
  assert.equal((await fran('POST', '/api/feedback', { message: 'Love the speed camera alerts!' })).status, 201);

  const owner = client();
  await owner('POST', '/api/auth/signup', { email: 'inbox@test.com', password: 'password9', name: 'Owner' });
  assert.equal((await owner('GET', '/api/feedback')).status, 404, 'no testers set: nobody can read it');
  env.TESTER_EMAILS = 'inbox@test.com';
  try {
    assert.equal((await fran('GET', '/api/feedback')).status, 404, 'other accounts cannot read it');
    assert.equal((await guest('GET', '/api/feedback')).status, 404);
    const { feedback } = (await owner('GET', '/api/feedback')).body;
    assert.deepEqual(feedback.map((f) => [f.message, f.name, f.email, f.app]), [
      ['Love the speed camera alerts!', 'Fran', 'fran@test.com', null],
      ['Route to KLCC took a closed road', null, null, 'abc123'],
    ]);
    assert.equal((await fran('DELETE', `/api/feedback/${feedback[0].id}`)).status, 404, 'only the owner marks it done');
    await owner('DELETE', `/api/feedback/${feedback[0].id}`);
    assert.equal((await owner('GET', '/api/feedback')).body.feedback.length, 1);
  } finally {
    delete env.TESTER_EMAILS;
  }

  for (let i = 1; i < 10; i++) await guest('POST', '/api/feedback', { message: `Idea number ${i}` });
  const more = await guest('POST', '/api/feedback', { message: 'One more idea' });
  assert.equal(more.status, 429, 'ten a day per device');
});

test('an overloaded routing server reads as busy, not as no route', async () => {
  routingDown = true;
  try {
    const r = await alice('POST', '/api/route', { from: [13.4, 52.5], to: [13.4, 52.509] });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /busy/);
  } finally {
    routingDown = false;
  }
});

test('a road beside one under construction is driven around, unless the detour costs too much', async () => {
  construction = LINE.map(([lng, lat]) => [lng + 0.00015, lat]); // ~10 m east of the route, all the way
  try {
    let r = await alice('POST', '/api/route', { from: [13.4, 52.5], to: [13.4, 52.509] });
    assert.equal(r.status, 200);
    assert.ok(r.body.construction_avoided >= 1);
    assert.ok(r.body.routes.every((x) => x.coords[5][0] > 13.402 && !x.warning), 'took the detour');
    // Over half as long again isn't worth it: keep the direct route, and say what it passes.
    detourTime = 1000;
    r = await alice('POST', '/api/route', { from: [13.4, 52.5], to: [13.4, 52.509] });
    assert.equal(r.body.construction_avoided, 0);
    assert.equal(r.body.routes.find((x) => x.coords.length === 21).warning, 'construction');
  } finally {
    construction = null;
    detourTime = 150;
  }
});

test('a closure blocks the road it was reported on, and says so when it cannot be avoided', async () => {
  const dave = client();
  await dave('POST', '/api/auth/signup', { email: 'dave.closures@test.com', password: 'password4', name: 'Dave' });
  const rep = await dave('POST', '/api/reports', { type: 'closure', lat: 52.53, lng: 13.44, heading: 0 });
  assert.equal(rep.status, 201);
  assert.equal(lastLocateBody.locations[0].heading, 0, 'the heading picks the road');
  let r = await alice('POST', '/api/route', { from: [13.4, 52.5], to: [13.4, 52.509] });
  assert.ok(lastRouteBody.exclude_locations.some((l) => l.lon === 13.44 && Math.abs(l.lat - 52.531) < 1e-6), 'middle of the reported stretch');
  assert.equal(r.body.closures_ignored, false);
  failWithExcludes = true;
  try {
    r = await alice('POST', '/api/route', { from: [13.4, 52.5], to: [13.4, 52.509] });
    assert.equal(r.status, 200);
    assert.equal(r.body.closures_ignored, true);
    assert.equal(r.body.closures_avoided, 0);
  } finally {
    failWithExcludes = false;
  }
});

test('only so many devices get a spot at once, and accounts can take the ones guests cannot', async () => {
  Object.assign(env, { MAX_ACTIVE: '3', MAX_GUESTS: '1' });
  await env.DB.prepare('DELETE FROM presence').run(); // earlier tests checked their devices in
  try {
    const guestA = client('guest-device-a'), guestB = client('guest-device-b');
    let r = await guestA('POST', '/api/presence');
    assert.deepEqual(r.body, { admitted: true, active: 1, max: 3, waiting: 0 });
    r = await guestB('POST', '/api/presence');
    assert.deepEqual(r.body, { admitted: false, active: 1, max: 3, waiting: 1 }, 'the one guest spot is taken');
    assert.equal((await guestB('POST', '/api/route', { from: [13.4, 52.5], to: [13.4, 52.509] })).body.code, 'full');
    assert.equal((await guestA('POST', '/api/route', { from: [13.4, 52.5], to: [13.4, 52.509] })).status, 200);

    // Accounts get the spots guests can't take, until the app is full.
    const fay = client('fay-device-1'), gus = client('gus-device-1');
    await fay('POST', '/api/auth/signup', { email: 'fay@test.com', password: 'password5', name: 'Fay' });
    await gus('POST', '/api/auth/signup', { email: 'gus@test.com', password: 'password6', name: 'Gus' });
    assert.equal((await fay('POST', '/api/presence')).body.admitted, true);
    assert.equal((await guestA('POST', '/api/presence')).body.admitted, true, 'checking in again keeps the spot');
    r = await guestB('POST', '/api/presence'); // B signs up while waiting and gets in on its next check-in
    await guestB('POST', '/api/auth/signup', { email: 'hal@test.com', password: 'password7', name: 'Hal' });
    r = await guestB('POST', '/api/presence');
    assert.deepEqual(r.body, { admitted: true, active: 3, max: 3, waiting: 0 });
    r = await gus('POST', '/api/presence');
    assert.deepEqual(r.body, { admitted: false, active: 3, max: 3, waiting: 1 }, 'full, even for accounts');

    // An app without a device id (an older version) is told to update instead of slipping past the cap.
    const bare = await worker.fetch(
      new Request('https://a2b.test/api/route', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: [13.4, 52.5], to: [13.4, 52.509] }) }),
      env,
    );
    assert.equal(bare.status, 400);
    // And a device that never checked in waits like everyone else, even when guests are full.
    assert.equal((await client()('POST', '/api/route', { from: [13.4, 52.5], to: [13.4, 52.509] })).body.code, 'full');
  } finally {
    delete env.MAX_ACTIVE;
    delete env.MAX_GUESTS;
    await env.DB.prepare('DELETE FROM presence').run();
  }
});

test('the usage dashboard counts devices, busy moments and turn-aways, for the owner only', async () => {
  Object.assign(env, { MAX_ACTIVE: '1', MAX_GUESTS: '1', TESTER_EMAILS: 'owner@test.com' });
  try {
    const owner = client('owner-device-1');
    await owner('POST', '/api/auth/signup', { email: 'owner@test.com', password: 'password8', name: 'Owner' });
    for (const t of ['usage_daily', 'usage_devices', 'presence']) await env.DB.prepare(`DELETE FROM ${t}`).run(); // start the day clean
    const one = client('usage-guest-1'), two = client('usage-guest-2');
    assert.equal((await one('POST', '/api/presence')).body.admitted, true);
    assert.equal((await one('POST', '/api/route', { from: [13.4, 52.5], to: [13.4, 52.509] })).status, 200);
    assert.equal((await two('POST', '/api/presence')).body.admitted, false);
    await two('POST', '/api/presence'); // still waiting: the same device isn't counted twice

    assert.equal((await one('GET', '/api/stats')).status, 404, 'not for other drivers');
    const r = await owner('GET', '/api/stats');
    assert.equal(r.status, 200);
    const today = r.body.days.at(-1);
    assert.equal(r.body.days.length, 14);
    assert.deepEqual([today.devices, today.turned_away, today.peak_active, today.routes], [2, 1, 1, 1]);
    assert.equal(today.signups, 0, 'the owner signed up before the counts were cleared');
    assert.deepEqual([r.body.now.active, r.body.now.guests, r.body.now.waiting, r.body.now.max], [1, 1, 1, 1]);
  } finally {
    for (const k of ['MAX_ACTIVE', 'MAX_GUESTS', 'TESTER_EMAILS']) delete env[k];
    await env.DB.prepare('DELETE FROM presence').run();
  }
});

test('parking near a destination: nearest first, with what kind it is and whether it charges, never private', async () => {
  const r = await alice('GET', '/api/parking?lat=52.5&lng=13.4');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.parking.map((p) => p.name), ['Car park on Test Street', 'Far Garage']);
  const [near, far] = r.body.parking;
  assert.equal(near.fee, false);
  assert.ok(near.distance < 30);
  assert.deepEqual([far.kind, far.fee, far.capacity], ['Multi-storey', true, 400]);
});

// ---------- Hunt fixes (Oct 2026): one regression test per finding ----------

test('route, search and reverse need a device and a spot; feedback needs only a device', async () => {
  const route = (headers) =>
    worker.fetch(
      new Request('https://a2b.test/api/route', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ from: [13.4, 52.5], to: [13.4, 52.509] }) }),
      env,
    );
  assert.equal((await route({})).status, 400, 'no device id: told to update, not let through');
  assert.equal((await route({ 'x-a2b-device': 'stranger-device-1' })).status, 503, 'a device that never checked in waits');
  const s = await worker.fetch(new Request('https://a2b.test/api/search?q=alex&lat=52.5&lng=13.4', { headers: { 'x-a2b-device': 'stranger-device-1' } }), env);
  assert.equal(s.status, 503);
  const fb = await worker.fetch(
    new Request('https://a2b.test/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json', 'x-a2b-device': 'stranger-device-1' }, body: JSON.stringify({ message: 'hello there' }) }),
    env,
  );
  assert.equal(fb.status, 201, 'feedback stays open with just a device id, even with no spot');
  const fbBare = await worker.fetch(
    new Request('https://a2b.test/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello there' }) }),
    env,
  );
  assert.equal(fbBare.status, 400, 'feedback without any device id is still refused');
});

test('sign-ups need a device; a taken address gets the same neutral 409', async () => {
  const device = { 'x-a2b-device': 'signup-device-1' };
  const signup = (email, headers = { 'content-type': 'application/json', ...device }) =>
    worker.fetch(
      new Request('https://a2b.test/api/auth/signup', { method: 'POST', headers, body: JSON.stringify({ email, password: 'password1', name: 'Farmer' }) }),
      env,
    );
  assert.equal((await signup('nodevice@test.com', { 'content-type': 'application/json' })).status, 400);
  assert.equal((await signup('farmer0@test.com')).status, 201);
  // A taken address gets the same answer either way (plus a UNIQUE race guard in the endpoint).
  const dup = await signup('farmer0@test.com');
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).error, 'This email address is already registered.');
});

test('reports far from the driver are refused when their position is known', async () => {
  const rick = client();
  await rick('POST', '/api/auth/signup', { email: 'rick@test.com', password: 'password11', name: 'Rick' });
  const made = await rick('POST', '/api/trips', { destination: { name: 'Work', lat: 52.509, lng: 13.4 }, route: [] });
  await rick('PATCH', `/api/trips/${made.body.token}`, { position: [13.4, 52.501] });
  assert.equal((await rick('POST', '/api/reports', { type: 'police', lat: 52.502, lng: 13.401 })).status, 201, 'around the driver: goes through');
  assert.equal((await rick('POST', '/api/reports', { type: 'closure', lat: 1.29, lng: 103.85 })).status, 403, 'across the country: refused');
  const mort = client();
  await mort('POST', '/api/auth/signup', { email: 'mort@test.com', password: 'password12', name: 'Mort' });
  assert.equal((await mort('POST', '/api/reports', { type: 'police', lat: 1.29, lng: 103.85 })).status, 201, 'no known position: still goes through');
});

test('a long route looks for reports along the way, not just at its ends', () => {
  const inside = ([x, y], [w, s, e, n]) => x >= w && x <= e && y >= s && y <= n;
  const from = [0, 0], to = [0, 2];
  // A route that bows far east of its straight line: sampling only the ends would miss the middle.
  const route = { coords: [[0, 0], [0.5, 0.5], [1, 1], [0.5, 1.5], [0, 2]] };
  assert.ok(!inside([1, 1], [from[0] - 0.2, from[1] - 0.2, to[0] + 0.2, to[1] + 0.2]), 'the old ends-only box misses the bow');
  assert.ok(inside([1, 1], routeReportBox([route], [from, to])), 'sampling the driven roads covers it');
  assert.ok(inside([0, 1], corridorBox([from, to])), 'the straight-line corridor covers the middle before routing');
});

test('changing the password ends other sessions and rotates your own', async () => {
  const s1 = client(), s2 = client();
  await s1('POST', '/api/auth/signup', { email: 'pascal@test.com', password: 'password13', name: 'Pascal' });
  await s2('POST', '/api/auth/login', { email: 'pascal@test.com', password: 'password13' });
  assert.equal((await s2('GET', '/api/me')).body.user.name, 'Pascal');
  const changed = await s1('PATCH', '/api/me', { password: 'newpassword13', current_password: 'password13' });
  assert.equal(changed.status, 200);
  assert.ok(changed.cookie, 'a fresh session cookie for the device the password changed on');
  assert.equal((await s2('GET', '/api/me')).body.user, null, 'the other session is dead');
  assert.equal((await s1('GET', '/api/me')).body.user.name, 'Pascal', 'your own session keeps working');
});

test('sign-ins are throttled per address, not per network', async () => {
  const attempt = (email) =>
    worker.fetch(
      new Request('https://a2b.test/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'wrong-password' }) }),
      env,
    );
  try {
    // One address hammered: stops at 8 wrong passwords a quarter hour.
    for (let i = 0; i < 8; i++) assert.equal((await attempt('hammered@test.com')).status, 401);
    assert.equal((await attempt('hammered@test.com')).status, 429, 'wrong passwords for one account stop here');
    // A different address is unaffected: there is no shared per-network throttle.
    assert.equal((await attempt('someone-else@test.com')).status, 401);
  } finally {
    await env.DB.prepare("DELETE FROM login_failures WHERE email IN ('hammered@test.com', 'someone-else@test.com')").run();
  }
});

test('malformed bodies are 400s and odd langs do not break search', async () => {
  const post = (body) => worker.fetch(new Request('https://a2b.test/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body }), env);
  assert.equal((await post('null')).status, 400);
  assert.equal((await post('"just a string"')).status, 400);
  assert.equal((await post('[1,2]')).status, 400, 'arrays are not bodies');
  // A string where settings belong is ignored instead of blowing up (used to be a 500 from `in`).
  const c = client();
  const r = await c('POST', '/api/auth/signup', { email: 'settings@test.com', password: 'password14', name: 'Set', settings: 'nope' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.user.settings, {});
  const s = await c('GET', '/api/search?q=alex&lat=52.5&lng=13.4&lang=en%20US');
  assert.equal(s.status, 200, 'a space in lang no longer breaks the cache key');
});

test('a search stays a handful of upstream requests', async () => {
  let calls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async (...a) => {
    if (String(a[0]).includes('geo.budget')) calls++;
    return orig(...a);
  };
  try {
    const r = await searchPlaces({ GEOCODER_URL: 'https://geo.budget' }, { q: 'nandos eco grandeur', lat: 3.22, lng: 101.47, lang: 'en' });
    assert.equal(r.places[0].name, "Nando's");
    assert.ok(calls <= 6, `${calls} upstream calls`);
    // And with no budget left it makes none at all.
    calls = 0;
    const empty = await searchPlaces({ GEOCODER_URL: 'https://geo.budget' }, { q: 'nandos eco grandeur', lat: 3.22, lng: 101.47, lang: 'en' }, { left: 0 });
    assert.deepEqual(empty.places, []);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = orig;
  }
});

test('switching a vote replaces it instead of double counting', async () => {
  const voter = client();
  await voter('POST', '/api/auth/signup', { email: 'voter@test.com', password: 'password15', name: 'Voter' });
  // Carol's jam from the routing test is still on the map: confirm it, then change the mind.
  const jam = (await voter('GET', '/api/reports?bbox=13.3,52.4,13.5,52.6')).body.reports.find((r) => r.type === 'traffic');
  assert.ok(jam);
  let v = await voter('POST', `/api/reports/${jam.id}/vote`, { vote: 'still' });
  assert.equal(v.body.report.still, 1);
  v = await voter('POST', `/api/reports/${jam.id}/vote`, { vote: 'gone' });
  assert.deepEqual([v.body.report.still, v.body.report.gone], [0, 1], 'the still is replaced, not kept');
  assert.equal(v.body.removed, false, 'one gone does not remove it');
  v = await voter('POST', `/api/reports/${jam.id}/vote`, { vote: 'gone' });
  assert.deepEqual([v.body.report.still, v.body.report.gone], [0, 1], 'voting twice changes nothing');
});

test('a forgotten password is recovered with the code shown at sign-up', async () => {
  const c = client();
  const signup = await c('POST', '/api/auth/signup', { email: 'loss@test.com', password: 'password16', name: 'Loss' });
  assert.equal(signup.status, 201);
  assert.match(signup.body.recovery_code, /^[0-9a-f]{16}$/);
  const other = client();
  await other('POST', '/api/auth/login', { email: 'loss@test.com', password: 'password16' });
  // Unknown addresses get the same answer: the endpoint can't list accounts.
  assert.equal((await other('POST', '/api/auth/recover', { email: 'nobody@test.com', code: signup.body.recovery_code, password: 'newpassword16' })).status, 401);
  assert.equal((await other('POST', '/api/auth/recover', { email: 'loss@test.com', code: 'wrongcode', password: 'newpassword16' })).status, 401);
  assert.equal((await other('POST', '/api/auth/recover', { email: 'loss@test.com', code: signup.body.recovery_code, password: 'newpassword16' })).status, 200);
  assert.equal((await c('GET', '/api/me')).body.user, null, 'recovery signs every device out');
  assert.equal((await other('POST', '/api/auth/login', { email: 'loss@test.com', password: 'newpassword16' })).status, 200, 'the new password works');
  assert.equal((await other('POST', '/api/auth/recover', { email: 'loss@test.com', code: signup.body.recovery_code, password: 'anotherpassword16' })).status, 401, 'a code works once');
  // No expiry: a code from sign-up day still works months later.
  const old = client();
  const signupOld = await old('POST', '/api/auth/signup', { email: 'oldcode@test.com', password: 'password18', name: 'Old' });
  const oldId = (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind('oldcode@test.com').first()).id;
  await env.DB.prepare('UPDATE recovery_codes SET created_at = ? WHERE user_id = ?').bind(Date.now() - 90 * 86400_000, oldId).run();
  assert.equal((await old('POST', '/api/auth/recover', { email: 'oldcode@test.com', code: signupOld.body.recovery_code, password: 'newpassword18' })).status, 200, 'a 90-day-old code still resets the password');
});

test('sessions slide while driving and can be revoked one by one', async () => {
  const a = client('session-dev-a'), b = client('session-dev-b');
  await a('POST', '/api/auth/signup', { email: 'sess@test.com', password: 'password17', name: 'Sess' });
  await b('POST', '/api/auth/login', { email: 'sess@test.com', password: 'password17' });
  const me = await a('GET', '/api/me');
  assert.equal(me.body.sessions.length, 2);
  assert.ok(me.body.sessions.some((s) => s.current && s.device === 'session-dev-a'));
  const other = me.body.sessions.find((s) => !s.current);
  assert.equal(other.device, 'session-dev-b');
  // Age the session almost out: the next request slides it forward again.
  await env.DB.prepare('UPDATE sessions SET expires_at = ?, created_at = ?, last_seen = ? WHERE substr(token_hash, 1, 12) = ?')
    .bind(Date.now() + 1000, Date.now(), Date.now(), other.id)
    .run();
  await b('GET', '/api/me');
  const after = (await env.DB.prepare('SELECT expires_at FROM sessions WHERE substr(token_hash, 1, 12) = ?').bind(other.id).first()).expires_at;
  assert.ok(after > Date.now() + 3600_000, 'slid forward instead of expiring');
  assert.equal((await a('DELETE', `/api/me/sessions/${other.id}`)).status, 200);
  assert.equal((await b('GET', '/api/me')).body.user, null, 'that device is signed out');
  assert.equal((await a('DELETE', '/api/me/sessions/deadbeefcafe')).status, 404);
});

test('presence check-ins admit new devices without a per-network throttle', async () => {
  const check = (d) => worker.fetch(new Request('https://a2b.test/api/presence', { method: 'POST', headers: { 'x-a2b-device': d } }), env);
  try {
    for (let i = 0; i < 5; i++) assert.equal((await check(`fresh-device-${i}`)).status, 200);
  } finally {
    await env.DB.prepare('DELETE FROM presence').run();
  }
});

test('this week’s pump prices, for the fuel cost on routes', async () => {
  const r = await client()('GET', '/api/fuel');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.prices, { date: '2026-10-22', ron95: 4.32, ron95_budi95: 1.99, ron97: 4.8, diesel: 5.07, diesel_eastmsia: 2.15 });
});

test('trips by train need a spot, a start and a destination', async () => {
  assert.equal((await client('transit-no-spot')('POST', '/api/transit', { from: [101.6865, 3.134], to: [101.7116, 3.1579] })).status, 503);
  const c = client();
  assert.equal((await c('POST', '/api/transit', { from: [101.6865, 3.134] })).status, 400);
  const res = await c('POST', '/api/transit', { from: [101.6865, 3.134], to: [101.7116, 3.1579] });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.trips));
  assert.equal(typeof res.body.walk, 'number');
  for (const trip of res.body.trips) assert.ok(trip.legs.some((l) => l.mode === 'train') && trip.arrive > trip.depart);
});
