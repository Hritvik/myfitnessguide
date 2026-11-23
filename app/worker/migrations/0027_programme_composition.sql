-- Migration number: 0027 	 2026-10-06
-- A programme load as a composition, as a set's already is (0023): the bar
-- or sled, and the plates on each side as a JSON array of
-- {value, unit, count}, units mixed (a 20 kg bar with 10 lb + 2.5 lb a
-- side). On a prescription's starting load and on each load change.
--
-- load_value / load_unit keep the per-side sum (in the plates' unit when
-- they share one, else in kg), so a reader that doesn't know compositions
-- still sees the load. The API validates each plate.
--
-- Additive: three nullable columns on each table, no rebuild; every
-- existing load reads NULL (a plain value, as before). Each CHECK is on the
-- last column it needs, so it is checked once the columns exist.
ALTER TABLE prescription ADD COLUMN bar_value REAL CHECK (bar_value IS NULL OR (bar_value >= 0 AND bar_value < 100));
ALTER TABLE prescription ADD COLUMN bar_unit TEXT
  CHECK ((bar_unit IS NULL OR bar_unit IN ('kg', 'lb'))
         AND (bar_value IS NULL) = (bar_unit IS NULL)
         AND (bar_unit IS NULL OR load_basis = 'per_side'));
ALTER TABLE prescription ADD COLUMN plates TEXT
  CHECK (plates IS NULL OR (json_valid(plates) AND json_type(plates) = 'array' AND json_array_length(plates) > 0 AND load_basis = 'per_side'));

ALTER TABLE load_change ADD COLUMN bar_value REAL CHECK (bar_value IS NULL OR (bar_value >= 0 AND bar_value < 100));
ALTER TABLE load_change ADD COLUMN bar_unit TEXT
  CHECK ((bar_unit IS NULL OR bar_unit IN ('kg', 'lb'))
         AND (bar_value IS NULL) = (bar_unit IS NULL)
         AND (bar_unit IS NULL OR load_basis = 'per_side'));
ALTER TABLE load_change ADD COLUMN plates TEXT
  CHECK (plates IS NULL OR (json_valid(plates) AND json_type(plates) = 'array' AND json_array_length(plates) > 0 AND load_basis = 'per_side'));

-- v_prescription as in 0018, plus the current load's bar and plates (from
-- the latest load change when there is one, else the prescription's own).
DROP VIEW v_prescription;

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
  l.changed_on AS load_changed_on,
  CASE WHEN l.id IS NOT NULL THEN l.bar_value ELSE p.bar_value END AS current_bar_value,
  CASE WHEN l.id IS NOT NULL THEN l.bar_unit ELSE p.bar_unit END AS current_bar_unit,
  CASE WHEN l.id IS NOT NULL THEN l.plates ELSE p.plates END AS current_plates
FROM prescription AS p
JOIN session_template AS tpl ON tpl.id = p.template_id
JOIN programme AS pr ON pr.id = tpl.programme_id
JOIN exercise AS ex ON ex.id = p.exercise_id
LEFT JOIN latest AS l ON l.prescription_id = p.id AND l.rn = 1;
