-- Curated location for a named back gate, added so it is searchable everywhere.
INSERT INTO driver_places (name, address, category, lat, lng, user_id, updated_at, removed)
SELECT
  'Keysight Back Gate',
  '5.3182834, 100.2955435',
  'office',
  5.3182834,
  100.2955435,
  NULL,
  COALESCE((SELECT MAX(updated_at) FROM driver_places), 0) + 1,
  0
WHERE NOT EXISTS (
  SELECT 1 FROM driver_places
  WHERE name = 'Keysight Back Gate'
    AND abs(lat - 5.3182834) < 0.0002
    AND abs(lng - 100.2955435) < 0.0002
);
