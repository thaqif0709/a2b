// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// The weather a driver will meet: at points along a route at the time they'll pass them, and at the destination
// when they arrive, plus MET Malaysia's live warnings (thunderstorms, heavy rain) for the states on the way.
//
// Forecasts come from Apple's WeatherKit when the app has a WeatherKit key (WEATHERKIT_* secrets, see README):
// hourly, for the exact spot. Each ~11 km square is fetched at most once an hour and shared by everyone driving
// through it (see shared-cache.js). Without a key, or when WeatherKit fails, MET Malaysia's free open forecast (api.data.gov.my) is used
// instead: morning, afternoon and night for the nearest of its ~420 towns and districts, fetched once an hour for
// the whole country. MET Malaysia has no humidity, so for the destination it's added from MET Norway's free
// Locationforecast (api.met.no), one fetch per square per hour. The weather is a nice-to-have: anything that fails
// just leaves that point without a forecast, or without humidity.

import { distance } from '../../public/geo.js';
import TOWNS from './met-towns.json' with { type: 'json' };
import { sharedCache } from './shared-cache.js';

const MET_FORECAST = 'https://api.data.gov.my/weather/forecast/?limit=10000';
const MET_WARNINGS = 'https://api.data.gov.my/weather/warning/?limit=50';
const WEATHERKIT = 'https://weatherkit.apple.com/api/v1/weather/en';
const MET_NORWAY = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
const UA = 'a2b-navigation/0.1 (+https://a2b-beta.pages.dev)';
export const MAX_POINTS = 8;
const CELL_DEG = 0.1; // ~11 km squares share one WeatherKit forecast
const FORECAST_TTL = 3600; // seconds
const WARNINGS_TTL = 900;
const TOWN_MAX_M = 60_000; // further than this from any MET town, MET Malaysia has nothing to say
const MYT = 8 * 3600_000; // Malaysia time, which MET Malaysia's dates and times are in

export const SOURCES = {
  weatherkit: { name: ' Weather', url: 'https://weatherkit.apple.com/legal-attribution.html' },
  met: { name: 'MET Malaysia', url: 'https://www.met.gov.my' },
  metno: { name: 'MET Norway', url: 'https://api.met.no' },
};

// ---------- What the weather means for a driver ----------

// One shape for both sources. sky: clear | cloudy | haze | windy | rain | heavy-rain | storm.
// chance: how likely rain is (0-1), temp/feels in °C and humidity 0-1 (WeatherKit), low/high for the day (MET Malaysia).
const WET = new Set(['rain', 'heavy-rain', 'storm']);
export const isWet = (f) => Boolean(f && WET.has(f.sky) && (f.chance ?? 1) >= 0.3);

// WeatherKit's condition codes (Clear, MostlyCloudy, ScatteredThunderstorms, HeavyRain...).
export function skyFromCondition(code, mmPerHour = 0) {
  const c = String(code ?? '');
  if (/thunder|storm|hurricane|tropical/i.test(c)) return 'storm';
  if (/heavyrain/i.test(c) || mmPerHour >= 7.6) return 'heavy-rain';
  if (/rain|drizzle|shower|sleet/i.test(c) || mmPerHour >= 0.5) return 'rain';
  if (/haze|smok|fog|dust/i.test(c)) return 'haze';
  if (/wind|breez/i.test(c)) return 'windy';
  if (/cloud/i.test(c)) return 'cloudy';
  return 'clear';
}

// MET Malaysia's Malay wording: "Ribut petir di beberapa tempat" (thunderstorms in a few places), "Hujan di
// kebanyakan tempat" (rain in most places), "Tiada hujan" (no rain), "Berangin" (windy).
export function readMetText(text) {
  const t = String(text ?? '').toLowerCase();
  const where = /menyeluruh/.test(t) ? 'widespread' : /kebanyakan/.test(t) ? 'in most places' : /beberapa/.test(t) ? 'in places' : '';
  const area = /pedalaman/.test(t) ? 'inland' : /pantai/.test(t) ? 'near the coast' : '';
  const chance = where === 'in places' ? 0.4 : where === 'in most places' ? 0.7 : 0.8;
  if (/tiada hujan/.test(t)) return { sky: 'clear', chance: 0.1, text: 'No rain' };
  if (/ribut petir/.test(t)) return { sky: 'storm', chance, text: ['Thunderstorms', where, area].filter(Boolean).join(' ') };
  if (/hujan/.test(t)) return { sky: 'rain', chance, text: ['Rain', where, area].filter(Boolean).join(' ') };
  if (/berangin/.test(t)) return { sky: 'windy', chance: 0.1, text: 'Windy' };
  if (/jerebu/.test(t)) return { sky: 'haze', chance: 0.1, text: 'Hazy' };
  return null;
}

// ---------- MET Malaysia ----------

export function nearestTown([lng, lat], towns = TOWNS) {
  let best = null, bestM = TOWN_MAX_M;
  for (const t of towns) {
    if (Math.abs(t[2] - lat) > 0.6 || Math.abs(t[3] - lng) > 0.6) continue;
    const m = distance([lng, lat], [t[3], t[2]]);
    if (m < bestM) (best = t), (bestM = m);
  }
  return best && { id: best[0], name: best[1], state: best[4] };
}

// The forecast row and part of the day for a moment: morning 6am-noon, afternoon noon-7pm, night 7pm-6am (the small
// hours belong to the night before).
export function metPeriod(at) {
  const local = new Date(at + MYT);
  let h = local.getUTCHours();
  if (h < 6) local.setUTCDate(local.getUTCDate() - 1), (h = 24);
  return { date: local.toISOString().slice(0, 10), part: h < 12 ? 'morning' : h < 19 ? 'afternoon' : 'night' };
}

export function metForecast(rows, town, at) {
  if (!town) return null;
  const { date, part } = metPeriod(at);
  const row = rows.find((r) => r.location?.location_id === town.id && r.date === date);
  const read = row && readMetText(row[`${part}_forecast`]);
  if (!read) return null;
  return { ...read, low: row.min_temp ?? null, high: row.max_temp ?? null, place: town.name, source: 'met' };
}

// The warnings in force over a moment's window that name one of these states, cut down to the part about them.
// Sea warnings (for boats) and "no advisory" notices are left out.
const STATE_NAMES = {
  'kuala lumpur': ['kuala lumpur'], putrajaya: ['putrajaya'], selangor: ['selangor'], 'negeri sembilan': ['n. sembilan', 'negeri sembilan'],
  melaka: ['melaka', 'malacca'], malacca: ['melaka', 'malacca'], johor: ['johor'], pahang: ['pahang'], terengganu: ['terengganu'],
  kelantan: ['kelantan'], perak: ['perak'], penang: ['pulau pinang', 'penang'], 'pulau pinang': ['pulau pinang', 'penang'],
  kedah: ['kedah'], perlis: ['perlis'], sabah: ['sabah'], sarawak: ['sarawak'], labuan: ['labuan'],
};
const stateKeys = (state) => {
  const s = String(state ?? '').toLowerCase().replace(/^(federal territory of|wilayah persekutuan)\s*/, '');
  return STATE_NAMES[s] ?? (s ? [s] : []);
};

export function warningsFor(warnings, states, from, to) {
  const keys = [...new Set(states.flatMap(stateKeys))];
  if (!keys.length) return [];
  const out = [];
  for (const w of warnings) {
    const title = w.warning_issue?.title_en ?? '';
    if (!w.valid_to || /sea|cyclone|no advisory/i.test(title)) continue;
    const start = Date.parse(`${w.valid_from}+08:00`), end = Date.parse(`${w.valid_to}+08:00`);
    if (!(end > from && start < to)) continue;
    const parts = String(w.text_en ?? '').split(/\s*\d+\)\s+/).filter(Boolean);
    const about = parts.filter((p) => keys.some((k) => p.toLowerCase().includes(k)));
    if (!about.length) continue;
    out.push({ title, text: about.join(' '), from: start, until: end });
  }
  // The same warning is often reissued with a longer window; keep the latest of each text.
  return [...new Map(out.sort((a, b) => a.until - b.until).map((w) => [w.text, w])).values()];
}

// ---------- WeatherKit ----------

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = (s) => b64url(new TextEncoder().encode(s));
let token = null; // { value, until }

export const weatherKitReady = (env) => Boolean(env.WEATHERKIT_TEAM_ID && env.WEATHERKIT_SERVICE_ID && env.WEATHERKIT_KEY_ID && env.WEATHERKIT_KEY);

// WeatherKit's REST API takes a short-lived ES256 token signed with the key from the Apple developer account.
async function weatherKitToken(env, now) {
  if (token && token.until > now + 60_000) return token.value;
  const pem = String(env.WEATHERKIT_KEY).replace(/-----[^-]+-----|\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const iat = Math.floor(now / 1000), exp = iat + 3600;
  const head = b64urlText(JSON.stringify({ alg: 'ES256', kid: env.WEATHERKIT_KEY_ID, id: `${env.WEATHERKIT_TEAM_ID}.${env.WEATHERKIT_SERVICE_ID}` }));
  const body = b64urlText(JSON.stringify({ iss: env.WEATHERKIT_TEAM_ID, sub: env.WEATHERKIT_SERVICE_ID, iat, exp }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${head}.${body}`));
  token = { value: `${head}.${body}.${b64url(sig)}`, until: exp * 1000 };
  return token.value;
}

export const cellOf = ([lng, lat]) => [Math.round(lat / CELL_DEG) * CELL_DEG, Math.round(lng / CELL_DEG) * CELL_DEG].map((v) => +v.toFixed(2));

// The next two days, hour by hour, for one square, kept small: [start ms, condition, °C, feels °C, chance, mm/h,
// humidity 0-1].
function weatherKitHours(env, cell, now, store) {
  const [lat, lng] = cell;
  return store.get(`weather:wk:${lat},${lng}`, FORECAST_TTL, async () => {
    const u = new URL(`${WEATHERKIT}/${lat}/${lng}`);
    u.searchParams.set('dataSets', 'forecastHourly');
    u.searchParams.set('timezone', 'Asia/Kuala_Lumpur');
    u.searchParams.set('hourlyEnd', new Date(now + 48 * 3600_000).toISOString());
    const res = await fetch(u, { headers: { authorization: `Bearer ${await weatherKitToken(env, now)}`, 'user-agent': UA }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`WeatherKit ${res.status}`);
    return ((await res.json()).forecastHourly?.hours ?? []).map((h) => [
      Date.parse(h.forecastStart), h.conditionCode, h.temperature, h.temperatureApparent, h.precipitationChance, h.precipitationIntensity, h.humidity,
    ]);
  });
}

export function weatherKitAt(hours, at) {
  const h = hours.filter((x) => x[0] <= at + 1800_000).at(-1);
  if (!h || at - h[0] > 2 * 3600_000) return null;
  const [, code, temp, feels, chance, mm, humidity] = h;
  const sky = skyFromCondition(code, mm ?? 0);
  return { sky, chance: chance ?? null, temp: temp ?? null, feels: feels ?? null, humidity: humidity ?? null, text: conditionText(code), source: 'weatherkit' };
}

// "MostlyCloudy" -> "Mostly cloudy".
const conditionText = (code) => String(code ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/^./, (c) => c.toUpperCase());

// ---------- MET Norway (humidity) ----------

// The hourly temperature and humidity for one square: [start ms, °C, humidity 0-1]. MET Norway asks every app to
// say who it is in the User-Agent and not to ask for the same place more than its Expires header allows (~30 min).
function metNorwayHours(cell, store) {
  const [lat, lng] = cell;
  return store.get(`weather:metno:${lat},${lng}`, FORECAST_TTL, async () => {
    const res = await fetch(`${MET_NORWAY}?lat=${lat}&lon=${lng}`, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`MET Norway ${res.status}`);
    return ((await res.json()).properties?.timeseries ?? []).map((t) => [
      Date.parse(t.time), t.data?.instant?.details?.air_temperature ?? null, (t.data?.instant?.details?.relative_humidity ?? NaN) / 100,
    ]);
  });
}

export function metNorwayAt(hours, at) {
  const h = hours.filter((x) => x[0] <= at + 1800_000).at(-1);
  if (!h || at - h[0] > 3 * 3600_000 || !Number.isFinite(h[2])) return null;
  return { temp: h[1], humidity: Math.round(h[2] * 100) / 100 };
}

// ---------- Both together ----------

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json();
}

// MET Malaysia's whole-country forecast, kept as small rows ([id, date, morning, afternoon, night, min °C, max °C],
// about a quarter of its size) and turned back into its own shape when read.
const metForecastRows = async (store) =>
  (
    await store.get('weather:met:forecast', FORECAST_TTL, async () =>
      (await getJson(MET_FORECAST)).map((r) => [
        r.location?.location_id, r.date, r.morning_forecast, r.afternoon_forecast, r.night_forecast, r.min_temp, r.max_temp,
      ]),
    )
  ).map(([id, date, morning, afternoon, night, min, max]) => ({
    location: { location_id: id }, date, morning_forecast: morning, afternoon_forecast: afternoon, night_forecast: night, min_temp: min, max_temp: max,
  }));

// points: [{ lng, lat, at }] with `at` the time (ms) the driver will be there.
// store: where answers are shared between drivers (shared-cache.js; the Worker passes one backed by D1).
export async function weatherAlong(env, points, { now = Date.now(), store = sharedCache(env.DB) } = {}) {
  const towns = points.map((p) => nearestTown([p.lng, p.lat]));
  let metRows = null;
  const met = async () => (metRows ??= metForecastRows(store).catch(() => []));

  const cells = new Map(); // one WeatherKit request per square, however many points fall in it
  const kit = weatherKitReady(env)
    ? (p) => {
        const cell = cellOf([p.lng, p.lat]);
        const k = cell.join(',');
        if (!cells.has(k)) cells.set(k, weatherKitHours(env, cell, now, store).catch((e) => (console.warn('weather', e.message), null)));
        return cells.get(k);
      }
    : null;

  const forecasts = await Promise.all(
    points.map(async (p, i) => {
      const hours = kit && (await kit(p));
      const f = hours && weatherKitAt(hours, p.at);
      if (f) return { ...f, place: towns[i]?.name ?? null };
      return metForecast(await met(), towns[i], p.at);
    }),
  );

  // Humidity for the destination, for what-to-wear tips, when the forecast came without it.
  const last = points.length - 1, dest = forecasts[last];
  if (dest && dest.humidity == null) {
    const extra = await metNorwayHours(cellOf([points[last].lng, points[last].lat]), store)
      .then((hours) => metNorwayAt(hours, points[last].at))
      .catch((e) => (console.warn('weather', e.message), null));
    if (extra) forecasts[last] = { ...dest, temp: dest.temp ?? extra.temp, humidity: extra.humidity, extra: 'metno' };
  }

  const states = [...new Set(towns.filter(Boolean).map((t) => t.state))];
  const end = Math.max(now, ...points.map((p) => p.at));
  const warnings = await store
    .get('weather:met:warnings', WARNINGS_TTL, () => getJson(MET_WARNINGS))
    .then((w) => warningsFor(Array.isArray(w) ? w : [], states, now, end))
    .catch(() => []);

  const used = new Set([...forecasts.filter(Boolean).flatMap((f) => [f.source, f.extra].filter(Boolean)), ...(warnings.length ? ['met'] : [])]);
  return { points: forecasts, warnings, sources: [...used].map((s) => SOURCES[s]) };
}
