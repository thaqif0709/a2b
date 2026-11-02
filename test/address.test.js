// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressQuery, streetText, onStreet, isExact, streetIndexWords, addressToLookUp, withAddresses } from '../public/address.js';
import { lookupAddress, rankAddresses } from '../src/lib/addresses.js';
import { usageRepo } from '../src/lib/usage.js';
import { ensureSchema } from '../src/lib/schema.js';
import { createD1 } from './d1-shim.js';

const ADDRESS = '129, BK 5/6, Bandar Kinrara, Puchong, 47180';

test('searches that look like an address are told apart from searches for a name', () => {
  assert.deepEqual(addressQuery(ADDRESS), { street: 'bk 5/6', number: '129', postcode: '47180' });
  assert.deepEqual(addressQuery('Jalan BK 5/6'), { street: 'jalan bk 5/6', number: null, postcode: null });
  assert.deepEqual(addressQuery('jln bk5/6'), { street: 'jalan bk 5/6', number: null, postcode: null });
  assert.deepEqual(addressQuery('129 jalan bk 5/6 bandar kinrara'), { street: 'jalan bk 5/6', number: '129', postcode: null });
  assert.deepEqual(addressQuery('No.54, Jalan Puteri 5/12, Puchong'), { street: 'jalan puteri 5/12', number: '54', postcode: null });
  assert.equal(addressQuery('SS 2/24').street, 'ss 2/24');
  assert.equal(addressQuery('Jalan 14/22').street, 'jalan 14/22');
  assert.deepEqual(addressQuery('47180 Puchong'), { street: null, number: null, postcode: '47180' });
  // Names, malls and places, a name on a street, and numbers that aren't street codes: not addresses.
  for (const q of ['nandos', 'trx', 'pavilion', '1 utama', 'klcc', 'mid valley', 'sunway pyramid', 'ioi city mall', 'ss15 courtyard', 'nandos jalan ipoh', 'Pavilion, Jalan Bukit Bintang', '24/7 fitness', '7/11', 'jalan']) {
    assert.equal(addressQuery(q), null, q);
  }
});

test('streets are matched whole, slash and all: "BK 5/6" is not "BK 5/14", "BK 5/61" or "BK 6/5"', () => {
  const a = addressQuery(ADDRESS);
  assert.ok(onStreet({ name: '129 Jalan BK 5/6' }, a));
  for (const other of ['Jalan BK 5/14', 'Jalan BK 5/61', 'Jalan BK 6/5', 'Jalan BK 5', 'Jalan BKK 5/6']) assert.ok(!onStreet({ name: other }, a), other);
  assert.ok(!onStreet({ name: 'x', address: '5 Jalan BK 5/14, Puchong' }, addressQuery('jalan bk 5/1')), '"5/1" is not the start of "5/14"');
  assert.ok(onStreet({ name: 'Empire', address: 'LG-02, Jalan SS16/1, Subang Jaya' }, addressQuery('jalan ss 16/1')));
  assert.equal(streetText('Jln. SS2 / 24'), 'jalan ss 2/24');
  // The house number has to be the one on that street.
  assert.ok(isExact({ name: '129 Jalan BK 5/6' }, a));
  assert.ok(isExact({ name: 'Kedai', address: 'No. 129, Jalan BK 5/6, Puchong' }, a));
  assert.ok(!isExact({ name: '12 Jalan BK 5/6' }, a));
  assert.ok(!isExact({ name: '1129 Jalan BK 5/6' }, a));
  assert.ok(isExact({ name: 'Jalan BK 5/6 129', address: 'Puchong' }, a), "OpenStreetMap's order: street, then number");
  assert.ok(!isExact({ name: 'SRA Bandar Kinrara 5', address: 'Jalan BK 5/6, Puchong' }, addressQuery('5 Jalan BK 5/6')), 'a number in the name is not the house number');
  assert.ok(isExact({ name: 'Jalan BK 5/6', address: 'Puchong' }, addressQuery('Jalan BK 5/6')), 'a street search is answered by the street');
});

test('a street is looked up in /places/ by its name words, as the build files them', () => {
  assert.deepEqual(streetIndexWords('jalan bk 5/6'), ['bk']);
  assert.deepEqual(streetIndexWords('jalan tun razak kuala lumpur'), ['tun', 'razak', 'kuala', 'lumpur']);
  assert.deepEqual(streetIndexWords('jalan 14/22'), ['14']);
});

test('TomTom is only asked for an address that no result already answers, never for a name', () => {
  const shop = { name: 'Nasi Tupe Soho', address: '5 Jalan BK 5/6, Puchong' };
  for (const q of ['nandos', 'trx', 'pavilion', 'nandos jalan ipoh']) assert.equal(addressToLookUp(q, []), null, q);
  assert.ok(addressToLookUp(ADDRESS, [shop]), 'a shop on the street is not house 129');
  assert.equal(addressToLookUp('5 Jalan BK 5/6', [shop]), null, 'the shop at number 5 is the answer');
  assert.equal(addressToLookUp('Jalan BK 5/6', [shop]), null, 'a shop on the street answers a street search');
});

// TomTom's geocoder for the test address, as it answered on 30 Oct 2026, but with the near misses first (its fuzzy
// search does rank "BK 5/14" first).
const tt = (number, street, score, lat, lon, type = 'Point Address') => ({
  type,
  matchConfidence: { score },
  address: { streetNumber: number, streetName: street, municipality: 'Puchong', postalCode: '47180', countrySubdivision: 'Selangor', country: 'Malaysia', freeformAddress: [number, street, 'Bandar Kinrara', '47180 Puchong', 'Selangor'].filter(Boolean).join(', ') },
  position: { lat, lon },
});
const TOMTOM = { results: [tt('129', 'Jalan BK 5/14', 0.901, 3.0391, 101.6512), tt('129', 'Jalan BK 5/2', 0.904, 3.0402, 101.6455), tt('129', 'Jalan BK 5/6', 0.905, 3.0414207, 101.6477069)] };

test("TomTom's answer on the street searched for comes first, and the near misses say they're on another street", () => {
  const places = rankAddresses(TOMTOM.results, addressQuery(ADDRESS));
  assert.deepEqual(places[0], { name: '129 Jalan BK 5/6', address: 'Bandar Kinrara, 47180 Puchong', lat: 3.0414207, lng: 101.6477069, category: 'address', source: 'tomtom' });
  assert.deepEqual(places.slice(1).map((p) => [p.name, p.address]), [
    ['129 Jalan BK 5/14', 'Different street · Bandar Kinrara, 47180 Puchong'],
    ['129 Jalan BK 5/2', 'Different street · Bandar Kinrara, 47180 Puchong'],
  ]);
  const street = rankAddresses([tt(undefined, 'Jalan BK 5/6', 0.9, 3.04, 101.647, 'Street')], addressQuery('Jalan BK 5/6'));
  assert.deepEqual([street[0].name, street[0].category], ['Jalan BK 5/6', 'street']);
});

test('the house goes first in the results, then the shops on its street, then the near misses, then the rest', () => {
  const a = addressQuery(ADDRESS);
  const found = rankAddresses(TOMTOM.results, a);
  const station = { name: 'BK5 LRT station', address: 'Puchong', category: 'station' };
  const shop = { name: 'Nasi Tupe Soho', address: '5 Jalan BK 5/6, Puchong' };
  const names = withAddresses([station, shop], found, a).map((p) => p.name);
  assert.deepEqual(names, ['129 Jalan BK 5/6', 'Nasi Tupe Soho', '129 Jalan BK 5/14', '129 Jalan BK 5/2', 'BK5 LRT station']);
});

test('the TomTom lookup encodes the slash, keeps to Malaysia, and is skipped for names, without a key, or over the cap', async () => {
  const orig = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(new URL(url));
    return Response.json(TOMTOM);
  };
  const env = { TOMTOM_KEY: 'test-key' };
  const yes = async () => true;
  try {
    const places = await lookupAddress(env, ADDRESS, [101.64771, 3.04142], yes);
    assert.equal(places[0].name, '129 Jalan BK 5/6');
    assert.equal(asked.length, 1);
    const u = asked[0];
    assert.equal(u.pathname, `/search/2/geocode/${encodeURIComponent(ADDRESS)}.json`);
    assert.ok(u.pathname.includes('5%2F6'), 'a bare "/" gets a 404 from TomTom');
    assert.deepEqual([u.searchParams.get('countrySet'), u.searchParams.get('lat'), u.searchParams.get('lon')], ['MY', '3.04', '101.65']);

    let takes = 0;
    const counted = async () => (takes++, true);
    for (const q of ['nandos', 'trx', 'pavilion']) assert.deepEqual(await lookupAddress(env, q, null, counted), [], q);
    assert.equal(takes, 0, 'a name search takes none of the lookups');
    assert.deepEqual(await lookupAddress({}, ADDRESS, null, yes), []);
    assert.deepEqual(await lookupAddress(env, ADDRESS, null, async () => false), []);
    assert.equal(asked.length, 1, 'TomTom was asked once only');
  } finally {
    globalThis.fetch = orig;
  }
});

test("the daily cap: each lookup takes one of the day's, and none are left after the cap", async () => {
  const db = createD1();
  await ensureSchema(db);
  const usage = usageRepo(db);
  const day = Date.UTC(2026, 9, 30, 4);
  assert.deepEqual([await usage.take('addresses', 2, day), await usage.take('addresses', 2, day), await usage.take('addresses', 2, day)], [true, true, false]);
  assert.equal(await usage.take('addresses', 2, day + 86400_000), true, 'a new day, new lookups');
  assert.equal(await usage.take('addresses', 0, day + 2 * 86400_000), false, 'a cap of 0 turns them off');
  assert.equal(await usage.take('searches', 9, day), false, 'only capped counters');
  const row = await db.prepare('SELECT addresses FROM usage_daily WHERE day = ?').bind('2026-10-30').first();
  assert.equal(row.addresses, 2);
});
