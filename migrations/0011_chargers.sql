-- EV chargers from OpenStreetMap and Open Charge Map, refreshed weekly by the nightly job. See src/lib/chargers.js.
CREATE TABLE IF NOT EXISTS chargers (id TEXT PRIMARY KEY, source TEXT NOT NULL, name TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, details TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS chargers_source ON chargers (source, updated_at);
