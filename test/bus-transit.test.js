import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTransit, nearestStops, serviceDay, runs, feeds } from '../src/lib/bus-transit.js';
import { planTransitCombined, withRealWalks, effort, MAX_OPTIONS } from '../src/lib/transit.js';
import { TrainGuide, walkText } from '../public/train-guide.js';

const FROM = [101.769309, 3.139853];
const TO = [101.78, 3.15];
const AT = Date.parse('2026-11-04T09:00:00+08:00');

test('bus planning returns usable bus legs and stop labels', () => {
  const plan = planTransit(FROM, TO, AT);
  assert.ok(plan.trips.length);
  for (const trip of plan.trips) {
    const buses = trip.legs.filter((l) => l.mode === 'bus');
    assert.ok(buses.length);
    assert.equal(trip.changes, buses.length - 1);
    for (const leg of buses) {
      assert.equal(leg.line.kind, 'Bus');
      assert.equal(leg.from.kind, 'Bus');
      assert.equal(leg.stations.length, leg.stops + 1);
      assert.ok(leg.arrive >= leg.depart);
    }
    assert.match(walkText(trip.legs[0]), / stop\.$/);
  }
});

test('the API trips field includes bus alternatives, capped and ranked', () => {
  const plan = planTransitCombined(FROM, TO, AT);
  assert.ok(plan.trips.some((t) => t.legs.some((l) => l.mode === 'bus')));
  assert.equal(plan.trips, plan.options);
  assert.ok(plan.trips.length <= MAX_OPTIONS);
  assert.deepEqual(plan.trips.map(effort), plan.trips.map(effort).sort((a, b) => a - b));
});

test('bus calendars distinguish weekdays, weekends and expired data', () => {
  assert.ok(runs('prasarana-bus:weekday', serviceDay(AT)));
  assert.ok(!runs('prasarana-bus:weekend', serviceDay(AT)));
  const until = feeds['prasarana-bus'].until;
  const after = Date.parse(`${until.slice(0,4)}-${until.slice(4,6)}-${until.slice(6)}T09:00:00+08:00`) + 86400000;
  const plan = planTransit(FROM, TO, after);
  assert.equal(plan.trips.length, 0);
  assert.match(plan.note, /out of date/);
});

test('nearest bus stops are sorted and bounded', () => {
  const stops = nearestStops(FROM, 100);
  assert.equal(stops.length, 20);
  assert.equal(stops[0].metres, 0);
  assert.deepEqual(stops.map((s) => s.metres), stops.map((s) => s.metres).sort((a,b) => a-b));
});

test('real walks reboard bus legs and keep the shared three-request budget', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ trip: { summary: { length: 1, time: 900 }, legs: [{ shape: '??' }] } });
  });
  const plan = await withRealWalks({}, planTransitCombined(FROM, TO, AT));
  assert.ok(calls > 0 && calls <= 3);
  for (const trip of plan.trips) {
    const buses = trip.legs.filter((l) => l.mode === 'bus');
    assert.equal(trip.changes, buses.length - 1);
    let at = trip.depart;
    for (const leg of trip.legs) {
      if (leg.mode === 'walk') at += leg.duration * 1000;
      else {
        assert.ok(leg.depart >= at);
        assert.equal(leg.wait, Math.round((leg.depart - at) / 1000));
        at = leg.arrive;
      }
    }
    assert.equal(trip.arrive, at);
  }
});

test('bus guidance can board and cannot arrive on stale GPS alone', () => {
  const trip = planTransit(FROM, TO, AT).trips[0];
  const leg = trip.legs.findIndex((l) => l.mode === 'bus');
  const guide = new TrainGuide(trip, { now: AT, leg });
  assert.equal(guide.hereText(), 'I’m on the bus');
  guide.here({ now: AT });
  const result = guide.update({ now: AT + 86400000, fix: null });
  assert.ok(!result.events.some((e) => e.type === 'arrived'));
});
