// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// SVG for turn arrows, the car, and map pins.

const ANGLES = {
  straight: 0, depart: 0, slight_right: 45, right: 90, sharp_right: 135, slight_left: -45, left: -90, sharp_left: -135,
  merge: 0, merge_right: 30, merge_left: -30, roundabout_exit: 45,
};

// A roundabout drawn the way this route takes it: in from the bottom, round the circle (clockwise where people
// drive on the left) and out along the exit's real direction. `turn` comes from roundaboutTurn() in nav.js.
export function roundaboutIcon(turn, color = '#fff') {
  const cx = 24, cy = 22, r = 9.5;
  const exit = (((turn.exitAngle % 360) + 360) % 360); // 0 = straight on, 90 = right, as compass angles on the icon
  const at = (deg, rad) => [cx + rad * Math.sin((deg * Math.PI) / 180), cy - rad * Math.cos((deg * Math.PI) / 180)];
  // Going round from the entry at the bottom (180°) to the exit, in the route's direction.
  let sweep = turn.clockwise ? (exit - 180 + 360) % 360 : (180 - exit + 360) % 360;
  sweep = Math.min(Math.max(sweep, 45), 318); // a U-turn comes out beside the way in, not on top of it
  const end = turn.clockwise ? 180 + sweep : 180 - sweep;
  const [sx, sy] = at(180, r), [ex, ey] = at(end, r), [tx, ty] = at(end, 20);
  const f = (n) => n.toFixed(1);
  const head = [-32, 32].map((spread) => {
    const back = end + 180 + spread;
    return `M${f(tx)} ${f(ty)} L${f(tx + 7 * Math.sin((back * Math.PI) / 180))} ${f(ty - 7 * Math.cos((back * Math.PI) / 180))}`;
  });
  const s = `stroke="${color}" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
  return `<svg viewBox="0 0 48 48"><circle cx="${cx}" cy="${cy}" r="${r}" ${s} stroke-width="3" opacity=".4"/>`
    + `<path d="M24 46V${f(sy)} A${r} ${r} 0 ${sweep > 180 ? 1 : 0} ${turn.clockwise ? 1 : 0} ${f(ex)} ${f(ey)} L${f(tx)} ${f(ty)} ${head.join(' ')}" ${s} stroke-width="5"/></svg>`;
}

export function turnIcon(type, color = '#fff') {
  const s = `stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
  if (type?.startsWith('arrive') || type === 'stop') {
    return `<svg viewBox="0 0 48 48"><path d="M14 42V8m0 0h20l-4 8 4 8H14" ${s}/></svg>`;
  }
  if (type === 'roundabout') {
    return `<svg viewBox="0 0 48 48"><circle cx="24" cy="20" r="9" ${s}/><path d="M24 44V29M30.4 13.6 38 6m0 0h-8m8 0v8" ${s}/></svg>`;
  }
  if (type === 'ferry') {
    return `<svg viewBox="0 0 48 48"><path d="M6 32h36l-5 8H11Zm8 0V20h20v12M24 20v-8" ${s}/></svg>`;
  }
  return `<svg viewBox="0 0 48 48">${arrowPaths(type, s)}</svg>`;
}

function arrowPaths(type, s) {
  if (type === 'uturn_left' || type === 'uturn_right') {
    const flip = type === 'uturn_right' ? ' transform="matrix(-1 0 0 1 48 0)"' : '';
    return `<g${flip}><path d="M30 42V20a8 8 0 0 0-16 0v12" ${s}/><path d="m7 26 7 8 7-8" ${s}/></g>`;
  }
  const a = ((ANGLES[type] ?? 0) * Math.PI) / 180;
  const bx = 24, by = 24;
  const ex = bx + 15 * Math.sin(a), ey = by - 15 * Math.cos(a);
  // arrow head: two short lines back from the tip at ±40°
  const back = (off) => {
    const b = a + Math.PI + off;
    return `${(ex + 9 * Math.sin(b)).toFixed(1)} ${(ey - 9 * Math.cos(b)).toFixed(1)}`;
  };
  const stemTop = Math.abs(a) > 1.8 ? 30 : 24;
  return `<path d="M${bx} 44V${stemTop}L${ex.toFixed(1)} ${ey.toFixed(1)}" ${s}/><path d="M${back(0.7)}L${ex.toFixed(1)} ${ey.toFixed(1)}L${back(-0.7)}" ${s}/>`;
}

// Lane arrow bits (see lanes() in src/lib/providers.js) -> the arrow drawn for them.
const LANE_ARROWS = [
  [1 | 2, 'straight'], [4, 'sharp_left'], [8, 'left'], [16, 'slight_left'], [32, 'slight_right'], [64, 'right'],
  [128, 'sharp_right'], [256, 'uturn_left'], [512, 'merge_left'], [1024, 'merge_right'],
];

// One lane: every arrow painted on it, with the ones to follow in white and the rest dimmed.
export function laneIcon({ d, use }) {
  const dim = [], lit = [];
  for (const [bits, type] of LANE_ARROWS) {
    if (!(d & bits)) continue;
    (use & bits ? lit : dim).push(type);
  }
  if (!dim.length && !lit.length) dim.push('straight');
  const stroke = (c) => `stroke="${c}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
  return `<svg viewBox="0 0 48 48">${dim.map((t) => arrowPaths(t, stroke('rgba(255,255,255,.38)'))).join('')}${lit.map((t) => arrowPaths(t, stroke('#fff'))).join('')}</svg>`;
}

export const CAR = `<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="21" fill="currentColor" fill-opacity=".2"/><path d="M24 7 37 38l-13-7-13 7Z" fill="currentColor" stroke="#fff" stroke-width="3" stroke-linejoin="round"/></svg>`;

export const DEST_PIN = `<svg viewBox="0 0 36 46"><path d="M18 44s15-15.4 15-26A15 15 0 0 0 3 18c0 10.6 15 26 15 26Z" fill="#e5484d" stroke="#fff" stroke-width="2.5"/><circle cx="18" cy="18" r="5.5" fill="#fff"/></svg>`;

export const DROP_PIN = `<svg viewBox="0 0 36 46"><path d="M18 44s15-15.4 15-26A15 15 0 0 0 3 18c0 10.6 15 26 15 26Z" fill="#a8306d" stroke="#fff" stroke-width="2.5"/><circle cx="18" cy="18" r="5.5" fill="#fff"/></svg>`;

export const PLACE_ICONS = {
  parking: '<svg viewBox="0 0 24 24"><path fill="currentColor" fill-rule="evenodd" d="M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm3 4v10h2.2v-3.2h2.3a3.4 3.4 0 0 0 0-6.8Zm2.2 2h2.2a1.4 1.4 0 0 1 0 2.8h-2.2Z"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 22s7-7.2 7-12.5a7 7 0 0 0-14 0C5 14.8 12 22 12 22Z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="9.5" r="2.5" fill="currentColor"/></svg>',
  house: '<svg viewBox="0 0 24 24"><path d="M3.5 11 12 4l8.5 7M6 9v11h12V9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 20v-5.5h4V20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  street: '<svg viewBox="0 0 24 24"><path d="M8.5 3 5 21M15.5 3 19 21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 4v3M12 10.5v3M12 17v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  recent: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6L12 16.7l-5.4 2.9 1.1-6-4.5-4.2 6.1-.8Z" fill="#f5b300"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="m13.5 6.5 4 4" stroke="currentColor" stroke-width="2"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 3h4M6 7l1 13h10l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 11v6M14 11v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="19" r="2" fill="currentColor"/></svg>',
};

export function soundIcon(on) {
  return on
    ? '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4Z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4Z" fill="currentColor"/><path d="m16 9 5 6m0-6-5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
}
