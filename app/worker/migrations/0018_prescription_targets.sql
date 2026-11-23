-- Migration number: 0018 	 2026-10-06
-- Prescriptions with a non-rep target, and richer progression rules.
--
-- 1. A prescription's target is reps (the rep range, as before), a
--    duration (a hold for "max time", a 20-minute walk) or a distance
--    (a carry over so many metres). Only a reps target has a rep range;
--    RIR is optional on every kind (an activation drill with no RIR).
--    Sets may be absent ("-") for a single continuous effort.
-- 2. A rep_top rule's rir_floor may be "from_prescription" (the
--    prescription's own RIR target low end, read when the check runs), its
--    increment may be "smallest_step" or carry its own unit and basis, and
--    a rule may carry a cue and per_leg. A rep_top rule needs a reps target.
--
-- SQLite can't relax NOT NULL in place, so the table is rebuilt. It is
-- applied before any data is loaded (cutover loads an empty database);
-- defer_foreign_keys keeps D1 happy while the old table is dropped.

PRAGMA defer_foreign_keys = true;

DROP VIEW v_prescription;

CREATE TABLE prescription_new (
  id                INTEGER PRIMARY KEY,
  template_id       INTEGER NOT NULL REFERENCES session_template (id),
  position          INTEGER NOT NULL CHECK (position >= 1),
  exercise_id       INTEGER NOT NULL REFERENCES exercise (id),
  target_kind       TEXT    NOT NULL DEFAULT 'reps' CHECK (target_kind IN ('reps', 'duration', 'distance')),
  -- NULL = one continuous effort, no set count.
  sets              INTEGER CHECK (sets BETWEEN 1 AND 20),
  rep_low           INTEGER CHECK (rep_low >= 1),
  rep_high          INTEGER CHECK (rep_high <= 100),
  -- NULL = no RIR target (timed and carried work, activation drills).
  rir_target_low    INTEGER CHECK (rir_target_low BETWEEN 0 AND 10),
  rir_target_high   INTEGER CHECK (rir_target_high BETWEEN 0 AND 10),
  -- A duration target; both NULL = as long as possible ("max time").
  duration_low_s    INTEGER CHECK (duration_low_s > 0),
  duration_high_s   INTEGER CHECK (duration_high_s > 0),
  distance_value    REAL    CHECK (distance_value > 0),
  distance_unit     TEXT    CHECK (distance_unit IN ('m', 'km', 'mi')),
  rest_s            INTEGER CHECK (rest_s BETWEEN 0 AND 3600),
  load_value        REAL    CHECK (abs(load_value) < 1000),
  load_unit         TEXT    CHECK (load_unit IN ('kg', 'lb')),
  load_basis        TEXT    CHECK (load_basis IN ('total', 'per_side', 'per_hand', 'per_leg')),
  load_implement_id INTEGER REFERENCES implement (id),
  progression_rule  TEXT    CHECK (
                      json_valid(progression_rule)
                      AND json_type(progression_rule) = 'object'
                      AND json_extract(progression_rule, '$.kind') IN ('rep_top', 'manual')
                      AND (json_extract(progression_rule, '$.kind') <> 'rep_top' OR (
                            json_type(progression_rule, '$.target_sets') = 'integer'
                        AND json_type(progression_rule, '$.rep_top') = 'integer'
                        AND (json_type(progression_rule, '$.rir_floor') IN ('integer', 'real')
                             OR json_extract(progression_rule, '$.rir_floor') = 'from_prescription')))
                      AND (coalesce(json_type(progression_rule, '$.increment'), 'object') = 'object'
                           OR json_extract(progression_rule, '$.increment') = 'smallest_step')
                      AND coalesce(json_type(progression_rule, '$.autoregulation'), 'object') = 'object'),
  cue               TEXT,
  fallback_note     TEXT,
  CHECK ((rep_low IS NULL) = (rep_high IS NULL)),
  CHECK (rep_low IS NULL OR rep_low <= rep_high),
  CHECK ((rir_target_low IS NULL) = (rir_target_high IS NULL)),
  CHECK (rir_target_low IS NULL OR rir_target_low <= rir_target_high),
  CHECK ((target_kind = 'reps') = (rep_low IS NOT NULL)),
  CHECK (target_kind = 'duration' OR (duration_low_s IS NULL AND duration_high_s IS NULL)),
  CHECK ((duration_low_s IS NULL) = (duration_high_s IS NULL)),
  CHECK (duration_low_s IS NULL OR duration_low_s <= duration_high_s),
  CHECK ((target_kind = 'distance') = (distance_value IS NOT NULL)),
  CHECK ((distance_value IS NULL) = (distance_unit IS NULL)),
  CHECK (coalesce(json_extract(progression_rule, '$.kind'), 'manual') = 'manual' OR target_kind = 'reps'),
  CHECK ((load_value IS NULL) = (load_unit IS NULL) AND (load_value IS NULL) = (load_basis IS NULL)),
  CHECK (load_implement_id IS NULL OR load_value IS NOT NULL),
  UNIQUE (template_id, position)
) STRICT;

INSERT INTO prescription_new (
  id, template_id, position, exercise_id, target_kind, sets, rep_low, rep_high, rir_target_low, rir_target_high,
  rest_s, load_value, load_unit, load_basis, load_implement_id, progression_rule, cue, fallback_note
)
SELECT
  id, template_id, position, exercise_id, 'reps', sets, rep_low, rep_high, rir_target_low, rir_target_high,
  rest_s, load_value, load_unit, load_basis, load_implement_id, progression_rule, cue, fallback_note
FROM prescription;

DROP TABLE prescription;

ALTER TABLE prescription_new RENAME TO prescription;

-- Prescriptions with their current load: the latest load change, else the
-- starting load. Now with the target.
CREATE VIEW v_prescription AS
WITH latest AS (
  SELECT lc.*, row_number() OVER (PARTITION BY lc.prescription_id ORDER BY lc.changed_on DESC, lc.id DESC) AS rn
  FROM load_change AS lc
)
SELECT
  p.id,
  pr.member_id,
  p.template_id,
  tpl.name AS template_name,
  p.position,
  p.exercise_id,
  ex.name AS exercise_name,
  p.target_kind,
  p.sets,
  p.rep_low,
  p.rep_high,
  p.rir_target_low,
  p.rir_target_high,
  p.duration_low_s,
  p.duration_high_s,
  p.distance_value,
  p.distance_unit,
  p.rest_s,
  p.progression_rule,
  p.cue,
  p.fallback_note,
  coalesce(l.load_value, p.load_value) AS current_load_value,
  CASE WHEN l.id IS NOT NULL THEN l.load_unit ELSE p.load_unit END AS current_load_unit,
  CASE WHEN l.id IS NOT NULL THEN l.load_basis ELSE p.load_basis END AS current_load_basis,
  CASE WHEN l.id IS NOT NULL THEN l.load_implement_id ELSE p.load_implement_id END AS current_load_implement_id,
  l.changed_on AS load_changed_on
FROM prescription AS p
JOIN session_template AS tpl ON tpl.id = p.template_id
JOIN programme AS pr ON pr.id = tpl.programme_id
JOIN exercise AS ex ON ex.id = p.exercise_id
LEFT JOIN latest AS l ON l.prescription_id = p.id AND l.rn = 1;
