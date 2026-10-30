// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { mergeResults } from '../public/places.js';
import { matchesWordStarts } from '../public/text.js';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
// Execute the application's actual functions. Only providers, time and rendering are replaced: deferred
// promises let the tests deliver responses after the user has changed query or left the screen.
function appFunction(name) {
  const match = app.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `app function ${name} exists`);
  return match[0];
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const place = (name = 'Cafe', extra = {}) => ({ name, address: '', lng: 101.7, lat: 3.1, ...extra });

function search() {
  const nodes = new Map(), timers = new Map(), requests = [], localCalls = [], results = [], messages = [], picked = [];
  let timer = 0;
  const node = (id) => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { value: '', focus() {}, blur() {}, textContent: '', classList: {
        add: (...names) => names.forEach((n) => classes.add(n)),
        remove: (...names) => names.forEach((n) => classes.delete(n)),
        contains: (name) => classes.has(name),
        toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
      } });
    }
    return nodes.get(id);
  };
  const context = vm.createContext({
    $: node, searchSeq: 0, searchTimer: null, searchTarget: null,
    setTimeout: (callback) => { timers.set(++timer, callback); return timer; }, clearTimeout: (id) => timers.delete(id),
    state: { pos: { lngLat: [101.7, 3.1] } }, navigator: { language: 'en' }, document: { activeElement: null },
    armBack() {}, syncDriverPlaces() {}, showSearching() {}, showSearchHome() {}, renderSearchHome() {}, toast() {},
    closeParking() {}, backToBrowse() {}, mergeResults, matchesWordStarts,
    api: (url) => { const d = deferred(); requests.push({ url, ...d }); return d.promise; },
    searchNearby: (_q, _near, options) => { const d = deferred(); localCalls.push({ options, ...d }); return d.promise; },
    searchByType: async () => null,
    searchMessage: (message) => messages.push(message),
    showResults: (q, near, places, note, overture, enter) => results.push({ q, places, note, enter, overture }),
    withOvertureParking: async (server) => server.places,
    addPlace: async (_kind, p) => picked.push(p), openPreview() {}, setHomeWork: async () => {},
    saveAsFavourite() {}, addStop() {}, origin: null, dest: null,
  });
  vm.runInContext(['invalidateSearch', 'isCurrentSearch', 'onSearchInput', 'onSearchKeydown', 'clearSearch',
    'openSearchFor', 'closeScreen', 'runSearch', 'pickPlace'].map(appFunction).join('\n'), context);
  return { context, node, requests, localCalls, results, messages, picked, timers, async start(q = 'Cafe', enter = false) {
    node('search-input').value = q;
    const promise = context.runSearch(q, enter);
    await flush();
    return { promise };
  } };
}

for (const action of ['edit', 'shorten', 'clear', 'close', 'target', 'pick']) {
  test(`a late Enter response cannot paint or select after ${action}`, async () => {
    const s = search();
    const pending = await s.start('Cafe', true);
    if (action === 'edit' || action === 'shorten') {
      s.node('search-input').value = action === 'edit' ? 'Bakery' : 'B';
      s.context.onSearchInput();
    } else if (action === 'clear') s.context.clearSearch();
    else if (action === 'close') s.context.closeScreen('search');
    else if (action === 'target') s.context.openSearchFor('home');
    else await s.context.pickPlace(place('Selected instead'));
    s.requests[0].resolve({ places: [place('Old cafe')] });
    s.localCalls[0].resolve([]);
    await pending.promise;
    assert.equal(s.results.length, 0, 'obsolete results, including auto-pick on Enter, are ignored');
    assert.equal(s.messages.length, 0);
    if (action === 'pick') assert.equal(s.picked.length, 1, 'only the explicitly picked place reaches Recent');
  });
}

test('clear and close cancel pending debounce work; a newer query wins out-of-order replies', async () => {
  const s = search();
  s.node('search-input').value = 'Cafe';
  s.context.onSearchInput();
  assert.equal(s.timers.size, 1);
  s.context.clearSearch();
  assert.equal(s.timers.size, 0);
  s.node('search-input').value = 'Cafe';
  s.context.onSearchInput();
  s.context.closeScreen('search');
  assert.equal(s.timers.size, 0);
  s.context.openSearchFor(null);
  const old = await s.start('Cafe', true);
  const latest = await s.start('Bakery');
  s.requests[1].resolve({ places: [place('Bakery')] });
  s.localCalls[1].resolve([]);
  await latest.promise;
  s.requests[0].reject(new Error('Old request failed'));
  s.localCalls[0].resolve([place('Cafe')]);
  await old.promise;
  assert.deepEqual(s.results.map((r) => r.q), ['Bakery']);
  assert.deepEqual(s.messages, []);
});

test('leaving during category lookup stops the obsolete fallback requests', async () => {
  const s = search(), typed = deferred();
  s.context.searchByType = () => typed.promise;
  const pending = await s.start('Petrol', true);
  s.context.closeScreen('search');
  typed.resolve(null);
  await pending.promise;
  assert.equal(s.requests.length, 0);
  assert.equal(s.results.length, 0);
});

test('closing during parking enrichment cannot restore an obsolete result list', async () => {
  const s = search(), parking = deferred();
  s.context.withOvertureParking = () => parking.promise;
  const pending = await s.start('Parking', true);
  s.requests[0].resolve({ places: [], parking: { lng: 101.7, lat: 3.1 } });
  s.localCalls[0].resolve([]);
  await flush();
  s.context.closeScreen('search');
  parking.resolve([place('Parking')]);
  await pending.promise;
  assert.equal(s.results.length, 0);
});

test('a delayed Home save cannot close or retarget a newly opened Work search', async () => {
  const s = search(), save = deferred();
  s.context.setHomeWork = () => save.promise;
  s.context.openSearchFor('home');
  const picked = s.context.pickPlace(place('Chosen home'));
  s.context.openSearchFor('work');
  save.resolve();
  await picked;
  assert.equal(s.context.searchTarget, 'work');
  assert.equal(s.node('search').classList.contains('hidden'), false);
});

for (const failed of ['server', 'local']) test(`a failed ${failed} search keeps the other provider's results with a limited notice`, async () => {
  const s = search(), pending = await s.start('Cafe', true);
  if (failed === 'server') {
    s.requests[0].reject(new Error('A2B is busy.'));
    s.localCalls[0].resolve([place('Cafe')]);
  } else {
    s.requests[0].resolve({ places: [place('Cafe')] });
    s.localCalls[0].reject(new Error('Local files unavailable'));
  }
  await pending.promise;
  assert.equal(s.results[0].places[0].name, 'Cafe');
  assert.match(s.results[0].note, /Limited results/);
  assert.equal(s.results[0].enter, false, 'an incomplete single result must not auto-select');
});

test('a partial local shard result is labelled and empty failed searches do not claim no results', async () => {
  const s = search(), pending = await s.start();
  s.localCalls[0].options.onUnavailable();
  s.localCalls[0].resolve([place()]);
  s.requests[0].resolve({ places: [] });
  await pending.promise;
  assert.match(s.results[0].note, /Limited results/);
  const empty = await s.start('Missing');
  s.localCalls[1].reject(new Error('Offline'));
  s.requests[1].reject(new Error('A2B is busy.'));
  await empty.promise;
  assert.equal(s.results[1].places.length, 0);
  assert.match(s.results[1].note, /could not be checked/);
  assert.doesNotMatch(s.results[1].note, /No results/);
});

test('successful sources retain matching, dedupe, and single-result Enter behaviour', async () => {
  const s = search(), pending = await s.start('Cafe', true);
  s.requests[0].resolve({ places: [place(), place('CAFE', { lng: 101.7001 })] });
  s.localCalls[0].resolve([place('Café', { lng: 101.7002 })]);
  await pending.promise;
  assert.equal(s.results[0].places.length, 1);
  assert.equal(s.results[0].enter, true);
  assert.equal(s.results[0].note, null);
  assert.ok(matchesWordStarts("Nando's Eco Grandeur", 'nando eco'));
});

test('successful empty providers remain a genuine empty search without a failure notice', async () => {
  const s = search(), pending = await s.start('Nothing');
  s.requests[0].resolve({ places: [] });
  s.localCalls[0].resolve([]);
  await pending.promise;
  assert.equal(s.results[0].places.length, 0);
  assert.equal(s.results[0].note, undefined, 'showResults supplies the ordinary No results message');
  assert.equal(s.messages.length, 0);
});

test('named category results survive an unavailable area provider', async () => {
  const s = search();
  s.context.typeQuery = () => ({ type: 'clinic', area: 'Ampang' });
  s.context.TYPES = { clinic: { label: 'Clinics' } };
  s.context.placesOfType = async () => [];
  vm.runInContext(appFunction('searchByType'), s.context);
  let limited = false;
  const pending = s.context.searchByType('Clinic Ampang', [101.7, 3.1], () => { limited = true; });
  await flush();
  s.requests[0].resolve({ places: [place('Clinic Ampang')] });
  s.localCalls[0].resolve([]);
  s.requests[1].reject(new Error('Area lookup unavailable'));
  const found = await pending;
  assert.equal(found.places[0].name, 'Clinic Ampang');
  assert.equal(limited, true);
});
