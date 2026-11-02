-- TomTom address lookups per day (src/lib/addresses.js): capped at ADDRESS_LOOKUPS_PER_DAY, shown on the usage dashboard.
ALTER TABLE usage_daily ADD COLUMN addresses INTEGER NOT NULL DEFAULT 0;
