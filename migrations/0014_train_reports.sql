-- What riders report about a train line (delays, a stopped train, crowds, a closed station), kept to the line and a
-- station rather than a point on the map, and the "still happening" / "cleared" votes on them. See
-- src/lib/train-reports.js.
CREATE TABLE IF NOT EXISTS train_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, line TEXT NOT NULL, station TEXT NOT NULL DEFAULT '', type TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, still INTEGER NOT NULL DEFAULT 0, gone INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS train_reports_live ON train_reports (line, expires_at);
CREATE INDEX IF NOT EXISTS train_reports_user ON train_reports (user_id, created_at);
CREATE TABLE IF NOT EXISTS train_report_votes (report_id INTEGER NOT NULL, user_id INTEGER NOT NULL, vote TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (report_id, user_id));
