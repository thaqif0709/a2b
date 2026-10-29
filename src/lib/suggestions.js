// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Places drivers suggest for A2B's own search (src/lib/locations.js). A suggestion waits until a tester approves it;
// then it becomes a searchable place and the driver gets points. Rejected ones stay, so the driver can see why.

import { httpError } from './providers.js';
import { inMalaysia } from '../../public/geo.js';

const PER_DAY = 20; // suggestions one account can send a day
export const APPROVED_POINTS = 10;

const clean = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max + 1);

export function suggestionsRepo(db) {
  return {
    async create(user, body) {
      const name = clean(body?.name, 80);
      const address = clean(body?.address, 120);
      const category = clean(body?.category, 40).toLowerCase();
      const note = clean(body?.note, 300);
      const lat = Number(body?.lat), lng = Number(body?.lng);
      if (name.length < 2 || name.length > 80) throw httpError('Give the place a name (2 to 80 characters).', 400);
      if (address.length > 120 || category.length > 40 || note.length > 300) throw httpError('That address, category or note is too long.', 400);
      if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw httpError('The place needs a position on the map.', 400);
      if (!inMalaysia([lng, lat])) throw httpError('A2B only has places in Malaysia.', 400);
      const { n } = await db
        .prepare('SELECT count(*) AS n FROM place_suggestions WHERE user_id = ? AND created_at > ?')
        .bind(user.id, Date.now() - 86_400_000)
        .first();
      if (n >= PER_DAY) throw httpError(`You can suggest up to ${PER_DAY} places a day.`, 429);
      const row = await db
        .prepare(
          `INSERT INTO place_suggestions (user_id, name, address, category, note, lat, lng, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?) RETURNING *`,
        )
        .bind(user.id, name, address, category, note, lat, lng, Date.now())
        .first();
      return row;
    },

    async mine(user) {
      const { results } = await db
        .prepare('SELECT * FROM place_suggestions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100')
        .bind(user.id)
        .all();
      return results;
    },

    // The review queue, oldest first, with who sent each one.
    async pending() {
      const { results } = await db
        .prepare(
          `SELECT s.*, u.name AS by_name FROM place_suggestions s LEFT JOIN users u ON u.id = s.user_id
           WHERE s.status = 'pending' ORDER BY s.created_at LIMIT 200`,
        )
        .all();
      return results;
    },

    // approve: the place joins search (with the reviewer's edits, if any) and the driver gets points.
    async review(reviewer, id, { action, name, category, address } = {}) {
      if (action !== 'approve' && action !== 'reject') throw httpError('action is approve or reject.', 400);
      const s = await db.prepare(`SELECT * FROM place_suggestions WHERE id = ? AND status = 'pending'`).bind(id).first();
      if (!s) throw httpError('Suggestion not found, or already reviewed.', 404);
      const now = Date.now();
      if (action === 'reject') {
        await db.prepare(`UPDATE place_suggestions SET status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE id = ?`).bind(reviewer.id, now, id).run();
        return { status: 'rejected' };
      }
      const final = { name: clean(name ?? s.name, 80) || s.name, category: clean(category ?? s.category, 40), address: clean(address ?? s.address, 120) };
      const place = await db
        .prepare(
          `INSERT INTO locations (name, address, category, kind, lat, lng, source, user_id, created_at)
           VALUES (?, ?, ?, 'place', ?, ?, 'driver', ?, ?) RETURNING id`,
        )
        .bind(final.name, final.address, final.category, s.lat, s.lng, s.user_id, now)
        .first();
      await db.batch([
        db
          .prepare(`UPDATE place_suggestions SET status = 'approved', reviewed_by = ?, reviewed_at = ?, location_id = ? WHERE id = ?`)
          .bind(reviewer.id, now, place.id, id),
        db.prepare('UPDATE users SET points = points + ? WHERE id = ?').bind(APPROVED_POINTS, s.user_id),
      ]);
      return { status: 'approved', location_id: `d${place.id}` }; // as /api/locations/changes names it
    },
  };
}
