-- Places drivers suggest for A2B's own search, kept until a tester approves (adds it to locations) or rejects them.
-- See src/lib/suggestions.js.
CREATE TABLE IF NOT EXISTS place_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '', lat REAL NOT NULL, lng REAL NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
  reviewed_by INTEGER, reviewed_at INTEGER, location_id INTEGER
);
CREATE INDEX IF NOT EXISTS place_suggestions_status ON place_suggestions (status, created_at);
CREATE INDEX IF NOT EXISTS place_suggestions_user ON place_suggestions (user_id, created_at);
