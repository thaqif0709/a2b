// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createLocationWatch, locationMessage } from '../public/location.js';

const position = (accuracy = 10) => ({ timestamp: 1000, coords: { longitude: 101.6, latitude: 3.1, accuracy } });
function fixture() {
  let nextWatch = 0, nextTimer = 0, maxWatches = 0, maxTimers = 0;
  const watches = new Map(), timers = new Map(), history = [], states = [], fixes = [];
  const geolocation = {
    watchPosition(success, error, options) {
      const id = nextWatch++;
      const watch = { id, success, error, options };
      watches.set(id, watch);
      history.push(watch);
      maxWatches = Math.max(maxWatches, watches.size);
      return id;
    },
    clearWatch(id) { watches.delete(id); },
  };
  const setTimer = (callback, ms) => {
    const id = nextTimer++;
    timers.set(id, { callback, ms });
    maxTimers = Math.max(maxTimers, timers.size);
    return id;
  };
  const clearTimer = (id) => timers.delete(id);
  const options = { geolocation, setTimer, clearTimer, onFix: (p) => fixes.push(p), onState: (s) => states.push(s) };
  const controller = createLocationWatch(options);
  return { controller, options, watches, timers, history, states, fixes,
    current: () => watches.values().next().value,
    runRetry() {
      const [id, { callback, ms }] = timers.entries().next().value;
      assert.equal(ms, 15_000);
      timers.delete(id);
      callback();
    },
    bounded() { assert.ok(maxWatches <= 1, `at most one active watch, saw ${maxWatches}`); assert.ok(maxTimers <= 1, `at most one retry, saw ${maxTimers}`); },
  };
}

test('repeated start and transient errors keep at most one watch and one retry', () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) f.controller.start();
  assert.equal(f.watches.size, 1);
  assert.equal(f.history.length, 1);
  assert.equal(f.current().id, 0, 'zero is a valid watch ID');
  assert.deepEqual(f.current().options, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
  for (let i = 0; i < 20; i++) {
    const old = f.current();
    old.error({ code: i % 2 ? 2 : 3 });
    assert.equal(f.controller.status, i % 2 ? 'unavailable' : 'timeout');
    assert.equal(f.watches.size, 1, 'transient errors keep listening while waiting');
    assert.equal(f.timers.size, 1);
    for (let j = 0; j < 5; j++) old.error({ code: 3 });
    assert.equal(f.timers.size, 1, 'repeated errors cannot create extra retries');
    f.runRetry();
    old.success(position());
    old.error({ code: 3 });
    assert.equal(f.fixes.length, 0, 'success from replaced watch is ignored');
    assert.equal(f.watches.size, 1);
    assert.equal(f.timers.size, 0);
  }
  f.current().success(position());
  assert.equal(f.controller.status, 'ready');
  assert.equal(f.fixes.length, 1);
  assert.equal(f.timers.size, 0);
  f.bounded();
});

test('permission denial waits for deliberate retry, while inaccurate GPS keeps its single watch', () => {
  const f = fixture();
  f.controller.start();
  f.current().error({ code: 1 });
  assert.equal(f.controller.status, 'denied');
  assert.equal(f.watches.size, 0);
  assert.equal(f.timers.size, 0);
  f.controller.start();
  const watch = f.current();
  watch.success(position(150));
  assert.equal(f.controller.status, 'inaccurate');
  assert.equal(f.watches.size, 1);
  assert.equal(f.timers.size, 0);
  watch.success(position(10));
  assert.equal(f.controller.status, 'ready');
  assert.equal(f.current(), watch);
  assert.equal(f.fixes.length, 2, 'quality remains available to the driving GPS filter');
  f.bounded();
});

test('manual retry and page cleanup cancel pending work and ignore late callbacks', () => {
  const f = fixture();
  f.controller.start();
  f.current().error({ code: 3 });
  const pending = f.timers.values().next().value.callback;
  f.controller.stop();
  assert.equal(f.timers.size, 0);
  f.controller.start();
  const current = f.current();
  pending();
  assert.equal(f.current(), current, 'a cleared retry callback cannot replace the current watch');
  f.controller.stop();
  current.success(position());
  current.error({ code: 2 });
  assert.equal(f.watches.size, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.fixes.length, 0);
  f.bounded();
});

test('missing API, thrown start and invalid coordinates report distinct recoverable state', () => {
  const states = [];
  const missing = createLocationWatch({ geolocation: undefined, onState: (s) => states.push(s), onFix() {} });
  missing.start();
  missing.start();
  missing.stop();
  assert.deepEqual(states, ['unsupported']);
  const f = fixture();
  f.options.geolocation.watchPosition = () => { throw new Error('provider unavailable'); };
  f.controller.start();
  assert.equal(f.controller.status, 'unavailable');
  assert.equal(f.timers.size, 1);
  f.controller.stop();
  const invalid = fixture();
  invalid.controller.start();
  invalid.current().success({ coords: { longitude: NaN, latitude: 3, accuracy: 10 } });
  assert.equal(invalid.controller.status, 'unavailable');
  assert.equal(invalid.fixes.length, 0);
  assert.equal(invalid.watches.size, 1, 'invalid data does not kill the watch');
  invalid.bounded();
});

test('synchronous timeout before watchPosition returns preserves the watch until retry', () => {
  const f = fixture();
  const register = f.options.geolocation.watchPosition;
  f.options.geolocation.watchPosition = (success, error, options) => {
    const id = register(success, error, options);
    error({ code: 3 });
    return id;
  };
  f.controller.start();
  assert.equal(f.watches.size, 1);
  assert.equal(f.timers.size, 1);
  f.current().success(position());
  assert.equal(f.fixes.length, 1);
  assert.equal(f.timers.size, 0);
  f.bounded();
});

test('app wiring distinguishes GPS states, retries once and cleans up across page lifecycle', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const functions = ['startLocation', 'retryLocation', 'stopLocation', 'resumeLocation', 'renderLocationStatus'].map((name) => {
    const match = app.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
    assert.ok(match, `app function ${name}`);
    return match[0];
  });
  const f = fixture(), events = new Map(), nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { textContent: '', classList: { toggle: (s, on) => on ? classes.add(s) : classes.delete(s), contains: (s) => classes.has(s) } });
    }
    return nodes.get(id);
  };
  const c = vm.createContext({ locationWatch: null, locationStarted: false, state: { pos: position() }, $, locationMessage,
    navigator: { geolocation: f.options.geolocation }, onFix: f.options.onFix,
    createLocationWatch: (options) => createLocationWatch({ ...f.options, ...options }),
    window: { addEventListener: (name, callback) => events.set(name, callback) },
  });
  vm.runInContext(functions.join('\n'), c);
  const bindings = app.match(/window\.addEventListener\('page(?:hide|show)', \w+\);/g);
  assert.equal(bindings?.length, 2);
  vm.runInContext(bindings.join('\n'), c);
  events.get('pageshow')();
  assert.equal(f.watches.size, 0, 'returning before consent does not start GPS');
  c.startLocation();
  c.startLocation();
  assert.equal(f.watches.size, 1);
  assert.equal(c.state.locationStatus, 'acquiring');
  assert.match($('loc-message').textContent, /Finding/);
  f.current().error({ code: 3 });
  assert.equal(c.state.locationDenied, false, 'timeout is not permission denial');
  assert.equal(c.state.locationStatus, 'timeout');
  assert.equal($('loc-banner').classList.contains('hidden'), false, 'show failure even when an old position exists');
  c.retryLocation();
  assert.equal(f.timers.size, 0);
  f.current().error({ code: 1 });
  assert.equal(c.state.locationDenied, true);
  assert.match($('loc-message').textContent, /browser settings/);
  events.get('pagehide')();
  events.get('pageshow')();
  assert.equal(f.watches.size, 0, 'page restore must not retry denied permission');
  c.retryLocation();
  f.current().success(position(150));
  assert.equal(c.state.locationStatus, 'inaccurate');
  assert.equal(c.state.locationDenied, false);
  f.current().success(position());
  assert.equal($('loc-banner').classList.contains('hidden'), true);
  events.get('pagehide')();
  assert.equal(f.watches.size, 0);
  events.get('pageshow')();
  assert.equal(f.watches.size, 1, 'restore resumes one previously authorized watcher');
  f.bounded();
  const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /'\/location\.js'/, 'the offline app includes its new imported module');
});


test('a tunnel timeout keeps the established watch accepting fixes immediately', () => {
  const f = fixture();
  f.controller.start();
  const watch = f.current();
  watch.success(position());
  for (const code of [3, 2, 3]) {
    watch.error({ code });
    assert.equal(f.current(), watch);
    assert.equal(f.timers.size, 0, 'no retry after a position has arrived');
  }
  watch.success(position());
  assert.equal(f.fixes.length, 2, 'tunnel-exit fix arrives without a 15-second gap');
  assert.equal(f.controller.status, 'ready');
  f.bounded();
});

test('first acquisition succeeds during retry wait and cancels replacement', () => {
  const f = fixture();
  f.controller.start();
  const watch = f.current();
  watch.error({ code: 3 });
  assert.equal(f.timers.size, 1);
  const pending = f.timers.values().next().value.callback;
  watch.success(position());
  pending();
  assert.equal(f.current(), watch);
  assert.equal(f.history.length, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.fixes.length, 1);
  f.bounded();
});

test('a cached app position keeps the watch rather than scheduling acquisition retries', () => {
  const f = fixture();
  const controller = createLocationWatch({ ...f.options, hasPosition: () => true });
  controller.start();
  const watch = f.current();
  watch.error({ code: 2 });
  assert.equal(f.timers.size, 0);
  assert.equal(f.current(), watch);
  controller.stop();
  f.bounded();
});


test('synchronous permission denial clears the returned watch and never retries', () => {
  const f = fixture();
  const register = f.options.geolocation.watchPosition;
  f.options.geolocation.watchPosition = (success, error, options) => {
    const id = register(success, error, options);
    error({ code: 1 });
    return id;
  };
  f.controller.start();
  assert.equal(f.controller.status, 'denied');
  assert.equal(f.watches.size, 0);
  assert.equal(f.timers.size, 0);
  f.bounded();
});
