// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cumulative } from '../public/geo.js';
import { isSchoolDay, isSchoolTime, schoolAhead, schoolLimit } from '../public/school-zones.js';
import { pointAlong } from '../public/nav.js';
import { schoolsAlong, schoolGrid } from '../src/lib/schools.js';
import { schoolRows } from '../scripts/build-schools.mjs';

const KL = [101.69, 3.14];
const ALOR_SETAR = [100.37, 6.12]; // Kedah
const KOTA_BHARU = [102.24, 6.13]; // Kelantan
const KUALA_TERENGGANU = [103.14, 5.33];
const KANGAR = [100.2, 6.44]; // Perlis, inside Kedah's box
const GEORGE_TOWN = [100.33, 5.41]; // Penang, inside Kedah's box
const KUANTAN = [103.33, 3.81]; // Pahang, south of Terengganu
const at = (iso) => Date.parse(`${iso}+08:00`);

test('school days: Monday to Friday, or Sunday to Thursday in Kedah, Kelantan and Terengganu', () => {
  const fri = at('2026-11-06T07:00:00'), sun = at('2026-11-08T07:00:00'), mon = at('2026-11-09T07:00:00');
  for (const pos of [KL, KANGAR, GEORGE_TOWN, KUANTAN]) {
    assert.deepEqual([isSchoolDay(fri, pos), isSchoolDay(sun, pos), isSchoolDay(mon, pos)], [true, false, true], String(pos));
  }
  for (const pos of [ALOR_SETAR, KOTA_BHARU, KUALA_TERENGGANU]) {
    assert.deepEqual([isSchoolDay(fri, pos), isSchoolDay(sun, pos), isSchoolDay(mon, pos)], [false, true, true], String(pos));
  }
  assert.equal(isSchoolDay(at('2026-11-07T07:00:00'), KL), false, 'Saturday');
  assert.equal(isSchoolDay(at('2026-11-07T07:00:00'), KOTA_BHARU), false, 'Saturday');
});

test('school times: the morning run, midday and the end of the afternoon session only', () => {
  const wed = (t) => isSchoolTime(at(`2026-11-04T${t}`), KL);
  assert.deepEqual(['06:29:59', '06:30:00', '07:44:59', '07:45:00'].map(wed), [false, true, true, false]);
  assert.deepEqual(['12:29:00', '12:30:00', '14:29:00', '14:30:00'].map(wed), [false, true, true, false]);
  assert.deepEqual(['17:44:00', '17:45:00', '18:44:00', '18:45:00'].map(wed), [false, true, true, false]);
  assert.equal(wed('10:00:00'), false);
  assert.equal(isSchoolTime(at('2026-11-07T07:00:00'), KL), false, 'not on Saturday');
});

test('which school to warn about: from 300 m before until 100 m past', () => {
  const coords = Array.from({ length: 21 }, (_, i) => [101.69, 3.14 + i * 0.0009]); // ~100 m apart, north
  const cum = cumulative(coords);
  const schools = [{ at: 5, name: 'SK Satu' }, { at: 8, name: 'SMK Dua' }, { at: 18, name: null }];
  const name = (along) => schoolAhead(along, schools, cum)?.school.name;
  assert.equal(schoolAhead(0, schools, cum), null, '~500 m away');
  assert.equal(name(cum[5] - 290), 'SK Satu');
  assert.equal(name(cum[5] + 50), 'SMK Dua', 'just past one, the next is coming up within 300 m');
  assert.equal(name(cum[8] + 90), 'SMK Dua', 'still in its zone');
  assert.equal(schoolAhead(cum[8] + 150, schools, cum), null, 'past, and the next is far');
  assert.equal(schoolAhead(cum[18] + 50, schools, cum).school.at, 18);
  assert.equal(schoolAhead(cum[20], [], cum), null);
});

test('schools beside a route, one zone for schools side by side', () => {
  const coords = Array.from({ length: 21 }, (_, i) => [101.69, 3.14 + i * 0.0009]);
  const rows = [
    [101.6905, 3.1445, 'SK Satu'], // ~55 m east, beside the road
    [101.6904, 3.1446, 'SMK Satu'], // next door: the same zone
    [101.69, 3.1535, 'SK Dua'],
    [101.695, 3.15, 'Too far'], // ~550 m off
  ];
  const grid = schoolGrid(rows);
  assert.deepEqual(schoolsAlong(coords, { grid }).map((s) => s.name), ['SK Satu', 'SK Dua']);
  assert.deepEqual(schoolsAlong(coords, { grid })[0].pos, [101.6905, 3.1445], 'where the school itself is, for its pin');
  assert.deepEqual(schoolsAlong(coords, { grid: new Map() }), []);
});

test('schools beside a route: only the road near each school is measured, with the same answer as the whole route', () => {
  // A winding 60 km drive (a point every ~100 m, and a 6 km straight with no points in between), and schools
  // scattered around it, some near the road.
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const coords = [];
  for (let i = 0; i < 600; i++) coords.push([101.5 + i * 0.0009, 3.0 + Math.sin(i / 40) * 0.02]);
  const last = coords.at(-1);
  coords.push([last[0] + 0.054, last[1]]); // the long straight
  const rows = Array.from({ length: 3000 }, (_, i) => {
    const c = coords[Math.floor(rand() * coords.length)];
    return [c[0] + (rand() - 0.5) * 0.006, c[1] + (rand() - 0.5) * 0.006, `S${i}`];
  });
  rows.push([last[0] + 0.03, last[1] + 0.0008, 'Mid-straight']); // ~90 m off the middle of the straight
  // What the whole-route scan (pointAlong over every segment) finds, zones merged the same way.
  const cum = cumulative(coords);
  const hits = rows
    .map(([lng, lat, name]) => ({ name, hit: pointAlong(coords, cum, [lng, lat]) }))
    .filter((s) => s.hit.dist <= 150)
    .sort((a, b) => a.hit.along - b.hit.along)
    .filter((s, i, all) => i === 0 || s.hit.along - all[i - 1].hit.along > 150)
    .map((s) => [s.name, s.hit.seg]);
  const got = schoolsAlong(coords, { grid: schoolGrid(rows) }).map((s) => [s.name, s.at]);
  assert.ok(hits.length > 20, `${hits.length}`);
  assert.deepEqual(got, hits);
  assert.ok(got.some(([name]) => name === 'Mid-straight'), 'a school beside a long straight with no points near it');
});

test('the build keeps schools and leaves out kindergartens, tuition centres and colleges', () => {
  const el = (name, lat = 3.1, lon = 101.6) => ({ type: 'node', id: 1, lat, lon, tags: { amenity: 'school', ...(name && { name }) } });
  assert.deepEqual(
    schoolRows([el('SK Taman Melawati'), el('Tadika Ceria'), el('Tabika Kemas'), el('Pusat Tuition Bijak'), el('Kolej Vokasional'), el('Universiti Malaya'), el(null, 3.2, 101.7)]),
    [[101.6, 3.1, 'SK Taman Melawati'], [101.7, 3.2, '']],
  );
  const built = JSON.parse(readFileSync(new URL('../public/schools.json', import.meta.url), 'utf8'));
  assert.ok(built.schools.length > 5000 && built.schools.every((s) => s.length === 3));
});

test('school zones are signed 30 km/h: the chip and the voice say so', () => {
  assert.deepEqual(schoolLimit('metric'), { chip: '30 km/h zone', spoken: 'Slow down to 30.' });
  assert.deepEqual(schoolLimit('imperial'), { chip: '20 mph zone', spoken: 'Slow down to 20.' });
});
