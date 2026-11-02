// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Following a trip by train once it's started (see "Start" on a train trip in app.js): the walk to the station, the
// ride, any change of line, and the walk at the end. On a ride the position comes from GPS when it's good, snapped to
// the track; underground (most of the Kelana Jaya Line in the city, the MRT's tunnels) it's estimated from the time
// since the train left, using the timetable's minutes between stations, and put right as soon as GPS comes back.
// "Next stop: X. Get off here." is said once, as the train leaves the stop before yours or about 90 s before it
// gets there, whichever comes first. Everything here is plain logic; app.js draws and speaks it.
//
// This works while A2B is open. With the phone locked in a pocket a web page doesn't keep running: that needs the
// native app's background location and notifications.

import { distance, bearing, cumulative, angleDiff } from './geo.js';

export const ARRIVE_M = 60; // this close to the station (or the destination), the walk is done
export const BOARD_MPS = 6; // faster than walking, along the line: on the train
export const NEAR_TRACK_M = 80; // a fix this close to the track counts as on it
export const GOOD_ACCURACY_M = 60; // fixes vaguer than this don't place you on the track
export const LOST_MS = 2500; // no good fix for this long: estimating
export const ALERT_BEFORE_S = 90;
export const DWELL_S = 25; // a train stands at each station for about this long
const PAST_M = 40; // past a station by this much, it's behind you
const LOOSE_ACCURACY_M = 150; // indoors and in stations GPS is vague: still good enough to say you've got there
export const STATION_M = 120; // within this of a station's point you're in it: big stations (KL Sentral) spread out
export const OFF_WALK_M = 120; // this far off the walk, and getting further from where it goes: off the trip
export const LEFT_STATION_M = 400; // waiting for a train this far from the station: you've left it
export const OFF_TRAIN_M = 400; // on a ride this far from the line, with good GPS: not on this train
export const OFF_MS = 15_000; // off for this long, not just a wobble
// Moving at train speed this far off the trip (on another line, say, after changing at an interchange) is no wobble:
// off sooner, so the trip is planned again while you can still act on it.
export const OFF_FAST_M = 200;
export const OFF_FAST_MS = 5_000;
const WALK_MPS = 1.25, WALK_DETOUR = 1.3; // as src/lib/transit.js: streets aren't straight lines
export const HERE_TRUST_MS = 120_000; // after "I'm already here", trust you over GPS this long (it's often wrong indoors)

// ---------- Geometry along a track ----------
export function trackOf(coords) {
  return { coords, cum: cumulative(coords) };
}

// Where `pos` ([lng, lat]) lies along the track: metres along it and metres off it.
export function snap(track, pos) {
  const { coords, cum } = track;
  const k = Math.cos((pos[1] * Math.PI) / 180) * 111_320;
  let best = { along: 0, off: Infinity };
  for (let i = 0; i < coords.length - 1; i++) {
    const [a, b] = [coords[i], coords[i + 1]];
    const dx = (b[0] - a[0]) * k, dy = (b[1] - a[1]) * 110_540;
    const px = (pos[0] - a[0]) * k, py = (pos[1] - a[1]) * 110_540;
    const len2 = dx * dx + dy * dy;
    const f = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
    const off = Math.hypot(px - f * dx, py - f * dy);
    if (off < best.off) best = { along: cum[i] + f * (cum[i + 1] - cum[i]), off };
  }
  return best;
}

// The point `along` metres along the track, and the way the track runs there.
export function pointAt(track, along) {
  const { coords, cum } = track;
  if (coords.length < 2) return { pos: coords[0], heading: 0 };
  let i = 1;
  while (i < cum.length - 1 && cum[i] < along) i++;
  const [a, b] = [coords[i - 1], coords[i]];
  const f = Math.max(0, Math.min(1, (along - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1)));
  return { pos: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], heading: bearing(a, b) };
}

// Each station's distance along the track, in order (never going backwards).
export function stationAlongs(track, stations) {
  let last = 0;
  return stations.map(([, lat, lng], i) => {
    const s = i === 0 ? 0 : snap(track, [lng, lat]).along;
    last = Math.max(last, s);
    return last;
  });
}

// ---------- Time along a ride, from the timetable ----------
// When the train leaves station k, in seconds after boarding: it stands a little at every station but the first.
const leaves = (times, k) => (k === 0 ? 0 : times[k] + Math.min(DWELL_S, ((times[k + 1] ?? times[k]) - times[k]) / 3));

// Where the train is `t` seconds after leaving the first station.
export function alongAtTime(times, alongs, t) {
  if (t <= 0) return 0;
  for (let k = 0; k < times.length - 1; k++) {
    const go = leaves(times, k), at = times[k + 1];
    if (t < go) return alongs[k];
    if (t < at) return alongs[k] + ((alongs[k + 1] - alongs[k]) * (t - go)) / ((at - go) || 1);
  }
  return alongs.at(-1);
}

// The other way: how long after leaving the first station the train is `along` metres along (for putting the
// estimate right when GPS comes back).
export function timeAtAlong(times, alongs, along) {
  for (let k = 0; k < times.length - 1; k++) {
    if (along > alongs[k + 1]) continue;
    const go = leaves(times, k), at = times[k + 1];
    const f = (along - alongs[k]) / ((alongs[k + 1] - alongs[k]) || 1);
    return go + Math.max(0, f) * (at - go);
  }
  return times.at(-1);
}

// The next station ahead (index into the ride's stations; at least 1, the first after boarding).
export function nextStop(alongs, along) {
  for (let k = 1; k < alongs.length; k++) if (alongs[k] > along + PAST_M) return k;
  return alongs.length - 1;
}

// Time to say "get off at the next stop": the train has left the stop before yours, or it's about 90 s away.
export function shouldAlert({ alongs, times, along, sinceBoard }) {
  const n = alongs.length;
  if (n < 2) return false;
  return along > alongs[n - 2] + PAST_M || (sinceBoard != null && sinceBoard >= times[n - 1] - ALERT_BEFORE_S);
}

// At your stop: close to it along the track, or (estimating) its time plus the stand has passed.
export function alighted({ alongs, times, along, sinceBoard }) {
  return along >= alongs.at(-1) - PAST_M || (sinceBoard != null && sinceBoard >= times.at(-1) + DWELL_S);
}

// On the train: moving faster than walking near the line, or the train's time has come and gone while you were at
// the station (underground, GPS rarely says).
export function boarded({ speed, off, now, departAt, atStation }) {
  return ((speed ?? 0) >= BOARD_MPS && off <= NEAR_TRACK_M) || (atStation && now >= departAt + 30_000);
}

// Where a fix says you already are on a train leg, when it's further on than the trip thinks (a trip started on
// the platform or on the train): 'ride' on its track at train speed, or on the track in from the stop before
// (`approach`), heading for the first station (`eta` seconds out); 'wait' at its first station; else null.
export function alreadyOn(leg, track, fix, approach = leg.approach?.length > 1 ? trackOf(leg.approach) : null) {
  if (!fix) return null;
  const pos = fix.lngLat;
  const toStation = distance(pos, [leg.from.lng, leg.from.lat]);
  if ((fix.speed ?? 0) >= BOARD_MPS && (fix.accuracy ?? 0) <= GOOD_ACCURACY_M) {
    const s = snap(track, pos);
    if (s.off <= NEAR_TRACK_M && s.along > PAST_M) return { phase: 'ride', along: s.along };
    if (toStation <= PAST_M) return { phase: 'ride', along: 0 };
    const a = approach && snap(approach, pos);
    // On the line into the station, going the way the line runs (not on a train the other way, leaving it).
    const ahead = a && a.off <= NEAR_TRACK_M && (!Number.isFinite(fix.heading) || Math.abs(angleDiff(fix.heading, pointAt(approach, a.along).heading)) <= 90);
    return ahead ? { phase: 'ride', along: 0, eta: toStation / fix.speed } : null;
  }
  return (fix.accuracy ?? 0) <= LOOSE_ACCURACY_M && toStation <= Math.max(STATION_M, fix.accuracy ?? 0) ? { phase: 'wait', along: 0 } : null;
}

// ---------- What to say ----------
const stationName = (s) => (s.name === 'Destination' ? 'your destination' : `${s.name} station`);
export const boardText = (leg) => `Take the ${leg.line.name} towards ${leg.towards}.`;
export const ridingText = (leg, stopsToGo) => `${stopsToGo} stop${stopsToGo > 1 ? 's' : ''} to ${leg.to.name}.`;
export const alertText = (leg) => `Next stop: ${leg.to.name}. Get off here.`;
export const changeText = (leg) => `Change to the ${leg.line.name}, towards ${leg.towards}.`;
export const walkText = (leg) => `Walk to ${stationName(leg.to)}.`;

// Which marker shows where you are: a 3D train on a ride, the chevron on foot (it shows which way you're facing),
// otherwise the vehicle from Settings
// (the chevron unless the car was picked).
export function markerFor({ mode, legMode, vehicle }) {
  if (mode === 'ride') return legMode === 'train' ? 'train' : 'chevron';
  return vehicle === 'car' ? 'car' : 'chevron';
}

// ---------- Following a whole trip ----------
// update({ now, fix }) once a second (fix: { lngLat, speed, accuracy, heading } or null when there's none); returns
// what to show and anything to announce: { view, events: [{ type, text }] }. The first update says how the trip
// starts. A view with `off` set means you've left the trip: app.js plans it again from where you are.
export class TrainGuide {
  constructor(trip, { now = Date.now(), leg = 0 } = {}) {
    this.trip = trip;
    this.i = Math.min(leg, trip.legs.length - 1); // picking a trip up again part-way (after the app reloaded)
    this.started = now;
    this.done = false;
    this.begun = false;
    this.tracks = new Map(); // each train leg's track, worked out once
    this.enterLeg(now);
  }

  get leg() {
    return this.trip.legs[this.i];
  }

  trackFor(k) {
    if (!this.tracks.has(k)) this.tracks.set(k, trackOf(this.trip.legs[k].coords));
    return this.tracks.get(k);
  }

  enterLeg(now) {
    const leg = this.leg;
    this.phase = leg.mode === 'walk' ? 'walk' : 'wait';
    this.along = 0;
    this.boardedAt = null;
    this.lastGood = now;
    this.alerted = false;
    this.approaching = false;
    this.offSince = null;
    this.closest = Infinity; // on a walk: the nearest you've been to where it goes
    this.walkLeft = null;
    this.track = this.trackFor(this.i);
    if (leg.mode === 'train') {
      this.times = leg.stations.map((s) => s[3]);
      this.alongs = stationAlongs(this.track, leg.stations);
      // Drawn along the real track, not just station to station (KTM's feed has no tracks: on a curve that straight
      // line can be a few hundred metres off the train), so being well off it means another train.
      this.onTrack = leg.coords.length > leg.stations.length;
      // Planned from on board (src/lib/transit.js): riding from the start, by the clock from when it left its first
      // stop until GPS says where.
      if (leg.aboard) {
        this.phase = 'ride';
        this.boardedAt = Math.min(now, leg.depart);
      }
    }
  }

  // The next leg, with what to say on reaching it.
  advance(now, events) {
    const was = this.leg;
    if (this.i >= this.trip.legs.length - 1) {
      this.done = true;
      events.push({ type: 'arrived', text: 'You have arrived.' });
      return;
    }
    this.i++;
    this.enterLeg(now);
    const leg = this.leg;
    const after = this.trip.legs[this.i + 1];
    if (leg.mode === 'train') events.push({ type: was.mode === 'train' ? 'change' : 'at-station', text: was.mode === 'train' ? changeText(leg) : boardText(leg) });
    else if (was.mode === 'train' && after?.mode === 'train') events.push({ type: 'change', text: `Get off. ${changeText(after)}` });
    else if (was.mode === 'train') events.push({ type: 'alight', text: `Get off here. ${walkText(leg)}` });
  }

  // On the train, from `along` metres along this leg's track (0 and `eta` seconds out when still heading for its
  // first station).
  board(now, { along = 0, eta = 0 } = {}) {
    this.phase = 'ride';
    this.along = along;
    this.approaching = eta > 0 && this.leg.approach?.length > 1;
    this.approachTrack = this.approaching ? trackOf(this.leg.approach) : null;
    this.boardedAt = this.approaching ? now + eta * 1000 : now - timeAtAlong(this.times, this.alongs, along) * 1000;
    this.lastGood = now;
  }

  boardedText(leg) {
    const n = this.alongs.length;
    return `On the ${leg.line.name}. ${ridingText(leg, this.approaching ? n : n - nextStop(this.alongs, this.along))}`;
  }

  // Already further on than the trip thinks: on the platform, or on the train, of a later leg (a trip started on
  // the train, or GPS that only just caught up). Jumps there, the furthest such leg first.
  catchUp(now, fix, events) {
    for (let k = this.trip.legs.length - 1; k > this.i; k--) {
      const leg = this.trip.legs[k];
      if (leg.mode !== 'train') continue;
      const hit = alreadyOn(leg, this.trackFor(k), fix);
      if (!hit) continue;
      this.i = k;
      this.enterLeg(now);
      if (hit.phase === 'ride') {
        this.board(now, hit);
        events.push({ type: 'boarded', text: this.boardedText(leg) });
      } else events.push({ type: 'at-station', text: boardText(leg) });
      return true;
    }
    return false;
  }

  // Off the trip for a while (not just a GPS wobble); `fast`, at train speed well off it, after only a moment.
  offFor(now, off, fast = false) {
    if (!off || now - (this.hereAt ?? -Infinity) < HERE_TRUST_MS) this.offSince = null;
    else this.offSince ??= now;
    return this.offSince != null && now - this.offSince >= (fast ? OFF_FAST_MS : OFF_MS);
  }

  // "I'm already here", for when GPS can't say (underground, indoors, no signal): on foot, at the end of this walk;
  // waiting, on the train; on a ride, at `station` (index into the ride's stations; the next one by default).
  here({ now = Date.now(), station = null } = {}) {
    const events = [];
    if (this.done) return events;
    this.offSince = null;
    this.hereAt = now;
    const leg = this.leg;
    if (leg.mode === 'walk') {
      this.advance(now, events);
      return events;
    }
    const n = this.alongs.length;
    if (this.phase === 'wait') {
      this.board(now);
      if (station == null || station === 0) {
        events.push({ type: 'boarded', text: this.boardedText(leg) });
        return events;
      }
    }
    const k = Math.max(0, Math.min(n - 1, station ?? (this.approaching ? 0 : nextStop(this.alongs, this.along))));
    this.approaching = false;
    this.along = this.alongs[k];
    this.boardedAt = now - this.times[k] * 1000; // standing at k: the timetable carries on from there
    this.lastGood = now;
    if (k === n - 1) this.advance(now, events);
    else events.push({ type: 'here', text: `At ${leg.stations[k][0]}. ${ridingText(leg, n - 1 - k)}` });
    return events;
  }

  // What "I'm already here" would say you've reached.
  hereText() {
    if (this.done) return null;
    const leg = this.leg;
    if (leg.mode === 'walk') return leg.to.name === 'Destination' ? 'I’ve arrived' : `I’m at ${leg.to.name}`;
    if (this.phase === 'wait') return 'I’m on the train';
    return `I’m at ${leg.stations[this.approaching ? 0 : nextStop(this.alongs, this.along)][0]}`;
  }

  // When you'll get there: the end of this leg from where you are (walking pace, the train you're on, or the one
  // you're waiting for), then the rest of the trip as planned.
  arrival(now = Date.now()) {
    if (this.done) return now;
    const leg = this.leg;
    let t;
    if (leg.mode === 'walk') t = now + ((this.walkLeft ?? leg.distance) * WALK_DETOUR / WALK_MPS) * 1000;
    else if (this.phase === 'wait') t = Math.max(now, leg.depart) + leg.duration * 1000;
    else t = Math.max(now, this.boardedAt + this.times.at(-1) * 1000);
    for (const l of this.trip.legs.slice(this.i + 1)) t += ((l.wait ?? 0) + l.duration) * 1000;
    return t;
  }

  update(o = {}) {
    const r = this.step(o);
    if (!this.done) r.view.arrive = this.arrival(o.now ?? Date.now());
    if (!this.begun) {
      this.begun = true;
      const leg = this.leg;
      const text = leg.mode === 'walk' ? walkText(leg) : leg.aboard ? `Stay on the ${leg.line.name}. ${ridingText(leg, leg.stations.length - nextStop(this.alongs, this.along))}` : boardText(leg);
      if (!r.events.length && !this.done) r.events.unshift({ type: 'start', text });
    }
    return r;
  }

  step({ now = Date.now(), fix = null } = {}) {
    const events = [];
    if (this.done) return { view: { kind: 'done' }, events };
    const good = fix && (fix.accuracy ?? 0) <= GOOD_ACCURACY_M ? fix : null;
    // Walking or waiting, but the GPS says you're already on a later platform or train.
    if (this.phase !== 'ride' && fix && this.catchUp(now, fix, events)) return { view: this.step({ now, fix }).view, events };
    const leg = this.leg;

    if (leg.mode === 'walk') {
      const target = [leg.to.lng, leg.to.lat];
      const pos = good?.lngLat ?? null;
      const left = pos ? distance(pos, target) : null;
      // A vague fix still counts for getting there: stations are big, and GPS inside them is poor.
      const loose = fix && (fix.accuracy ?? 0) <= LOOSE_ACCURACY_M ? distance(fix.lngLat, target) <= Math.max(ARRIVE_M, fix.accuracy ?? 0) : false;
      if ((left != null && left <= ARRIVE_M) || loose || leg.distance < ARRIVE_M / 2) {
        this.advance(now, events);
        return { view: this.done ? { kind: 'done' } : this.step({ now, fix }).view, events };
      }
      if (left != null) this.closest = Math.min(this.closest, left);
      this.walkLeft = left ?? this.walkLeft;
      const offWalk = pos != null ? snap(this.track, pos).off : 0;
      const fast = (good?.speed ?? 0) >= BOARD_MPS && offWalk > OFF_FAST_M; // on a train instead of walking
      const off = this.offFor(now, pos != null && ((offWalk > OFF_WALK_M && left > this.closest + 100) || fast), fast);
      return { view: { kind: 'walk', leg, left: left ?? leg.distance, pos, heading: pos ? bearing(pos, target) : null, off }, events };
    }

    const n = this.alongs.length;
    if (this.phase === 'wait') {
      const s = good ? snap(this.track, good.lngLat) : null;
      const fromStation = good ? distance(good.lngLat, [leg.from.lng, leg.from.lat]) : 0;
      const atStation = !good || fromStation <= 150;
      if (boarded({ speed: good?.speed, off: s?.off ?? Infinity, now, departAt: leg.depart, atStation })) {
        // Boarded seen from GPS part-way along: start the clock from there; otherwise from the train's time.
        this.board(now, { along: s && s.along > PAST_M ? s.along : 0 });
        if (!(s && s.along > PAST_M)) this.boardedAt = Math.min(now, leg.depart + 30_000);
        events.push({ type: 'boarded', text: `On the ${leg.line.name}. ${ridingText(leg, n - 1)}` });
      } else {
        // On a train, but not this one (it isn't on this line's track): another line, or the wrong way.
        const fast = this.onTrack && (good?.speed ?? 0) >= BOARD_MPS && fromStation > OFF_FAST_M && s.off > NEAR_TRACK_M;
        const off = this.offFor(now, fromStation > LEFT_STATION_M || fast, fast);
        // Wandering off from the platform: the marker goes with you, not left at the station.
        const pos = good && fromStation > ARRIVE_M ? good.lngLat : [leg.from.lng, leg.from.lat];
        return { view: { kind: 'wait', leg, pos, heading: pointAt(this.track, 0).heading, departAt: leg.depart, off }, events };
      }
    }

    // Riding: from GPS when it's good and on the line, else from the timetable.
    const s = good ? snap(this.track, good.lngLat) : null;
    let estimating = false;
    let wayOff = s != null && s.off > OFF_TRAIN_M;
    if (this.approaching) {
      // Still heading for the first station: wait there until GPS (or the clock) says the train has reached it.
      const toStation = good ? distance(good.lngLat, [leg.from.lng, leg.from.lat]) : null;
      wayOff = good != null && snap(this.approachTrack, good.lngLat).off > OFF_TRAIN_M && s.off > OFF_TRAIN_M;
      if (toStation != null && toStation > PAST_M && !(s.off <= NEAR_TRACK_M && s.along > PAST_M)) {
        if ((good.speed ?? 0) > 1) this.boardedAt = now + (toStation / good.speed) * 1000;
        this.lastGood = now;
      } else if (good || now >= this.boardedAt) {
        this.approaching = false;
        if (good) this.boardedAt = now - timeAtAlong(this.times, this.alongs, Math.max(0, s.along)) * 1000;
      }
    }
    if (!this.approaching && s && s.off <= NEAR_TRACK_M * 1.5) {
      this.along = Math.max(this.along - 20, s.along); // GPS wobble can't send the train backwards far
      this.boardedAt = now - timeAtAlong(this.times, this.alongs, this.along) * 1000; // put the estimate right
      this.lastGood = now;
    } else if (!this.approaching) {
      const sinceBoard = (now - this.boardedAt) / 1000;
      this.along = Math.max(this.along, alongAtTime(this.times, this.alongs, sinceBoard));
      // "No GPS" only when there's no good fix: one that's good but off the line isn't underground.
      estimating = !s && now - this.lastGood > LOST_MS;
    }
    const fast = this.onTrack && (good?.speed ?? 0) >= BOARD_MPS && s != null && s.off > OFF_FAST_M
      && (!this.approaching || snap(this.approachTrack, good.lngLat).off > OFF_FAST_M);
    const off = this.offFor(now, wayOff || fast, fast);
    const sinceBoard = (now - this.boardedAt) / 1000;
    if (!this.approaching && !this.alerted && shouldAlert({ alongs: this.alongs, times: this.times, along: this.along, sinceBoard })) {
      this.alerted = true;
      events.push({ type: 'alert', text: alertText(leg) });
    }
    if (!this.approaching && alighted({ alongs: this.alongs, times: this.times, along: this.along, sinceBoard })) {
      this.advance(now, events);
      return { view: this.done ? { kind: 'done' } : this.step({ now, fix }).view, events };
    }
    const next = this.approaching ? 0 : nextStop(this.alongs, this.along);
    const at = pointAt(this.track, this.along);
    return {
      view: {
        kind: 'ride', leg, pos: off ? good.lngLat : at.pos, heading: at.heading, estimating, alerted: this.alerted, off,
        next: leg.stations[next][0], stopsToGo: n - next,
        stations: leg.stations.map(([name], k) => ({ name, state: k < next ? 'past' : k === n - 1 ? 'alight' : k === next ? 'next' : 'later' })),
      },
      events,
    };
  }
}
