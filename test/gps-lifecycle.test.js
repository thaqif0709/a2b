// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Navigator } from '../public/nav.js';
import { shouldSend } from '../public/follow.js';
import { distance, bearing } from '../public/geo.js';
import { DeadReckoningEpisode, isFreshGpsFix, LOST_AFTER_MS, shouldEstimate, nearTunnel, pointAt } from '../public/dead-reckoning.js';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
// Run the real browser functions with a synthetic clock, GPS and DOM. No map servers or GPS hardware are used.
// Functions end at an unindented brace; fail loudly if a refactor moves them instead of testing a copied body.
function appFunction(name) {
  const match = app.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `app function ${name} exists`);
  return match[0];
}

function route(count = 301, stop = false) {
  const coords = Array.from({ length: count }, (_, i) => [101.6 + i * 0.001, 3.1]);
  const last = count - 1;
  const steps = [
    { type: 'depart', begin: 0, end: last, length: last * 111, time: last * 8, pre: 'Drive east.', alert: 'Drive east.' },
    { type: 'arrive', begin: last, end: last, length: 0, time: 0, pre: 'You have arrived.', alert: 'You will arrive.' },
  ];
  if (stop) steps.splice(1, 0, { type: 'stop', begin: 10, end: last, length: 1110, time: 80, pre: 'You have reached your stop.' });
  return { coords, steps };
}

function drive({ speed = 8, count, stop = false } = {}) {
  const clock = { now: 1_000_000 };
  const calls = { moves: [], shares: 0, probes: 0, patches: [], spoken: [], reroutes: 0, reached: [] };
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) {
      const classes = new Set(['hidden']);
      const span = { textContent: '' };
      nodes.set(id, { textContent: '', querySelector: () => span, classList: {
        add: (...items) => items.forEach((s) => classes.add(s)),
        remove: (...items) => items.forEach((s) => classes.delete(s)),
        contains: (s) => classes.has(s),
        toggle: (s, on) => on ? classes.add(s) : classes.delete(s),
      } });
    }
    return nodes.get(id);
  };
  const r = route(count, stop);
  const context = vm.createContext({
    Date: { now: () => clock.now }, setInterval: () => 1, clearInterval() {},
    DeadReckoningEpisode, isFreshGpsFix, LOST_AFTER_MS, shouldEstimate, nearTunnel, pointAt, distance, bearing, Navigator,
    tunnelEpisode: new DeadReckoningEpisode(), tunnelTimer: null, tunnelFixAt: 0, lastFixAccuracy: null, lastGoodSpeed: 0,
    mode: 'drive', sim: null, gpsBlocked: false, nav: new Navigator(r), live: null, travel: 'drive',
    state: { pos: null, settings: { units: 'metric' } }, local: { set() {} },
    share: { token: 'synthetic-trip' }, stops: stop ? [{ name: 'Test stop' }] : [], offTrail: [],
    carMarker: { _map: true }, map: { easeTo() {} }, document: { body: node('body') },
    dest: { name: 'Test destination' }, destMarker: null, driveStarted: clock.now, lastFixAt: 0,
    wakeLock: null, parkingFor: null, trail: [], onRoute: [], STILL_SPEED: 1,
    $: node, moveCar: (pose) => calls.moves.push(pose), updateSpeedo() {},
    noteProbeFix: () => calls.probes++, pushShare: () => calls.shares++,
    speak: (text) => calls.spoken.push(text), toast: (text) => calls.reached.push(text),
    reroute: () => calls.reroutes++, api: async (url, options) => calls.patches.push({ url, ...options }),
    formatDistance: (n) => `${n} m`, formatDuration: (n) => `${n} s`,
  });
  for (const name of ['renderBanner', 'renderEta', 'renderLimit', 'drawDriveLine', 'drawManeuverArrow',
    'checkTolls', 'checkCameras', 'checkAlerts', 'renderStopMenu', 'setOffrouteNote', 'stopSimulation',
    'discardProbeBuffer', 'clearParkingPins', 'renderShareMenu', 'forgetTrip', 'drawTrail',
    'backToBrowse', 'resetTravel', 'resetTripRequests', 'drawRoutes', 'updateCheckpoint']) context[name] = () => {};
  vm.runInContext(['onFix', 'estSpeed', 'handleFix', 'driveTick', 'tunnelAhead', 'currentGpsUsable', 'startTunnelWatch',
    'stopTunnelWatch', 'stopReckoning', 'renderTunnelStatus', 'tunnelTick', 'arrive', 'endDrive'].map(appFunction).join('\n'), context);
  const fix = (point = r.coords[0], extra = {}) => context.onFix({
    timestamp: clock.now,
    coords: { longitude: point[0], latitude: point[1], speed, heading: 90, accuracy: 10, ...extra },
  });
  context.startTunnelWatch();
  fix();
  return { context, clock, calls, node, route: r, fix, tick(seconds = 1) {
    for (let i = 0; i < seconds; i++) { clock.now += 1000; context.tunnelTick(); }
  } };
}

// Run the actual async reroute function; the API response is deferred so real fixes or an outage can happen
// while it is pending. The request-ownership stubs also allow this GPS fixture to run with the separate M2 fix.
function pendingReroute(d) {
  let resolve;
  let task = null;
  const result = new Promise((done) => { resolve = done; });
  Object.assign(d.context, {
    rerouting: false, lastReroute: 0, REROUTE_GAP_MS: 8000, navigator: { onLine: true }, tripId: 1,
    requestRoutes: () => result, keepTrail() {}, computeOnRoute() {}, loadReports() {}, startSimulation() {},
    routeRequest: (from, to, heading, stops) => ({ from, to, heading, stops, units: 'metric' }),
    rerouteRequests: {
      get pending() { return task !== null; },
      start(input) {
        task?.controller.abort();
        const controller = new AbortController();
        return task = { input, controller, signal: controller.signal };
      },
      owns: (candidate) => candidate === task,
      finish(candidate) { if (candidate === task) task = null; },
      cancel() { task?.controller.abort(); task = null; },
    },
  });
  vm.runInContext(appFunction('reroute'), d.context);
  return { promise: d.context.reroute(d.context.state.pos, { force: true }), resolve: (r) => resolve([r]) };
}

for (const speed of [8, 70]) test(`app timer cannot restart exhausted ${speed} m/s GPS estimates`, () => {
  const d = drive({ speed });
  let seconds = 0;
  while (!d.context.tunnelEpisode.exhausted && seconds < 100) { d.tick(); seconds++; }
  assert.equal(d.context.tunnelEpisode.exhausted, true);
  assert.ok(speed === 8 ? seconds === 92 : seconds < 90, `budget reached at ${seconds}s`);
  const along = d.context.live.along, updates = d.calls.moves.length;
  d.tick(180);
  assert.equal(d.calls.moves.length, updates, 'three more minutes produce no movement');
  assert.equal(d.context.live.along, along);
  assert.equal(d.node('dr-chip').classList.contains('hidden'), false);
  assert.equal(d.node('dr-chip').querySelector('span').textContent, 'Waiting for GPS');
  assert.equal(d.calls.shares, 1, 'only the initial real fix was shared');
  assert.equal(d.calls.probes, 1, 'estimates never enter traffic probes');
  assert.equal(d.calls.patches.length, 0, 'outage does not end the shared trip');

  d.fix(d.route.coords[1], { accuracy: 150 });
  d.context.handleFix({ lngLat: d.route.coords[1], accuracy: 10, speed, time: d.clock.now - 3000 });
  d.tick(5);
  assert.equal(d.calls.moves.length, updates, 'poor and stale fixes cannot restart the episode');
  assert.equal(d.context.tunnelEpisode.exhausted, true);
  d.fix(d.route.coords[1]);
  assert.equal(d.context.tunnelEpisode.exhausted, false);
  assert.equal(d.node('dr-chip').classList.contains('hidden'), true);
  const recovered = d.context.live.along;
  d.tick(2);
  assert.equal(d.context.live.along, recovered, 'wait for a new GPS gap');
  d.tick();
  assert.ok(d.context.live.along > recovered);
  assert.equal(d.node('dr-chip').querySelector('span').textContent, 'Estimating your position');
  d.context.stopTunnelWatch();
  assert.equal(d.context.tunnelEpisode.active, false);
  assert.equal(d.node('dr-chip').classList.contains('hidden'), true);
});

test('app estimated destination cannot announce arrival, finish the drive or end sharing; real GPS can', async () => {
  const d = drive({ speed: 20, count: 3 });
  d.tick(35);
  assert.equal(d.context.live.remaining, 0, 'estimate reaches the route endpoint');
  assert.equal(d.context.nav.arrived, false);
  assert.equal(d.context.mode, 'drive');
  assert.ok(d.context.share);
  assert.equal(d.calls.patches.length, 0);
  assert.equal(d.calls.shares, 1);
  assert.equal(d.calls.spoken.some((s) => /arrived/.test(s)), false);
  d.tick(100);
  assert.equal(d.context.mode, 'drive', 'waiting beyond exhaustion also keeps the trip open');
  d.fix(d.route.coords[0]);
  assert.equal(d.context.nav.arrived, false, 'a real fix before destination does not inherit estimated arrival');
  d.clock.now += 1000;
  d.fix(d.route.coords.at(-1), { speed: 0 });
  await Promise.resolve();
  assert.equal(d.context.mode, 'browse');
  assert.equal(d.context.share, null);
  assert.equal(d.calls.patches.length, 1);
  assert.equal(d.calls.patches[0].body.ended, 'arrived');
  assert.equal(d.node('arrived').classList.contains('hidden'), false);
  assert.ok(d.calls.spoken.some((s) => /arrived/.test(s)));
});

test('app estimated progress cannot consume a stop or reroute', () => {
  const d = drive({ speed: 70, count: 30, stop: true });
  d.tick(30);
  assert.ok(d.context.live.stepIndex >= 1);
  assert.equal(d.context.stops.length, 1);
  assert.equal(d.calls.reached.length, 0);
  assert.equal(d.calls.reroutes, 0);
  d.fix([101.612, 3.11]);
  assert.ok(d.context.live.offBy > 1000);
  assert.equal(d.context.live.offRoute, false, 'the first off-route fix has not yet triggered a reroute');
  assert.equal(d.context.stops.length, 1, 'its stale estimated step cannot confirm the stop');
  assert.equal(d.calls.reached.length, 0);
  d.clock.now += 1000;
  d.fix(d.route.coords[12]);
  assert.equal(d.context.stops.length, 0);
  assert.deepEqual(d.calls.reached, ['Reached Test stop']);
});

test('fresh stationary onFix measurements recover GPS even when movement time is old', () => {
  const d = drive();
  d.tick(95);
  const oldTime = d.context.state.pos.time;
  d.fix(d.route.coords[0], { speed: 0 });
  assert.equal(d.context.state.pos.time, oldTime);
  assert.equal(d.context.state.pos.gpsTime, d.clock.now);
  assert.equal(d.context.tunnelEpisode.exhausted, false);
  d.tick(100);
  assert.equal(d.context.tunnelEpisode.active, false, 'stationary car stays still');
});

for (const exhausted of [false, true]) test(`reroute ${exhausted ? 'after exhaustion' : 'during an estimate'} waits for a new fix without renewing the outage budget`, async () => {
  const d = drive({ speed: 20 });
  d.clock.now += 1000;
  d.fix(d.route.coords[50]); // already 5.5 km into the old route
  const request = pendingReroute(d);
  d.tick(exhausted ? 100 : 10);
  assert.ok(d.context.live.along > 5000);
  assert.equal(d.context.tunnelEpisode.exhausted, exhausted);
  const original = d.context.tunnelEpisode.reckoner;
  const lastFixTime = d.context.tunnelEpisode.lastFixTime;
  const moves = d.calls.moves.length, shares = d.calls.shares;
  const short = route(3); // only 222 m long: the old along would jump straight to its destination
  request.resolve(short);
  await request.promise;
  assert.equal(d.context.live, null, 'old route progress is discarded');
  assert.equal(d.context.tunnelEpisode.suspended, true);
  assert.equal(d.context.tunnelEpisode.exhausted, exhausted);
  assert.equal(d.context.tunnelEpisode.reckoner, original, 'route replacement does not reset or renew the budget');
  assert.equal(d.context.tunnelEpisode.lastFixTime, lastFixTime);
  assert.equal(d.node('dr-chip').querySelector('span').textContent, 'Waiting for GPS');
  d.tick(180);
  assert.equal(d.calls.moves.length, moves, 'timer cannot move the marker on the replacement route');
  assert.equal(d.calls.shares, shares, 'reroute cannot publish stale progress');
  assert.equal(d.calls.patches.length, 0);
  assert.equal(d.context.mode, 'drive');
  d.fix(short.coords[0], { accuracy: 150 });
  assert.equal(d.context.tunnelEpisode.suspended, true);
  d.clock.now += 1000;
  d.fix(short.coords[0]);
  assert.equal(d.context.tunnelEpisode.suspended, false);
  assert.equal(d.context.live.along, 0);
  assert.equal(d.context.nav.arrived, false);
  d.tick(3);
  assert.ok(d.context.live.along > 0 && d.context.live.along < 100, 'a new outage starts from the new route position');
});

test('delayed reroute uses the latest fresh real fix instead of the captured destination fix', async () => {
  const d = drive({ speed: 10 });
  d.clock.now += 1000;
  d.fix(d.route.coords[2]); // request position will be the replacement route's destination
  const request = pendingReroute(d);
  d.clock.now += 5000;
  d.fix(d.route.coords[0]); // later real measurement, before the request resolves
  request.resolve(route(3));
  await request.promise;
  assert.equal(d.context.live.along, 0);
  assert.equal(d.context.nav.arrived, false);
  assert.equal(d.context.mode, 'drive');
  assert.equal(d.calls.patches.length, 0);
  assert.equal(d.context.tunnelEpisode.suspended, false);
  d.clock.now += 1000;
  d.fix(d.route.coords[2], { speed: 0 });
  await Promise.resolve();
  assert.equal(d.context.mode, 'browse');
  assert.equal(d.calls.patches.at(-1).body.ended, 'arrived');
});

test('a stale captured fix cannot confirm a stop or arrival when a route response resolves before the next timer', async () => {
  const d = drive({ speed: 10, stop: true });
  d.clock.now += 1000;
  d.fix(d.route.coords[2]);
  const request = pendingReroute(d);
  const moves = d.calls.moves.length, shares = d.calls.shares;
  d.clock.now += 30_000; // delayed route response, and no timer tick to mark an active estimate yet
  request.resolve(route(3));
  await request.promise;
  assert.equal(d.context.tunnelEpisode.suspended, true);
  assert.equal(d.context.live, null);
  assert.equal(d.context.stops.length, 1);
  assert.equal(d.calls.moves.length, moves);
  assert.equal(d.calls.shares, shares);
  assert.equal(d.calls.patches.length, 0);
  assert.equal(d.calls.spoken.some((s) => /arrived|reached your stop/i.test(s)), false);
  d.tick(120);
  assert.equal(d.calls.moves.length, moves);
});

test('sharing heartbeat cannot publish estimated, stale or suspended route progress', () => {
  const d = drive({ speed: 20 });
  d.context.shouldSend = () => true;
  vm.runInContext(appFunction('pushShare'), d.context);
  d.context.pushShare(true);
  assert.equal(d.calls.patches.length, 1, 'fresh real position can be shared');
  d.tick(5);
  d.context.pushShare(true);
  assert.equal(d.calls.patches.length, 1, 'periodic sharing does not leak an estimated position');
  d.context.tunnelEpisode.suspend();
  d.context.pushShare(true);
  assert.equal(d.calls.patches.length, 1);
  d.clock.now += 1000;
  d.fix(d.route.coords[1]);
  assert.equal(d.calls.patches.length, 2, 'real recovery resumes sharing');
  d.clock.now += 3000; // still no timer tick: stale age alone must block sharing
  d.context.pushShare(true);
  assert.equal(d.calls.patches.length, 2);
});

test('a replacement route is shared with the first fresh recovery fix, after waiting through the outage', async () => {
  const d = drive({ speed: 20 });
  d.context.shouldSend = () => true;
  vm.runInContext(appFunction('pushShare'), d.context);
  d.context.pushShare(true);
  const request = pendingReroute(d);
  d.tick(10);
  const replacement = route(3);
  request.resolve(replacement);
  await request.promise;
  assert.equal(d.calls.patches.length, 1, 'no stale position or route update is published');
  d.clock.now += 1000;
  d.fix(replacement.coords[0]);
  assert.equal(d.calls.patches.length, 2);
  assert.equal(d.calls.patches[1].body.route, replacement.coords, 'viewer receives the held route with real progress');
});

test('a failed route update is retried until acknowledged, without requiring new movement', async () => {
  const d = drive({ speed: 0 });
  d.context.shouldSend = shouldSend;
  let attempts = 0;
  d.context.api = async (url, options) => {
    d.calls.patches.push({ url, ...options });
    if (++attempts === 1) throw new Error('temporary network failure');
  };
  vm.runInContext(appFunction('pushShare'), d.context);
  d.context.pushShare();
  await Promise.resolve();
  assert.equal(d.context.share.route, undefined);
  for (let i = 0; i < 3; i++) {
    d.clock.now += 1000;
    d.fix();
    assert.equal(d.calls.patches.length, 1, 'per-second GPS fixes cannot bypass the send minimum');
  }
  d.clock.now += 1000;
  d.fix();
  await Promise.resolve();
  assert.equal(d.calls.patches.length, 2);
  assert.equal(d.calls.patches[1].body.route, d.context.nav.coords);
  assert.equal(d.context.share.route, d.context.nav);
  d.context.pushShare();
  assert.equal(d.calls.patches.length, 2, 'acknowledged route respects ordinary heartbeat throttling');
});

test('slow and failed route PATCHes keep retries bounded across GPS ticks; a new route sends promptly', async () => {
  const d = drive({ speed: 0 });
  d.context.shouldSend = shouldSend;
  const pending = [];
  d.context.api = (url, options) => {
    d.calls.patches.push({ url, ...options, at: d.clock.now });
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };
  vm.runInContext(appFunction('pushShare'), d.context);
  const start = d.clock.now;
  d.context.pushShare(true);
  for (let second = 1; second <= 64; second++) {
    d.clock.now += 1000;
    d.fix();
    if (second === 10) { pending[0].reject(new Error('slow network failure')); await Promise.resolve(); }
  }
  assert.deepEqual(d.calls.patches.map((p) => p.at - start), [0, 4000, 34000, 64000], 'existing second-update/heartbeat cadence bounds attempts');
  assert.ok(d.calls.patches.every((p) => p.body.route === d.route.coords), 'unacknowledged route remains attached to bounded retries');
  const replacement = route(5);
  d.context.nav = new Navigator(replacement);
  d.clock.now += 1000;
  d.fix();
  assert.equal(d.calls.patches.length, 5, 'new route is sent one second later, without waiting for the old attempt');
  assert.equal(d.calls.patches[4].body.route, replacement.coords);
  pending[1].resolve();
  await Promise.resolve();
  assert.equal(d.context.share.route, undefined, 'late acknowledgement for the old route cannot acknowledge the new route');
  pending[4].resolve();
  await Promise.resolve();
  assert.equal(d.context.share.route, d.context.nav);
  d.clock.now += 1000;
  d.fix();
  assert.equal(d.calls.patches.length, 5);
});

test('a late route acknowledgement cannot mark a different sharing session as updated', async () => {
  const d = drive();
  d.context.shouldSend = () => true;
  let resolve;
  d.context.api = () => new Promise((done) => { resolve = done; });
  vm.runInContext(appFunction('pushShare'), d.context);
  d.context.pushShare(true);
  d.context.share = { token: 'new-synthetic-trip' };
  resolve();
  await Promise.resolve();
  assert.equal(d.context.share.route, undefined);
});


for (const travel of ['drive', 'walk', 'motorcycle']) test(`${travel}: ordinary weak, stale and repeated real GPS still updates progress`, () => {
  const d = drive();
  d.context.travel = travel;
  const before = d.calls.moves.length;
  // No tunnel or estimate: main accepts these real measurements.
  for (const [i, accuracy, gpsTime] of [[1, 150, d.clock.now], [2, 10, d.clock.now - 5000], [3, 10, d.clock.now]]) {
    d.context.handleFix({ lngLat: d.route.coords[i], speed: 8, accuracy, time: gpsTime, gpsTime });
    assert.deepEqual(d.context.state.pos.lngLat, d.route.coords[i]);
  }
  assert.equal(d.calls.moves.length, before + 3);
});

test('tunnel-ahead filtering rejects weak, stale and repeated measurements before estimating', () => {
  const d = drive();
  d.context.nav.route.tunnels = [[0, 5]];
  const before = d.calls.moves.length;
  for (const [accuracy, gpsTime] of [[150, d.clock.now + 1000], [10, d.clock.now - 5000], [10, d.clock.now]]) {
    d.context.handleFix({ lngLat: d.route.coords[1], speed: 8, accuracy, time: gpsTime, gpsTime });
  }
  assert.equal(d.calls.moves.length, before);
  d.clock.now += 1000;
  d.fix(d.route.coords[1]);
  assert.equal(d.calls.moves.length, before + 1);
});


for (const travel of ['drive', 'walk', 'motorcycle']) test(`${travel}: ordinary weak GPS can reroute, move and share without entering an outage`, async () => {
  const d = drive({ speed: 2 });
  d.context.travel = travel;
  d.context.shouldSend = () => true;
  vm.runInContext(appFunction('pushShare'), d.context);
  d.clock.now += 1000;
  d.fix(d.route.coords[1], { accuracy: 150 });
  assert.equal(d.calls.patches.length, 1, 'ordinary weak real position is shared');
  const request = pendingReroute(d);
  const replacement = route(20);
  request.resolve(replacement);
  await request.promise;
  assert.equal(d.context.tunnelEpisode.suspended, false, 'reroute must not turn an ordinary weak fix into an outage');
  assert.ok(d.context.live);
  assert.ok(d.calls.patches.some(p => p.body.route === replacement.coords), 'replacement route is shared with current real progress');
  const before = d.calls.moves.length;
  d.clock.now += 1000;
  d.fix(replacement.coords[2], { accuracy: 150 });
  assert.equal(d.calls.moves.length, before + 1, 'next weak real fix still moves the marker');
  assert.deepEqual(Array.from(d.context.state.pos.lngLat), replacement.coords[2]);
});

test('ordinary stale measurement timestamps with current callbacks do not create a false GPS outage', async () => {
  const d = drive({ speed: 8 });
  d.context.shouldSend = () => true;
  vm.runInContext(appFunction('pushShare'), d.context);
  const oldMeasurement = d.clock.now;
  for (let i = 1; i <= 4; i++) {
    d.clock.now += 1000;
    d.context.handleFix({ lngLat: d.route.coords[i], speed: 8, accuracy: 10, gpsTime: oldMeasurement, time: oldMeasurement });
    d.context.tunnelTick();
    assert.equal(d.context.tunnelEpisode.active, false, 'callback freshness keeps main behavior outside tunnels');
  }
  assert.equal(d.calls.patches.length, 4);
  const request = pendingReroute(d);
  request.resolve(route(30));
  await request.promise;
  assert.equal(d.context.tunnelEpisode.suspended, false);
  d.clock.now += 3000;
  d.context.pushShare(true);
  assert.equal(d.calls.patches.length, 5, 'an actual callback gap blocks further stale sharing');
});
