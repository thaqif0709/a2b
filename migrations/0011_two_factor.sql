-- Two-factor logins (TOTP authenticator apps): per-account secret plus one-time login challenges.
-- Numbered 0011 so it applies after 0009 (auth throttles) and 0010 (probe traffic) in either landing order.
-- Keep in sync with src/lib/schema.js (which creates the same tables/columns on first request).
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;
CREATE TABLE IF NOT EXISTS auth_challenges (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, purpose TEXT NOT NULL DEFAULT 'totp', secret TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
