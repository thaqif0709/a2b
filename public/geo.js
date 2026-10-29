// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Small geometry helpers on [lng, lat] pairs. Shared by the app and the Worker.

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function distance(a, b) {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearing(a, b) {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

// Signed smallest difference between two headings, in degrees (-180..180].
export function angleDiff(a, b) {
  let d = (((b - a) % 360) + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

export function interpolate(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// Closest point to p on segment a-b, using a local flat projection (fine at street scale).
export function projectOnSegment(p, a, b) {
  const k = Math.cos(rad(p[1]));
  const ax = a[0] * k, ay = a[1], bx = b[0] * k, by = b[1], px = p[0] * k, py = p[1];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const point = interpolate(a, b, t);
  return { t, point, dist: distance(p, point) };
}

// The point d metres along a line, given its cumulative() distances.
export function atDistance(coords, cum, d) {
  let i = 1;
  while (i < coords.length - 1 && cum[i] < d) i++;
  const span = cum[i] - cum[i - 1];
  return interpolate(coords[i - 1], coords[i], span ? Math.max(0, Math.min(1, (d - cum[i - 1]) / span)) : 0);
}

export function cumulative(coords) {
  const out = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i++) out[i] = out[i - 1] + distance(coords[i - 1], coords[i]);
  return out;
}

// Decodes Google/Valhalla encoded polylines into [lng, lat] pairs. Valhalla uses precision 6.
export function decodePolyline(str, precision = 6) {
  const factor = 10 ** precision;
  const coords = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, byte;
      do {
        byte = str.charCodeAt(i++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lng += delta;
    }
    coords.push([lng / factor, lat / factor]);
  }
  return coords;
}

export function encodePolyline(coords, precision = 6) {
  const factor = 10 ** precision;
  const one = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let out = '';
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return out + String.fromCharCode(v + 63);
  };
  let out = '', pLat = 0, pLng = 0;
  for (const [lng, lat] of coords) {
    const la = Math.round(lat * factor), ln = Math.round(lng * factor);
    out += one(la - pLat) + one(ln - pLng);
    pLat = la;
    pLng = ln;
  }
  return out;
}

export function formatDistance(m, units = 'metric') {
  if (units === 'imperial') {
    const ft = m * 3.28084;
    if (ft < 1000) return `${Math.max(0, Math.round(ft / 50) * 50)} ft`;
    const mi = m / 1609.344;
    return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
  }
  if (m < 950) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  const km = m / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

export function formatDuration(s) {
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function formatClock(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Roughly Malaysia ([lng, lat]): the peninsula, and Sabah and Sarawak, less Singapore island. These boxes also take in
// Brunei and the edges of southern Thailand and Kalimantan, so a place's own country (Photon's, Google's address) and
// a tester's review do the rest.
const MALAYSIA = [[99.6, 1.15, 104.6, 6.75], [109.5, 0.85, 119.3, 7.4]];
const SINGAPORE = [103.6, 1.15, 104.1, 1.445];
const inBox = ([lng, lat], [w, s, e, n]) => lng >= w && lng <= e && lat >= s && lat <= n;
export function inMalaysia(p) {
  return MALAYSIA.some((b) => inBox(p, b)) && !inBox(p, SINGAPORE);
}
