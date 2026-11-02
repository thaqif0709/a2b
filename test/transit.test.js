// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTransit, withRealWalks, serviceDay, runs, board, feeds, effort } from '../src/lib/transit.js';

const KL_SENTRAL = [101.6865, 3.134];
const KLCC = [101.7116, 3.1579];
const AMPANG = [101.7601, 3.1503];
const KAJANG = [101.7906, 2.9831];
const MID_VALLEY = [101.677, 3.118];
const PUNCAK_ALAM = [101.468, 3.224];
const USJ = [101.5851, 3.0567];
const PAVILION = [101.7136, 3.149];

const RAWANG = [101.575, 3.319];
const KLANG = [101.4495, 3.0431];

// 9am on the day after a timetable's last day (YYYYMMDD), Malaysia time.
const dayAfter = (until) => Date.parse(`${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6)}T09:00:00+08:00`) + 86400_000;
// A Wednesday morning a week before the first timetable runs out, so every line runs and the tests keep working
// after a rebuild.
const ENDS = Object.entries(feeds).sort(([, a], [, b]) => a.until.localeCompare(b.until));
const end = dayAfter(ENDS[0][1].until) - 8 * 86400_000;
const WEDNESDAY_9AM = end - ((new Date(end + 8 * 3600_000).getUTCDay() + 7 - 3) % 7) * 86400_000;
const ONE_AM = WEDNESDAY_9AM + 16 * 3600_000; // Thursday 1am

const trains = (trip) => trip.legs.filter((l) => l.mode === 'train');

const KINRARA_BK5 = [101.644294, 3.050506];
const Q_SENTRAL = [101.6851, 3.135];
const MASJID_JAMEK = [101.6963, 3.1496];
const TRX = [101.7178, 3.1422];
const ON_KJ = [101.695111, 3.1462]; // on the Kelana Jaya Line between Pasar Seni and Masjid Jamek

test('the service day is in Malaysia time', () => {
  const d = serviceDay(Date.parse('2026-10-28T23:30:00Z')); // Thursday 7:30am in KL
  assert.deepEqual(d, { date: '20261029', dow: 3, secs: 7.5 * 3600 });
  assert.ok(runs('prasarana:MonFri', serviceDay(WEDNESDAY_9AM)));
  assert.ok(!runs('prasarana:Sun', serviceDay(WEDNESDAY_9AM)));
});

test('boarding: half a headway on lines that only give a frequency, the next train on timetabled ones', () => {
  const freq = { freq: [[6 * 3600, 9 * 3600, 240], [9 * 3600, 23 * 3600, 600]], offsets: [0, 120, 300] };
  const b = board(freq, 1, 8 * 3600);
  assert.equal(b.dep, 8 * 3600 + 120);
  assert.equal(b.arrive(2), 8 * 3600 + 120 + 180);
  assert.equal(board(freq, 0, 5 * 3600).dep, 6 * 3600, 'before the first train: the first train');
  assert.equal(board(freq, 0, 23.5 * 3600), null, 'after the last');
  const timed = { trips: [[3600, 3900, 4200], [7200, 7500, 7800]] };
  assert.deepEqual([board(timed, 1, 4000).dep, board(timed, 1, 4000).arrive(2)], [7500, 7800]);
  assert.equal(board(timed, 0, 8000), null);
});

test('KL Sentral to KLCC: the Kelana Jaya Line, no changes', () => {
  const plan = planTransit(KL_SENTRAL, KLCC, WEDNESDAY_9AM);
  const [best] = plan.trips;
  assert.ok(best, plan.note);
  assert.deepEqual(trains(best).map((l) => [l.line.name, l.from.name, l.to.name]), [['Kelana Jaya Line', 'KL Sentral', 'KLCC']]);
  assert.ok(best.duration > 10 * 60 && best.duration < 40 * 60, `${best.duration}s`);
  assert.equal(best.legs[0].mode, 'walk');
  assert.equal(best.legs.at(-1).mode, 'walk');
  assert.ok(trains(best)[0].every >= 2 && trains(best)[0].every <= 10, 'how often trains run');
  assert.ok(trains(best)[0].coords.length > 5, 'drawn along the track');
  assert.equal(best.arrive - best.depart, best.duration * 1000);
});

test('changes lines where they meet, and offers different ways', () => {
  const best = planTransit(KAJANG, MID_VALLEY, WEDNESDAY_9AM).trips[0];
  assert.ok(best.changes >= 1);
  assert.equal(trains(best)[0].line.kind, 'MRT', 'the Kajang Line first');
  // USJ to Pavilion: the Kelana Jaya Line, then either the MRT or the Monorail.
  const plan = planTransit(USJ, PAVILION, WEDNESDAY_9AM);
  assert.ok(plan.trips.length >= 2, 'alternatives');
  const keys = plan.trips.map((t) => trains(t).map((l) => l.line.id).join('>'));
  assert.equal(new Set(keys).size, keys.length, 'no two the same');
  assert.ok(plan.trips.every((t, i) => !i || t.arrive >= plan.trips[i - 1].arrive), 'soonest arrival first');
  assert.ok(planTransit(AMPANG, KLCC, WEDNESDAY_9AM).trips[0].changes >= 1, 'Ampang Line to the Kelana Jaya Line');
});

test('says when there are no trains: too far from a station, or late at night', () => {
  assert.match(planTransit(PUNCAK_ALAM, KLCC, WEDNESDAY_9AM).note, /no train station within walking distance of the start/i);
  assert.match(planTransit(KLCC, PUNCAK_ALAM, WEDNESDAY_9AM).note, /of the destination/i);
  const night = planTransit(KL_SENTRAL, KLCC, ONE_AM);
  assert.ok(night.night);
  assert.match(night.note, /stopped for the night/);
  assert.ok(night.firstTrain > ONE_AM + 4 * 3600_000, 'the first train is in the morning');
  // An hour between KTM trains in the morning is a long wait, not the night.
  const hourly = planTransit([101.579, 3.319], KAJANG, WEDNESDAY_9AM);
  assert.ok(hourly.trips[0].legs[1].wait > 45 * 60, 'the next train from Rawang is a while');
  assert.ok(!hourly.night && !/night/.test(hourly.note ?? ''), hourly.note);
  assert.match(planTransit(KLCC, [101.7136, 3.149], WEDNESDAY_9AM).note ?? '', /walking/i, 'Pavilion is a short walk');
});

test('walks become real walking routes, and the trip times follow', async () => {
  const plan = planTransit(KL_SENTRAL, KLCC, WEDNESDAY_9AM);
  const before = plan.trips[0].duration;
  const firstWalk = plan.trips[0].legs[0];
  const asked = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    asked.push(body);
    // Every walk comes back 2 minutes longer than estimated, along a three-point path.
    const [a, b] = body.locations;
    const est = plan.trips.flatMap((t) => t.legs).find((l) => l.mode === 'walk' && Math.abs(l.from.lat - a.lat) < 1e-5 && Math.abs(l.to.lng - b.lon) < 1e-5);
    return Response.json({ trip: { summary: { length: 0.4, time: est.duration + 120 }, legs: [{ shape: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' }] } });
  };
  try {
    await withRealWalks({ ROUTING_URL: 'https://routing.test/route' }, plan);
  } finally {
    globalThis.fetch = orig;
  }
  assert.ok(asked.every((b) => b.costing === 'pedestrian'));
  assert.equal(firstWalk.distance, 400);
  assert.equal(firstWalk.coords.length, 3);
  const walks = plan.trips[0].legs.filter((l) => l.mode === 'walk' && l.coords.length === 3).length;
  assert.equal(plan.trips[0].duration, before + walks * 120);
  assert.equal(trains(plan.trips[0])[0].depart - plan.trips[0].depart, (firstWalk.duration + trains(plan.trips[0])[0].wait) * 1000, 'the train is caught after the longer walk');
});

test('a few minutes more on the train beats a long walk', () => {
  // Rawang to USJ: the quickest way walks almost 2 km and changes four times; one change and half the walking is
  // only minutes slower.
  const plan = planTransit(RAWANG, USJ, WEDNESDAY_9AM);
  const [best] = plan.trips;
  assert.ok(best.walk < 1300, `walks ${best.walk} m`);
  assert.equal(best.changes, 1);
  assert.ok(plan.trips.every((t) => effort(t) >= effort(best)), 'shown first');
});

test('trips are still best first after the real walks', async () => {
  const plan = planTransit(TRX, MID_VALLEY, WEDNESDAY_9AM);
  const first = plan.trips[0];
  const lastWalk = first.legs.at(-1);
  assert.ok(plan.trips.slice(1).some((t) => t.legs.at(-1).from.name !== lastWalk.from.name), 'another trip ends at a different station');
  const orig = globalThis.fetch;
  // The first trip's walk from its last station turns out to be an hour: it should drop behind the others.
  globalThis.fetch = async (url, init) => {
    const [a] = JSON.parse(init.body).locations;
    if (Math.abs(a.lat - lastWalk.from.lat) > 1e-5 || Math.abs(a.lon - lastWalk.from.lng) > 1e-5) return new Response('', { status: 500 });
    return Response.json({ trip: { summary: { length: 4, time: 3600 }, legs: [{ shape: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' }] } });
  };
  try {
    await withRealWalks({ ROUTING_URL: 'https://routing.test/route' }, plan);
  } finally {
    globalThis.fetch = orig;
  }
  assert.notEqual(plan.trips[0], first);
  assert.ok(plan.trips.every((t, i) => !i || effort(t) >= effort(plan.trips[i - 1])));
});

test('says when a timetable is out of date, instead of "no trains"', () => {
  const [[, firstEnd], [, lastEnd]] = ENDS;
  if (firstEnd.until < lastEnd.until) {
    const plan = planTransit(RAWANG, KAJANG, dayAfter(firstEnd.until));
    assert.match(plan.note, /timetable is out of date, so its trains aren’t included/);
    assert.equal(plan.outdated.length, 1);
    assert.match(planTransit(KL_SENTRAL, KLCC, dayAfter(firstEnd.until)).note, /out of date/, 'even when other lines get you there');
  }
  const plan = planTransit(KL_SENTRAL, KLCC, dayAfter(lastEnd.until));
  assert.deepEqual(plan.trips, []);
  assert.match(plan.note, /^Train timetables are out of date/);
  assert.doesNotMatch(plan.note, /No trains/);
  assert.equal(planTransit(KL_SENTRAL, KLCC, WEDNESDAY_9AM).outdated, undefined, 'not before then');
});

// A fake router: every walk is `extra(leg)` seconds longer than estimated, along a three-point path.
function fakeRouter(plan, extra) {
  const asked = [];
  const walks = plan.trips.flatMap((t) => t.legs).filter((l) => l.mode === 'walk');
  const fetch = async (url, init) => {
    const [a, b] = JSON.parse(init.body).locations;
    asked.push([a, b]);
    const est = walks.find((l) => Math.abs(l.from.lat - a.lat) < 1e-5 && Math.abs(l.from.lng - a.lon) < 1e-5 && Math.abs(l.to.lat - b.lat) < 1e-5 && Math.abs(l.to.lng - b.lon) < 1e-5);
    const more = est && extra(est);
    if (more == null) return new Response('', { status: 500 });
    return Response.json({ trip: { summary: { length: 0.4, time: est.duration + more }, legs: [{ shape: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' }] } });
  };
  return { asked, fetch };
}

async function withFetch(fetch, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

test('asks the public router for 3 walks at most, top trip first, and remembers them for a day', async () => {
  const now = Date.now() + 10 * 86400_000; // its own slice of the walk cache
  const plan = planTransit(KAJANG, MID_VALLEY, WEDNESDAY_9AM);
  const walks = plan.trips.flatMap((t) => t.legs).filter((l) => l.mode === 'walk' && l.distance > 30);
  assert.ok(new Set(walks.map((l) => `${l.from.lat},${l.to.lat}`)).size > 3, 'more walks than that to choose from');
  const top = plan.trips[0];
  const router = fakeRouter(plan, () => 60);
  await withFetch(router.fetch, () => withRealWalks({ ROUTING_URL: 'https://routing.test/route' }, plan, { now }));
  assert.equal(router.asked.length, 3);
  const asked = (l) => router.asked.some(([a, b]) => Math.abs(a.lat - l.from.lat) < 1e-5 && Math.abs(b.lat - l.to.lat) < 1e-5);
  assert.ok(asked(top.legs[0]) && asked(top.legs.at(-1)), 'the top trip’s first and last walks');

  // The same trip again: those three come from memory, and three more are asked for.
  const again = planTransit(KAJANG, MID_VALLEY, WEDNESDAY_9AM);
  const second = fakeRouter(again, () => 60);
  await withFetch(second.fetch, () => withRealWalks({ ROUTING_URL: 'https://routing.test/route' }, again, { now: now + 3600_000 }));
  assert.ok(second.asked.length <= 3 && !second.asked.some(([a, b]) => router.asked.some(([c, d]) => a.lat === c.lat && b.lat === d.lat)));
  assert.equal(again.trips.find((t) => t.legs[0].from.lat === top.legs[0].from.lat).legs[0].coords.length, 3, 'a remembered walk is still drawn');

  // A day later they're asked for again.
  const later = planTransit(KAJANG, MID_VALLEY, WEDNESDAY_9AM);
  const third = fakeRouter(later, () => 60);
  await withFetch(third.fetch, () => withRealWalks({ ROUTING_URL: 'https://routing.test/route' }, later, { now: now + 25 * 3600_000 }));
  assert.equal(third.asked.length, 3);
  assert.ok(third.asked.some(([a, b]) => Math.abs(a.lat - top.legs[0].from.lat) < 1e-5 && Math.abs(b.lat - top.legs[0].to.lat) < 1e-5));
});

test('a longer walk than estimated catches the next KTM train, not a train that has already gone', async () => {
  const station = [101.575012, 3.318955]; // Rawang
  const start = [station[0] + 0.004, station[1]]; // ~450 m away
  const plan = planTransit(start, KAJANG, WEDNESDAY_9AM);
  const trip = plan.trips[0];
  const ktm = trip.legs[1];
  assert.equal(ktm.line.kind, 'KTM Komuter');
  assert.equal(ktm.every, null, 'a timetabled line');
  const missed = ktm.depart; // the leg is updated in place
  const missedBy = ktm.wait + 120; // reaches the platform two minutes after that train leaves
  const router = fakeRouter(plan, (l) => (l === trip.legs[0] ? missedBy : null));
  await withFetch(router.fetch, () => withRealWalks({ ROUTING_URL: 'https://routing.test/route' }, plan, { now: Date.now() + 40 * 86400_000 }));
  const after = plan.trips.find((t) => t.legs[1].line?.id === ktm.line.id) ?? plan.trips[0];
  const reach = after.depart + after.legs[0].duration * 1000;
  const next = planTransit(station, KAJANG, reach).trips[0].legs.find((l) => l.mode === 'train');
  assert.equal(after.legs[1].depart, next.depart, 'the next train from Rawang after reaching it');
  assert.ok(after.legs[1].depart > missed, 'not the train that left before');
  assert.equal(after.legs[1].wait, (after.legs[1].depart - reach) / 1000);
  assert.equal(after.arrive - after.depart, after.duration * 1000);
});

test('trips by train are counted with routes', async () => {
  const src = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../src/worker.js', import.meta.url), 'utf8'));
  const route = src.slice(src.indexOf("path === '/api/transit'"), src.indexOf("path === '/api/route'"));
  assert.match(route, /count\('routes'\)/);
});

test('other ways there, not three versions of the same one', () => {
  // Kinrara BK5 to Q Sentral: into town on the Sri Petaling Line, or off it at Sungai Besi for the Putrajaya Line to
  // TRX and the Kajang Line to Muzium Negara.
  const plan = planTransit(KINRARA_BK5, Q_SENTRAL, WEDNESDAY_9AM);
  const lines = plan.trips.map((t) => trains(t).map((l) => l.line.short).join('>'));
  assert.ok(lines.includes('SPL>PYL>KGL'), lines.join(' | '));
  assert.equal(new Set(lines).size, lines.length, 'no two on the same lines');
  // The Ampang and Sri Petaling Lines share their track into town: riding either there is one option, not two.
  const mj = planTransit(MASJID_JAMEK, TRX, WEDNESDAY_9AM).trips.map((t) => trains(t).map((l) => `${l.from.name}>${l.to.name}`).join('|'));
  assert.equal(new Set(mj).size, mj.length, mj.join(' / '));
});

test('planned on a train: the trip starts on it, not with a walk to a station', () => {
  const plan = planTransit(ON_KJ, KLCC, WEDNESDAY_9AM, { moving: { speed: 14, heading: 10 } });
  const first = plan.trips[0].legs[0];
  assert.equal(first.mode, 'train', 'no walk first');
  assert.ok(first.aboard);
  assert.equal(first.line.short, 'KJL');
  assert.equal(first.from.name, 'Pasar Seni', 'from the stop it just left');
  assert.equal(first.wait, 0);
  assert.ok(first.arrive - WEDNESDAY_9AM < 20 * 60_000, 'KLCC soon, not after a wait for the next train');
  // The train the other way, and standing still beside the line, aren't the same.
  assert.notEqual(planTransit(ON_KJ, KLCC, WEDNESDAY_9AM, { moving: { speed: 14, heading: 190 } }).trips[0].legs[0].towards, first.towards);
  assert.equal(planTransit(ON_KJ, KLCC, WEDNESDAY_9AM).trips[0].legs[0].mode, 'walk');
  assert.equal(planTransit(ON_KJ, KLCC, WEDNESDAY_9AM, { moving: { speed: 2, heading: 10 } }).trips[0].legs[0].mode, 'walk', 'walking pace');
});

test('the real walks don\'t make you wait for the train you\'re on', async () => {
  const plan = planTransit(ON_KJ, KLCC, WEDNESDAY_9AM, { moving: { speed: 14, heading: 10 } });
  const before = plan.trips[0].legs[0].arrive;
  await withRealWalks({}, plan, { now: WEDNESDAY_9AM });
  assert.equal(plan.trips[0].legs[0].arrive, before);
  assert.equal(plan.trips[0].legs[0].wait, 0);
});

test('the last train of the night is marked', () => {
  const late = WEDNESDAY_9AM + 14 * 3600_000 + 20 * 60_000; // 11:20pm
  const plans = [planTransit(KL_SENTRAL, KLCC, WEDNESDAY_9AM), planTransit(KL_SENTRAL, KLCC, late)];
  assert.ok(!plans[0].trips.some((t) => t.lastTrain), 'not in the morning');
  const marked = plans[1].trips.filter((t) => t.lastTrain);
  assert.ok(marked.length, 'the Monorail ends before midnight');
  for (const t of marked) assert.ok(t.legs.some((l) => l.last));
});
