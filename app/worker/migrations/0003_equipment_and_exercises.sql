-- Migration number: 0003 	 2026-10-05
-- Gyms, implements with explicit producible loads, and exercises with
-- aliases and movement-pattern / stimulus tags.

CREATE TABLE gym (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household (id),
  name          TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  UNIQUE (household_id, name)
) STRICT;

-- Each member trains at a different gym; imported sessions get this one.
ALTER TABLE member ADD COLUMN home_gym_id INTEGER REFERENCES gym (id);

-- One piece of a gym's equipment. Its producible loads are an explicit
-- list (implement_load), never a start/step formula.
CREATE TABLE implement (
  id                  INTEGER PRIMARY KEY,
  gym_id              INTEGER NOT NULL REFERENCES gym (id),
  name                TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  kind                TEXT    NOT NULL CHECK (kind IN (
                        'barbell', 'dumbbell', 'kettlebell', 'machine', 'plate_loaded', 'cable',
                        'fixed_bar', 'plates', 'bodyweight', 'band', 'cardio_machine', 'other')),
  unit                TEXT    NOT NULL CHECK (unit IN ('kg', 'lb')),
  -- How the listed load relates to what is moved: the whole load, per side
  -- (plates on a bar or sled), or plates only (the sled weight is unknown,
  -- so e1RM is never compared across machines).
  loading             TEXT    NOT NULL CHECK (loading IN ('total', 'per_side', 'plates_only')),
  -- 0 = loads above the listed maximum may exist (a fixed bar rack whose
  -- top is unknown).
  load_list_complete  INTEGER NOT NULL DEFAULT 1 CHECK (load_list_complete IN (0, 1)),
  note                TEXT,
  UNIQUE (gym_id, name)
) STRICT;

-- A producible load in the implement's own unit. Assisted implements list
-- their assistance as negative loads.
CREATE TABLE implement_load (
  id            INTEGER PRIMARY KEY,
  implement_id  INTEGER NOT NULL REFERENCES implement (id),
  load          REAL    NOT NULL CHECK (abs(load) < 1000),
  UNIQUE (implement_id, load)
) STRICT;

-- A canonical, generic movement on a kind of implement.
CREATE TABLE exercise (
  id              INTEGER PRIMARY KEY,
  household_id    INTEGER NOT NULL REFERENCES household (id),
  name            TEXT    NOT NULL COLLATE NOCASE CHECK (length(trim(name)) > 0),
  implement_kind  TEXT    NOT NULL CHECK (implement_kind IN (
                    'barbell', 'dumbbell', 'kettlebell', 'machine', 'plate_loaded', 'cable',
                    'fixed_bar', 'plates', 'bodyweight', 'band', 'cardio_machine', 'other')),
  note            TEXT,
  UNIQUE (household_id, name)
) STRICT;

-- The names people actually say. Unique across the catalogue, ignoring case,
-- so an alias resolves to exactly one exercise.
CREATE TABLE exercise_alias (
  id           INTEGER PRIMARY KEY,
  exercise_id  INTEGER NOT NULL REFERENCES exercise (id),
  alias        TEXT    NOT NULL UNIQUE COLLATE NOCASE CHECK (length(trim(alias)) > 0)
) STRICT;

-- Movement-pattern tags (for coverage) and stimulus tags (a fallback counts
-- as coverage only when its stimulus tags match). Tags are lower snake_case.
CREATE TABLE exercise_tag (
  exercise_id  INTEGER NOT NULL REFERENCES exercise (id),
  kind         TEXT    NOT NULL CHECK (kind IN ('movement_pattern', 'stimulus')),
  tag          TEXT    NOT NULL CHECK (tag GLOB '[a-z]*' AND tag NOT GLOB '*[^a-z0-9_]*'),
  PRIMARY KEY (exercise_id, kind, tag)
) STRICT;

CREATE INDEX exercise_tag_by_tag ON exercise_tag (kind, tag);
