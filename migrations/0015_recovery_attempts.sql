-- Per-account recovery throttling; each attempt is reserved inside the recovery transaction.
CREATE TABLE IF NOT EXISTS recovery_attempts (attempt TEXT PRIMARY KEY, email TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS recovery_attempts_email ON recovery_attempts (email, at);
