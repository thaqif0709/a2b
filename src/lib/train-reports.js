// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// What riders report about a train line (delays, a stopped train, crowds, a closed station): kept to the line and a
// station, not a point on the map, so drivers never see them and road routing never reads them. Riders on that line
// see them, on the ride and when planning a trip that uses it, and say whether they're still happening.

import { TRAIN_REPORT_TYPES, TRAIN_REPORT_POINTS } from '../../public/report-types.js';
import { lineStations } from './transit.js';
import { httpError } from './providers.js';
import { extendedExpiry, shouldRemove } from './reports.js';

const MIN = 60_000;
const MERGE_WINDOW = 15 * MIN; // the same thing on the same line (and station) this recently: the same report
const COOLDOWN = 60_000; // one report a minute per rider
const MAX_LINES = 12;

export function publicTrainReport(r, viewerId = null) {
  return {
    id: r.id, line: r.line, station: r.station || null, type: r.type,
    created_at: r.created_at, expires_at: r.expires_at, still: r.still, gone: r.gone,
    mine: viewerId != null && r.user_id === viewerId,
  };
}

// As road reports: each "still happening" adds a quarter of the type's life (up to two lives from now).
const extended = (type, expires, now) => extendedExpiry(type, expires, now, TRAIN_REPORT_TYPES);

export function trainReportsRepo(db) {
  const get = (id) => db.prepare('SELECT * FROM train_reports WHERE id = ?').bind(id).first();
  return {
    // The live reports on these lines, newest first.
    async forLines(lines, viewerId = null) {
      const ids = [...new Set(lines.filter((l) => typeof l === 'string' && lineStations(l)))].slice(0, MAX_LINES);
      if (!ids.length) return [];
      const rows = (
        await db
          .prepare(`SELECT * FROM train_reports WHERE removed = 0 AND expires_at > ? AND line IN (${ids.map(() => '?').join(', ')}) ORDER BY created_at DESC LIMIT 50`)
          .bind(Date.now(), ...ids)
          .all()
      ).results;
      return rows.map((r) => publicTrainReport(r, viewerId));
    },

    async create(user, body) {
      const { type, line } = body ?? {};
      const station = typeof body?.station === 'string' ? body.station.trim() : '';
      if (!Object.hasOwn(TRAIN_REPORT_TYPES, type ?? '')) throw httpError('Unknown report type.', 400);
      const names = typeof line === 'string' ? lineStations(line) : null;
      if (!names) throw httpError('Unknown train line.', 400);
      if (station && !names.has(station)) throw httpError('That station is not on this line.', 400);
      if (type === 'closed' && !station) throw httpError('Say which station is closed.', 400);
      const now = Date.now();

      const same = await db
        .prepare('SELECT * FROM train_reports WHERE line = ? AND type = ? AND station = ? AND removed = 0 AND expires_at > ? AND created_at > ? ORDER BY created_at DESC LIMIT 1')
        .bind(line, type, station, now, now - MERGE_WINDOW)
        .first();
      if (same) {
        // Someone already said so: it counts as "still happening", not a second report.
        const res = same.user_id === user.id ? { report: publicTrainReport(same, user.id), points: 0 } : await this.vote(user, same.id, 'still');
        return { ...res, merged: true };
      }

      const last = await db.prepare('SELECT created_at FROM train_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').bind(user.id).first();
      if (last && now - last.created_at < COOLDOWN) throw httpError('You just sent a report. Try again in a few seconds.', 429);

      const [ins] = await db.batch([
        db
          .prepare('INSERT INTO train_reports (user_id, line, station, type, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
          .bind(user.id, line, station, type, now, now + TRAIN_REPORT_TYPES[type].life * MIN),
        db.prepare('UPDATE users SET points = points + ? WHERE id = ?').bind(TRAIN_REPORT_POINTS, user.id),
      ]);
      return { report: publicTrainReport(ins.results[0], user.id), points: TRAIN_REPORT_POINTS };
    },

    // "still" (still happening) or "gone" (cleared): one opinion per rider, a change of mind replaces it. The reporter
    // saying it's cleared removes it straight away.
    async vote(user, id, vote) {
      if (!['still', 'gone'].includes(vote)) throw httpError('Unknown vote.', 400);
      const r = await get(id);
      if (!r || r.removed || r.expires_at <= Date.now()) throw httpError('This report has already gone.', 404);
      const own = r.user_id === user.id;
      if (own && vote === 'still') return { report: publicTrainReport(r, user.id), points: 0 };
      const now = Date.now();
      const before = await db.prepare('SELECT vote FROM train_report_votes WHERE report_id = ? AND user_id = ?').bind(id, user.id).first();
      await db.prepare('INSERT OR REPLACE INTO train_report_votes (report_id, user_id, vote, created_at) VALUES (?, ?, ?, ?)').bind(id, user.id, vote, now).run();
      // Counted from the votes themselves, so two at once can't lose one.
      await db
        .prepare(`UPDATE train_reports SET still = (SELECT COUNT(*) FROM train_report_votes WHERE report_id = ?1 AND vote = 'still'),
                  gone = (SELECT COUNT(*) FROM train_report_votes WHERE report_id = ?1 AND vote = 'gone') WHERE id = ?1`)
        .bind(id)
        .run();
      const counted = await get(id);
      let { expires_at, removed } = counted;
      if (vote === 'still' && before?.vote !== 'still') expires_at = extended(counted.type, counted.expires_at, now);
      if (vote === 'gone' && (own || shouldRemove(counted))) removed = 1;
      if (expires_at !== counted.expires_at || removed !== counted.removed) {
        await db.prepare('UPDATE train_reports SET expires_at = ?, removed = ? WHERE id = ?').bind(expires_at, removed, id).run();
      }
      // A first opinion on someone else's report earns a point; the reporter earns one when it's confirmed.
      let points = 0;
      if (!own && !before) {
        points = 1;
        const stmts = [db.prepare('UPDATE users SET points = points + 1 WHERE id = ?').bind(user.id)];
        if (vote === 'still') stmts.push(db.prepare('UPDATE users SET points = points + 1 WHERE id = ?').bind(r.user_id));
        await db.batch(stmts);
      }
      return { report: publicTrainReport({ ...counted, expires_at, removed }, user.id), points, removed: Boolean(removed) };
    },
  };
}
