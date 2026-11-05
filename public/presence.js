// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Keeps this device's spot in A2B (see src/lib/presence.js) by checking in every couple of minutes, and
// covers the app with a waiting screen when it's full, letting the driver in as soon as a spot opens.

import { $, api, state, esc, presenceHook } from './core.js';
import { tr, trPlural } from './i18n.js';

const CHECKIN_MS = 2 * 60_000;
let timer = null;
let isDriving = () => false;

export function startPresence({ driving, signUp }) {
  isDriving = driving;
  $('gate-signup').onclick = signUp;
  $('gate-retry').onclick = () => checkIn(true);
  document.addEventListener('visibilitychange', () => !document.hidden && checkIn());
  // A search or route was turned away: check in (showing the waiting screen if it's really full) and let it retry.
  presenceHook.recheck = async () => {
    await checkIn();
    return Boolean(state.presence?.admitted);
  };
  checkIn();
}

let pending = null; // one check-in at a time, however many requests were turned away together

export async function checkIn(byHand = false) {
  clearTimeout(timer);
  timer = setTimeout(checkIn, CHECKIN_MS);
  // A tab left open in the background shouldn't hold a spot, unless it's guiding a drive.
  if (document.hidden && !isDriving()) return;
  if (byHand) $('gate-retry').disabled = true;
  try {
    state.presence = await (pending ??= api('/api/presence', { method: 'POST' }).finally(() => (pending = null)));
    renderGate(state.presence);
  } catch {
    // Offline or the server is busy: leave the app as it is and try again next time.
  } finally {
    $('gate-retry').disabled = false;
  }
}

function renderGate(p) {
  $('gate').classList.toggle('hidden', p.admitted);
  if (p.admitted) return;
  $('gate-count').textContent = tr('{active} of {max}', { active: p.active, max: p.max });
  const others = p.waiting - 1;
  $('gate-wait').textContent = others > 0
    ? trPlural(others, "{n} other person is waiting too. You'll get in when a spot opens.", "{n} other people are waiting too. You'll get in when a spot opens.")
    : tr("You're next. You'll get in when a spot opens.");
  $('gate-signup').classList.toggle('hidden', Boolean(state.user));
  $('gate-priority').textContent = state.user
    ? tr("You're signed in, so you can take any spot that opens, including the ones kept for accounts.")
    : tr('Some spots are kept for drivers with an account, so signing up (free) gets you in sooner.');
}

// "12 of 50 drivers on A2B now", for the menu.
export function onlineLine() {
  const p = state.presence;
  return p?.admitted ? `<span class="dot"></span>${tr('{active} of {max} drivers on A2B now', { active: esc(String(p.active)), max: esc(String(p.max)) })}` : '';
}
