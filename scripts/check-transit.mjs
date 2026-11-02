// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Runs before `npm run deploy`: makes sure the train timetables shipped aren't expired. Some of the feeds
// (KTM Komuter) end only a few months out, so rebuild them while the places are still being finished rather
// than ship a app that says every timetable is out of date.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = new URL('../src/lib/transit-data.json', import.meta.url);
const today = new Date().toISOString().slice(0, 10);
let data = null;
try { data = JSON.parse(readFileSync(file, 'utf8')); } catch {}
const feeds = data?.feeds ?? {};
const expired = Object.entries(feeds).filter(([, f]) => f?.until && String(f.until) < today);
if (!data || expired.length) {
  console.warn(`\n⚠  Train timetables are expired or missing (expired: ${expired.map(([k]) => k).join(', ') || 'all'}, today ${today}).`);
  console.warn('   Rebuilding them now with `python3 scripts/build-transit.py`…\n');
  try {
    execFileSync('python3', [resolve(process.cwd(), 'scripts/build-transit.py')], { stdio: 'inherit' });
  } catch (e) {
    console.warn(`\n⚠  The live feed rebuild failed (${e?.message ?? e}). Shipping the current timetable instead.\n`);
  }
} else {
  const nearest = Object.values(feeds).map((f) => f.until).sort().at(0);
  console.log(`Train timetables: feed valid to ${nearest}.`);
}
