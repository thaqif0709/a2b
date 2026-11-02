// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// EV chargers in Malaysia, kept in the database and refreshed weekly by the nightly job: OpenStreetMap's (through
// Overpass) and, when an OCM_KEY secret is set, Open Charge Map's openly licensed ones. Neither is complete on its
// own, so both are kept and a charger listed by both shows once. The phone adds Overture's few (public/places.js).
// Each source is replaced only by a fetch of it that worked, so a source being down keeps last week's list.

import { distance } from '../../public/geo.js';

const UA = 'a2b-navigation/0.1 (+https://a2b-beta.pages.dev)';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const OCM = 'https://api.openchargemap.io/v3/poi';
const REFRESH_MS = 7 * 86400_000;
const SAME_M = 50; // a charger listed by both sources this close together is one charger
const CATEGORY = 'ev_charging_station';
const INSERT_CHUNK = 400;

// OpenStreetMap socket tags and Open Charge Map connection type ids, as drivers call them.
const OSM_SOCKETS = { type2_combo: 'CCS2', type2: 'Type 2', type2_cable: 'Type 2', chademo: 'CHAdeMO', tesla_supercharger: 'Tesla', type1_combo: 'CCS1', type1: 'Type 1', gb_dc: 'GB/T' };
const OCM_CONNECTIONS = { 33: 'CCS2', 25: 'Type 2', 1036: 'Type 2', 2: 'CHAdeMO', 27: 'Tesla', 30: 'Tesla', 32: 'CCS1', 1: 'Type 1', 1038: 'GB/T', 1039: 'GB/T' };

// "Gentari · CCS2, Type 2 · up to 60 kW · 4 bays": what's worth knowing before driving there.
export function describe({ operator, plugs = [], kw = null, bays = null, name = '' }) {
  return [
    operator && !name.toLowerCase().includes(operator.toLowerCase()) ? operator : null,
    [...new Set(plugs)].join(', ') || null,
    kw ? `up to ${Math.round(kw)} kW` : null,
    bays > 1 ? `${bays} bays` : null,
  ].filter(Boolean).join(' · ');
}

const kwOf = (v) => {
  const m = /([\d.]+)\s*(kw|w)?/i.exec(String(v ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  return m[2]?.toLowerCase() === 'w' ? n / 1000 : n;
};

// Overpass elements -> rows. Private chargers and motorcycle-only ones are left out.
export function osmRows(elements) {
  const rows = [];
  for (const e of elements) {
    const t = e.tags ?? {};
    const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
    if (lat == null || lng == null) continue;
    if (['private', 'no', 'customers_only'].includes(t.access) || t.motorcar === 'no') continue;
    const plugs = [], powers = [];
    for (const [k, label] of Object.entries(OSM_SOCKETS)) {
      if (!t[`socket:${k}`] || t[`socket:${k}`] === 'no') continue;
      plugs.push(label);
      const kw = kwOf(t[`socket:${k}:output`]);
      if (kw) powers.push(kw);
    }
    const operator = t.operator || t.network || null;
    const name = t['name:en'] || t.name || t.brand || t.network || operator || 'EV charger';
    rows.push({
      id: `osm:${e.type}/${e.id}`, source: 'osm', name, lat, lng,
      details: describe({ operator, plugs, kw: powers.length ? Math.max(...powers) : null, bays: Number(t.capacity) || null, name }),
    });
  }
  return rows;
}

// Open Charge Map POIs (compact) -> rows. Ones marked not working are left out.
export function ocmRows(pois) {
  const rows = [];
  for (const p of pois) {
    const a = p.AddressInfo ?? {};
    if (a.Latitude == null || a.Longitude == null) continue;
    if (p.StatusType?.IsOperational === false || p.StatusTypeID === 100 || p.StatusTypeID === 150) continue; // not working, planned
    const conns = p.Connections ?? [];
    const powers = conns.map((c) => c.PowerKW).filter((x) => x > 0);
    rows.push({
      id: `ocm:${p.ID}`, source: 'ocm', name: (a.Title || 'EV charger').trim(), lat: a.Latitude, lng: a.Longitude,
      details: describe({
        plugs: conns.map((c) => OCM_CONNECTIONS[c.ConnectionTypeID]).filter(Boolean),
        kw: powers.length ? Math.max(...powers) : null,
        bays: p.NumberOfPoints ?? (conns.reduce((n, c) => n + (c.Quantity || 0), 0) || null),
      }),
    });
  }
  return rows;
}

async function fetchJson(url, init) {
  const res = await fetch(url, { ...init, headers: { 'user-agent': UA, accept: 'application/json', ...init?.headers }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${new URL(url).host}: ${res.status}`);
  return res.json();
}

const SOURCES = {
  osm: async () => {
    const q = '[out:json][timeout:60];area["ISO3166-1"="MY"][admin_level=2]->.my;nwr["amenity"="charging_station"](area.my);out center tags;';
    return osmRows((await fetchJson(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: q }) })).elements ?? []);
  },
  ocm: async (env) => {
    const u = new URL(OCM);
    // opendata: only chargers under an open licence (CC BY-SA 4.0), as Open Charge Map's terms ask for reuse.
    Object.entries({ countrycode: 'MY', maxresults: 10000, compact: true, verbose: false, opendata: true, key: env.OCM_KEY }).forEach(([k, v]) => u.searchParams.set(k, v));
    return ocmRows(await fetchJson(u));
  },
};

// The nightly job: refreshes each source last refreshed over a week ago (or never). Returns what it did.
export async function refreshChargers(env, { now = Date.now() } = {}) {
  const db = env.DB;
  const done = {};
  for (const [source, load] of Object.entries(SOURCES)) {
    if (source === 'ocm' && !env.OCM_KEY) continue;
    const last = (await db.prepare('SELECT MAX(updated_at) AS at FROM chargers WHERE source = ?').bind(source).first())?.at;
    if (last != null && now - last < REFRESH_MS) continue;
    let rows;
    try {
      rows = await load(env);
    } catch (e) {
      console.warn('chargers', source, e.message);
      done[source] = 'failed';
      continue;
    }
    if (!rows.length) {
      done[source] = 'empty'; // more likely a bad answer than every charger gone: keep last week's
      continue;
    }
    // A few hundred rows per statement, as JSON: D1 allows only so many queries per run.
    const insert = `INSERT OR REPLACE INTO chargers (id, source, name, lat, lng, details, updated_at)
      SELECT json_extract(value, '$[0]'), ?1, json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'), ?2
      FROM json_each(?3)`;
    const chunks = [];
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      chunks.push(JSON.stringify(rows.slice(i, i + INSERT_CHUNK).map((r) => [r.id, r.name.slice(0, 80), r.lat, r.lng, r.details.slice(0, 120)])));
    }
    await db.batch([
      db.prepare('DELETE FROM chargers WHERE source = ?').bind(source),
      ...chunks.map((c) => db.prepare(insert).bind(source, now, c)),
    ]);
    done[source] = rows.length;
  }
  memo = null;
  return done;
}

// Every charger, a charger in both lists once (Open Charge Map's, which usually says more, kept), as the phone's
// place rows: [name, lng, lat, details, category].
let memo = null; // { at, rows }, for this Worker instance
export async function allChargers(db, { now = Date.now() } = {}) {
  if (memo && now - memo.at < 3600_000) return memo.rows;
  const { results = [] } = await db.prepare('SELECT source, name, lat, lng, details FROM chargers ORDER BY source').all();
  const grid = new Map(); // ~1 km cells, so finding a twin doesn't compare every pair
  const cell = (lat, lng) => `${Math.floor(lat * 100)}:${Math.floor(lng * 100)}`;
  const kept = [];
  for (const r of results) { // 'ocm' sorts before 'osm'
    const [cy, cx] = [Math.floor(r.lat * 100), Math.floor(r.lng * 100)];
    let twin = false;
    for (let dy = -1; dy <= 1 && !twin; dy++) for (let dx = -1; dx <= 1 && !twin; dx++) {
      twin = (grid.get(`${cy + dy}:${cx + dx}`) ?? []).some((o) => distance([o.lng, o.lat], [r.lng, r.lat]) < SAME_M);
    }
    if (twin) continue;
    const k = cell(r.lat, r.lng);
    grid.set(k, [...(grid.get(k) ?? []), r]);
    kept.push([r.name, Math.round(r.lng * 1e5) / 1e5, Math.round(r.lat * 1e5) / 1e5, r.details, CATEGORY]);
  }
  memo = { at: now, rows: kept };
  return kept;
}

export const attribution = 'EV chargers: © OpenStreetMap contributors (ODbL), Open Charge Map (CC BY-SA 4.0)';
