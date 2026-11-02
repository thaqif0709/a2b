// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Places drivers suggest: a missing place (add), a place pinned in the wrong spot (move) or one that isn't there any
// more (gone). A suggestion waits until a tester approves it in Settings › Testing › Feedback; then it becomes a
// driver place, which every phone downloads (GET /api/driver-places) and searches with its own places
// (public/places.js). A move or gone also hides the wrong place: the same name within HIDE_M of where it was.

import { httpError } from './providers.js';

const PER_DAY = 20; // suggestions one account can send a day
export const APPROVED_POINTS = 10;
const KINDS = new Set(['add', 'move', 'gone']);
// Malaysia's rough box: a pin outside it is a slip of the finger (testers still see each one before it counts).
const BOX = { w: 99.5, s: 0.8, e: 119.5, n: 7.5 };

const clean = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const inBox = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && lng >= BOX.w && lng <= BOX.e && lat >= BOX.s && lat <= BOX.n;
const CATEGORY = /^[a-z_]{0,20}$/;
// updated_at is the phones' cursor (changes below), so every change gets a later one than the last, even within a
// millisecond: D1 runs writes one at a time, so a change can't land behind a cursor a phone already has.
const NEXT_STAMP = 'max(?, (SELECT coalesce(max(updated_at), 0) + 1 FROM driver_places))';

export function suggestionsRepo(db) {
  return {
    async create(user, body = {}) {
      const kind = String(body.kind ?? 'add');
      if (!KINDS.has(kind)) throw httpError('kind is add, move or gone.', 400);
      const was = kind === 'add' ? null : body.was ?? {};
      const name = clean(body.name ?? was?.name, 80);
      if (name.length < 2) throw httpError('Give the place a name.', 400);
      const category = clean(body.category, 20).toLowerCase();
      if (!CATEGORY.test(category)) throw httpError('Unknown kind of place.', 400);
      const lat = kind === 'gone' ? null : Number(body.lat), lng = kind === 'gone' ? null : Number(body.lng);
      if (kind !== 'gone' && !inBox(lat, lng)) throw httpError('Put the pin on the place, in Malaysia.', 400);
      if (was && !inBox(Number(was.lat), Number(was.lng))) throw httpError('Which place is wrong?', 400);
      const { n } = await db
        .prepare('SELECT count(*) AS n FROM place_suggestions WHERE user_id = ? AND created_at > ?')
        .bind(user.id, Date.now() - 86_400_000)
        .first();
      if (n >= PER_DAY) throw httpError(`You can suggest up to ${PER_DAY} places a day. Thank you!`, 429);
      return db
        .prepare(
          `INSERT INTO place_suggestions (user_id, kind, name, address, category, note, lat, lng, was_name, was_address, was_lat, was_lng, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?) RETURNING id, kind, name, status`,
        )
        .bind(
          user.id, kind, name, clean(body.address, 160), category, clean(body.note, 300), lat, lng,
          was ? clean(was.name, 80) : null, was ? clean(was.address, 160) : null, was ? Number(was.lat) : null, was ? Number(was.lng) : null,
          Date.now(),
        )
        .first();
    },

    // The review queue, oldest first, then the last few reviewed (an approved one can be taken back out).
    async forReview() {
      const pick = (where, order) =>
        db
          .prepare(`SELECT s.*, u.name AS by_name, u.email AS by_email FROM place_suggestions s LEFT JOIN users u ON u.id = s.user_id WHERE ${where} ORDER BY ${order} LIMIT 100`)
          .all();
      const [pending, reviewed] = await Promise.all([pick(`s.status = 'pending'`, 's.created_at'), pick(`s.status != 'pending'`, 's.reviewed_at DESC')]);
      return { pending: pending.results, reviewed: reviewed.results.slice(0, 30) };
    },

    // approve (with the tester's name, kind or pin, when changed) or reject. Approving gives the driver points.
    async review(reviewer, id, body = {}) {
      const { action } = body;
      if (action !== 'approve' && action !== 'reject') throw httpError('action is approve or reject.', 400);
      const s = await db.prepare(`SELECT * FROM place_suggestions WHERE id = ? AND status = 'pending'`).bind(id).first();
      if (!s) throw httpError('Suggestion not found, or already reviewed.', 404);
      const now = Date.now();
      if (action === 'reject') {
        await db.prepare(`UPDATE place_suggestions SET status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE id = ?`).bind(reviewer.id, now, id).run();
        return { status: 'rejected' };
      }
      const name = clean(body.name, 80) || s.name;
      const category = body.category === undefined ? s.category : clean(body.category, 20).toLowerCase();
      if (!CATEGORY.test(category)) throw httpError('Unknown kind of place.', 400);
      const address = body.address === undefined ? s.address : clean(body.address, 160);
      let lat = s.lat, lng = s.lng;
      if (s.kind !== 'gone' && body.lat !== undefined) {
        lat = Number(body.lat), lng = Number(body.lng);
        if (!inBox(lat, lng)) throw httpError('Put the pin on the place, in Malaysia.', 400);
      }
      const place = await db
        .prepare(
          `INSERT INTO driver_places (suggestion_id, name, address, category, lat, lng, hides_name, hides_lat, hides_lng, user_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NEXT_STAMP}) RETURNING id`,
        )
        .bind(id, name, address, category, lat, lng, s.was_name, s.was_lat, s.was_lng, s.user_id, now)
        .first();
      await db.batch([
        db
          .prepare(`UPDATE place_suggestions SET status = 'approved', reviewed_by = ?, reviewed_at = ?, place_id = ?, name = ?, address = ?, category = ?, lat = ?, lng = ? WHERE id = ?`)
          .bind(reviewer.id, now, place.id, name, address, category, lat, lng, id),
        db.prepare('UPDATE users SET points = points + ? WHERE id = ?').bind(APPROVED_POINTS, s.user_id),
      ]);
      return { status: 'approved', place_id: place.id };
    },

    // Takes an approved place back out of search (phones drop it on their next download).
    async undo(reviewer, id) {
      const s = await db.prepare(`SELECT * FROM place_suggestions WHERE id = ? AND status = 'approved'`).bind(id).first();
      if (!s) throw httpError('Suggestion not found, or not approved.', 404);
      const now = Date.now();
      await db.batch([
        db.prepare(`UPDATE driver_places SET removed = 1, updated_at = ${NEXT_STAMP} WHERE id = ?`).bind(now, s.place_id),
        db.prepare(`UPDATE place_suggestions SET status = 'undone', reviewed_by = ?, reviewed_at = ? WHERE id = ?`).bind(reviewer.id, now, id),
        db.prepare('UPDATE users SET points = max(0, points - ?) WHERE id = ?').bind(APPROVED_POINTS, s.user_id),
      ]);
      return { status: 'undone' };
    },

    // Driver places changed after `since` (ms), removed ones too, so a phone keeps its copy current by asking for
    // what's new. `next` is the `since` for the next ask; `more` means ask again straight away.
    async changes(since, limit = 2000) {
      const { results } = await db
        .prepare(
          `SELECT id, name, address, category, lat, lng, hides_name, hides_lat, hides_lng, removed, updated_at
           FROM driver_places WHERE updated_at > ? ORDER BY updated_at, id LIMIT ?`,
        )
        .bind(Math.max(0, Number(since) || 0), limit + 1)
        .all();
      const more = results.length > limit;
      const places = results.slice(0, limit);
      return { places, next: places.at(-1)?.updated_at ?? Math.max(0, Number(since) || 0), more };
    },
  };
}
