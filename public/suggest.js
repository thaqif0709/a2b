// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Suggesting a place (src/lib/suggestions.js): a missing one, from a search that didn't find it, or a fix for one
// that's pinned in the wrong spot or isn't there any more, from its sheet. The pin stays in the middle of the map
// and the map moves under it, as in other map apps: a dragged pin hides under the finger, and pinch-zoom keeps
// working. Testers review suggestions on the same screen (Settings › Testing › Feedback › Places). Approved places
// come back to every phone through GET /api/driver-places and are searched with its own (public/places.js).

import { $, state, api, local, toast, esc, armBack, sideColumnEnd } from './core.js';
import { setDriverPlaces } from './places.js';
import { DEST_PIN } from './icons.js';

// The kinds a driver can pick. fuel, ev, hospital, clinic, police and convenience are the kinds a search for "petrol"
// or "klinik" finds (public/places.js TYPES), so a place of those kinds is found that way too.
export const KINDS = [
  ['shop', 'Shop'], ['food', 'Food & drink'], ['fuel', 'Petrol'], ['ev', 'EV charger'], ['clinic', 'Clinic'], ['hospital', 'Hospital'],
  ['police', 'Police'], ['convenience', 'Convenience store'], ['office', 'Office'], ['', 'Something else'],
];
const kindLabel = (k) => KINDS.find(([v]) => v === (k ?? ''))?.[1] ?? k;

let ctx = null; // { map, openAuth, setBrowseHidden }
let open = null; // the suggestion being made or reviewed
let wasMarker = null;
let atMarker = null; // while reviewing: the spot the driver suggested
let whereSeq = 0;

export function initSuggest(callbacks) {
  ctx = callbacks;
  $('suggest-pin').innerHTML = `${DEST_PIN}<i></i>`;
  ctx.map.on('movestart', () => open?.picking && $('suggest-pin').classList.add('moving'));
  ctx.map.on('moveend', () => {
    if (!open?.picking) return;
    $('suggest-pin').classList.remove('moving');
    nameSpot();
  });
}

export const suggesting = () => open !== null;

// ---------- Keeping the approved places on the phone ----------
const SYNC_EVERY = 5 * 60_000;
let syncing = null;
let syncedAt = 0;

// Loads the places kept on this phone, then asks for what changed since. Cheap enough to call whenever search opens.
export function syncDriverPlaces(force = false) {
  const kept = local.get('driverPlaces', { since: 0, rows: [] });
  if (!syncedAt) setDriverPlaces(kept.rows);
  if (syncing || (!force && Date.now() - syncedAt < SYNC_EVERY)) return syncing ?? Promise.resolve();
  syncing = (async () => {
    const byId = new Map(kept.rows.map((r) => [r.id, r]));
    let since = kept.since;
    for (let i = 0; i < 10; i++) {
      const { places, next, more } = await api(`/api/driver-places?since=${since}`);
      for (const r of places) r.removed ? byId.delete(r.id) : byId.set(r.id, r);
      since = next;
      if (!more) break;
    }
    const rows = [...byId.values()];
    local.set('driverPlaces', { since, rows });
    setDriverPlaces(rows);
    syncedAt = Date.now();
  })()
    .catch(() => {})
    .finally(() => (syncing = null));
  return syncing;
}

// ---------- Suggesting ----------

// kind: 'add' (name: what was searched), or for a place that's wrong, 'fix' (asks move or gone first).
export function openSuggest({ kind, name = '', place = null, onClose = null }) {
  if (!state.user) return ctx.openAuth('suggest');
  if (kind === 'fix') return askWhatsWrong(place, onClose);
  const at = place ? [place.lng, place.lat] : state.pos?.lngLat ?? ctx.map.getCenter().toArray();
  start({ kind, name: place?.name ?? name, category: '', note: '', was: kind === 'add' ? null : place, at, onClose });
}

function askWhatsWrong(place, onClose) {
  open = { kind: 'fix', was: place, onClose };
  show(`What's wrong with ${esc(place.name)}?`, esc(place.address || ''), `
    <div class="suggest-choices">
      <button class="set-row" data-pick="move"><span>It's in the wrong spot<small>Move the pin to where it really is</small></span></button>
      <button class="set-row" data-pick="gone"><span>It isn't here any more<small>Closed, moved away or never there</small></span></button>
    </div>`);
  placeWasMarker(place);
  ctx.map.easeTo({ center: [place.lng, place.lat], zoom: Math.max(ctx.map.getZoom(), 16), padding: padding() });
  $('suggest-body').onclick = (e) => {
    const pick = e.target.closest('[data-pick]')?.dataset.pick;
    if (pick) start({ kind: pick, name: place.name, category: '', note: '', was: place, at: [place.lng, place.lat], onClose });
  };
}

// The suggestion screen. With review set, a tester's: who sent it, and Approve or Reject.
function start(s, review = null) {
  // A tester reviews the driver's spot as it is: no centre pin to move, just the driver's pin on the map.
  open = { ...s, review, picking: !review && s.kind !== 'gone' };
  const title = review
    ? { add: 'Add a place?', move: 'Move this place?', gone: 'Take this place out?' }[s.kind]
    : { add: 'Add a missing place', move: 'Move the pin', gone: `${s.name} isn't here any more` }[s.kind];
  const sub = s.kind === 'gone' ? esc(s.was?.address || '') : review ? esc(s.address || '') : 'Move the map so the pin is on the entrance';
  const by = review ? `<p class="hint suggest-by">From ${esc(review.by_name ?? 'a driver')}${review.by_email ? ` · ${esc(review.by_email)}` : ''}${review.note ? `<br>“${esc(review.note)}”` : ''}</p>` : '';
  show(esc(title), sub, `${by}
    ${s.kind !== 'add' ? '' : `<input id="suggest-name" class="field" maxlength="80" placeholder="Name of the place" value="${esc(s.name)}" autocomplete="off">
      <div class="suggest-kinds" role="radiogroup" aria-label="Kind of place">${KINDS.map(([v, l]) => `<button type="button" role="radio" data-kind="${v}" aria-checked="${v === s.category}" class="${v === s.category ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`}
    ${review ? '' : `<input id="suggest-note" class="field" maxlength="300" placeholder="${s.kind === 'gone' ? 'What happened to it? (optional)' : 'Anything else? (optional)'}">`}
    <p id="suggest-error" class="error hidden"></p>
    <div class="sheet-actions">
      ${review ? '<button id="suggest-no" class="btn ghost">Reject</button><button id="suggest-yes" class="btn primary">Approve</button>'
        : '<button id="suggest-no" class="btn ghost">Cancel</button><button id="suggest-yes" class="btn primary">Send</button>'}
    </div>`);
  $('suggest-pin').classList.toggle('hidden', !open.picking);
  placeWasMarker(s.kind === 'add' ? null : s.was);
  if (review && s.kind !== 'gone') atMarker = pinAt(s.at, 'dest-pin');
  ctx.map.easeTo({ center: s.at, zoom: Math.max(ctx.map.getZoom(), 17), padding: padding() });
  $('suggest-body').onclick = (e) => {
    const k = e.target.closest('[data-kind]');
    if (!k) return;
    $('suggest-body').querySelectorAll('[data-kind]').forEach((b) => {
      b.classList.toggle('on', b === k);
      b.setAttribute('aria-checked', String(b === k));
    });
    open.category = k.dataset.kind;
  };
  $('suggest-no').onclick = () => (review ? decide('reject') : closeSuggest());
  $('suggest-yes').onclick = () => (review ? decide('approve') : send());
  if (open.picking) nameSpot();
}

function show(title, sub, body) {
  ctx.setBrowseHidden(true);
  $('suggest-title').innerHTML = title;
  $('suggest-where').innerHTML = sub;
  $('suggest-body').innerHTML = body;
  $('suggest').classList.remove('hidden');
  armBack();
  requestAnimationFrame(placePin);
}

// The fixed pin sits in the middle of the map that's left above the sheet (beside it on a wide screen), which is
// where the map's padding puts its centre.
function padding() {
  const sheet = $('suggest').getBoundingClientRect();
  return innerWidth >= 720 || sideColumnEnd() ? { left: sheet.right, top: 0, right: 0, bottom: 0 } : { bottom: sheet.height || innerHeight * 0.45, top: 0, left: 0, right: 0 };
}
function placePin() {
  const p = padding();
  const pin = $('suggest-pin');
  pin.style.left = `${p.left + (innerWidth - p.left) / 2}px`;
  pin.style.top = `${(innerHeight - p.bottom) / 2}px`;
}

function placeWasMarker(place) {
  wasMarker?.remove();
  wasMarker = null;
  if (!place) return;
  // Where the place is now: faded beside the new spot of a move, the usual red otherwise (asking what's wrong, gone).
  wasMarker = pinAt([place.lng, place.lat], `dest-pin${open?.kind === 'move' ? ' was-pin' : ''}`);
}

function pinAt(lngLat, className) {
  const el = document.createElement('div');
  el.className = className;
  el.innerHTML = DEST_PIN;
  return new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(lngLat).addTo(ctx.map);
}

// "Near Jalan Tiang U8/94, Bukit Jelutong" for where the pin is, so the driver knows they've got the right street.
async function nameSpot() {
  const seq = ++whereSeq;
  const c = ctx.map.getCenter();
  try {
    const { place } = await api(`/api/reverse?lat=${c.lat}&lng=${c.lng}`);
    if (seq !== whereSeq || !open?.picking) return;
    open.address = [place.name, place.address].filter(Boolean).join(', ');
    $('suggest-where').textContent = open.address ? `Near ${open.address}` : 'Move the map so the pin is on the entrance';
  } catch {}
}

function spot() {
  const c = ctx.map.getCenter();
  return { lat: Number(c.lat.toFixed(6)), lng: Number(c.lng.toFixed(6)) };
}

function fail(msg) {
  const e = $('suggest-error');
  e.textContent = msg;
  e.classList.remove('hidden');
}

async function send() {
  const s = open;
  const name = $('suggest-name')?.value.trim() ?? s.name;
  if (s.kind === 'add' && name.length < 2) return fail('Give the place a name.');
  const was = s.was ? { name: s.was.name, address: s.was.address ?? '', lat: s.was.lat, lng: s.was.lng } : undefined;
  const btn = $('suggest-yes');
  btn.disabled = true;
  try {
    await api('/api/suggestions', {
      method: 'POST',
      body: { kind: s.kind, name, category: s.category, note: $('suggest-note')?.value ?? '', address: s.address ?? '', ...(s.kind === 'gone' ? {} : spot()), was },
    });
    closeSuggest(false);
    toast("Thanks! We'll check it and add it to search.", 3500);
  } catch (e) {
    btn.disabled = false;
    fail(e.message);
  }
}

// Closes the screen. cancelled: back to where the driver came from (the place's sheet, for a fix).
export function closeSuggest(cancelled = true) {
  if (!open) return;
  const { onClose } = open;
  open = null;
  wasMarker?.remove();
  atMarker?.remove();
  wasMarker = atMarker = null;
  $('suggest').classList.add('hidden');
  $('suggest-pin').classList.add('hidden');
  ctx.setBrowseHidden(false);
  ctx.map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  onClose?.(cancelled);
}

// ---------- Reviewing (testers) ----------

// One suggestion from GET /api/suggestions, on the map at the driver's spot: the tester can fix the name and kind
// of a new place. Approving keeps the driver's pin and address (the server's copy), wherever the map was moved to.
export function openReview(s, onDone) {
  const was = s.was_name ? { name: s.was_name, address: s.was_address ?? '', lat: s.was_lat, lng: s.was_lng } : null;
  const at = s.kind === 'gone' ? [was.lng, was.lat] : [s.lng, s.lat];
  start({ kind: s.kind, name: s.name, category: s.category, address: s.address, was, at, onClose: () => onDone(), id: s.id }, s);
}

async function decide(action) {
  const s = open;
  const body = { action };
  if (action === 'approve' && s.kind === 'add') Object.assign(body, { name: $('suggest-name').value.trim(), category: s.category });
  const btns = [$('suggest-yes'), $('suggest-no')];
  btns.forEach((b) => (b.disabled = true));
  try {
    await api(`/api/suggestions/${s.id}`, { method: 'POST', body });
    closeSuggest(false);
    toast(action === 'approve' ? 'Approved: phones get it within minutes.' : 'Rejected.');
    if (action === 'approve') syncDriverPlaces(true);
  } catch (e) {
    btns.forEach((b) => (b.disabled = false));
    fail(e.message);
  }
}

export const suggestionSummary = (s) =>
  ({ add: `Add ${s.name}`, move: `Move ${s.was_name ?? s.name}`, gone: `${s.was_name ?? s.name} is gone` }[s.kind] ?? s.name) +
  (s.category ? ` · ${kindLabel(s.category)}` : '');
