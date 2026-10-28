// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weatherAlong, readMetText, metPeriod, warningsFor, nearestTown, skyFromCondition, cellOf, metNorwayAt } from '../src/lib/weather.js';
import { weatherPoints, weatherQuery, describeTrip, wetAhead, spokenWeather, restTip, restReminder, drivesAtNight } from '../public/weather.js';
import { formatDuration } from '../public/geo.js';
import { cumulative } from '../public/geo.js';
import { sharedCache } from '../src/lib/shared-cache.js';
import { createD1 } from './d1-shim.js';

const KL = [101.6953, 3.1478];
const SEREMBAN = [101.94, 2.7258];
const MYT = (s) => Date.parse(`${s}+08:00`);
const NOW = MYT('2026-10-28T14:00:00');

// A shared cache as the Worker has it: a D1 table, plus one Worker instance's memory.
async function sharedDb() {
  const db = createD1();
  await db.prepare('CREATE TABLE shared_cache (key TEXT PRIMARY KEY, body TEXT NOT NULL, expires_at INTEGER NOT NULL)').run();
  return db;
}
const fakeCache = async (db) => sharedCache(db ?? (await sharedDb()), { memory: new Map() });

function withFetch(handler) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { calls, restore: () => (globalThis.fetch = orig) };
}

const klTown = nearestTown(KL);
const metRows = (forecast) => [
  { location: { location_id: klTown.id, location_name: klTown.name }, date: '2026-10-28', morning_forecast: 'Tiada Hujan', afternoon_forecast: forecast, night_forecast: 'Tiada hujan', summary_forecast: forecast, summary_when: 'Petang', min_temp: 24, max_temp: 33 },
];
const WARNING = {
  warning_issue: { issued: '2026-10-28T12:00:00', title_en: 'Thunderstorms Warning' },
  valid_from: '2026-10-28T12:00:00',
  valid_to: '2026-10-28T17:00:00',
  text_en: '1) Thunderstorms, heavy rain and strong winds are expected over the states of Sarawak: Miri until 3:00 PM. 2) Thunderstorms, heavy rain and strong winds are expected over the state of Selangor (Gombak and Petaling) and W.P. Kuala Lumpur until 5:00 PM.',
};
// MET Norway's Locationforecast for the hours around NOW: 31°C and 78% humidity.
const metNorway = () => Response.json({ properties: { timeseries: [-1, 0, 1, 2].map((h) => ({
  time: new Date(NOW + h * 3600_000).toISOString(), data: { instant: { details: { air_temperature: 31 + h * 0.1, relative_humidity: 78 } } },
})) } });
const SEA = { ...WARNING, warning_issue: { title_en: 'Strong Winds and Rough Seas Warning' }, text_en: 'Rough seas over the waters of Selangor.' };

test('MET Malaysia wording is read into rain, storms and dry spells', () => {
  assert.deepEqual(readMetText('Tiada Hujan'), { sky: 'clear', chance: 0.1, text: 'No rain' });
  assert.equal(readMetText('Ribut petir di beberapa tempat').text, 'Thunderstorms in places');
  assert.equal(readMetText('Ribut petir di beberapa tempat').sky, 'storm');
  assert.equal(readMetText('Hujan di kebanyakan tempat di kawasan pedalaman').text, 'Rain in most places inland');
  assert.equal(readMetText('Hujan menyeluruh').chance, 0.8);
  assert.equal(readMetText('Berangin').sky, 'windy');
  assert.equal(readMetText('???'), null);
});

test("MET Malaysia's morning, afternoon and night are in Malaysia time; small hours belong to the night before", () => {
  assert.deepEqual(metPeriod(MYT('2026-10-28T08:00:00')), { date: '2026-10-28', part: 'morning' });
  assert.deepEqual(metPeriod(MYT('2026-10-28T15:30:00')), { date: '2026-10-28', part: 'afternoon' });
  assert.deepEqual(metPeriod(MYT('2026-10-28T22:00:00')), { date: '2026-10-28', part: 'night' });
  assert.deepEqual(metPeriod(MYT('2026-10-29T02:00:00')), { date: '2026-10-28', part: 'night' });
});

test('WeatherKit conditions map to what a driver cares about', () => {
  assert.equal(skyFromCondition('ScatteredThunderstorms'), 'storm');
  assert.equal(skyFromCondition('HeavyRain'), 'heavy-rain');
  assert.equal(skyFromCondition('Drizzle'), 'rain');
  assert.equal(skyFromCondition('MostlyCloudy', 10), 'heavy-rain', 'heavy rain by the amount');
  assert.equal(skyFromCondition('MostlyClear'), 'clear');
  assert.deepEqual(cellOf([101.6953, 3.1478]), [3.1, 101.7]);
});

test('every MET Malaysia place has a position in Malaysia, and the nearest one is found', () => {
  assert.ok(klTown, 'a MET town near Kuala Lumpur');
  assert.match(klTown.state, /kuala lumpur|selangor/i);
  assert.equal(nearestTown([110, 20]), null, 'nothing out at sea');
});

test("MET Norway's humidity is read for the hour of arrival, and not from a stale hour", () => {
  const hours = [[NOW, 30, 0.8], [NOW + 3600_000, 31, 0.75]];
  assert.deepEqual(metNorwayAt(hours, NOW + 3000_000), { temp: 31, humidity: 0.75 });
  assert.deepEqual(metNorwayAt(hours, NOW + 600_000), { temp: 30, humidity: 0.8 });
  assert.equal(metNorwayAt(hours, NOW + 8 * 3600_000), null);
  assert.equal(metNorwayAt([[NOW, 30, NaN]], NOW), null);
});

test('warnings are cut down to the states on the route, and sea warnings are left out', () => {
  const ws = warningsFor([WARNING, SEA], ['Federal Territory of Kuala Lumpur'], NOW, NOW + 3600_000);
  assert.equal(ws.length, 1);
  assert.match(ws[0].text, /Selangor/);
  assert.doesNotMatch(ws[0].text, /Miri/);
  assert.equal(warningsFor([WARNING], ['Johor'], NOW, NOW + 3600_000).length, 0, 'not on the route');
  assert.equal(warningsFor([WARNING], ['Selangor'], NOW + 4 * 3600_000, NOW + 5 * 3600_000).length, 0, 'over by then');
});

test('without a WeatherKit key, the forecast comes from MET Malaysia, fetched once and cached', async () => {
  const f = withFetch((url) => {
    if (url.includes('/weather/forecast')) return Response.json(metRows('Ribut petir di beberapa tempat'));
    if (url.includes('/weather/warning')) return Response.json([WARNING, SEA]);
    if (url.includes('api.met.no')) return metNorway();
    throw new Error(`unexpected ${url}`);
  });
  try {
    const db = await sharedDb();
    const store = await fakeCache(db);
    const pts = [{ lng: KL[0], lat: KL[1], at: NOW + 1800_000 }, { lng: KL[0], lat: KL[1], at: NOW + 3600_000 }];
    const a = await weatherAlong({}, pts, { now: NOW, store });
    assert.equal(a.points[0].sky, 'storm');
    assert.equal(a.points[1].source, 'met');
    assert.equal(a.points[1].high, 33);
    assert.equal(a.points[0].humidity, undefined, 'humidity only for the destination');
    assert.equal(a.points[1].humidity, 0.78, 'from MET Norway');
    assert.equal(a.points[1].temp, 31.1, 'the hour of arrival');
    assert.match(f.calls.find((c) => c.url.includes('api.met.no')).init.headers['user-agent'], /^a2b-navigation\/.+\(\+https:/, 'says who is asking');
    assert.equal(a.warnings.length, 1);
    assert.deepEqual(a.sources.map((s) => s.name), ['MET Malaysia', 'MET Norway']);
    await weatherAlong({}, pts, { now: NOW, store });
    assert.equal(f.calls.length, 3, 'forecast, warnings and humidity once each, then from the cache');
    const other = await weatherAlong({}, pts, { now: NOW, store: await fakeCache(db) });
    assert.equal(f.calls.length, 3, 'another Worker instance reads them from D1');
    assert.deepEqual(other.points, a.points);
    const far = await weatherAlong({}, [{ lng: 110, lat: 20, at: NOW }], { now: NOW, store });
    assert.deepEqual(far.points, [null], 'no forecast far from any MET place');
  } finally {
    f.restore();
  }
});

test('with a WeatherKit key, each square is fetched once with a signed token; MET Malaysia fills in when it fails', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  const env = { WEATHERKIT_TEAM_ID: 'TEAM123', WEATHERKIT_SERVICE_ID: 'my.a2b.weather', WEATHERKIT_KEY_ID: 'KEY456', WEATHERKIT_KEY: `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----` };
  let kitDown = false;
  const f = withFetch((url) => {
    if (url.includes('weatherkit.apple.com')) {
      if (kitDown) return new Response('nope', { status: 500 });
      const start = Date.parse('2026-10-28T06:00:00Z');
      return Response.json({ forecastHourly: { hours: [0, 1, 2].map((h) => ({ forecastStart: new Date(start + h * 3600_000).toISOString(), conditionCode: h === 1 ? 'HeavyRain' : 'Cloudy', temperature: 30, temperatureApparent: 36, humidity: 0.82, precipitationChance: h === 1 ? 0.8 : 0.1, precipitationIntensity: h === 1 ? 9 : 0 })) } });
    }
    if (url.includes('/weather/forecast')) return Response.json(metRows('Hujan di beberapa tempat'));
    if (url.includes('/weather/warning')) return Response.json([]);
    if (url.includes('api.met.no')) return metNorway();
    throw new Error(`unexpected ${url}`);
  });
  try {
    const pts = [{ lng: KL[0], lat: KL[1], at: NOW }, { lng: KL[0] - 0.01, lat: KL[1] - 0.01, at: NOW + 3600_000 }];
    const a = await weatherAlong(env, pts, { now: NOW, store: await fakeCache() });
    const kit = f.calls.filter((c) => c.url.includes('weatherkit'));
    assert.equal(kit.length, 1, 'both points are in one square');
    assert.match(kit[0].url, /\/en\/3\.1\/101\.7\?dataSets=forecastHourly/);
    assert.deepEqual([a.points[0].sky, a.points[1].sky], ['cloudy', 'heavy-rain']);
    assert.equal(a.points[1].feels, 36);
    assert.equal(a.points[1].humidity, 0.82);
    assert.deepEqual(a.sources.map((s) => s.name), [' Weather']);
    assert.ok(!f.calls.some((c) => c.url.includes('api.met.no')), 'WeatherKit has humidity already');

    const [head, body, sig] = kit[0].init.headers.authorization.replace('Bearer ', '').split('.');
    const read = (s) => JSON.parse(Buffer.from(s, 'base64url'));
    assert.deepEqual(read(head), { alg: 'ES256', kid: 'KEY456', id: 'TEAM123.my.a2b.weather' });
    assert.equal(read(body).iss, 'TEAM123');
    assert.equal(read(body).sub, 'my.a2b.weather');
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, Buffer.from(sig, 'base64url'), new TextEncoder().encode(`${head}.${body}`));
    assert.ok(ok, 'the token is signed with the key');

    kitDown = true;
    const b = await weatherAlong(env, [{ lng: SEREMBAN[0], lat: SEREMBAN[1], at: NOW }], { now: NOW, store: await fakeCache() });
    assert.equal(b.points[0]?.source ?? 'met', 'met', 'MET Malaysia, not an error');
  } finally {
    f.restore();
  }
});

// ---------- The app's side ----------
const line = Array.from({ length: 101 }, (_, i) => [101.69 + i * 0.006, 3.15 - i * 0.0042]); // ~80 km to the south-east
const route = { coords: line, cum: cumulative(line), duration: 3600 };
const clock = (at) => new Date(at + 8 * 3600_000).toISOString().slice(11, 16);

test('a route is asked about every ~15 km at the time the driver passes, ending at the destination on arrival', () => {
  const pts = weatherPoints(route, NOW);
  assert.ok(pts.length >= 5 && pts.length <= 8, `${pts.length} points`);
  assert.deepEqual([pts.at(-1).lng, pts.at(-1).lat], line.at(-1));
  assert.equal(pts.at(-1).at, NOW + 3600_000);
  assert.ok(pts.every((p, i) => !i || (p.at > pts[i - 1].at && p.along > pts[i - 1].along)));
  assert.match(weatherQuery(pts.slice(0, 1)), /^pts=101\.\d{3},3\.\d{3},\d{10}$/);
  assert.deepEqual(weatherPoints({ coords: [line[0], line[0]], duration: 0 }), [], 'nowhere to go');
});

const hourOf = (t) => new Date(t + 8 * 3600_000).getUTCHours(); // Malaysia time, whatever the test machine's zone
const opts = { clock, duration: formatDuration, now: NOW, hourOf };
const hour = { start: NOW, seconds: 3600 }; // a 1-hour drive at 2pm: no rest tip

test('the route sheet says in short points what may happen on arrival and on the way, and what to bring', () => {
  const pts = weatherPoints(route, NOW);
  const dry = { sky: 'clear', chance: 0.1, text: 'No rain', low: 24, high: 33, source: 'met' };
  const points = pts.map(() => dry);
  points[3] = { sky: 'storm', chance: 0.4, text: 'Thunderstorms in places', place: 'Kajang', source: 'met' };
  points[points.length - 1] = { sky: 'rain', chance: 0.7, text: 'Rain in most places', low: 24, high: 32, place: 'Seremban', source: 'met' };
  const warning = { title: 'Thunderstorms Warning', until: MYT('2026-10-28T17:00:00') };
  const trip = describeTrip({ points, warnings: [warning], sources: [{ name: 'MET Malaysia' }] }, pts, hour, opts);
  assert.deepEqual(trip.lines, [
    `Rain possible on arrival (${clock(pts.at(-1).at)}, 24–32°C)`,
    `Storms possible near Kajang around ${clock(pts[3].at)}`,
    'MET Malaysia: Thunderstorms warning until 17:00',
  ]);
  assert.deepEqual(trip.tips, ['Umbrella or raincoat; avoid light colours', 'If it pours: slow down, headlights on']);
  assert.equal(trip.sky, 'storm');

  // Rain forecast for a spot the driver reaches in a few minutes: it may be raining there already.
  points[1] = { sky: 'rain', chance: 0.7, text: 'Rain', place: 'Ampang', source: 'met' };
  points[3] = dry;
  const soon = describeTrip({ points, warnings: [] }, pts, hour, { ...opts, now: pts[1].at - 10 * 60_000 });
  assert.equal(soon.lines[1], 'Rain possible near Ampang now');

  const sunny = describeTrip({ points: pts.map(() => ({ sky: 'clear', chance: 0.05, text: 'Clear', temp: 34, feels: 39, humidity: 0.5, source: 'weatherkit' })), warnings: [] }, pts, hour, opts);
  assert.deepEqual(sunny.lines, [`Likely dry on arrival (${clock(pts.at(-1).at)}, 34°C)`]);
  assert.deepEqual(sunny.tips, ['May be hot: light clothes and water']);
  const highlands = describeTrip({ points: [{ sky: 'cloudy', text: 'Cloudy', temp: 18, humidity: 0.9, source: 'met' }], warnings: [] }, pts.slice(-1), hour, opts);
  assert.deepEqual(highlands.tips, ['May be cool: bring a jacket'], 'cool wins over humid');
  const sticky = describeTrip({ points: [{ sky: 'cloudy', text: 'Mostly cloudy', temp: 31, feels: 35, humidity: 0.78, source: 'weatherkit' }], warnings: [] }, pts.slice(-1), hour, opts);
  assert.deepEqual(sticky.tips, ['May be humid: skip long sleeves, jackets and shirts that show sweat']);
  const dryHeat = describeTrip({ points: [{ sky: 'clear', text: 'Clear', temp: 31, feels: 33, humidity: 0.5, source: 'weatherkit' }], warnings: [] }, pts.slice(-1), hour, opts);
  assert.deepEqual(dryHeat.tips, [], 'not humid enough');
  for (const t of [trip, soon, sunny, highlands]) {
    assert.doesNotMatch(t.lines.join(' '), /will|expected/i, 'never certain');
    assert.ok([...t.lines, ...t.tips].every((l) => l.length <= 70), 'short enough to read at a glance');
  }
  assert.equal(describeTrip({ points: [null], warnings: [] }, pts.slice(-1), hour, opts), null, 'nothing known, nothing shown');
});

test('long and night drives get a tip to rest, even without a forecast', () => {
  const at = (s) => ({ start: MYT(s), seconds: 0 });
  assert.equal(restTip({ ...at('2026-10-28T14:00:00'), seconds: 2.9 * 3600 }, formatDuration, hourOf), 'Long drive (2 h 54 min): rest every 2 hours');
  assert.equal(restTip({ ...at('2026-10-28T21:00:00'), seconds: 1.5 * 3600 }, formatDuration, hourOf), 'Night drive: stop and rest if you feel sleepy');
  assert.equal(restTip({ ...at('2026-10-28T18:30:00'), seconds: 3 * 3600 }, formatDuration, hourOf), 'Long night drive (3 h): rest every 2 hours, sooner if sleepy', 'runs past 8pm');
  assert.equal(restTip({ ...at('2026-10-28T23:00:00'), seconds: 1800 }, formatDuration, hourOf), '', 'a short hop at night');
  assert.equal(restTip({ ...at('2026-10-28T09:00:00'), seconds: 5400 }, formatDuration, hourOf), '', 'a daytime drive under 2 hours');
  assert.ok(drivesAtNight(MYT('2026-10-29T05:30:00'), 0, hourOf));
  assert.ok(!drivesAtNight(MYT('2026-10-29T06:00:00'), 3600, hourOf));

  const trip = describeTrip(null, [], { start: MYT('2026-10-28T22:00:00'), seconds: 4 * 3600 }, opts);
  assert.deepEqual(trip, { sky: 'rest', lines: [], tips: ['Long night drive (4 h): rest every 2 hours, sooner if sleepy'], sources: [] });
});

test('while driving, a rest reminder comes after every 2 hours at the wheel', () => {
  assert.equal(restReminder(100 * 60, 0, false), '');
  assert.equal(restReminder(2 * 3600 + 5, 0, false), "You've been driving for 2 hours. Take a break at the next rest stop.");
  assert.equal(restReminder(2 * 3600 + 600, 1, false), '', 'said once');
  assert.equal(restReminder(4 * 3600, 1, true), "You've been driving for 4 hours. Take a break at the next rest stop, especially if you feel sleepy.");
});

test('while driving, a likely wet stretch a few km ahead is announced', () => {
  const pts = weatherPoints(route, NOW);
  const points = pts.map(() => null);
  points[2] = { sky: 'heavy-rain', chance: 0.8, place: 'Kajang' };
  const answer = { points };
  assert.equal(wetAhead(answer, pts, 0), null, 'still far off');
  const near = wetAhead(answer, pts, pts[2].along - 5000);
  assert.equal(near.i, 2);
  assert.equal(spokenWeather(near), 'It may rain heavily ahead near Kajang. Drive carefully.');
  assert.equal(spokenWeather({ sky: 'storm' }), 'There may be thunderstorms ahead. Drive carefully.');
  assert.equal(wetAhead(answer, pts, pts[2].along + 100), null, 'already passed');
  points[2] = { sky: 'storm', chance: 0.4 };
  assert.equal(wetAhead(answer, pts, pts[2].along - 5000), null, 'too unsure to say out loud');
});

test('the shared cache fetches once for drivers asking together, keeps answers until they expire, and never keeps a failure', async () => {
  const db = await sharedDb();
  let t = 1_000_000, loads = 0;
  const now = () => t;
  const a = sharedCache(db, { memory: new Map(), now });
  const b = sharedCache(db, { memory: new Map(), now });
  const load = async () => (loads++, { n: loads });
  const together = await Promise.all([a.get('k', 60, load), a.get('k', 60, load), a.get('k', 60, load)]);
  assert.deepEqual(together, [{ n: 1 }, { n: 1 }, { n: 1 }]);
  assert.deepEqual(await b.get('k', 60, load), { n: 1 }, 'from D1 in another instance');
  assert.equal(loads, 1);
  t += 61_000;
  assert.deepEqual(await b.get('k', 60, load), { n: 2 }, 'expired, so fetched again');
  assert.deepEqual(await a.get('k', 60, load), { n: 2 }, 'and shared again');

  await assert.rejects(a.get('bad', 60, async () => { throw new Error('down'); }));
  assert.deepEqual(await a.get('bad', 60, async () => 'up'), 'up', 'the failure was not kept');
  assert.deepEqual(await sharedCache(null, { memory: new Map(), now }).get('k', 60, async () => 'no db'), 'no db', 'works without D1');
});
