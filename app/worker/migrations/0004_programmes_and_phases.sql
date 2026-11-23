-- Migration number: 0004 	 2026-10-05
-- Programmes (weekday or rotation schedule), session templates, ordered
-- prescriptions with structured progression rules and fallbacks, load
-- changes, and phases.
--
-- A load "as entered" is always the group (value, unit, basis[, implement]):
-- all present or all absent, so a bare number never lands without its unit.

CREATE TABLE programme (
  id             INTEGER PRIMARY KEY,
  member_id      INTEGER NOT NULL REFERENCES member (id),
  name           TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  -- Next session follows whichever schedule the programme declares.
  schedule_kind  TEXT    NOT NULL CHECK (schedule_kind IN ('weekday', 'rotation')),
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  started_on     TEXT    NOT NULL CHECK (date(started_on) IS started_on),
  ended_on       TEXT    CHECK (date(ended_on) IS ended_on),
  CHECK (ended_on IS NULL OR ended_on >= started_on)
) STRICT;

-- At most one active programme per member.
CREATE UNIQUE INDEX programme_one_active ON programme (member_id) WHERE active = 1;

CREATE TABLE session_template (
  id            INTEGER PRIMARY KEY,
  programme_id  INTEGER NOT NULL REFERENCES programme (id),
  name          TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  session_type  TEXT    NOT NULL CHECK (session_type IN ('strength', 'cardio', 'class')),
  UNIQUE (programme_id, name)
) STRICT;

-- Where a template sits in its programme's schedule: an ISO weekday
-- (1 = Monday) for a weekday plan, or a position for a rotation.
CREATE TABLE schedule_slot (
  id                 INTEGER PRIMARY KEY,
  programme_id       INTEGER NOT NULL REFERENCES programme (id),
  weekday            INTEGER CHECK (weekday BETWEEN 1 AND 7),
  rotation_position  INTEGER CHECK (rotation_position >= 1),
  template_id        INTEGER NOT NULL REFERENCES session_template (id),
  CHECK ((weekday IS NULL) <> (rotation_position IS NULL)),
  UNIQUE (programme_id, weekday),
  UNIQUE (programme_id, rotation_position)
) STRICT;

-- A one-off swap on a weekday plan. template_id NULL = no session that day.
CREATE TABLE schedule_swap (
  id            INTEGER PRIMARY KEY,
  programme_id  INTEGER NOT NULL REFERENCES programme (id),
  on_date       TEXT    NOT NULL CHECK (date(on_date) IS on_date),
  template_id   INTEGER REFERENCES session_template (id),
  reason        TEXT    NOT NULL CHECK (length(trim(reason)) > 0),
  UNIQUE (programme_id, on_date)
) STRICT;

-- What a template asks for on one exercise. The starting load is stored
-- here; the current load is this plus its load_change events (computed in
-- the view, never stored).
CREATE TABLE prescription (
  id                INTEGER PRIMARY KEY,
  template_id       INTEGER NOT NULL REFERENCES session_template (id),
  position          INTEGER NOT NULL CHECK (position >= 1),
  exercise_id       INTEGER NOT NULL REFERENCES exercise (id),
  sets              INTEGER NOT NULL CHECK (sets BETWEEN 1 AND 20),
  rep_low           INTEGER NOT NULL CHECK (rep_low >= 1),
  rep_high          INTEGER NOT NULL CHECK (rep_high <= 100),
  rir_target_low    INTEGER NOT NULL CHECK (rir_target_low BETWEEN 0 AND 10),
  rir_target_high   INTEGER NOT NULL CHECK (rir_target_high BETWEEN 0 AND 10),
  rest_s            INTEGER CHECK (rest_s BETWEEN 0 AND 3600),
  load_value        REAL    CHECK (abs(load_value) < 1000),
  load_unit         TEXT    CHECK (load_unit IN ('kg', 'lb')),
  load_basis        TEXT    CHECK (load_basis IN ('total', 'per_side', 'per_hand', 'per_leg')),
  load_implement_id INTEGER REFERENCES implement (id),
  -- Structured data; its full schema is owned by the domain package. The
  -- 'rep_top' kind (gymcalc R3) must carry its three numbers. An optional
  -- 'autoregulation' object holds the autoregulation branch.
  progression_rule  TEXT    CHECK (
                      json_valid(progression_rule)
                      AND json_type(progression_rule) = 'object'
                      AND json_extract(progression_rule, '$.kind') IN ('rep_top', 'manual')
                      AND (json_extract(progression_rule, '$.kind') <> 'rep_top' OR (
                            json_type(progression_rule, '$.target_sets') = 'integer'
                        AND json_type(progression_rule, '$.rep_top') = 'integer'
                        AND json_type(progression_rule, '$.rir_floor') IN ('integer', 'real')))
                      AND coalesce(json_type(progression_rule, '$.autoregulation'), 'object') = 'object'),
  cue               TEXT,
  fallback_note     TEXT,
  CHECK (rep_low <= rep_high),
  CHECK (rir_target_low <= rir_target_high),
  CHECK ((load_value IS NULL) = (load_unit IS NULL) AND (load_value IS NULL) = (load_basis IS NULL)),
  CHECK (load_implement_id IS NULL OR load_value IS NOT NULL),
  UNIQUE (template_id, position)
) STRICT;

-- Ranked substitutes. Whether one counts as coverage (matching stimulus
-- tags) is computed, not stored.
CREATE TABLE prescription_fallback (
  prescription_id  INTEGER NOT NULL REFERENCES prescription (id),
  exercise_id      INTEGER NOT NULL REFERENCES exercise (id),
  rank             INTEGER NOT NULL CHECK (rank >= 1),
  note             TEXT,
  PRIMARY KEY (prescription_id, exercise_id),
  UNIQUE (prescription_id, rank)
) STRICT;

-- A recorded move of a prescription's load (replaces "Last Moved"). Only the
-- new load is stored; the previous one is the prior event or the start load.
CREATE TABLE load_change (
  id                INTEGER PRIMARY KEY,
  prescription_id   INTEGER NOT NULL REFERENCES prescription (id),
  changed_on        TEXT    NOT NULL CHECK (date(changed_on) IS changed_on),
  load_value        REAL    NOT NULL CHECK (abs(load_value) < 1000),
  load_unit         TEXT    NOT NULL CHECK (load_unit IN ('kg', 'lb')),
  load_basis        TEXT    NOT NULL CHECK (load_basis IN ('total', 'per_side', 'per_hand', 'per_leg')),
  load_implement_id INTEGER REFERENCES implement (id),
  reason            TEXT    NOT NULL CHECK (length(trim(reason)) > 0)
) STRICT;

CREATE INDEX load_change_by_prescription ON load_change (prescription_id, changed_on);

-- A dated period in a member's training. Never typed onto rows.
CREATE TABLE phase (
  id             INTEGER PRIMARY KEY,
  member_id      INTEGER NOT NULL REFERENCES member (id),
  name           TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  starts_on      TEXT    NOT NULL CHECK (date(starts_on) IS starts_on),
  ends_on        TEXT    CHECK (date(ends_on) IS ends_on),
  energy_stance  TEXT    NOT NULL CHECK (energy_stance IN ('deficit', 'maintenance', 'surplus')),
  intent         TEXT    NOT NULL CHECK (length(trim(intent)) > 0),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
) STRICT;

CREATE INDEX phase_by_member ON phase (member_id, starts_on);
