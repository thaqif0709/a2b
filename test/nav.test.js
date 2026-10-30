// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distance, bearing, angleDiff, decodePolyline, formatDistance, formatDuration, cumulative } from '../public/geo.js';
import { Navigator, Simulator, pointAlong, pointAtDistance, reportsAlong, spokenDistance, spokenCodes, sliceAlong } from '../public/nav.js';

// An L-shaped test route: 1 km north, then 500 m east. Roughly 0.009° lat = 1 km.
const A = [13.4, 52.5], B = [13.4, 52.509], C = [13.4074, 52.509];
function lRoute() {
  const coords = [];
  for (let i = 0; i <= 20; i++) coords.push([A[0], A[1] + (B[1] - A[1]) * (i / 20)]);
  for (let i = 1; i <= 10; i++) coords.push([B[0] + (C[0] - B[0]) * (i / 10), B[1]]);
  return {
    coords,
    delay: 0,
    steps: [
      { type: 'depart', instruction: 'Drive north on Main St.', alert: 'Drive north.', pre: 'Drive north on Main St.', street: 'Main St', begin: 0, end: 20, length: 1000, time: 100 },
      { type: 'right', instruction: 'Turn right onto Side St.', alert: 'Turn right onto Side St.', pre: 'Turn right onto Side St.', street: 'Side St', begin: 20, end: 30, length: 500, time: 50 },
      { type: 'arrive', instruction: 'You have arrived.', alert: 'You will arrive.', pre: 'You have arrived at your destination.', street: '', begin: 30, end: 30, length: 0, time: 0 },
    ],
  };
}

test('geo basics', () => {
  assert.ok(Math.abs(distance(A, B) - 1000.8) < 2);
  assert.ok(Math.abs(bearing(A, B)) < 0.5);
  assert.ok(Math.abs(bearing(B, C) - 90) < 0.5);
  assert.equal(angleDiff(350, 10), 20);
  assert.equal(angleDiff(10, 350), -20);
  assert.equal(formatDistance(1234), '1.2 km');
  assert.equal(formatDistance(234), '230 m');
  assert.equal(formatDistance(100, 'imperial'), '350 ft');
  assert.equal(formatDuration(59 * 60), '59 min');
  assert.equal(formatDuration(3 * 3600 + 5 * 60), '3 h 5 min');
  assert.equal(spokenDistance(400), '400 meters');
  assert.equal(spokenDistance(389), '400 meters');
  assert.equal(spokenDistance(130), '150 meters');
  assert.equal(spokenDistance(1000), '1 kilometer');
  assert.equal(spokenDistance(2000), '2 kilometers');
  assert.equal(spokenDistance(1500), '1.5 kilometers');
  assert.equal(spokenDistance(1609.344, 'imperial'), '1 mile');
});

test('decodes precision-6 polylines (Valhalla)', () => {
  // From Valhalla's docs/test data: encodes [[-76.3,40.0],[-76.299,40.001]] style coordinates.
  const pts = decodePolyline('_izlhA~rlgdF_{geC~ywl@_kwzCn`{nI', 6);
  assert.deepEqual(pts.map((p) => p.map((v) => Math.round(v * 1e3) / 1e3)), [[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]]);
});

test('snapping finds the right spot along the route', () => {
  const r = lRoute();
  const cum = cumulative(r.coords);
  const hit = pointAlong(r.coords, cum, [13.4002, 52.5045]); // ~14 m east of the line, half way up
  assert.ok(hit.dist < 20);
  assert.ok(Math.abs(hit.along - 500) < 10);
  const at = pointAtDistance(r.coords, cum, 1250);
  assert.ok(Math.abs(at.point[1] - 52.509) < 1e-6);
});

test('navigator tracks the next turn, ETA and voice cues', () => {
  const nav = new Navigator(lRoute());
  const s0 = nav.update({ position: A, heading: 0, speed: 14 });
  assert.equal(s0.next.type, 'right');
  assert.ok(Math.abs(s0.distToNext - 1000) < 5);
  assert.ok(Math.abs(s0.remainingTime - 150) < 2);
  assert.equal(s0.prompt, 'Drive north on Main St.');

  const s1 = nav.update({ position: [13.4, 52.5055], heading: 0, speed: 14 });
  assert.match(s1.prompt, /^In 400 meters, turn right onto Side St/);
  assert.ok(Math.abs(s1.remainingTime - 89) < 2);

  const s2 = nav.update({ position: [13.4, 52.5086], heading: 0, speed: 14 });
  assert.equal(s2.prompt, 'Turn right onto Side St.');
  const s3 = nav.update({ position: [13.4, 52.5087], heading: 0, speed: 14 });
  assert.equal(s3.prompt, null, 'each cue is spoken once');

  const s4 = nav.update({ position: [13.403, 52.509], heading: 90, speed: 14 });
  assert.equal(s4.next.type, 'arrive');
  assert.equal(s4.arrived, false);
  const s5 = nav.update({ position: C, heading: 90, speed: 3 });
  assert.equal(s5.arrived, true);
});

test('estimated arrival never latches or consumes the real arrival cue', () => {
  const nav = new Navigator(lRoute());
  nav.update({ position: A, speed: 14 });
  const turn = nav.update({ position: [13.4, 52.5086], speed: 14, estimated: true });
  assert.equal(turn.prompt, 'Turn right onto Side St.', 'ordinary turn guidance still works');
  const guessed = nav.update({ position: C, speed: 14, estimated: true });
  assert.equal(guessed.arrived, false);
  assert.equal(nav.arrived, false);
  assert.equal(guessed.prompt, null);
  assert.equal(nav.spoken.has('2:near'), false);
  // A real off-route position must not confirm the estimate left at the end of the route.
  assert.equal(nav.update({ position: [13.42, 52.51], speed: 5 }).arrived, false);
  assert.equal(nav.update({ position: B, speed: 5 }).arrived, false, 'real recovery before the destination');
  const arrived = nav.update({ position: C, speed: 0 });
  assert.equal(arrived.arrived, true);
  assert.equal(arrived.prompt, 'You have arrived at your destination.');
});

test('estimated stops do not consume stop cues or count as off-route fixes', () => {
  const route = lRoute();
  route.steps[1] = { ...route.steps[1], type: 'stop', pre: 'You have reached your stop.' };
  const nav = new Navigator(route);
  nav.update({ position: A });
  const nearStop = [13.4, 52.5086];
  assert.equal(nav.update({ position: nearStop, speed: 10, estimated: true }).prompt, null);
  assert.equal(nav.spoken.has('1:near'), false);
  assert.equal(nav.update({ position: nearStop, speed: 10 }).prompt, 'You have reached your stop.');
  const away = [13.403, 52.503];
  nav.update({ position: away });
  assert.equal(nav.offCount, 1);
  for (let i = 0; i < 5; i++) assert.equal(nav.update({ position: away, estimated: true }).offRoute, false);
  assert.equal(nav.offCount, 1, 'only real fixes change the off-route counter');
});

test('a slice of the route runs around the corner', () => {
  const r = lRoute();
  const cum = cumulative(r.coords);
  const part = sliceAlong(r.coords, cum, 965, 1025); // 35 m before the turn to ~25 m after
  assert.ok(Math.abs(distance(part[0], B) - 35) < 2);
  assert.ok(part.some((p) => distance(p, B) < 0.5), 'includes the corner itself');
  assert.ok(Math.abs(part.at(-1)[1] - B[1]) < 1e-9 && part.at(-1)[0] > B[0]);
  assert.ok(Math.abs(bearing(part.at(-2), part.at(-1)) - 90) < 1);
});

test('speed limit follows the route position', () => {
  const nav = new Navigator({ ...lRoute(), limits: [[0, 50], [20, 30]] });
  assert.equal(nav.update({ position: [13.4, 52.502] }).limit, 50);
  assert.equal(nav.update({ position: [13.403, 52.509] }).limit, 30);
  assert.equal(new Navigator(lRoute()).update({ position: A }).limit, null);
});

test('off-route needs several bad fixes in a row', () => {
  const nav = new Navigator(lRoute());
  nav.update({ position: A });
  const away = [13.403, 52.503]; // ~200 m east of the first leg
  assert.equal(nav.update({ position: away }).offRoute, false);
  assert.equal(nav.update({ position: away }).offRoute, false);
  assert.equal(nav.update({ position: away }).offRoute, true);
  assert.equal(nav.update({ position: [13.4, 52.503] }).offRoute, false);
});

test('reports along the route are found and ordered', () => {
  const r = lRoute();
  const found = reportsAlong(r, [
    { id: 1, lat: 52.509, lng: 13.405 }, // on the second leg
    { id: 2, lat: 52.502, lng: 13.4001 }, // on the first leg
    { id: 3, lat: 52.502, lng: 13.41 }, // far away
  ]);
  assert.deepEqual(found.map((f) => f.id), [2, 1]);
  assert.ok(Math.abs(found[0].at - 222) < 5);
});

test('simulator drives to the end', () => {
  const sim = new Simulator(lRoute(), { speedFactor: 3 });
  let f, n = 0;
  do f = sim.next(); while (!f.done && ++n < 500);
  assert.ok(f.done);
  assert.ok(distance(f.position, C) < 1);
  assert.ok(n < 100);
});

test('roundabouts: exit direction and which way round, from the route line', async () => {
  const { roundaboutTurn } = await import('../public/nav.js');
  const { roundaboutIcon } = await import('../public/icons.js');
  const C = [101.6, 3.1], R = 0.0003, k = Math.cos((3.1 * Math.PI) / 180);
  const around = (deg) => [C[0] + (R * Math.sin((deg * Math.PI) / 180)) / k, C[1] + R * Math.cos((deg * Math.PI) / 180)];
  // In from the south heading north, round the circle, out along `exitDeg` (compass position of the exit).
  const build = (exitDeg, clockwise) => {
    const coords = [[C[0], C[1] - R * 4], [C[0], C[1] - R * 2.5], around(180)];
    const enterAt = coords.length - 1;
    const sweep = clockwise ? (exitDeg - 180 + 360) % 360 : (180 - exitDeg + 360) % 360;
    for (let s = 10; s <= sweep; s += 10) coords.push(around(clockwise ? 180 + s : 180 - s));
    const exitAt = coords.length - 1;
    const out = around(exitDeg), dir = [out[0] - C[0], out[1] - C[1]];
    coords.push([out[0] + dir[0] * 2, out[1] + dir[1] * 2], [out[0] + dir[0] * 4, out[1] + dir[1] * 4]);
    const steps = [{ type: 'depart', begin: 0 }, { type: 'roundabout', begin: enterAt }, { type: 'roundabout_exit', begin: exitAt }];
    return roundaboutTurn(coords, cumulative(coords), steps, 1);
  };
  const right = build(90, true); // drive-on-the-left style: clockwise, leave to the east = turning right
  assert.equal(right.clockwise, true);
  assert.ok(Math.abs(right.exitAngle - 90) < 3, `exit ${right.exitAngle}`);
  const left = build(270, false); // anticlockwise, leave to the west = turning left
  assert.equal(left.clockwise, false);
  assert.ok(Math.abs(left.exitAngle + 90) < 3, `exit ${left.exitAngle}`);
  const straight = build(0, true);
  assert.ok(Math.abs(straight.exitAngle) < 3, `exit ${straight.exitAngle}`);
  assert.equal(roundaboutTurn([[0, 0], [0, 1]], [0, 1], [{ type: 'left', begin: 0 }], 0), null);
  assert.match(roundaboutIcon(right), /<svg[\s\S]*A9\.5 9\.5 0 [01] 1 /, 'clockwise arc');
});

test('sheets settle the way people expect', async () => {
  const { settle, rubberBand } = await import('../public/sheet-drag.js');
  assert.equal(settle(false, -10, -0.8, 300), true, 'a quick flick up opens');
  assert.equal(settle(true, 15, 0.6, 300), false, 'a quick flick down closes');
  assert.equal(settle(false, -90, -0.1, 300), true, 'a slow drag past a quarter goes on');
  assert.equal(settle(false, -40, -0.1, 300), false, 'a short nudge springs back');
  assert.equal(settle(true, 40, 0.1, 300), true);
  assert.equal(rubberBand(50, 0, 100), 50);
  assert.ok(rubberBand(-100, 0, 100) > -25, 'pulling past the end only stretches a little');
});

test('exit numbers and long road codes are read digit by digit', () => {
  assert.equal(spokenCodes('Take the E3108 exit toward Shah Alam.'), 'Take the E three one zero eight exit toward Shah Alam.');
  assert.equal(spokenCodes('Take exit 1601 on the left.'), 'Take exit one six zero one on the left.');
  assert.equal(spokenCodes('Take exit 230A.'), 'Take exit two three zero A.');
  assert.equal(spokenCodes('Keep left to take E2 toward Ipoh.'), 'Keep left to take E2 toward Ipoh.');
  assert.equal(spokenCodes('Turn right onto FT50.'), 'Turn right onto FT50.');
  assert.equal(spokenCodes('In 300 meters, turn right.'), 'In 300 meters, turn right.');
  assert.equal(spokenCodes('Speed camera in 500 meters. The limit is 110.'), 'Speed camera in 500 meters. The limit is 110.');
});


test('ordinary real GPS retains main arrival behavior without an on-route prerequisite', () => {
  // A very short route is already within main's arrival-distance threshold at its start.
  const short = { coords: [[101.6, 3.1], [101.6001, 3.1]], steps: [
    { type: 'depart', begin: 0, end: 1, time: 10, pre: 'Walk east.' },
    { type: 'arrive', begin: 1, end: 1, time: 0, pre: 'You have arrived.' },
  ] };
  const result = new Navigator(short).update({ position: [101.6, 3.1005], accuracy: 10 });
  assert.ok(result.offBy > 40);
  assert.equal(result.offRoute, false);
  assert.equal(result.arrived, true, 'ordinary real GPS keeps main distance-based arrival');
});

test('ordinary real GPS keeps stop cues outside the route without estimate recovery', () => {
  const route = lRoute();
  route.steps[1] = { ...route.steps[1], type: 'stop', pre: 'You have reached your stop.' };
  const nav = new Navigator(route);
  nav.update({ position: A, speed: 0 });
  nav.update({ position: [13.4, 52.508], speed: 0 }); // ~111 m before stop, outside the near-cue range
  const result = nav.update({ position: [13.401, 52.508], speed: 20 });
  assert.ok(result.offBy > 40);
  assert.equal(result.prompt, 'You have reached your stop.', 'real fixes retain main speed-based cue timing');
});
