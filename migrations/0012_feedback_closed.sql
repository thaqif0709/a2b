-- Feedback is closed (handled) instead of deleted: closed_at is when, NULL while it's open. See src/worker.js.
ALTER TABLE feedback ADD COLUMN closed_at INTEGER;
