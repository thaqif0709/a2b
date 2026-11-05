import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectTransitNetworks } from '../src/lib/transit-network.js';
import { createTransitPlanner } from '../src/lib/transit-planner.js';
import { planTransitCombined, effort, MAX_OPTIONS } from '../src/lib/transit.js';
import { TrainGuide } from '../public/train-guide.js';

const AT = Date.parse('2026-11-05T09:00:00+08:00');
const FROM = [101, 3], TO = [101.06, 3];
const service = { days: [1,1,1,1,1,1,1], start: '20260101', end: '20261231', add: [], remove: [] };
const freq = [[6*3600, 23*3600, 600]];
function networks() {
  const make = (id, stops, kind) => ({
    feeds: { [id]: { until: '20261231' } }, services: { [id]: structuredClone(service) },
    lines: { [id]: { short: id, name: id, kind, color: '#123456', text: '#ffffff' } },
    shapes: {}, stops, nearby: [[], []],
    patterns: [
      { line: id, service: id, stops: [0, 1], freq, offsets: [0, 600], headsign: stops[1][0] },
      { line: id, service: id, stops: [1, 0], freq, offsets: [0, 600], headsign: stops[0][0] },
    ],
  });
  const bus = make('bus', [['Origin',3,101,'B0'],['Bus interchange',3,101.02,'B1']], 'Bus');
  const rail = make('rail', [['Rail interchange',3,101.0205,'R0'],['Destination',3,101.06,'R1']], 'MRT');
  rail.patterns[0] = { line: 'rail', service: 'rail', stops: [0,1], trips: [[9*3600+20*60,9*3600+30*60],[9*3600+40*60,9*3600+50*60]], headsign: 'Destination' };
  return { rail, bus };
}
const planner = (net = networks()) => createTransitPlanner(connectTransitNetworks(net.rail, net.bus), { mixed: true });
const rides = (t) => t.legs.filter((l) => l.mode !== 'walk');

test('joins only nearby bus/rail stops in both directions without changing source data', () => {
  const { rail, bus } = networks();
  const before = JSON.stringify({ rail, bus });
  const joined = connectTransitNetworks(rail, bus);
  assert.ok(joined.nearby[0].some(([i, m]) => i === 3 && m < 60));
  assert.ok(joined.nearby[3].some(([i]) => i === 0));
  assert.deepEqual(joined.nearby[1], []);
  assert.deepEqual(joined.patterns[2].stops, [2,3]);
  assert.equal(JSON.stringify({ rail, bus }), before);
});

test('bus → walk → train includes transfer time and catches a later scheduled departure', () => {
  const trip = planner().planTransit(FROM, TO, AT).trips[0];
  assert.deepEqual(rides(trip).map((l) => l.mode), ['bus','train']);
  assert.equal(trip.changes, 1);
  const transfer = trip.legs[2];
  assert.equal(transfer.mode, 'walk');
  assert.equal(transfer.from.kind, 'Bus');
  assert.equal(transfer.to.name, 'Rail interchange');
  assert.equal(transfer.buffer, 60);
  const [bus, train] = rides(trip);
  assert.ok(train.depart >= bus.arrive + transfer.duration * 1000);
  assert.equal(train.depart, AT + 20*60_000);
});

test('train → walk → bus works in the reverse direction', () => {
  const trip = planner().planTransit(TO, FROM, AT).trips[0];
  assert.deepEqual(rides(trip).map((l) => l.mode), ['train','bus']);
  assert.equal(trip.legs[2].to.kind, 'Bus');
});

test('a long real transfer walk reboards the next train within the three-walk budget', async (t) => {
  const p = planner();
  const plan = p.planTransit(FROM, TO, AT);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ trip: { summary: { length: 1, time: 900 }, legs: [{ shape: '??' }] } }); });
  const result = await p.withRealWalks({}, plan);
  assert.ok(result.trips.length);
  const trip = result.trips[0];
  assert.equal(trip.legs[2].duration, 960, 'retain a minute to change platforms/board');
  assert.equal(rides(trip)[1].depart, AT+40*60_000);
  assert.ok(calls <= 3);
  assert.equal(trip.arrive, AT+50*60_000);
});

test('a missed last service is removed instead of inventing a departure', async (t) => {
  const net = networks();net.rail.patterns[0].trips = [net.rail.patterns[0].trips[0]];
  const p=planner(net), plan=p.planTransit(FROM,TO,AT);
  assert.ok(plan.trips.length);
  t.mock.method(globalThis,'fetch',async()=>Response.json({trip:{summary:{length:1,time:900},legs:[{shape:'??'}]}}));
  assert.equal((await p.withRealWalks({},plan)).trips.length,0);
});

test('missing, expired or disconnected service does not fabricate mixed journeys', () => {
  for (const change of [net=>{net.bus.services.bus.end='20261104';},net=>{net.bus.patterns=[];},net=>{net.rail.stops[0][2]=101.03;}]) {
    const net=networks();change(net);
    assert.equal(planner(net).planTransit(FROM,TO,AT).trips.length,0);
  }
});

test('real Klang Valley feeds provide both directions of mixed journeys and retain direct rail', () => {
  const sriNilam=[101.769309,3.139853], klcc=[101.7116,3.1579];
  for (const [from,to,first,last] of [[sriNilam,klcc,'bus','train'],[klcc,sriNilam,'train','bus']]) {
    const plan=planTransitCombined(from,to,AT);
    assert.ok(plan.trips.length && plan.trips.length<=MAX_OPTIONS);
    const trip=plan.trips.find(t=>rides(t)[0].mode===first && rides(t).at(-1).mode===last);
    assert.ok(trip);
    assert.equal(trip.changes,rides(trip).length-1);
    assert.deepEqual(plan.trips.map(effort),plan.trips.map(effort).sort((a,b)=>a-b));
  }
  const direct=planTransitCombined([101.6865,3.134],klcc,AT).trips[0];
  assert.deepEqual(rides(direct).map(l=>l.mode),['train']);
});

test('Ride guidance follows a bus, the transfer walk and the train without auto-arrival', () => {
  const trip=planner().planTransit(FROM,TO,AT).trips[0];
  const guide=new TrainGuide(trip,{now:AT,leg:1});
  assert.equal(guide.hereText(),'I’m on the bus');
  guide.here({now:AT});
  const alight=guide.here({now:AT+600000,station:1});
  assert.equal(guide.leg.mode,'walk');
  assert.ok(alight.some(e=>/Change to the rail/.test(e.text)));
  guide.here({now:AT+700000});
  assert.equal(guide.leg.mode,'train');
  assert.equal(guide.hereText(),'I’m on the train');
  const result=guide.update({now:AT+86400000,fix:null});
  assert.ok(!result.events.some(e=>e.type==='arrived'));
});

test('a confirmed unreachable transfer is rejected, but a temporary router failure keeps estimates', async (t) => {
  for (const status of [404,503]) {
    const p=planner();
    const mock=t.mock.method(globalThis,'fetch',async()=>new Response('',{status}));
    const result=await p.withRealWalks({},p.planTransit(FROM,TO,AT));
    assert.equal(result.trips.length>0,status===503);
    mock.mock.restore();
  }
});

test('expected frequency departure cannot extend beyond the last service window', () => {
  const p=planner();
  assert.equal(p.board({freq:[[3600,4200,600]],offsets:[0,120]},0,4199),null);
  assert.equal(p.board({freq:[[3600,4200,600]],offsets:[0,120]},1,4319),null);
});
