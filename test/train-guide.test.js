// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TrainGuide, trackOf, snap, pointAt, stationAlongs, alongAtTime, timeAtAlong, nextStop, shouldAlert, alighted, boarded, markerFor, alreadyOn, DWELL_S, OFF_MS, OFF_FAST_MS, HERE_TRUST_MS,
} from '../public/train-guide.js';
import { planTransit, feeds } from '../src/lib/transit.js';
import { canReportFrom } from '../public/report-types.js';
import { readFile } from 'node:fs/promises';

// A straight line north along 101.7°E: four stations 1 km apart, 2 minutes between each.
const lat = (m) => 3 + m / 111_195; // metres north, as geo.js measures them
const COORDS = [[101.7, lat(0)], [101.7, lat(1000)], [101.7, lat(2000)], [101.7, lat(3000)]];
const STATIONS = [['A', lat(0), 101.7, 0], ['B', lat(1000), 101.7, 120], ['C', lat(2000), 101.7, 240], ['D', lat(3000), 101.7, 360]];
const T0 = Date.parse('2026-11-04T09:00:00+08:00');
const ride = (o = {}) => ({
  mode: 'train', line: { id: 'x:KJ', short: 'KJ', name: 'Kelana Jaya Line', color: '#e0115f', text: '#fff' }, towards: 'Gombak',
  from: { name: 'A', lat: lat(0), lng: 101.7 }, to: { name: 'D', lat: lat(3000), lng: 101.7 }, stops: 3, wait: 120,
  depart: T0 + 300_000, arrive: T0 + 660_000, duration: 360, coords: COORDS, stations: STATIONS, ...o,
});
const walk = (from, to, m) => ({ mode: 'walk', from, to, distance: m, duration: m / 1.25, coords: [[from.lng, from.lat], [to.lng, to.lat]] });
const fix = (m, o = {}) => ({ lngLat: [101.7, lat(m)], speed: 15, accuracy: 10, ...o });

test('along the track: snapping, points and the stations', () => {
  const track = trackOf(COORDS);
  const s = snap(track, [101.7005, lat(1500)]);
  assert.ok(Math.abs(s.along - 1500) < 3 && s.off > 50 && s.off < 60, JSON.stringify(s));
  assert.ok(Math.abs(pointAt(track, 2500).pos[1] - lat(2500)) < 1e-6);
  assert.ok(Math.abs(pointAt(track, 2500).heading) < 1, 'heading north');
  assert.deepEqual(stationAlongs(track, STATIONS).map((x) => Math.round(x / 10) * 10), [0, 1000, 2000, 3000]);
});

test('time and place on a ride, from the timetable, standing at each station', () => {
  const times = [0, 120, 240, 360], alongs = [0, 1000, 2000, 3000];
  assert.equal(alongAtTime(times, alongs, 60), 500);
  assert.equal(alongAtTime(times, alongs, 120 + DWELL_S / 2), 1000, 'standing at B');
  assert.ok(alongAtTime(times, alongs, 200) > 1000 && alongAtTime(times, alongs, 200) < 2000);
  assert.equal(alongAtTime(times, alongs, 999), 3000);
  for (const t of [30, 160, 300]) assert.ok(Math.abs(timeAtAlong(times, alongs, alongAtTime(times, alongs, t)) - t) < 1e-6, `${t}`);
  assert.equal(nextStop(alongs, 0), 1);
  assert.equal(nextStop(alongs, 1100), 2);
});

test('when to say "get off at the next stop", and when you have', () => {
  const g = { times: [0, 120, 240, 360], alongs: [0, 1000, 2000, 3000] };
  assert.ok(!shouldAlert({ ...g, along: 1900, sinceBoard: 200 }));
  assert.ok(shouldAlert({ ...g, along: 2100, sinceBoard: 200 }), 'left the stop before yours');
  assert.ok(shouldAlert({ ...g, along: 1500, sinceBoard: 275 }), 'or 90 s to go, by the clock');
  assert.ok(!alighted({ ...g, along: 2900, sinceBoard: 360 }));
  assert.ok(alighted({ ...g, along: 2970, sinceBoard: 300 }));
  assert.ok(alighted({ ...g, along: 2500, sinceBoard: 360 + DWELL_S }), 'underground: by the clock');
});

test('boarding: moving fast along the line, or the train time passes at the station', () => {
  assert.ok(boarded({ speed: 12, off: 20, now: 0, departAt: 1e9, atStation: false }));
  assert.ok(!boarded({ speed: 12, off: 300, now: 0, departAt: 1e9, atStation: false }), 'a car beside it is not the train');
  assert.ok(!boarded({ speed: 1.2, off: 5, now: 0, departAt: 1e9, atStation: true }), 'walking on the platform');
  assert.ok(boarded({ speed: null, off: Infinity, now: 100_000, departAt: 60_000, atStation: true }));
});

test('a whole trip: walk, ride, the alert once, a change, the walk at the end', () => {
  const start = { name: 'Start', lat: lat(-300), lng: 101.7 };
  const second = ride({
    line: { id: 'x:SP', short: 'SP', name: 'Sri Petaling Line', color: '#7f2b0a', text: '#fff' }, towards: 'Putra Heights',
    from: { name: 'D', lat: lat(3000), lng: 101.7 }, to: { name: 'F', lat: lat(5000), lng: 101.7 },
    depart: T0 + 900_000, coords: [[101.7, lat(3000)], [101.7, lat(5000)]], stations: [['D', lat(3000), 101.7, 0], ['E', lat(4000), 101.7, 120], ['F', lat(5000), 101.7, 240]],
  });
  const end = { name: 'Destination', lat: lat(5200), lng: 101.7 };
  const trip = { legs: [walk(start, ride().from, 300), ride(), second, walk(second.to, end, 200)] };
  const g = new TrainGuide(trip, { now: T0 });
  const said = [];
  const step = (o) => {
    const r = g.update(o);
    said.push(...r.events.map((e) => e.type));
    return r.view;
  };

  assert.equal(step({ now: T0, fix: fix(-300, { speed: 1.3 }) }).kind, 'walk');
  assert.ok(step({ now: T0 + 60_000, fix: fix(-150, { speed: 1.3 }) }).left > 100);
  assert.equal(step({ now: T0 + 200_000, fix: fix(-20, { speed: 1 }) }).kind, 'wait', 'at the station');
  assert.equal(step({ now: T0 + 290_000, fix: fix(0, { speed: 0.5 }) }).kind, 'wait');
  let v = step({ now: T0 + 340_000, fix: fix(300, { speed: 14 }) });
  assert.equal(v.kind, 'ride');
  assert.deepEqual([v.next, v.stopsToGo], ['B', 3]);
  // Underground: no GPS at all. The estimate carries on from the timetable.
  v = step({ now: T0 + 400_000, fix: null });
  assert.ok(v.estimating, 'estimating');
  assert.equal(v.next, 'B');
  v = step({ now: T0 + 560_000, fix: null });
  assert.equal(v.next, 'D');
  assert.ok(!v.alerted, 'standing at C, not yet');
  v = step({ now: T0 + 580_000, fix: null }); // 90 s before D
  assert.ok(v.alerted && said.filter((x) => x === 'alert').length === 1, 'said once');
  step({ now: T0 + 590_000, fix: null });
  assert.equal(said.filter((x) => x === 'alert').length, 1);
  // GPS back at D: off, and change.
  step({ now: T0 + 640_000, fix: fix(2990, { speed: 0 }) });
  assert.ok(said.includes('change'), said.join());
  assert.equal(g.leg.line.short, 'SP');
  v = step({ now: T0 + 960_000, fix: fix(3400, { speed: 15 }) });
  assert.equal(v.kind, 'ride');
  step({ now: T0 + 1_100_000, fix: fix(4995, { speed: 0 }) });
  assert.ok(said.includes('alight'), said.join());
  step({ now: T0 + 1_200_000, fix: fix(5180, { speed: 1 }) });
  assert.ok(g.done && said.at(-1) === 'arrived', said.join());
});

test('GPS that comes back puts the estimate right', () => {
  const g = new TrainGuide({ legs: [ride(), walk(ride().to, { name: 'Destination', lat: lat(3100), lng: 101.7 }, 100)] }, { now: T0 });
  g.update({ now: T0 + 300_000, fix: fix(100, { speed: 12 }) });
  g.update({ now: T0 + 330_000, fix: null });
  const v = g.update({ now: T0 + 340_000, fix: fix(1600) }).view; // further on than the timetable says
  assert.ok(!v.estimating);
  assert.equal(v.next, 'C');
  const later = g.update({ now: T0 + 345_000, fix: null }).view;
  assert.ok(later.pos[1] >= lat(1590), 'carries on from there, not back to the timetable');
});

// A trip from a start 300 m south of A: the walk to A, then the ride A to D, then a short walk at the end.
const START = { name: 'Start', lat: lat(-300), lng: 101.7 };
const END = { name: 'Destination', lat: lat(3100), lng: 101.7 };
const oneRide = (o) => ({ legs: [walk(START, ride().from, 300), ride(o), walk(ride().to, END, 100)] });

test('a trip started on the platform skips the walk to it', () => {
  const g = new TrainGuide(oneRide(), { now: T0 });
  const r = g.update({ now: T0, fix: fix(-10, { speed: 0, accuracy: 25 }) });
  assert.equal(r.view.kind, 'wait');
  assert.deepEqual(r.events.map((e) => e.type), ['at-station']);
  // Inside the station GPS is vague: 140 m out at 150 m accuracy is still there.
  const vague = new TrainGuide(oneRide(), { now: T0 });
  assert.equal(vague.update({ now: T0, fix: fix(-140, { speed: 0, accuracy: 150 }) }).view.kind, 'wait');
  // A big station: 100 m from its point is still in it.
  assert.equal(new TrainGuide(oneRide(), { now: T0 }).update({ now: T0, fix: fix(-100, { speed: 0.5 }) }).view.kind, 'wait');
  assert.equal(new TrainGuide(oneRide(), { now: T0 }).update({ now: T0, fix: fix(-250, { speed: 0.5 }) }).view.kind, 'walk');
});

test('a trip started on the train goes straight to the ride, not a walk to the station', () => {
  const g = new TrainGuide(oneRide(), { now: T0 });
  const r = g.update({ now: T0, fix: fix(1400, { speed: 14, heading: 0 }) });
  assert.equal(r.view.kind, 'ride');
  assert.equal(r.view.next, 'C');
  assert.equal(r.events[0].type, 'boarded');
  assert.match(r.events[0].text, /2 stops to D/);
  // A car beside the line at the same speed is not the train.
  const car = new TrainGuide(oneRide(), { now: T0 });
  assert.equal(car.update({ now: T0, fix: { lngLat: [101.703, lat(1400)], speed: 14, accuracy: 10 } }).view.kind, 'walk');
});

test('on the train coming in to the station you board at: already on it', () => {
  const approach = [[101.7, lat(-1000)], [101.7, lat(0)]]; // the line in from the stop before A
  const hit = alreadyOn(ride({ approach }), trackOf(COORDS), fix(-600, { speed: 15, heading: 0 }));
  assert.deepEqual([hit.phase, hit.along, Math.round(hit.eta)], ['ride', 0, 40], '600 m out at 15 m/s');
  assert.equal(alreadyOn(ride({ approach }), trackOf(COORDS), fix(-600, { speed: 15, heading: 180 })), null, 'a train the other way');
  assert.equal(alreadyOn(ride(), trackOf(COORDS), fix(-600, { speed: 15, heading: 0 })), null, 'no track in: not guessed');
  const g = new TrainGuide(oneRide({ approach }), { now: T0 });
  let v = g.update({ now: T0, fix: fix(-600, { speed: 15, heading: 0 }) }).view;
  assert.deepEqual([v.kind, v.next, v.stopsToGo], ['ride', 'A', 4]);
  assert.ok(!v.off, 'coming in is not off the line');
  v = g.update({ now: T0 + 20_000, fix: null }).view; // into the tunnel before A
  assert.equal(v.next, 'A', 'not run on by the timetable before reaching A');
  v = g.update({ now: T0 + 100_000, fix: null }).view;
  assert.equal(v.next, 'B', 'past A by the clock');
});

test('off the trip: on a walk heading away, or off the line on a ride', () => {
  const g = new TrainGuide(oneRide(), { now: T0 });
  g.update({ now: T0, fix: fix(-300, { speed: 1.3 }) });
  const away = (t) => g.update({ now: T0 + t, fix: { lngLat: [101.703, lat(-400)], speed: 1.3, accuracy: 10 } }).view;
  assert.ok(!away(1000).off, 'not straight away: could be a wobble');
  assert.ok(away(1000 + OFF_MS).off);
  assert.equal(away(2000 + OFF_MS).pos[0], 101.703, 'the marker follows you');
  // Back on the walk: no longer off.
  assert.ok(!g.update({ now: T0 + 60_000, fix: fix(-200, { speed: 1.3 }) }).view.off);

  const r = new TrainGuide({ legs: [ride(), walk(ride().to, END, 100)] }, { now: T0 });
  r.update({ now: T0 + 300_000, fix: fix(100, { speed: 12 }) });
  const offLine = (t) => r.update({ now: T0 + t, fix: { lngLat: [101.71, lat(1000)], speed: 12, accuracy: 10 } }).view;
  offLine(310_000);
  const v = offLine(310_000 + OFF_MS);
  assert.ok(v.off && v.pos[0] === 101.71, 'off, and shown where GPS says');
  assert.ok(!v.estimating, 'good GPS off the line is not "no GPS"');
  // Underground with no GPS is never off.
  assert.ok(!r.update({ now: T0 + 400_000, fix: null }).view.off);
});

test('on another line: off within moments at train speed, where the track is known', () => {
  // Drawn along its track (points between the stations), as the LRT and MRT lines are.
  const TRACK = [];
  for (let m = 0; m <= 3000; m += 250) TRACK.push([101.7, lat(m)]);
  const shaped = () => ({ legs: [ride({ coords: TRACK }), walk(ride().to, END, 100)] });
  const east = (m) => ({ lngLat: [101.7 + 250 / 111_195, lat(m)], speed: 12, accuracy: 10 }); // 250 m off the line

  const r = new TrainGuide(shaped(), { now: T0 });
  r.update({ now: T0 + 300_000, fix: fix(100, { speed: 12 }) }); // on board
  r.update({ now: T0 + 310_000, fix: east(300) });
  assert.ok(!r.update({ now: T0 + 312_000, fix: east(330) }).view.off, 'not on the first fix');
  assert.ok(r.update({ now: T0 + 310_000 + OFF_FAST_MS, fix: east(360) }).view.off, `off after ${OFF_FAST_MS / 1000} s, not ${OFF_MS / 1000}`);

  // Walking pace that far off is a wobble or a platform walk, not another train: the usual 400 m and 15 s.
  const w = new TrainGuide(shaped(), { now: T0 });
  w.update({ now: T0 + 300_000, fix: fix(100, { speed: 12 }) });
  for (let t = 310_000; t <= 330_000; t += 5000) assert.ok(!w.update({ now: T0 + t, fix: { ...east(400), speed: 1.2 } }).view.off);

  // A line drawn station to station (KTM's feed has no tracks) can be that far off the train on a curve: no hurry.
  const k = new TrainGuide({ legs: [ride(), walk(ride().to, END, 100)] }, { now: T0 });
  k.update({ now: T0 + 300_000, fix: fix(100, { speed: 12 }) });
  k.update({ now: T0 + 310_000, fix: east(300) });
  assert.ok(!k.update({ now: T0 + 310_000 + OFF_FAST_MS, fix: east(360) }).view.off);

  // Waiting at A, then on a train going east, away from this line: off just as soon.
  const g = new TrainGuide(shaped(), { now: T0 });
  g.update({ now: T0, fix: fix(0, { speed: 0 }) });
  const away = (t, m) => g.update({ now: T0 + t, fix: { lngLat: [101.7 + m / 111_195, lat(0)], speed: 12, accuracy: 10 } }).view;
  away(10_000, 250);
  const v = away(10_000 + OFF_FAST_MS, 310);
  assert.equal(v.kind, 'wait');
  assert.ok(v.off, 'boarded the wrong train');
});

test('leaving the platform before the train comes: off the trip, the marker with you', () => {
  const g = new TrainGuide({ legs: [ride(), walk(ride().to, END, 100)] }, { now: T0 });
  const out = (t) => g.update({ now: T0 + t, fix: { lngLat: [101.706, lat(0)], speed: 1.2, accuracy: 10 } }).view;
  out(0);
  const v = out(OFF_MS);
  assert.equal(v.kind, 'wait');
  assert.ok(v.off);
  assert.equal(v.pos[0], 101.706);
});

test('"I\'m already here": at the station, on the train, at a stop', () => {
  const g = new TrainGuide(oneRide(), { now: T0 });
  g.update({ now: T0, fix: null });
  assert.equal(g.hereText(), 'I’m at A');
  assert.deepEqual(g.here({ now: T0 + 1000 }).map((e) => e.type), ['at-station']);
  assert.equal(g.update({ now: T0 + 2000, fix: null }).view.kind, 'wait');
  assert.equal(g.hereText(), 'I’m on the train');
  assert.deepEqual(g.here({ now: T0 + 3000 }).map((e) => e.type), ['boarded']);
  let v = g.update({ now: T0 + 4000, fix: null }).view;
  assert.deepEqual([v.kind, v.next], ['ride', 'B']);
  assert.equal(g.hereText(), 'I’m at B');
  // Underground, the train ran late: say you're at B, and the timetable carries on from there.
  const said = g.here({ now: T0 + 200_000 });
  assert.equal(said[0].type, 'here');
  assert.match(said[0].text, /At B\. 2 stops to D/);
  v = g.update({ now: T0 + 201_000, fix: null }).view;
  assert.equal(v.next, 'C');
  assert.ok(!v.estimating, 'just placed by hand');
  // Tapping the last stop: off the train.
  assert.ok(g.here({ now: T0 + 300_000, station: 3 }).some((e) => e.type === 'alight'));
  assert.equal(g.hereText(), 'I’ve arrived');
  assert.deepEqual(g.here({ now: T0 + 310_000 }).map((e) => e.type), ['arrived']);
  assert.ok(g.done);
});

test('after "I\'m already here", GPS that disagrees doesn\'t re-plan straight away', () => {
  const g = new TrainGuide(oneRide(), { now: T0 });
  g.update({ now: T0, fix: null });
  g.here({ now: T0 }); // at A, though GPS (wrong, indoors) puts you 1 km away
  const far = (t) => g.update({ now: T0 + t, fix: { lngLat: [101.71, lat(0)], speed: 0, accuracy: 30 } }).view;
  far(1000);
  assert.ok(!far(1000 + OFF_MS).off, 'you said where you are');
  far(HERE_TRUST_MS + 1000);
  assert.ok(far(HERE_TRUST_MS + 1000 + OFF_MS).off, 'but not for ever');
});

test('a trip planned on board starts on the train, even with no GPS', () => {
  const g = new TrainGuide({ legs: [ride({ aboard: true, depart: T0 - 60_000 }), walk(ride().to, END, 100)] }, { now: T0 });
  const r = g.update({ now: T0, fix: null });
  assert.equal(r.view.kind, 'ride');
  assert.match(r.events[0].text, /^Stay on the Kelana Jaya Line/);
  assert.equal(r.view.next, 'B', 'a minute after leaving A, by the clock');
});

test('when you\'ll get there: walking, waiting, riding, then the rest of the trip', () => {
  const trip = oneRide(); // walk 300 m, ride A to D (6 min), walk 100 m (80 s)
  const g = new TrainGuide(trip, { now: T0 });
  const rest = 80_000;
  let v = g.update({ now: T0, fix: fix(-300, { speed: 1.3 }) }).view;
  assert.ok(Math.abs(v.arrive - (T0 + (300 * 1.3 / 1.25) * 1000 + (120 + 360) * 1000 + rest)) < 2000, 'walk, the planned wait and ride, the last walk');
  v = g.update({ now: T0 + 200_000, fix: fix(-20, { speed: 1 }) }).view;
  assert.equal(v.kind, 'wait');
  assert.equal(v.arrive, trip.legs[1].depart + 360_000 + rest, 'the train you\'re waiting for');
  v = g.update({ now: T0 + 400_000, fix: fix(300, { speed: 14 }) }).view;
  assert.equal(v.kind, 'ride');
  assert.ok(v.arrive > T0 + 400_000 && v.arrive < T0 + 400_000 + 360_000 + rest, 'by the train you\'re on');
});

test('picked up again part-way (the app reloaded): from the leg it had reached', () => {
  const g = new TrainGuide(oneRide(), { now: T0, leg: 2 });
  const r = g.update({ now: T0, fix: null });
  assert.equal(r.view.kind, 'walk');
  assert.equal(g.leg.to.name, 'Destination');
});

test('the first update says how the trip starts', () => {
  assert.deepEqual(new TrainGuide(oneRide(), { now: T0 }).update({ now: T0, fix: null }).events.map((e) => e.type), ['start']);
});

test('which marker shows where you are', () => {
  assert.equal(markerFor({ mode: 'ride', legMode: 'train', vehicle: 'car' }), 'train');
  assert.equal(markerFor({ mode: 'ride', legMode: 'walk', vehicle: 'car' }), 'chevron', 'on foot: which way you face');
  assert.equal(markerFor({ mode: 'drive', legMode: null, vehicle: 'car' }), 'car');
  assert.equal(markerFor({ mode: 'browse', legMode: null, vehicle: 'chevron' }), 'chevron');
  assert.equal(markerFor({ mode: 'drive', legMode: null, vehicle: undefined }), 'chevron', 'the chevron by default, as on main');
  assert.equal(markerFor({ mode: 'drive', legMode: null, vehicle: 'something old' }), 'chevron');
});

test('train legs from the planner carry their stations with times', () => {
  const until = Object.values(feeds).map((f) => f.until).sort()[0];
  const at = Date.parse(`${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6)}T09:00:00+08:00`) - 8 * 86400_000;
  const plan = planTransit([101.6865, 3.134], [101.7116, 3.1579], at);
  const leg = plan.trips[0].legs.find((l) => l.mode === 'train');
  assert.equal(leg.stations.length, leg.stops + 1);
  if (leg.approach) assert.ok(leg.approach.length > 1 && Math.abs(leg.approach.at(-1)[1] - leg.from.lat) < 1e-4, 'the track in ends at the first station');
  assert.deepEqual([leg.stations[0][0], leg.stations.at(-1)[0]], [leg.from.name, leg.to.name]);
  assert.equal(leg.stations[0][3], 0);
  assert.ok(leg.stations.every((s, i) => !i || s[3] > leg.stations[i - 1][3]), 'times go up');
  assert.ok(Math.abs(leg.stations.at(-1)[3] - leg.duration) <= 1, 'the last is the ride');
});

test('no road reports from a train trip: only its own report button, about the line, and the road menu won\'t open', async () => {
  assert.equal(canReportFrom('ride'), false, 'a report from a train would sit on the rail line');
  assert.equal(canReportFrom('drive'), true);
  assert.equal(canReportFrom('browse'), true);
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const ride = html.slice(html.indexOf('id="ride-ui"'), html.indexOf('<!-- ===== Arrived'));
  assert.ok(ride.length > 100, 'found the ride screen');
  assert.doesNotMatch(ride, /report-fab/, 'no road report button on it');
  assert.deepEqual([...ride.matchAll(/id="(btn-report[\w-]*)"/g)].map((m) => m[1]), ['btn-report-ride'], 'only the train report button');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /\$\('btn-report-ride'\)\.onclick = openTrainReport;/, 'which reports on the line (src/lib/train-reports.js), not the road');
});
