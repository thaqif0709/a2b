// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// What A2B's own place search learns after its files are built (public/places/, scripts/build-locations.py, searched
// on the phone by public/places.js): places drivers added (approved suggestions, src/lib/suggestions.js) and places
// from the files that testers took out of search. The phone gets both as one small list, changes(), and merges it
// into what it finds in the files; the next monthly build takes them in. Removed rows stay, marked removed.

import { distance } from '../../public/geo.js';

export const DRIVER = 8; // the sources bit of a driver's place, after public/places.js SOURCES

export function locationsRepo(db) {
  return {
    // Drivers' places as rows like the files' ([name, lng, lat, address, category, kind, sources, id]), and the IDs
    // of the files' places taken out of search.
    async changes() {
      const [added, hidden] = await db.batch([
        db.prepare('SELECT id, name, address, category, lat, lng FROM locations WHERE removed = 0 ORDER BY id'),
        db.prepare('SELECT id FROM hidden_places ORDER BY id'),
      ]);
      return {
        places: added.results.map((r) => [r.name, r.lng, r.lat, r.address, r.category, '', DRIVER, `d${r.id}`]),
        hidden: hidden.results.map((h) => h.id),
      };
    },

    // The drivers' place closest to a point, for "what's here?" (the files can't answer that; the geocoder does).
    async nearest([lng, lat], maxM = 120) {
      const d = 0.002;
      const { results } = await db
        .prepare('SELECT id, name, address, category, lat, lng FROM locations WHERE removed = 0 AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?')
        .bind(lat - d, lat + d, lng - d, lng + d)
        .all();
      const best = results.map((r) => ({ r, m: distance([lng, lat], [r.lng, r.lat]) })).filter((x) => x.m <= maxM).sort((a, b) => a.m - b.m)[0];
      return best ? { name: best.r.name, address: best.r.address, lat: best.r.lat, lng: best.r.lng, category: best.r.category || 'place' } : null;
    },

    // A wrong place out of search (testers only, see src/worker.js): a driver's ("d12") or one of the files' (its id
    // there, e.g. "1f3a9c2b").
    async remove(id, user) {
      const driver = /^d(\d+)$/.exec(id);
      if (driver) {
        const { meta } = await db.prepare('UPDATE locations SET removed = 1 WHERE id = ? AND removed = 0').bind(Number(driver[1])).run();
        return meta.changes > 0;
      }
      if (!/^[0-9a-f]{1,8}$/.test(id)) return false;
      await db.prepare('INSERT OR IGNORE INTO hidden_places (id, user_id, created_at) VALUES (?, ?, ?)').bind(id, user.id, Date.now()).run();
      return true;
    },
  };
}
