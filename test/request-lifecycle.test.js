// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { RequestScope, boundedRequest } from '../public/request-lifecycle.js';
import { canAutoStartRoute } from '../public/route-preview.js';
import { api } from '../public/core.js';

const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const route = (name) => ({ name, duration: 60, distance: 100, coords: [[101, 3], [101.01, 3.01]], steps: [] });
const response = (name, closures = false) => ({ routes: [route(name)], closures_ignored: closures });
const place = { name: 'Same destination', lng: 101.01, lat: 3.01 };

// Execute the production orchestration functions, with only DOM/map/transport side effects replaced.
// The transport deliberately ignores abort, so these tests exercise ownership rather than lucky timing.
function app() {
  const elements = new Map(), requests = [], timers = [], messages = [];
  const $ = (id) => {
    if (!elements.has(id)) {
      const classes = new Set(['hidden']);
      elements.set(id, { innerHTML: '', textContent: '', disabled: false, value: '', classList: {
        add: (...xs) => xs.forEach((x) => classes.add(x)), remove: (...xs) => xs.forEach((x) => classes.delete(x)),
        contains: (x) => classes.has(x), toggle: (x, yes) => yes ? classes.add(x) : classes.delete(x),
      } });
    }
    return elements.get(id);
  };
  class Marker { setLngLat() { return this; } addTo() { return this; } setRotation() { return this; } remove() {} }
  const context = vm.createContext({
    $, RequestScope, canAutoStartRoute, structuredClone, AbortController, Date, Promise, Set,
    ROUTE_REQUEST_MS: 30_000, REROUTE_GAP_MS: 8000, REPLAN_MS: 20_000, AUTO_GO_S: 8,
    previewRequests: new RequestScope(), rerouteRequests: new RequestScope(), rideRequests: new RequestScope(), laterRequests: new RequestScope(),
    mode: 'browse', travel: 'drive', dest: null, origin: null, routes: [], selected: 0, transit: null, tripId: 0,
    state: { pos: { lngLat: [101, 3] }, settings: { units: 'metric', avoid_tolls: false, avoid_highways: false, avoid_ferries: false } },
    navigator: { onLine: true, language: 'en' }, document: { hidden: false, body: $('body') },
    map: { getCenter: () => ({ toArray: () => [101, 3] }), easeTo() {} },
    maplibregl: { Marker, LngLatBounds: class { extend() {} isEmpty() { return true; } } },
    destMarker: null, dropMarker: null, originMarker: null, carMarker: new Marker(), routeLabels: [],
    DEST_PIN: '', resuming: null, laterTimer: null, laterTrip: null, laterMode: 'leave',
    lastReroute: 0, replanAt: 0, replanNoted: false, stops: [], nav: null, live: null, sim: null,
    trail: [], offTrail: [], tollsSpoken: new Set(), camerasWarned: new Set(), alerted: new Map(),
    driveStarted: 0, share: null, wakeLock: null, parkingFor: null, onRoute: [], follow: true,
    tripSheet: { set() {} }, local: { get: () => false }, guide: null,
    // GPS quality/estimate behavior is tested by M1; these ownership scenarios assume a fresh real fix.
    isFreshGpsFix: () => true,
    currentGpsUsable: () => true,
    tunnelEpisode: { active: false, exhausted: false, suspended: false, suspend() { this.suspended = true; } },
    Navigator: class { constructor(r, options) { this.route = r; this.options = options; this.spoken = new Set(); } },
    TrainGuide: class { constructor(trip) { this.trip = trip; } }, rideNow: () => Date.now(), rideTick: () => {},
    api: (path, options) => { const d = deferred(); requests.push({ ...d, path, ...options }); return d.promise; },
    setInterval: (fn) => { const timer = { fn }; timers.push(timer); return timer; },
    clearInterval: (timer) => { if (timer) timer.cancelled = true; }, clearTimeout,
    cumulative: () => [0, 100], el: () => ({}), movingNow: () => null, sheetPadding: () => ({}),
    routeNote: (rs) => rs.closuresIgnored ? 'Closure warning' : '',
    showRouteLoading: (node, message) => { node.textContent = message; }, // M1 safe text-rendering integration
    toast: (text) => messages.push(text), speak: (text) => messages.push(text),
    addPlace: async () => {}, formatClock: () => '12:00', formatDuration: () => '1 min',
  });
  for (const name of ['armBack', 'hideContextMenu', 'renderTravel', 'updateSaveStar', 'renderFrom', 'drawTransit', 'drawRoutes',
    'renderRouteOptions', 'renderPeekSummary', 'fitRoutes', 'renderTransit', 'resumeStart', 'fitTo', 'syncVehicle', 'schedulePois',
    'drawPois', 'drawTrail', 'startTunnelWatch', 'renderStopMenu', 'saveTrip', 'renderSearchHome', 'computeOnRoute', 'loadReports',
    'requestWakeLock', 'driveTick', 'driveCamera', 'stopSimulation', 'stopTunnelWatch', 'discardProbeBuffer', 'clearParkingPins',
    'forgetTrip', 'updateCheckpoint', 'keepTrail', 'pushShare', 'noteReplan',
    'drawDriveLine', 'drawManeuverArrow', 'renderTunnelStatus']) context[name] = () => {};
  const functions = ['openPreview', 'showTransit', 'routeRequest', 'requestRoutes', 'reroute', 'resetTripRequests', 'backToBrowse',
    'startDrive', 'endDrive', 'cancelLaterRequests', 'resetTravel', 'replanRide', 'updateLaterTrains', 'closeScreen'];
  for (const name of functions) {
    const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.notEqual(start, -1, name);
    vm.runInContext(source.slice(start, source.indexOf('\n}\n', start) + 2), context);
  }
  const autoStart = source.indexOf('const autoGo =');
  vm.runInContext(source.slice(autoStart, source.indexOf('\n})();', autoStart) + 6) + '\nglobalThis.autoGo = autoGo;', context);
  return { c: context, $, requests, timers, messages };
}

test('same destination: B from a new origin/preferences wins before A, including countdown ownership', async () => {
  const { c, $, requests, timers } = app();
  const a = c.openPreview(place);
  assert.equal(requests[0].body.avoid.tolls, false);
  c.state.pos.lngLat = [102, 4];
  c.state.settings.avoid_tolls = true;
  const b = c.openPreview(place);
  assert.equal(requests[0].signal.aborted, true);
  assert.deepEqual(Array.from(requests[0].body.from), [101, 3]);
  assert.deepEqual(Array.from(requests[1].body.from), [102, 4]);
  assert.equal(requests[1].body.avoid.tolls, true);
  requests[1].resolve(response('B'));
  await b;
  const bTimer = timers.at(-1);
  requests[0].resolve(response('A'));
  await a;
  assert.equal(c.routes[0].name, 'B');
  assert.equal(timers.at(-1), bTimer);
  assert.equal($('btn-go').disabled, false);
  const next = c.openPreview(place);
  bTimer.fn(); // simulate a tick already queued before clearInterval
  assert.equal(c.mode, 'preview');
  assert.equal($('btn-go').disabled, true);
  requests[2].resolve(response('C', true));
  await next;
  assert.equal(timers.length, 1, 'closure fallback never starts a countdown');
  assert.equal($('route-status').textContent, 'Closure warning');
  const d = c.openPreview(place);
  requests[3].resolve(response('D'));
  await d;
  const dTimer = timers.at(-1);
  bTimer.fn();
  assert.equal(dTimer.cancelled, undefined, 'a queued old tick cannot stop the new countdown');
});

test('old transit failure cannot erase a new drive preview or resume its saved trip', async () => {
  const { c, $, requests } = app();
  c.travel = 'transit';
  const a = c.openPreview(place);
  c.travel = 'drive';
  const b = c.openPreview(place);
  requests[1].resolve(response('drive B'));
  await b;
  requests[0].reject(new Error('old train failure'));
  await a;
  assert.equal(c.routes[0].name, 'drive B');
  assert.notEqual($('route-status').textContent, 'old train failure');
  assert.equal($('btn-go').disabled, false);
});

test('drive A reroute resolves after end/start B: no route, speech, error or lock leaks', async () => {
  const { c, requests, messages } = app();
  c.mode = 'preview'; c.routes = [route('drive A')]; c.dest = place;
  c.startDrive();
  const a = c.reroute({ lngLat: [101, 3], heading: 20 }, { force: true });
  await c.endDrive(false);
  c.mode = 'preview'; c.routes = [route('drive B')]; c.dest = place;
  c.startDrive();
  const b = c.reroute({ lngLat: [102, 4] }, { force: true });
  const before = messages.length;
  requests[0].resolve(response('stale reroute A'));
  await a;
  assert.equal(c.nav.route.name, 'drive B');
  assert.equal(messages.length, before);
  assert.equal(c.rerouteRequests.pending, true, 'A finally must not release B lock');
  requests[1].resolve(response('reroute B'));
  await b;
  assert.equal(c.nav.route.name, 'reroute B');
  assert.equal(c.rerouteRequests.pending, false);
});

test('superseded reroute errors stay silent; current timeout releases its lock', async () => {
  const { c, requests, messages } = app();
  c.mode = 'preview'; c.routes = [route('drive')]; c.dest = place;
  c.startDrive();
  const a = c.reroute({ lngLat: [101, 3] }, { force: true });
  const b = c.reroute({ lngLat: [102, 4] }, { force: true });
  const before = messages.length;
  requests[0].reject(new Error('old error'));
  await a;
  assert.equal(messages.length, before);
  assert.equal(c.rerouteRequests.pending, true);
  requests[1].reject(Object.assign(new Error('Timed out'), { name: 'TimeoutError', status: 408 }));
  await b;
  assert.equal(c.rerouteRequests.pending, false);
  assert.equal(messages.at(-1), 'Timed out');
});

test('closing the preview invalidates both deferred success and error', async () => {
  for (const fail of [false, true]) {
    const { c, $, requests, timers } = app();
    const pending = c.openPreview(place);
    c.backToBrowse();
    const status = $('route-status').textContent;
    if (fail) requests[0].reject(new Error('obsolete error'));
    else requests[0].resolve(response('obsolete'));
    await pending;
    assert.equal(c.mode, 'browse');
    assert.equal(c.routes.length, 0);
    assert.equal($('route-status').textContent, status);
    assert.equal(timers.length, 0);
  }
});

test('train previews for the same destination keep only the newest origin result', async () => {
  const { c, requests } = app();
  c.travel = 'transit';
  const a = c.openPreview(place);
  c.origin = { name: 'New station', lng: 102, lat: 4 };
  const b = c.openPreview(place);
  requests[1].resolve({ trips: [{ name: 'train B', legs: [] }], reports: [{ id: 'current-line-report' }] });
  await b;
  requests[0].resolve({ trips: [{ name: 'train A', legs: [] }], reports: [{ id: 'obsolete-line-report' }] });
  await a;
  assert.equal(c.transit.trips[0].name, 'train B');
  assert.equal(c.transit.reports[0].id, 'current-line-report', 'train reports follow the winning preview');
  assert.deepEqual(Array.from(requests[1].body.from), [102, 4]);
});

test('closing Leave later cancels its train request and stale error cannot replace the result', async () => {
  const { c, $, requests } = app();
  c.mode = 'preview'; c.travel = 'transit'; c.dest = place; c.transit = { trips: [{ duration: 60 }] };
  $('later').classList.remove('hidden');
  $('later-time').value = '2026-10-29T12:00';
  const a = c.updateLaterTrains();
  c.closeScreen('later');
  const previous = $('later-result').textContent;
  requests[0].reject(new Error('old later error'));
  await a;
  assert.equal(requests[0].signal.aborted, true);
  assert.equal($('later-result').textContent, previous);
  assert.equal(c.laterRequests.pending, false);
  assert.equal(c.laterTrip, null);
});

test('ending a train trip invalidates its replan without releasing the next trip request', async () => {
  const { c, requests } = app();
  c.mode = 'ride'; c.dest = place; c.guide = { trip: { name: 'train A' } };
  const a = c.replanRide();
  c.resetTripRequests(); // the same trip boundary used by endRide/startRide
  c.guide = { trip: { name: 'train B' } };
  const b = c.replanRide();
  requests[0].resolve({ trips: [{ name: 'old replan A' }] });
  await a;
  assert.equal(c.guide.trip.name, 'train B');
  assert.equal(c.rideRequests.pending, true);
  requests[1].resolve({ trips: [{ name: 'new replan B' }] });
  await b;
  assert.equal(c.guide.trip.name, 'new replan B');
  assert.equal(c.rideRequests.pending, false);
});

test('API cancellation and body deadlines release callers even when transport ignores abort', async (t) => {
  let sentSignal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    sentSignal = options.signal;
    return { ok: true, status: 200, json: () => new Promise(() => {}) };
  });
  await assert.rejects(api('/synthetic', { timeoutMs: 5 }), { name: 'TimeoutError', status: 408 });
  assert.equal(sentSignal.aborted, true);
  const controller = new AbortController();
  const cancelled = api('/synthetic', { signal: controller.signal, timeoutMs: 1000 });
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  await assert.rejects(boundedRequest(() => { throw new Error('must not run'); }, { signal: controller.signal }), { name: 'AbortError' });
});
