-- Migration number: 0022 	 2026-10-06
-- Mixed-unit inventories: a unit per load, loads known not to exist,
-- bars and sleds with their own weight, and a gym's plates.
--
-- A gym can mix kg and lb, so an implement's load list may too: each load
-- is stored in its native unit (the one that makes it a whole or half
-- number). `implement.unit` stays the unit a bare number means. A load
-- known not to exist ("there's no 15 kg dumbbell") is kept as `absent`, so
-- a proposed step above an unknown top never lands on it.
--
-- Barbells and plate-loaded machines are loaded with plates, not picked
-- from a list: their producible loads are the per-side combinations of the
-- gym's plates (derived by the API). A plate set per unit says whether
-- every denomination is known; each plate is confirmed (a member said so),
-- inferred (read from loads lifted at import) or absent.

-- implement_load gains its unit and status. Rebuilt: SQLite can't add a
-- NOT NULL column without a constant default, and the unique key changes.
-- Nothing references implement_load, and it runs before any data is loaded
-- in production; existing rows take their implement's unit.
DROP VIEW v_implement;

CREATE TABLE implement_load_new (
  id            INTEGER PRIMARY KEY,
  implement_id  INTEGER NOT NULL REFERENCES implement (id),
  load          REAL    NOT NULL CHECK (abs(load) < 1000),
  unit          TEXT    NOT NULL CHECK (unit IN ('kg', 'lb')),
  status        TEXT    NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'absent')),
  UNIQUE (implement_id, load, unit)
) STRICT;

INSERT INTO implement_load_new (id, implement_id, load, unit, status)
SELECT il.id, il.implement_id, il.load, im.unit, 'available'
FROM implement_load AS il JOIN implement AS im ON im.id = il.implement_id;

DROP TABLE implement_load;
ALTER TABLE implement_load_new RENAME TO implement_load;

-- A bar's or sled's own weight, in its unit. NULL = not known (a sled that
-- is unmarked; plates-only loading leaves it out of the total).
ALTER TABLE implement ADD COLUMN bar_value REAL CHECK (bar_value >= 0 AND bar_value < 1000);
ALTER TABLE implement ADD COLUMN bar_unit TEXT CHECK (bar_unit IN ('kg', 'lb') AND bar_value IS NOT NULL OR bar_unit IS NULL AND bar_value IS NULL);

-- One unit's plates at a gym. complete = every denomination is known.
CREATE TABLE plate_set (
  id        INTEGER PRIMARY KEY,
  gym_id    INTEGER NOT NULL REFERENCES gym (id),
  unit      TEXT    NOT NULL CHECK (unit IN ('kg', 'lb')),
  complete  INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
  note      TEXT,
  UNIQUE (gym_id, unit)
) STRICT;

-- One denomination in a plate set, assumed to come in enough pairs.
CREATE TABLE plate (
  id            INTEGER PRIMARY KEY,
  plate_set_id  INTEGER NOT NULL REFERENCES plate_set (id),
  value         REAL    NOT NULL CHECK (value > 0 AND value < 100),
  status        TEXT    NOT NULL CHECK (status IN ('confirmed', 'inferred', 'absent')),
  UNIQUE (plate_set_id, value)
) STRICT;

-- v_implement as in 0011, its loads each with their unit, lightest first,
-- and the loads known not to exist.
CREATE VIEW v_implement AS
SELECT i.*, g.name AS gym_name,
       (SELECT group_concat(load || ' ' || unit, ', ') FROM (
          SELECT load, unit FROM implement_load WHERE implement_id = i.id AND status = 'available'
          ORDER BY load * (CASE unit WHEN 'lb' THEN 0.45359237 ELSE 1.0 END))) AS loads,
       (SELECT group_concat(load || ' ' || unit, ', ') FROM (
          SELECT load, unit FROM implement_load WHERE implement_id = i.id AND status = 'absent'
          ORDER BY load * (CASE unit WHEN 'lb' THEN 0.45359237 ELSE 1.0 END))) AS absent_loads
FROM implement AS i
JOIN gym AS g ON g.id = i.gym_id;

-- A gym's plates, for query.
CREATE VIEW v_plate AS
SELECT s.gym_id, g.name AS gym_name, s.unit, s.complete, p.value, p.status
FROM plate_set AS s
JOIN gym AS g ON g.id = s.gym_id
LEFT JOIN plate AS p ON p.plate_set_id = s.id;
