// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Runs before `npm run deploy`: warns when A2B's place files (public/places/, not kept in git) haven't been built,
// because search then only has the server's geocoder.
import { existsSync, readFileSync } from 'node:fs';

const index = new URL('../public/places/index.json', import.meta.url);
if (!existsSync(index)) {
  console.warn('\n⚠  No place data in public/places/. Search will only use the geocoder.');
  console.warn('   Build it first: pip install duckdb && npm run places && npm run locations\n');
} else {
  const { release, count, built, areas = [], source = '' } = JSON.parse(readFileSync(index, 'utf8'));
  console.log(`Place data: ${source || 'Overture'} ${release}, ${count.toLocaleString()} places, built ${built}.`);
  if (!source.startsWith('A2B places')) {
    console.warn('\n⚠  These are Overture\'s places only. For A2B\'s merged places (OpenStreetMap, Overture, Foursquare): npm run locations\n');
  }
  // Searches like "petrol" or "klinik" and the map's petrol stations, hospitals and clinics need the per-kind files.
  const typed = areas.some((a) => {
    const files = new URL(`../public/places/${a}/files.json`, import.meta.url);
    return existsSync(files) && '@fuel' in JSON.parse(readFileSync(files, 'utf8'));
  });
  if (!typed) {
    console.warn('\n⚠  The place data has no files by kind of place, so "petrol", "hospital" or "klinik" only match names');
    console.warn('   and the map shows no petrol stations, hospitals or clinics. Rebuild it: npm run places\n');
  }
}

const roads = new URL('../public/construction/index.json', import.meta.url);
if (existsSync(roads)) {
  const { release, roads: n } = JSON.parse(readFileSync(roads, 'utf8'));
  console.log(`Roads under construction: Overture ${release}, ${n.toLocaleString()} roads.`);
} else {
  console.warn('\n⚠  No construction road data in public/construction/. Routes won\'t be checked for roadworks.');
  console.warn('   Build it first: pip install duckdb && npm run construction\n');
}

const cams = new URL('../public/cameras.json', import.meta.url);
if (existsSync(cams)) {
  const { built, count } = JSON.parse(readFileSync(cams, 'utf8'));
  console.log(`Speed cameras: ${count.toLocaleString()}, built ${built}.`);
} else {
  console.warn('\n⚠  No speed camera list in public/cameras.json. Routes won\'t warn about fixed cameras.');
  console.warn('   Build it first: npm run cameras\n');
}
