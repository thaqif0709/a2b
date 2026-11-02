// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// What drivers can report. Shared by the app (menus, map pins) and the Worker (validation, lifetimes).
// `life` is how long a report stays on the map (minutes) unless other drivers confirm or dismiss it.

// Reports are about roads, and placed where you are. Not on a train trip, its walks included: from a train the report
// would sit on the rail line, and drivers on roads nearby would be warned of jams, police or hazards that aren't there.
export const canReportFrom = (mode) => mode !== 'ride';

export const REPORT_TYPES = {
  traffic: {
    label: 'Traffic', color: '#e5484d', life: 30, points: 5,
    subtypes: { moderate: 'Moderate', heavy: 'Heavy', standstill: 'Standstill' },
  },
  police: {
    label: 'Police', color: '#3e63dd', life: 60, points: 5,
    subtypes: { visible: 'Visible', hidden: 'Hidden', other_side: 'Other side' },
  },
  crash: {
    label: 'Crash', color: '#d6409f', life: 60, points: 6,
    subtypes: { minor: 'Minor', major: 'Major', other_side: 'Other side' },
  },
  hazard: {
    label: 'Hazard', color: '#f76b15', life: 120, points: 5,
    subtypes: {
      object: 'Object on road', pothole: 'Pothole', stopped_vehicle: 'Stopped vehicle', construction: 'Construction',
      animal: 'Animal', broken_light: 'Broken traffic light', fog: 'Fog', flood: 'Flood', ice: 'Ice',
    },
  },
  lane: {
    label: 'Blocked lane', color: '#ffb224', life: 60, points: 5,
    subtypes: { left: 'Left lane', center: 'Center lane', right: 'Right lane' },
  },
  closure: {
    label: 'Closure', color: '#11181c', life: 3 * 24 * 60, points: 8, // until drivers say it's open (or about 3 days)
    subtypes: { construction: 'Construction', event: 'Event', hazard: 'Hazard' },
  },
  camera: {
    label: 'Camera', color: '#8e4ec6', life: 60 * 24 * 30, points: 5,
    subtypes: { speed: 'Speed camera', red_light: 'Red light camera' },
  },
};

// What riders can report about a train line, from a train trip (src/lib/train-reports.js). Kept to the line and a
// station, not a spot on the map: riders see them on that line's rides and when a trip by train uses it, and drivers
// never do. `life` in minutes, as above.
export const TRAIN_REPORT_TYPES = {
  delay: {
    label: 'Delays', short: 'DELAYS', color: '#e67700', life: 45,
    icon: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="#fff" stroke-width="2"/><path d="M12 7.5V12l3 2" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  stopped: {
    label: 'Train stopped', short: 'STOPPED', color: '#e5484d', life: 60,
    icon: '<rect x="6" y="3" width="12" height="14" rx="3.5" fill="none" stroke="#fff" stroke-width="2"/><path d="M10.2 7.5v5M13.8 7.5v5M8.5 21l2-3.5M15.5 21l-2-3.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
  },
  crowded: {
    label: 'Very crowded', short: 'CROWDED', color: '#8e4ec6', life: 30,
    icon: '<circle cx="8" cy="7" r="2.5" fill="#fff"/><circle cx="16" cy="7" r="2.5" fill="#fff"/><path d="M3.5 19v-3a4.5 4.5 0 0 1 9 0v3M11.5 19v-3a4.5 4.5 0 0 1 9 0v3" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
  },
  closed: {
    label: 'Station closed', short: 'CLOSED', color: '#11181c', life: 3 * 60,
    icon: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="#fff" stroke-width="2"/><path d="M7.5 12h9" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>',
  },
};
export const trainReportIcon = (type, size = 24) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${TRAIN_REPORT_TYPES[type]?.icon ?? ''}</svg>`;
export const TRAIN_REPORT_POINTS = 3;

export function isValidReport(type, subtype) {
  const t = REPORT_TYPES[type];
  return Boolean(t && (subtype == null || subtype === '' || Object.hasOwn(t.subtypes, subtype)));
}

export function reportLabel(type, subtype) {
  const t = REPORT_TYPES[type];
  if (!t) return 'Report';
  const s = subtype && t.subtypes[subtype];
  return s ? `${t.label} · ${s}` : t.label;
}

// Small inline icons, drawn on a 24x24 grid in white so they sit on the coloured pin.
export const REPORT_ICONS = {
  traffic: '<path d="M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" fill="none" stroke="#fff" stroke-width="2"/><circle cx="12" cy="7.5" r="1.8" fill="#fff"/><circle cx="12" cy="12" r="1.8" fill="#fff"/><circle cx="12" cy="16.5" r="1.8" fill="#fff"/>',
  police: '<path d="M12 2.5 4 5.5v5.8c0 4.8 3.4 8.8 8 10.2 4.6-1.4 8-5.4 8-10.2V5.5Z" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><path d="m12 7.5 1.3 2.7 3 .4-2.2 2.1.5 3-2.6-1.4-2.6 1.4.5-3-2.2-2.1 3-.4Z" fill="#fff"/>',
  crash: '<path d="M5 15.5 6.6 10a2 2 0 0 1 1.9-1.5h7a2 2 0 0 1 1.9 1.5l1.6 5.5v3.5h-2.5v-2H7.5v2H5Z" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><path d="m4 3 2.5 3M12 2v3.5M20 3l-2.5 3" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
  hazard: '<path d="M12 3.5 2.8 19.5h18.4Z" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><path d="M12 9.5v4.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.3" fill="#fff"/>',
  lane: '<path d="M6 3v18M18 3v18" stroke="#fff" stroke-width="2" stroke-linecap="round"/><path d="M12 3v3M12 9v3" stroke="#fff" stroke-width="2" stroke-linecap="round"/><path d="m9 15 6 6M15 15l-6 6" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>',
  closure: '<rect x="3" y="8" width="18" height="6" rx="1" fill="none" stroke="#fff" stroke-width="2"/><path d="m7 8 4 6M13 8l4 6M6 14v6M18 14v6" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
  camera: '<rect x="3" y="7" width="13" height="9" rx="2" fill="none" stroke="#fff" stroke-width="2"/><path d="m16 10 5-2.5v8L16 13" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><circle cx="9.5" cy="11.5" r="2" fill="#fff"/>',
};

export function reportIcon(type, size = 24) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${REPORT_ICONS[type] ?? REPORT_ICONS.hazard}</svg>`;
}
