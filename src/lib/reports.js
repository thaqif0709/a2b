// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Road reports: creating, merging duplicates, and the votes that keep them alive or remove them.

import { REPORT_TYPES, isValidReport } from '../../public/report-types.js';
import { distance } from '../../public/geo.js';
import { httpError } from './providers.js';

const MIN = 60_000;
const MERGE_RADIUS_M = 150;
const MERGE_WINDOW = 15 * MIN;
const REPORT_COOLDOWN = 60_000; // one report a minute per driver: fast enough on the road, slow for a script
const REPORT_RADIUS_M = 10_000; // a report should come from near it: within this of the driver's known position

// Each "still there" adds a quarter of the type's life, but a report never lives more than 2 lifetimes from now.
export function extendedExpiry(type, currentExpiry, now = Date.now(), types = REPORT_TYPES) {
  const life = types[type].life * MIN;
  return Math.min(Math.max(currentExpiry, now) + life / 4, now + life * 2);
}

// Removed when "not there" clearly outweighs "still there".
export function shouldRemove({ still, gone }) {
  return gone >= still + 2;
}

export function publicReport(r, viewerId = null) {
  return {
    id: r.id,
    type: r.type,
    subtype: r.subtype,
    lat: r.lat,
    lng: r.lng,
    heading: r.heading,
    comment: r.comment,
    created_at: r.created_at,
    expires_at: r.expires_at,
    thanks: r.thanks,
    still: r.still,
    gone: r.gone,
    by: r.reporter ?? null,
    mine: viewerId != null && r.user_id === viewerId,
  };
}

export function reportsRepo(db) {
  return {
    async inBox([w, s, e, n], viewerId) {
      const rows = (
        await db
          .prepare(
            `SELECT r.*, u.name AS reporter FROM reports r JOIN users u ON u.id = r.user_id
             WHERE r.removed = 0 AND r.expires_at > ? AND r.lat BETWEEN ? AND ? AND r.lng BETWEEN ? AND ?
             ORDER BY r.created_at DESC LIMIT 500`,
          )
          .bind(Date.now(), s, n, w, e)
          .all()
      ).results;
      return rows.map((r) => publicReport(r, viewerId));
    },

    // roadAt(point, heading): where to block the road for a closure (see roadMidpoint), or null.
    // reporterAt: the driver's last known position ([lng, lat]) or null when it isn't known.
    async create(user, body, { roadAt, reporterAt = null } = {}) {
      const { type, subtype = null, comment = null } = body;
      const lat = Number(body.lat), lng = Number(body.lng);
      if (!isValidReport(type, subtype)) throw httpError('Unknown report type.', 400);
      if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) throw httpError('Report needs a location.', 400);
      // Reports from far away reroute drivers who are actually there, so when the driver's position is known
      // the report has to be near it. Without a known position (no shared drive lately) it still goes through.
      if (reporterAt && distance(reporterAt, [lng, lat]) > REPORT_RADIUS_M) throw httpError('You can only report what is around you.', 403);
      const now = Date.now();

      const near = (
        await db
          .prepare('SELECT * FROM reports WHERE type = ? AND removed = 0 AND expires_at > ? AND created_at > ? AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?')
          .bind(type, now, now - MERGE_WINDOW, lat - 0.002, lat + 0.002, lng - 0.003, lng + 0.003)
          .all()
      ).results.find((r) => distance([r.lng, r.lat], [lng, lat]) <= MERGE_RADIUS_M);
      if (near) {
        // Someone already reported this: it counts as a thanks, not a second pin and not a life-extending
        // confirmation (merged confirmations used to inflate "still there" until nothing could remove the report).
        const res = await this.vote(user, near.id, 'thanks');
        return { ...res, merged: true };
      }

      const last = await db.prepare('SELECT created_at FROM reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').bind(user.id).first();
      if (last && now - last.created_at < REPORT_COOLDOWN) throw httpError('You just sent a report. Try again in a few seconds.', 429);

      const heading = Number.isFinite(Number(body.heading)) && body.heading !== null ? Number(body.heading) : null;
      const text = typeof comment === 'string' ? comment.trim().slice(0, 140) || null : null;
      const expires = now + REPORT_TYPES[type].life * MIN;
      const pts = REPORT_TYPES[type].points;
      const [ins] = await db.batch([
        db
          .prepare('INSERT INTO reports (user_id, type, subtype, lat, lng, heading, comment, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *')
          .bind(user.id, type, subtype || null, lat, lng, heading, text, now, expires),
        db.prepare('UPDATE users SET points = points + ? WHERE id = ?').bind(pts, user.id),
      ]);
      const row = ins.results[0];
      if (type === 'closure' && roadAt) {
        const at = await roadAt([lng, lat], heading).catch(() => null);
        if (at) await db.prepare('INSERT OR REPLACE INTO closure_blocks (report_id, lat, lng) VALUES (?, ?, ?)').bind(row.id, at[1], at[0]).run();
      }
      return { report: publicReport({ ...row, reporter: user.name }, user.id), points: pts };
    },

    async vote(user, id, vote) {
      if (!['thanks', 'still', 'gone'].includes(vote)) throw httpError('Unknown vote.', 400);
      const r = await db.prepare('SELECT r.*, u.name AS reporter FROM reports r JOIN users u ON u.id = r.user_id WHERE r.id = ?').bind(id).first();
      if (!r || r.removed || r.expires_at <= Date.now()) throw httpError('This report has already gone.', 404);
      const own = r.user_id === user.id;
      if (own && vote !== 'gone') return { report: publicReport(r, user.id), points: 0 };

      // still and gone are one opinion per driver; switching replaces the old one.
      const opposite = vote === 'still' ? 'gone' : vote === 'gone' ? 'still' : null;
      const now = Date.now();
      // Claim the vote first: concurrent taps from two devices can't both add to the count.
      const claimed = await db
        .prepare('INSERT OR IGNORE INTO votes (report_id, user_id, vote, created_at) VALUES (?, ?, ?, ?)')
        .bind(id, user.id, vote, now)
        .run();
      if (!claimed.meta.changes) {
        const fresh = await db.prepare('SELECT r.*, u.name AS reporter FROM reports r JOIN users u ON u.id = r.user_id WHERE r.id = ?').bind(id).first();
        return { report: publicReport(fresh, user.id), points: 0 };
      }
      // One atomic update moves the counters, so two votes at the same moment can't lose one between
      // reading and writing them. Lifetime and removal are derived from the fresh row afterwards.
      let dropped = 0;
      if (opposite) {
        dropped = (await db.prepare('DELETE FROM votes WHERE report_id = ? AND user_id = ? AND vote = ?').bind(id, user.id, opposite).run()).meta.changes;
      }
      await db
        .prepare('UPDATE reports SET thanks = thanks + ?, still = MAX(0, still + ?), gone = MAX(0, gone + ?) WHERE id = ?')
        .bind(
          vote === 'thanks' ? 1 : 0,
          (vote === 'still' ? 1 : 0) - (opposite === 'still' && dropped ? 1 : 0),
          (vote === 'gone' ? 1 : 0) - (opposite === 'gone' && dropped ? 1 : 0),
          id,
        )
        .run();
      const counted = await db.prepare('SELECT r.*, u.name AS reporter FROM reports r JOIN users u ON u.id = r.user_id WHERE r.id = ?').bind(id).first();
      let expires_at = counted.expires_at, removed = counted.removed;
      if (vote === 'still') expires_at = extendedExpiry(counted.type, counted.expires_at, now);
      if (vote === 'gone' && (own || shouldRemove({ still: counted.still, gone: counted.gone }))) removed = 1;
      if (expires_at !== counted.expires_at || removed !== counted.removed) {
        await db.prepare('UPDATE reports SET expires_at = ?, removed = ? WHERE id = ?').bind(expires_at, removed, id).run();
      }
      // The reporter earns a point whenever someone thanks or confirms them; voters earn one for helping.
      let points = 0;
      const stmts = [];
      if (!own && vote !== 'gone') stmts.push(db.prepare('UPDATE users SET points = points + 1 WHERE id = ?').bind(r.user_id));
      if (!own && vote !== 'thanks' && !dropped) {
        points = 1;
        stmts.push(db.prepare('UPDATE users SET points = points + 1 WHERE id = ?').bind(user.id));
      }
      if (stmts.length) await db.batch(stmts);
      const fresh = await db.prepare('SELECT r.*, u.name AS reporter FROM reports r JOIN users u ON u.id = r.user_id WHERE r.id = ?').bind(id).first();
      return { report: publicReport({ ...fresh, expires_at, removed }, user.id), points, removed: Boolean(removed) };
    },

    async closuresNear([w, s, e, n]) {
      return (
        await db
          .prepare(
            `SELECT COALESCE(b.lat, r.lat) AS lat, COALESCE(b.lng, r.lng) AS lng FROM reports r LEFT JOIN closure_blocks b ON b.report_id = r.id
             WHERE r.type = 'closure' AND r.removed = 0 AND r.expires_at > ? AND r.lat BETWEEN ? AND ? AND r.lng BETWEEN ? AND ?
             ORDER BY r.created_at DESC LIMIT 35`,
          )
          .bind(Date.now(), s, n, w, e)
          .all()
      ).results.map((r) => [r.lng, r.lat]);
    },

    async stats(userId) {
      const row = await db
        .prepare('SELECT COUNT(*) AS reports, COALESCE(SUM(thanks), 0) AS thanks, COALESCE(SUM(still), 0) AS confirmed FROM reports WHERE user_id = ?')
        .bind(userId)
        .first();
      return row;
    },
  };
}
