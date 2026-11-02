// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { shouldCheck, routeTime, overlap, pickFaster, offerText, simplify, checkBody, worthOffering, checkGap, MAX_CHECKS, KEEP_FOR_MS, MAX_REST_CHARS } from '../public/faster-route.js';
import { encodePolyline, decodePolyline } from '../public/geo.js';

const T0 = Date.parse('2026-11-04T08:00:00+08:00');
const MIN = 60_000;
const drive = { now: T0 + 10 * MIN, startedAt: T0, lastCheck: 0, checks: 0, left: 20_000, leftTime: 30 * 60 };

test('when to look: after 2 minutes, then every 4, at most 8 times, with a fair way to go', () => {
  assert.equal(shouldCheck({ ...drive, now: T0 + 1 * MIN }), false, 'too soon after starting');
  assert.equal(shouldCheck({ ...drive, now: T0 + 2 * MIN }), true);
  assert.equal(shouldCheck({ ...drive, lastCheck: drive.now - 3 * MIN }), false, 'checked 3 min ago');
  assert.equal(shouldCheck({ ...drive, lastCheck: drive.now - 4 * MIN }), true);
  assert.equal(shouldCheck({ ...drive, checks: MAX_CHECKS }), false, 'enough for one drive');
  assert.equal(shouldCheck({ ...drive, left: 4000 }), false, 'nearly there');
  assert.equal(shouldCheck({ ...drive, leftTime: 4 * 60 }), false);
  assert.equal(shouldCheck({ ...drive, toStop: 1500 }), false, 'about to stop');
  assert.equal(shouldCheck({ ...drive, toStop: 3000 }), true);
  assert.equal(shouldCheck({ ...drive, offRoute: true }), false, 'a reroute is on its way');
  assert.equal(shouldCheck({ ...drive, busy: true }), false, 'one check at a time');
  assert.equal(shouldCheck({ ...drive, demo: true }), false, 'not on a demo drive');
});

test('a route’s time counts like the ETA: its steps (traffic included) plus reported delays', () => {
  assert.equal(routeTime({ steps: [{ time: 600 }, { time: 300 }, { time: 0 }], delay: 120 }), 1020);
  assert.equal(routeTime({ steps: [{ time: 60 }] }), 60);
});

// Two ways from (101.70, 3.10) to (101.70, 3.20), ~11 km: straight north, or a dog-leg ~1.1 km east.
// The corners, with 40 points along each leg.
function line(pts, n = 40) {
  const out = [pts[0]];
  for (let k = 1; k < pts.length; k++) {
    const [a, b] = [pts[k - 1], pts[k]];
    for (let i = 1; i <= n; i++) out.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  }
  return out;
}
const NORTH = line([[101.7, 3.1], [101.7, 3.2]]);
const EAST = line([[101.7, 3.1], [101.71, 3.11], [101.71, 3.19], [101.7, 3.2]]);

test('overlap: the share of one route that runs along another', () => {
  assert.ok(overlap(NORTH, NORTH) > 0.99);
  assert.ok(overlap(EAST, NORTH) < 0.15, `${overlap(EAST, NORTH)}`);
  // A route 20 m beside it (the other carriageway, or GPS noise) is the same road.
  assert.ok(overlap(NORTH.map(([x, y]) => [x + 0.00018, y]), NORTH) > 0.99);
  const half = NORTH.slice(0, Math.floor(NORTH.length / 2)).concat(EAST.slice(Math.floor(EAST.length / 2)));
  assert.ok(Math.abs(overlap(half, NORTH) - 0.5) < 0.15, 'about half');
  assert.equal(overlap([], NORTH), 0);
});

const route = (coords, minutes, via) => ({ coords, via, steps: [{ time: minutes * 60 }] });

test('offered only when clearly quicker and really another way', () => {
  const opts = { leftTime: 30 * 60, rest: NORTH, now: T0 };
  const pick = pickFaster([route(NORTH, 29, 'Jalan Lurus'), route(EAST, 22, 'Jalan Timur')], opts);
  assert.equal(pick.route.via, 'Jalan Timur');
  assert.equal(pick.saves, 8 * 60);
  assert.equal(pickFaster([route(EAST, 26, 'Jalan Timur')], opts), null, '4 minutes is not enough');
  assert.equal(pickFaster([route(EAST, 100, 'x')], { ...opts, leftTime: 104 * 60 }), null, '4% of a long drive is not enough');
  assert.equal(pickFaster([route(NORTH, 20, 'Jalan Lurus')], opts), null, 'the same roads, just a new estimate');
  assert.equal(pickFaster([], opts), null);
  // Turned down a minute ago: not offered again for a while, then it may be.
  const kept = [{ coords: EAST, until: T0 + KEEP_FOR_MS }];
  assert.equal(pickFaster([route(EAST, 20, 'Jalan Timur')], { ...opts, kept }), null);
  assert.ok(pickFaster([route(EAST, 20, 'Jalan Timur')], { ...opts, kept, now: T0 + KEEP_FOR_MS + 1 }));
});

test('what the card and the voice say', () => {
  assert.deepEqual(offerText(8 * 60 + 10, 'Jalan Tun Razak'), {
    line: 'Save 8 min via Jalan Tun Razak',
    spoken: 'A faster route is available, saving 8 minutes. Tap Switch to take it.',
  });
  assert.equal(offerText(60).line, 'Save 1 min');
});

test('the drive checks, offers on a card with Switch and Keep, and adopts the route like a reroute', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="faster-card"[\s\S]*id="btn-faster-keep"[\s\S]*id="btn-faster-take"/);
  const body = (name) => app.slice(app.indexOf(`function ${name}(`), app.indexOf('\n}\n', app.indexOf(`function ${name}(`)));
  assert.match(body('driveTick'), /checkFaster\(\)/);
  assert.match(body('takeFaster'), /adoptRoute\(/);
  assert.match(body('reroute'), /adoptRoute\(/, 'the same way a reroute switches routes');
  assert.match(body('startDrive'), /resetFaster\(\)/);
  assert.match(body('endDrive'), /resetFaster\(\)/);
  const sw = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /'\/faster-route\.js'/);
});

test('a check sends the rest of the route simplified, and the time left', () => {
  // 20 km: straight north with a point every 10 m, then a right-angle turn east.
  const north = Array.from({ length: 1001 }, (_, i) => [101.6, 3.0 + i * 0.00009]);
  const east = Array.from({ length: 1000 }, (_, i) => [101.6 + (i + 1) * 0.00009, north.at(-1)[1]]);
  const rest = [...north, ...east];
  const kept = simplify(rest, 10);
  assert.deepEqual(kept, [rest[0], north.at(-1), rest.at(-1)], 'only the ends and the corner');
  const body = checkBody(rest, 1234.4, encodePolyline);
  assert.equal(body.left, 1234);
  assert.ok(overlap(decodePolyline(body.rest, 5), rest) > 0.99 && overlap(rest, decodePolyline(body.rest, 5)) > 0.99, 'the same road');
  // A wiggle every point can't be simplified: too big to send, so it's an ordinary request.
  const zigzag = Array.from({ length: 20_000 }, (_, i) => [101.6 + i * 0.0003, 3.0 + (i % 2) * 0.0005]);
  assert.ok(encodePolyline(simplify(zigzag), 5).length > MAX_REST_CHARS);
  assert.equal(checkBody(zigzag, 600, encodePolyline), null);
});

test('worth offering: at least 5 minutes and a tenth quicker', () => {
  assert.equal(worthOffering(1500, 1800), true);
  assert.equal(worthOffering(1560, 1800), false, '4 minutes');
  assert.equal(worthOffering(6700, 7200), false, '8 minutes of 2 hours is under a tenth');
  assert.equal(worthOffering(6400, 7200), true);
});

test('checks that find nothing wait longer for the next: 4, 6, 8, then every 10 minutes', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map((q) => checkGap(q) / MIN), [4, 4, 6, 8, 10, 10]);
  assert.equal(shouldCheck({ ...drive, quiet: 3, lastCheck: drive.now - 7 * MIN }), false, 'three found nothing: 8 minutes');
  assert.equal(shouldCheck({ ...drive, quiet: 3, lastCheck: drive.now - 8 * MIN }), true);
  // An hour's drive: checks at 2, 6, 12, 20, 30, 40, 50 minutes when none finds anything (it was 8 by 30 minutes).
  const at = [];
  let lastCheck = 0, quiet = 0;
  for (let m = 0; m <= 60; m++) {
    const now = T0 + m * MIN;
    if (shouldCheck({ ...drive, now, lastCheck, quiet, checks: at.length, leftTime: (65 - m) * 60 })) at.push(m), (lastCheck = now), quiet++;
  }
  assert.deepEqual(at, [2, 6, 12, 20, 30, 40, 50]);
});
