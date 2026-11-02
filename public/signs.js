// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Expressway signs at exits, as drivers see them overhead: "EXIT 218 · 241 · Seremban / Labu". Valhalla gives
// each exit, ramp or fork its sign (exit number, the road it leads onto, where it goes); src/lib/providers.js keeps
// a compact copy on the step, the banner draws it (app.js) and the spoken cues name what they don't already.

const ROUTE_CODE = /^(?:[A-Z]{1,3}\s?)?\d{1,4}[A-Z]?$/; // E2, FT2, 241: a road number, drawn as a shield
const MAX_NAMES = 3;
const MAX_ROADS = 2;

const texts = (list) => (Array.isArray(list) ? list.map((x) => String(x?.text ?? '').trim()).filter(Boolean) : []);
const unique = (list) => list.filter((x, i) => list.indexOf(x) === i);

// Valhalla's maneuver `sign` -> { exit, roads, toward } (each part only when there is one), or null. Place names
// Valhalla lists towards (often mixed with road numbers: "E2, E26, KLIA, Puchong") stay names; the numbers join
// the roads.
export function compactSign(sign) {
  if (!sign) return null;
  const exit = texts(sign.exit_number_elements)[0] ?? '';
  const towards = texts(sign.exit_toward_elements);
  const roads = unique([...texts(sign.exit_branch_elements), ...towards.filter((t) => ROUTE_CODE.test(t))]).slice(0, MAX_ROADS);
  const toward = unique(towards.filter((t) => !ROUTE_CODE.test(t))).slice(0, MAX_NAMES);
  const out = {};
  if (exit) out.exit = exit;
  if (roads.length) out.roads = roads;
  if (toward.length) out.toward = toward;
  return Object.keys(out).length ? out : null;
}

// "Seremban / Labu": the places on the sign, two at most.
export const signPlaces = (sign) => (sign?.toward ?? []).slice(0, 2).join(' / ');

// A spoken cue with what the sign says and the cue doesn't: "Take exit 218." -> "Take exit 218 towards Seremban
// and Labu." Nothing is said twice.
export function withSign(text, sign) {
  if (!text || !sign) return text;
  const has = (s) => text.toLowerCase().includes(s.toLowerCase());
  const exit = sign.exit && !new RegExp(`\\bexit ${sign.exit}\\b`, 'i').test(text) ? sign.exit : null;
  const places = (sign.toward ?? []).slice(0, 2);
  const toward = places.length && !places.some(has) && !/\btowards?\b/i.test(text) ? places : null; // already says where
  if (!exit && !toward) return text;
  const base = text.replace(/[.\s]+$/, '');
  return `${base}${exit ? `, exit ${exit}` : ''}${toward ? ` towards ${toward.join(' and ')}` : ''}.`;
}
