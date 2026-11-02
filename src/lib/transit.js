// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Trips by train around the Klang Valley: walk to a station, ride the LRT, MRT, Monorail, BRT or KTM Komuter
// (changing where lines meet), and walk on to the destination. The timetables are Malaysia's official GTFS feeds
// (scripts/build-transit.py -> transit-data.json). Prasarana's lines only say how often trains run, so a wait is
// counted as half the time between trains; KTM Komuter has real departure times. The network is small (under 300
// stations), so a plain Dijkstra over stations, by time, finds the trips. Walks here are straight-line estimates;
// the Worker swaps in real walking routes for the trips it returns.

import DATA from './transit-data.json' with { type: 'json' };
import { distance, decodePolyline, angleDiff } from '../../public/geo.js';
import { trackOf, snap, pointAt } from '../../public/train-guide.js';

const WALK_MPS = 1.25; // ~4.5 km/h
const DETOUR = 1.3; // streets aren't straight lines
const ACCESS_M = 1500; // furthest walk to or from a station, as the crow flies
const ACCESS_STOPS = 6; // nearest stations tried at each end
const TRANSFER_M = 400; // stations this close are one interchange (Masjid Jamek, KL Sentral)
const TRANSFER_EXTRA_S = 60; // stairs, gates
const CHANGE_PENALTY_S = 240; // a change of train is worse than its minutes alone
// A minute on foot counts as this many on a train when choosing a way there: a few minutes more on board beats a
// long walk to a further station or between lines (people would rather ride than walk 20 minutes in the heat).
const WALK_COST = 2;
const MAX_OPTIONS = 3;
const MAX_SEARCHES = 16; // looking for different ways there: each search is under a millisecond
const ALT_DEPTH = 3;
const SLOWER_OK = (best) => best * 1.4 + 600; // an option this much slower than the fastest isn't worth showing
const SAME_WAY_S = 15 * 60; // an option that rides the same track as one already shown counts this much slower
const ON_TRAIN_MPS = 6; // moving this fast along a line: on its train (BOARD_MPS in train-guide.js)
const ON_LINE_M = 80;
const NIGHT_WAIT_S = 45 * 60; // waiting longer than this, overnight, means trains have stopped for the night
const NIGHT_ENDS_S = 5 * 3600; // KTM Komuter can be an hour apart by day: that's a long wait, not the night
const QUICK_WALK_S = 30 * 60; // only suggest walking instead when it's a short walk
const MYT = 8 * 3600_000;
const FEED_NAMES = { prasarana: 'LRT, MRT, Monorail and BRT', ktmb: 'KTM Komuter' };
const DAY = 86400;

export const walkSeconds = (m) => Math.round((m * DETOUR) / WALK_MPS);
const walkCost = (m) => walkSeconds(m) * WALK_COST;
// How a whole trip ranks: its minutes, with the walking counted as WALK_COST says (trip.walk is street metres).
export const effort = (trip) => trip.duration + ((WALK_COST - 1) * trip.walk) / WALK_MPS;

// ---------- The network, read once ----------
const stops = DATA.stops.map(([name, lat, lng, code], i) => ({ i, name, lat, lng, code, at: [lng, lat], visits: [] }));
const patterns = DATA.patterns.map((p, k) => ({ ...p, k }));
for (const p of patterns) p.stops.forEach((s, pos) => stops[s].visits.push([p.k, pos]));
// Stations close enough to change trains on foot, worked out by the build (TRANSFER_M there too).
const nearby = DATA.nearby.map((list) => list.map(([to, m]) => ({ to, m, secs: walkSeconds(m) + TRANSFER_EXTRA_S, cost: walkCost(m) + TRANSFER_EXTRA_S })));
// Each train leg's pattern and stops, kept off the leg itself so they aren't sent: withRealWalks re-boards with them.
const rides = new WeakMap();
const shapes = new Map();
const shapeOf = (id) => {
  if (!id || !DATA.shapes[id]) return null;
  if (!shapes.has(id)) shapes.set(id, decodePolyline(DATA.shapes[id], 5));
  return shapes.get(id);
};

// ---------- When trains run ----------
// The service day for a moment: its date (YYYYMMDD), weekday (Monday 0) and seconds since midnight, Malaysia time.
export function serviceDay(at) {
  const d = new Date(at + MYT);
  return { date: d.toISOString().slice(0, 10).replace(/-/g, ''), dow: (d.getUTCDay() + 6) % 7, secs: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds() };
}

export function runs(serviceId, { date, dow }) {
  const s = DATA.services[serviceId];
  if (!s) return false;
  if (s.remove.includes(date)) return false;
  if (s.add.includes(date)) return true;
  return date >= s.start && date <= s.end && s.days[dow] === 1;
}

// Boarding pattern p at its stop `pos`, at `t` seconds into the service day: when the train leaves (for lines that
// only give a frequency, the expected wait of half a headway) and when it reaches each later stop. Null when no
// more trains run today.
export function board(p, pos, t) {
  if (p.freq) {
    const offset = p.offsets[pos];
    const start = t - offset; // the train must have left its first stop by then
    for (const [from, to, headway] of p.freq) {
      if (start >= to) continue;
      const dep = start < from ? from + offset : t + headway / 2;
      return { dep, headway, arrive: (j) => dep + p.offsets[j] - offset };
    }
    return null;
  }
  const trip = p.trips.find((d) => d[pos] >= t);
  return trip ? { dep: trip[pos], headway: null, arrive: (j) => trip[j] } : null;
}

// ---------- Planning ----------
// A binary heap of numbers by key, smallest key first: the search's queue of stops.
class Heap {
  keys = [];
  vals = [];
  get size() {
    return this.keys.length;
  }
  push(key, val) {
    const { keys, vals } = this;
    let i = keys.length;
    keys.push(key);
    vals.push(val);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (keys[up] <= key) break;
      [keys[i], vals[i]] = [keys[up], vals[up]];
      i = up;
    }
    [keys[i], vals[i]] = [key, val];
  }
  pop() {
    const { keys, vals } = this;
    const top = vals[0];
    const key = keys.pop(), val = vals.pop();
    if (keys.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= keys.length) break;
        if (c + 1 < keys.length && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        [keys[i], vals[i]] = [keys[c], vals[c]];
        i = c;
      }
      [keys[i], vals[i]] = [key, val];
    }
    return top;
  }
}

function access(point) {
  return stops
    .map((s) => ({ s: s.i, m: distance(point, s.at) }))
    .filter((x) => x.m <= ACCESS_M)
    .sort((a, b) => a.m - b.m)
    .slice(0, ACCESS_STOPS);
}

// The fastest trip from `from` to `to` ([lng, lat]) leaving at `t` (seconds into `day`), not using `forbidden` lines
// and not changing trains at the `noChange` stops. `aboard` (see aboardAt): you're on a train already, so the trip
// starts on it, not with a walk to a station.
function search(from, to, t0, day, forbidden, { noChange = new Set(), aboard = null } = {}) {
  const starts = aboard ? [] : access(from);
  const ends = new Map(access(to).map((x) => [x.s, x.m]));
  if ((!starts.length && !aboard) || !ends.size) return null;
  const live = patterns.filter((p) => !forbidden.has(p.line) && runs(p.service, day));
  const liveSet = new Set(live.map((p) => p.k));

  const label = new Array(stops.length).fill(null); // { t, cost, rides, line, prev }
  const done = new Array(stops.length).fill(false);
  const queue = new Heap(); // stops by cost, cheapest first (a stop can be in it more than once: the old ones are skipped)
  const relax = (s, l) => {
    if (label[s] && l.cost >= label[s].cost) return;
    label[s] = l;
    queue.push(l.cost, s);
  };
  for (const { s, m } of starts) relax(s, { t: t0 + walkSeconds(m), cost: walkCost(m), rides: 0, line: null, prev: { kind: 'walk', from: null, m } });
  if (aboard) {
    // Staying on: every later stop of your train, when it gets there.
    const p = patterns[aboard.k];
    for (let j = aboard.i + 1; j < p.stops.length; j++) {
      const arrive = aboard.arrive(j);
      relax(p.stops[j], { t: arrive, cost: arrive - t0, rides: 1, line: p.line, prev: { kind: 'ride', from: null, k: aboard.k, i: aboard.i, j, dep: aboard.dep, headway: aboard.headway, wait: 0, aboard: true } });
    }
  }

  while (queue.size) {
    const s = queue.pop();
    if (done[s]) continue;
    done[s] = true;
    const here = label[s];
    if (here.prev.kind === 'ride' && noChange.has(s)) continue; // looking for a way that changes somewhere else
    // Walk across to another line's platform, but never two walks in a row.
    if (here.prev.kind === 'ride') {
      for (const n of nearby[s]) relax(n.to, { t: here.t + n.secs, cost: here.cost + n.cost, rides: here.rides, line: here.line, prev: { kind: 'walk', from: s, m: n.m } });
    }
    for (const [k, pos] of stops[s].visits) {
      const p = patterns[k];
      if (!liveSet.has(k) || p.line === here.line) continue; // no getting off and back on the same line
      const b = board(p, pos, here.t);
      if (!b) continue;
      const penalty = here.rides ? CHANGE_PENALTY_S : 0;
      for (let j = pos + 1; j < p.stops.length; j++) {
        const arrive = b.arrive(j);
        if (arrive >= DAY + 3 * 3600) break;
        relax(p.stops[j], { t: arrive, cost: here.cost + (arrive - here.t) + penalty, rides: here.rides + 1, line: p.line, prev: { kind: 'ride', from: s, k, i: pos, j, dep: b.dep, headway: b.headway, wait: b.dep - here.t } });
      }
    }
  }

  let best = null;
  for (const [s, m] of ends) {
    const l = label[s];
    if (!l || !l.rides) continue;
    const total = l.cost + walkCost(m);
    if (!best || total < best.cost) best = { s, m, cost: total, t: l.t + walkSeconds(m) };
  }
  if (!best) return null;

  // Back from the last station to the first, then forwards as legs.
  const steps = [];
  for (let s = best.s; s != null; ) {
    const l = label[s];
    steps.unshift({ s, ...l.prev, t: l.t });
    s = l.prev.from;
  }
  return { steps, end: best, t0 };
}

// Each pattern's whole line and where its stops lie along it, worked out the first time it's asked for.
const lines = new Map();
function lineOf(p) {
  if (!lines.has(p.k)) {
    const track = trackOf(rideLine(p, 0, p.stops.length - 1));
    let last = 0;
    const alongs = p.stops.map((s, x) => (last = x ? Math.max(last, snap(track, stops[s].at).along) : 0));
    lines.set(p.k, { track, alongs });
  }
  return lines.get(p.k);
}

// Which train you're on, from a fix moving at train speed: the running line whose track you're on, going the way
// it runs, and between which two of its stops. Null when you aren't on one (or the heading doesn't say which way).
export function aboardAt({ pos, speed, heading }, t, day) {
  if (!pos || !(speed >= ON_TRAIN_MPS) || !Number.isFinite(heading)) return null;
  let best = null;
  for (const p of patterns) {
    if (!runs(p.service, day) || !p.stops.some((s) => distance(stops[s].at, pos) < 5000)) continue;
    const { track, alongs } = lineOf(p);
    const at = snap(track, pos);
    if (at.off > ON_LINE_M || (best && at.off >= best.off)) continue;
    if (Math.abs(angleDiff(heading, pointAt(track, at.along).heading)) > 60) continue; // the other way's train
    let i = 0;
    while (i < alongs.length - 2 && alongs[i + 1] <= at.along) i++;
    best = { p, i, frac: Math.min(1, Math.max(0, (at.along - alongs[i]) / ((alongs[i + 1] - alongs[i]) || 1))), off: at.off };
  }
  if (!best) return null;
  const { p, i, frac } = best;
  if (p.freq) {
    // Part-way from stop i to the next: the rest of that run, then the timetable's minutes between stops.
    const gap = p.offsets[i + 1] - p.offsets[i];
    const next = t + (1 - frac) * gap;
    const headway = (p.freq.find(([from, to]) => t - p.offsets[i] >= from && t - p.offsets[i] < to) ?? p.freq[0])[2];
    return { k: p.k, i, dep: t - frac * gap, headway, arrive: (j) => next + p.offsets[j] - p.offsets[i + 1] };
  }
  // A timed train (KTM Komuter): the one between those two stops now.
  const trip = p.trips.find((d) => d[i] <= t + 60 && d[i + 1] >= t - 60);
  return trip ? { k: p.k, i, dep: trip[i], headway: null, arrive: (j) => Math.max(trip[j], t) } : null;
}

// The stations of a ride from stop index i to j of pattern p, boarding at `dep` (seconds into the service day), for
// the phone to follow the ride (public/train-guide.js): [name, lat, lng, seconds after boarding], in order.
export function rideStations(p, i, j, dep) {
  const b = board(p, i, dep);
  const times = b ? (x) => b.arrive(x) - b.dep : (x) => (p.offsets ? p.offsets[x] - p.offsets[i] : 0);
  const out = [];
  for (let x = i; x <= j; x++) {
    const s = stops[p.stops[x]];
    out.push([s.name, Math.round(s.lat * 1e5) / 1e5, Math.round(s.lng * 1e5) / 1e5, Math.max(0, Math.round(times(x)))]);
  }
  return out;
}

function stationOf(i) {
  const s = stops[i];
  return { name: s.name, code: s.code, lat: s.lat, lng: s.lng };
}

// The line drawn for a ride from stop index i to j of a pattern: along its track where the feed has one.
function rideLine(p, i, j) {
  const pts = p.stops.slice(i, j + 1).map((s) => stops[s].at);
  const track = shapeOf(p.shape);
  if (!track) return pts;
  const near = (pt, from) => {
    let best = from;
    for (let k = from; k < track.length; k++) if (distance(track[k], pt) < distance(track[best], pt)) best = k;
    return best;
  };
  const a = near(pts[0], 0);
  const b = near(pts.at(-1), a);
  return b > a ? [pts[0], ...track.slice(a, b + 1), pts.at(-1)] : pts;
}

function toTrip(found, from, to, dayStart) {
  const ms = (t) => dayStart + t * 1000;
  const legs = [];
  let t = found.t0;
  let place = { name: 'Start', lat: from[1], lng: from[0] };
  for (const st of found.steps) {
    if (st.kind === 'walk') {
      const dest = stationOf(st.s);
      legs.push({ mode: 'walk', from: place, to: dest, distance: Math.round(st.m * DETOUR), duration: st.t - t, coords: [[place.lng, place.lat], [dest.lng, dest.lat]] });
    } else {
      const p = patterns[st.k];
      const line = DATA.lines[p.line];
      const leg = {
        mode: 'train',
        line: { id: p.line, short: line.short, name: line.name, color: line.color, text: line.text, kind: line.kind },
        towards: p.headsign,
        from: stationOf(p.stops[st.i]),
        to: stationOf(p.stops[st.j]),
        stops: st.j - st.i,
        wait: Math.round(st.wait),
        ...(st.aboard && { aboard: true }), // you're on this train already: stay on
        // No train after this one today: miss it and there's no other by this line.
        ...(!st.aboard && !board(p, st.i, st.dep + (st.headway ?? 60)) && { last: true }),
        every: st.headway ? Math.round(st.headway / 60) : null,
        depart: ms(st.dep),
        arrive: ms(st.t),
        duration: st.t - st.dep,
        coords: rideLine(p, st.i, st.j),
        // The track in from the stop before, so the phone can tell you're already on this train as it comes in.
        approach: st.i > 0 ? rideLine(p, st.i - 1, st.i) : null,
        stations: rideStations(p, st.i, st.j, st.dep),
      };
      rides.set(leg, { p, i: st.i, j: st.j, dayStart });
      legs.push(leg);
    }
    t = st.t;
    place = stationOf(st.s);
  }
  const end = found.end;
  legs.push({ mode: 'walk', from: place, to: { name: 'Destination', lat: to[1], lng: to[0] }, distance: Math.round(end.m * DETOUR), duration: walkSeconds(end.m), coords: [[place.lng, place.lat], to] });
  return summarise(legs, ms(found.t0));
}

export function summarise(legs, depart) {
  const duration = legs.reduce((a, l) => a + l.duration + (l.wait ?? 0), 0);
  return {
    ...(legs.some((l) => l.last) && { lastTrain: true }),
    depart,
    arrive: depart + duration * 1000,
    duration,
    walk: legs.filter((l) => l.mode === 'walk').reduce((a, l) => a + l.distance, 0),
    changes: Math.max(0, legs.filter((l) => l.mode === 'train').length - 1),
    legs,
  };
}

// Up to three trips by train from `from` to `to` ([lng, lat]) leaving at `at` (ms): the fastest, then the fastest
// without each of its lines in turn, when they aren't much slower. Also says when walking is simply quicker.
export function planTransit(from, to, at = Date.now(), { moving = null } = {}) {
  const day = serviceDay(at);
  const dayStart = at - day.secs * 1000;
  const walkAll = walkSeconds(distance(from, to));
  // A timetable past its end date drops that operator's trains (see runs). Say so: "no trains" would read as a
  // real answer when it's only old data.
  const outdated = Object.entries(DATA.feeds).filter(([, f]) => f.until && day.date > f.until).map(([id]) => FEED_NAMES[id] ?? id);
  const stale = !outdated.length
    ? null
    : outdated.length === Object.keys(DATA.feeds).length
      ? 'Train timetables are out of date, so trips by train can’t be planned right now.'
      : `${outdated.join(' and ')}${outdated.length > 1 ? ' timetables are' : '’s timetable is'} out of date, so ${outdated.length > 1 ? 'their' : 'its'} trains aren’t included.`;
  const note = (msg) => ({ trips: [], walk: walkAll, note: [stale, msg].filter(Boolean).join(' '), ...(stale && { outdated }) });
  if (outdated.length === Object.keys(DATA.feeds).length) return note(null);
  // On a train already (moving along a line): the trip starts on it, from where it is now.
  const aboard = moving ? aboardAt({ pos: from, ...moving }, day.secs, day) : null;
  if (!aboard && !access(from).length) return note('No train station within walking distance of the start.');
  if (!access(to).length) return note('No train station within walking distance of the destination.');

  const trips = alternatives(from, to, day, dayStart, aboard);
  if (!trips.length) return note(stale ? 'No other trains can get you there at this time.' : 'No trains can get you there at this time.');
  // Late at night the first trip waits for the morning's first train: say so rather than offer a long wait.
  const firstTrain = trips[0].legs.find((l) => l.mode === 'train');
  const overnight = day.secs < NIGHT_ENDS_S || (firstTrain.depart - dayStart) / 1000 >= DAY;
  if (firstTrain.wait > NIGHT_WAIT_S && overnight) return { ...note('Trains have stopped for the night.'), trips, night: true, firstTrain: firstTrain.depart };
  const quickerOnFoot = !aboard && walkAll <= Math.min(...trips.map((t) => t.duration), QUICK_WALK_S);
  return { ...note(quickerOnFoot ? 'Walking there is about as quick.' : null), trips };
}

// Up to three trips: the fastest, then others that go a different way. Each trip found is searched again without
// one of its lines, or without changing where it changes, a few levels deep, so ways that share a line with the
// fastest turn up too (Kinrara BK5 to Q Sentral: the Sri Petaling Line into town, or off it at Sungai Besi for the
// Putrajaya and Kajang Lines). Then each next one shown is the quickest once riding the same track as one already
// shown counts against it, so three versions of nearly the same trip don't crowd out a different one.
function alternatives(from, to, day, dayStart, aboard) {
  const found = new Map();
  const queue = [{ lines: new Set(), noChange: new Set(), depth: 0 }];
  for (let n = 0; queue.length && n < MAX_SEARCHES; n++) {
    const q = queue.shift();
    const f = search(from, to, day.secs, day, q.lines, { noChange: q.noChange, aboard });
    if (!f) continue;
    const trip = toTrip(f, from, to, dayStart);
    const key = lineKey(trip);
    if (found.has(key)) continue;
    found.set(key, trip);
    if (q.depth >= ALT_DEPTH) continue;
    const rideSteps = f.steps.filter((st) => st.kind === 'ride');
    for (const line of new Set(rideSteps.filter((st) => !st.aboard).map((st) => patterns[st.k].line))) {
      queue.push({ lines: new Set([...q.lines, line]), noChange: q.noChange, depth: q.depth + 1 });
    }
    for (const st of rideSteps.slice(0, -1)) queue.push({ lines: q.lines, noChange: new Set([...q.noChange, st.s]), depth: q.depth + 1 });
    // Getting off sooner: at each interchange a ride passes before its stop, the fastest way that changes there or
    // earlier (no changing at the stops after it on that ride).
    for (const st of rideSteps) {
      const on = patterns[st.k].stops;
      for (let m = st.i + 1; m < st.j; m++) {
        if (!canChange(on[m], patterns[st.k].line)) continue;
        queue.push({ lines: q.lines, noChange: new Set([...q.noChange, ...on.slice(m + 1, st.j + 1)]), depth: q.depth + 1 });
      }
    }
  }
  // Best first: the least effort (time, with walking counting extra), not simply the earliest there.
  const all = [...found.values()].sort((a, b) => effort(a) - effort(b));
  if (!all.length) return [];
  const limit = SLOWER_OK(Math.min(...all.map((t) => t.duration)));
  const chosen = [all[0]];
  const lines = (t) => t.legs.filter((l) => l.mode === 'train').map((l) => l.line.id).join('>');
  let pool = all.slice(1).filter((t) => t.duration <= limit && lines(t) !== lines(all[0]));
  while (chosen.length < MAX_OPTIONS && pool.length) {
    const score = (t) => effort(t) - effort(all[0]) + SAME_WAY_S * Math.max(...chosen.map((c) => sameWay(t, c)));
    pool.sort((a, b) => score(a) - score(b));
    const next = pool.shift();
    chosen.push(next);
    pool = pool.filter((t) => lines(t) !== lines(next)); // the same lines changing somewhere else: not another option
  }
  return chosen.sort((a, b) => effort(a) - effort(b));
}

// A stop where you could change to another line: one of its trains, or another line's station a short walk away.
const canChange = (s, line) => nearby[s].length > 0 || stops[s].visits.some(([k]) => patterns[k].line !== line);

// How much of trip a's riding is on the same track as trip b's (0 to 1), by station names: the Ampang and Sri
// Petaling Lines share their track into town, and riding either there is the same trip.
const segments = new WeakMap();
function segmentsOf(trip) {
  if (!segments.has(trip)) {
    const set = new Set();
    for (const l of trip.legs) {
      const r = rides.get(l);
      if (r) for (let x = r.i; x < r.j; x++) set.add(`${stops[r.p.stops[x]].name}>${stops[r.p.stops[x + 1]].name}`);
    }
    segments.set(trip, set);
  }
  return segments.get(trip);
}
function sameWay(a, b) {
  const sa = segmentsOf(a), sb = segmentsOf(b);
  if (!sa.size) return 0;
  let n = 0;
  for (const x of sa) if (sb.has(x)) n++;
  return n / sa.size;
}

const lineKey = (trip) => trip.legs.filter((l) => l.mode === 'train').map((l) => `${l.line.id}:${l.from.code}:${l.to.code}`).join('>');

export const feeds = DATA.feeds;

// The names of a line's stations (for checking a rider's report names one), or null for a line there isn't.
const stationNames = new Map();
export function lineStations(line) {
  if (!DATA.lines[line]) return null;
  if (!stationNames.has(line)) stationNames.set(line, new Set(patterns.filter((p) => p.line === line).flatMap((p) => p.stops.map((s) => stops[s].name))));
  return stationNames.get(line);
}

// ---------- Real walks ----------
const UA = 'a2b-navigation/0.1 (+https://a2b-beta.pages.dev)';
// The public routing server is volunteer-run (fair use), and driving routes need it too: ask it for a few walks per
// request, at most, and remember walks for a day (destinations are often the same places, changes always are).
const MAX_WALKS = 3;
const WALK_TTL_MS = 24 * 3600_000;
const WALK_CACHE_MAX = 500;
const walkCache = new Map(); // key -> { at, walk }, for as long as this Worker instance lives

// Swaps the straight-line walks of these trips for walking routes from the router (Valhalla's pedestrian costing):
// the path to draw, its length and time. A walk not asked for, or that the router can't find, keeps its estimate.
// Then the trips are timed again: a longer walk can miss a KTM train and need the next one.
export async function withRealWalks(env, plan, { now = Date.now() } = {}) {
  const key = (l) => [l.from.lng, l.from.lat, l.to.lng, l.to.lat].map((v) => v.toFixed(5)).join(',');
  // The most useful first: the top trip's walks to the first station and from the last, then the other trips'.
  const order = new Set();
  const want = (l) => l?.mode === 'walk' && l.distance > 30 && order.add(key(l));
  for (const trip of plan.trips) [trip.legs[0], trip.legs.at(-1)].forEach(want);
  for (const trip of plan.trips) trip.legs.forEach(want);
  const walks = new Map();
  const ask = [];
  for (const k of order) {
    const hit = walkCache.get(k);
    if (hit && now - hit.at < WALK_TTL_MS) walks.set(k, hit.walk);
    else if (ask.length < MAX_WALKS) ask.push(k);
  }
  await Promise.all(ask.map(async (k) => {
    const walk = await walkRoute(env, k.split(',').map(Number)).catch(() => null);
    if (!walk) return; // not kept: asked again next time
    walks.set(k, walk);
    walkCache.delete(k);
    walkCache.set(k, { at: now, walk });
    if (walkCache.size > WALK_CACHE_MAX) walkCache.delete(walkCache.keys().next().value);
  }));
  for (const trip of plan.trips) {
    let t = trip.depart; // when each leg can start, in ms
    for (const l of trip.legs) {
      if (l.mode === 'walk') {
        const w = walks.get(key(l));
        if (w) Object.assign(l, structuredClone(w));
        t += l.duration * 1000;
        continue;
      }
      if (l.aboard) { // the train you're on already: no boarding it again
        t = l.arrive;
        continue;
      }
      const ride = rides.get(l);
      const b = ride && board(ride.p, ride.i, (t - ride.dayStart) / 1000);
      if (b) {
        l.depart = ride.dayStart + b.dep * 1000;
        l.arrive = ride.dayStart + b.arrive(ride.j) * 1000;
        l.stations = rideStations(ride.p, ride.i, ride.j, b.dep); // a later KTM train can run to other times
      } else {
        const shift = t + l.wait * 1000 - l.depart; // no train after all: keep the old wait rather than drop the trip
        l.depart += shift;
        l.arrive += shift;
      }
      l.wait = Math.round((l.depart - t) / 1000);
      l.duration = Math.round((l.arrive - l.depart) / 1000);
      t = l.arrive;
    }
    Object.assign(trip, summarise(trip.legs, trip.depart));
  }
  plan.trips.sort((a, b) => effort(a) - effort(b)); // the real walks can change which is best
  return plan;
}

async function walkRoute(env, [lng1, lat1, lng2, lat2]) {
  const res = await fetch(env.ROUTING_URL || 'https://valhalla1.openstreetmap.de/route', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ locations: [{ lat: lat1, lon: lng1 }, { lat: lat2, lon: lng2 }], costing: 'pedestrian', directions_type: 'none', units: 'kilometers' }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const trip = (await res.json()).trip;
  const leg = trip?.legs?.[0];
  if (!leg) return null;
  return { coords: decodePolyline(leg.shape, 6), distance: Math.round(trip.summary.length * 1000), duration: Math.round(trip.summary.time) };
}
