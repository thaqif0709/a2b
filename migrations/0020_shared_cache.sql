-- Answers from outside services (weather forecasts), shared by every driver so the same place is fetched once an
-- hour, not once per person (see src/lib/shared-cache.js). Cloudflare's Cache API does nothing on *.workers.dev.
-- The nightly job deletes expired rows.
CREATE TABLE IF NOT EXISTS shared_cache (key TEXT PRIMARY KEY, body TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS shared_cache_expiry ON shared_cache (expires_at);
