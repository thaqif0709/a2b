-- What A2B's own place search learns after its files are built (public/places/, scripts/build-locations.py): places
-- drivers added (approved suggestions, see src/lib/suggestions.js) and places from the files that testers took out of
-- search, by their id there. The phone gets both as /api/locations/changes (see src/lib/locations.js).
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'place', lat REAL NOT NULL, lng REAL NOT NULL, source TEXT NOT NULL DEFAULT 'driver', user_id INTEGER,
  created_at INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS hidden_places (id TEXT PRIMARY KEY, user_id INTEGER, created_at INTEGER NOT NULL);
