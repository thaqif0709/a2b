// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Where did I park? When a drive ends, the car's last GPS fix is kept on this phone (never sent anywhere), with
// a note if you add one ("B2, pillar C4"), so a walking route can take you back to it. Which drives count, the
// label for it and when it's been picked up are worked out here; app.js keeps it and draws it.

const MIN_DRIVEN_M = 300; // a drive shorter than this hasn't moved the car anywhere new
const PICKED_UP_M = 150; // a drive starting this close to it means you've gone back to the car

// Whether a drive that just ended parked the car: driven, not walked or by train, not a demo, and far enough.
export function shouldSave({ travel, simulated, driven, at }) {
  return travel === 'drive' && !simulated && driven >= MIN_DRIVEN_M && Array.isArray(at);
}

// What's kept: { lng, lat, at (ms), near (where you were going), note }.
export function parkedCar(at, near, now = Date.now()) {
  return { lng: at[0], lat: at[1], at: now, near: near || '', note: '' };
}

// "Parked 2 h ago near Pavilion Kuala Lumpur".
export function parkedLabel(car, now = Date.now()) {
  const mins = Math.max(0, Math.round((now - car.at) / 60_000));
  const days = Math.round(mins / (24 * 60));
  const ago = mins < 1 ? 'just now'
    : mins < 60 ? `${mins} min ago`
    : mins < 24 * 60 ? `${Math.round(mins / 60)} h ago`
    : `${days} day${days > 1 ? 's' : ''} ago`;
  return `Parked ${ago}${car.near ? ` near ${car.near}` : ''}`;
}

// A new drive starting at `from` ([lng, lat]) close to the car: it's been picked up.
export function pickedUp(car, from, distance) {
  return Boolean(car && from) && distance([car.lng, car.lat], from) <= PICKED_UP_M;
}
