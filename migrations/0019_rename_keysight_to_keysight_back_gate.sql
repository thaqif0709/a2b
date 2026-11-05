-- Correct the name of the curated Keysight Back Gate place in place, and keep a
-- row available even if the previous migration has not yet been applied.
UPDATE driver_places
SET name = 'Keysight Back Gate',
    address = '5.3182834, 100.2955435',
    category = 'office',
    lat = 5.3182834,
    lng = 100.2955435,
    updated_at = updated_at + 1
WHERE (name = 'Keysight' OR name = 'Keysight Back Gate')
  AND abs(lat - 5.3182834) < 0.0002
  AND abs(lng - 100.2955435) < 0.0002;

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
