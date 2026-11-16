-- Trust scores: a vote from a driver with more points counts for more (see trustWeight in src/lib/reports.js).
-- still/gone keep the raw vote counts shown in the UI; the weighted sums decide extension and removal.
ALTER TABLE reports ADD COLUMN still_weight REAL NOT NULL DEFAULT 0;
ALTER TABLE reports ADD COLUMN gone_weight REAL NOT NULL DEFAULT 0;
