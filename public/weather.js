// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// The weather on a drive: which points of a route to ask about (each at the time the driver will pass it), and
// what the answer means for them, in a few short points for the route sheet: what it may be like on arrival, rain
// or storms on the way, MET Malaysia's warnings, what to bring, and when to rest on a long or night drive. The
// forecasts themselves come from /api/weather.

import { atDistance, cumulative } from './geo.js';

const MAX_POINTS = 8; // the server's limit, destination included
const MIN_STEP_M = 15_000; // a forecast square is ~11 km across; closer points would ask the same one twice

// Points along the route at the time the driver gets there, ending with the destination on arrival.
// route: { coords, cum, distance, duration }; departAt: ms. Returns [{ lng, lat, at, along }].
export function weatherPoints(route, departAt = Date.now()) {
  if (!route.coords?.length) return [];
  const cum = route.cum ?? cumulative(route.coords);
  const total = cum.at(-1);
  if (!total) return [];
  const step = Math.max(MIN_STEP_M, total / (MAX_POINTS - 1));
  const at = (d) => Math.round(departAt + route.duration * 1000 * (d / total));
  const out = [];
  for (let d = step / 2; d < total - step / 2; d += step) {
    const [lng, lat] = atDistance(route.coords, cum, d);
    out.push({ lng, lat, at: at(d), along: d });
  }
  const [lng, lat] = route.coords.at(-1);
  out.push({ lng, lat, at: at(total), along: total });
  return out.slice(-MAX_POINTS);
}

export const weatherQuery = (points) => `pts=${points.map((p) => `${p.lng.toFixed(3)},${p.lat.toFixed(3)},${Math.round(p.at / 1000)}`).join(';')}`;

const WORSE = ['rain', 'heavy-rain', 'storm'];
const wet = (f) => Boolean(f && WORSE.includes(f.sky) && (f.chance ?? 1) >= 0.3);
const severity = (f) => (wet(f) ? WORSE.indexOf(f.sky) + 1 : 0);
const temps = (f) => (f.temp != null ? `${Math.round(f.temp)}°C` : f.low != null && f.high != null ? `${f.low}–${f.high}°C` : '');
// Forecasts are often wrong about exactly where and when it rains, so A2B only ever says what's possible.
const WET_WORDS = { rain: 'Rain', 'heavy-rain': 'Heavy rain', storm: 'Storms' };
const DRY_WORDS = { clear: 'Likely dry', cloudy: 'Likely dry and cloudy', haze: 'Possibly hazy', windy: 'Possibly windy' };
const NOW_MS = 20 * 60_000; // a point this close in time is "now"
// Sticky: warm and damp enough that sweat doesn't dry. MET Malaysia has no humidity; WeatherKit or MET Norway do.
const humid = (f) => Boolean(f && (f.humidity ?? 0) >= 0.7 && (f.temp ?? 0) >= 27);

// Tiredness: a break every 2 hours on a long drive, and a word about drowsiness for drives at night.
export const REST_EVERY_S = 2 * 3600;
const LONG_S = 2 * 3600;
const NIGHT_FROM = 20, NIGHT_TO = 6; // 8pm to 6am, the driver's own clock
export function drivesAtNight(start, seconds, hourOf = (t) => new Date(t).getHours()) {
  for (let t = start; t <= start + seconds * 1000; t += 15 * 60_000) {
    const h = hourOf(t);
    if (h >= NIGHT_FROM || h < NIGHT_TO) return true;
  }
  return false;
}
export function restTip({ start, seconds }, duration, hourOf) {
  const long = seconds >= LONG_S;
  const night = seconds >= 3600 && drivesAtNight(start, seconds, hourOf);
  if (long && night) return `Long night drive (${duration(seconds)}): rest every 2 hours, sooner if sleepy`;
  if (long) return `Long drive (${duration(seconds)}): rest every 2 hours`;
  if (night) return 'Night drive: stop and rest if you feel sleepy';
  return '';
}

// What to show for a drive, short enough to read at a glance. answer: /api/weather's reply (or null); points: what
// was asked; drive: { start ms, seconds }. opts: clock(ms) -> "5:40 PM", duration(s) -> "2 h 5 min", now, hourOf.
// Returns null when there's nothing to say, else { sky, lines, tips, sources }.
export function describeTrip(answer, points, drive, { clock, duration, now = Date.now(), hourOf } = {}) {
  const fs = answer?.points ?? [];
  const destF = fs.at(-1);
  const destP = points.at(-1);
  const lines = [];
  if (destF) {
    const when = [clock(destP.at), temps(destF)].filter(Boolean).join(', ');
    lines.push(`${wet(destF) ? `${WET_WORDS[destF.sky]} possible` : DRY_WORDS[destF.sky] ?? 'Likely dry'} on arrival (${when})`);
  }

  // The worst weather on the way there (not counting the destination), where it's first met.
  let ahead = null;
  fs.slice(0, -1).forEach((f, i) => {
    if (severity(f) > (ahead ? severity(ahead.f) : 0)) ahead = { f, p: points[i] };
  });
  if (ahead) {
    const near = ahead.f.place ? ` near ${ahead.f.place}` : ' on the way';
    lines.push(`${WET_WORDS[ahead.f.sky]} possible${near} ${ahead.p.at - now <= NOW_MS ? 'now' : `around ${clock(ahead.p.at)}`}`);
  }
  for (const w of answer?.warnings ?? []) lines.push(`MET Malaysia: ${w.title.replace(/\bWarning\b/, 'warning')} until ${clock(w.until)}`);

  const tips = [];
  if (wet(destF) || ahead) tips.push('Umbrella or raincoat; avoid light colours');
  const hot = destF && ((destF.feels ?? destF.temp ?? -99) >= 36 || (destF.high ?? -99) >= 35);
  const cool = destF && ((destF.feels ?? destF.temp ?? 99) <= 20 || (destF.high ?? 99) <= 22);
  if (cool) tips.push('May be cool: bring a jacket');
  else if (humid(destF)) tips.push('May be humid: skip long sleeves, jackets and shirts that show sweat');
  if (hot) tips.push('May be hot: light clothes and water');
  if (ahead && severity(ahead.f) >= 2) tips.push('If it pours: slow down, headlights on');
  const rest = drive && duration ? restTip(drive, duration, hourOf) : '';
  if (rest) tips.push(rest);

  if (!lines.length && !tips.length) return null;
  const worst = [destF, ...(ahead ? [ahead.f] : [])].reduce((a, f) => (severity(f) > severity(a) ? f : a), destF);
  const sky = answer?.warnings?.length && !wet(worst) ? 'storm' : worst?.sky ?? 'rest';
  return { sky, lines, tips, sources: answer?.sources ?? [] };
}

// While driving: the next wet stretch within `withinM` ahead, for one spoken heads-up. along: metres driven.
export function wetAhead(answer, points, along, withinM = 8000) {
  const fs = answer?.points ?? [];
  for (let i = 0; i < points.length; i++) {
    const ahead = points[i].along - along;
    if (ahead > 0 && ahead <= withinM && wet(fs[i]) && (fs[i].chance ?? 1) >= 0.5) return { i, ahead, sky: fs[i].sky, place: fs[i].place };
  }
  return null;
}

export function spokenWeather({ sky, place }) {
  const near = place ? ` near ${place}` : '';
  return `${sky === 'storm' ? 'There may be thunderstorms' : sky === 'heavy-rain' ? 'It may rain heavily' : 'It may rain'} ahead${near}. Drive carefully.`;
}

// While driving: a spoken reminder to rest after every 2 hours at the wheel. Returns the text, or '' if not due yet.
export function restReminder(drivenS, reminded, night) {
  const due = Math.floor(drivenS / REST_EVERY_S);
  if (due <= reminded) return '';
  const hours = due * (REST_EVERY_S / 3600);
  return `You've been driving for ${hours} hours. Take a break at the next rest stop${night ? ', especially if you feel sleepy' : ''}.`;
}
