-- Places drivers suggest (add a missing one, move a wrong pin, or say one is gone), kept until a tester approves or
-- rejects them, and the approved ones every phone downloads and searches. See src/lib/suggestions.js.
CREATE TABLE IF NOT EXISTS place_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', lat REAL, lng REAL,
  was_name TEXT, was_address TEXT, was_lat REAL, was_lng REAL,
  status TEXT NOT NULL, created_at INTEGER NOT NULL, reviewed_by INTEGER, reviewed_at INTEGER, place_id INTEGER
);
CREATE INDEX IF NOT EXISTS place_suggestions_status ON place_suggestions (status, created_at);
CREATE INDEX IF NOT EXISTS place_suggestions_user ON place_suggestions (user_id, created_at);
CREATE TABLE IF NOT EXISTS driver_places (
  id INTEGER PRIMARY KEY AUTOINCREMENT, suggestion_id INTEGER, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
  lat REAL, lng REAL, hides_name TEXT, hides_lat REAL, hides_lng REAL, user_id INTEGER, updated_at INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS driver_places_updated ON driver_places (updated_at);
