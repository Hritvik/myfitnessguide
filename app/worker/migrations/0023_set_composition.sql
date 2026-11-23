-- Migration number: 0023 	 2026-10-06
-- A set's load as a composition: one set can mix units (a 20 kg bar with
-- 10 kg + 5 lb on each side).
--
-- `plates` is the plates on each side, as a JSON array of
-- {value, unit, count}, on a per_side load only. The bar or sled stays in
-- bar_value / bar_unit (NULL on a plates-only sled of unknown weight). The
-- per-side load is the plates' sum; load_value / load_unit hold that sum
-- too (in the plates' unit when they share one, else in kg) so a reader
-- that doesn't know compositions still sees the load. The API validates
-- each element; v_set computes from the plates, as the domain's totalLoad
-- does.

ALTER TABLE session_set ADD COLUMN plates TEXT
  CHECK (plates IS NULL OR (json_valid(plates) AND json_type(plates) = 'array' AND json_array_length(plates) > 0 AND load_basis = 'per_side'));

DROP VIEW v_set;

-- v_set as in 0021; a per-side total comes from the plates when the set has them.
CREATE VIEW v_set AS
WITH loaded AS (
  SELECT
    st.*,
    coalesce(im.kind, ex.implement_kind) AS implement_kind,
    CASE st.load_basis
      WHEN 'total' THEN st.load_value * (CASE st.load_unit WHEN 'lb' THEN 0.45359237 ELSE 1.0 END)
      WHEN 'per_side' THEN 2 * coalesce(
                             (SELECT sum(json_extract(p.value, '$.count') * json_extract(p.value, '$.value')
                                         * (CASE json_extract(p.value, '$.unit') WHEN 'lb' THEN 0.45359237 ELSE 1.0 END))
                              FROM json_each(st.plates) AS p),
                             st.load_value * (CASE st.load_unit WHEN 'lb' THEN 0.45359237 ELSE 1.0 END))
                           + coalesce(st.bar_value * (CASE st.bar_unit WHEN 'lb' THEN 0.45359237 ELSE 1.0 END), 0)
      WHEN 'per_hand' THEN (CASE st.unilateral WHEN 1 THEN 1 ELSE 2 END) * st.load_value
                           * (CASE st.load_unit WHEN 'lb' THEN 0.45359237 ELSE 1.0 END)
      WHEN 'per_leg' THEN (CASE st.unilateral WHEN 1 THEN 1 ELSE 2 END) * st.load_value
                          * (CASE st.load_unit WHEN 'lb' THEN 0.45359237 ELSE 1.0 END)
    END AS total_load_kg,
    CASE
      WHEN st.load_basis IN ('per_hand', 'per_leg') AND st.unilateral = 0 THEN 2
      WHEN st.load_basis = 'per_side' AND coalesce(im.kind, ex.implement_kind) = 'cable' THEN 2
      ELSE 1
    END AS implements_sharing
  FROM session_set AS st
  JOIN exercise AS ex ON ex.id = st.exercise_id
  LEFT JOIN implement AS im ON im.id = st.load_implement_id
)
SELECT
  l.id,
  l.session_id,
  se.member_id,
  se.performed_on,
  se.state AS session_state,
  l.exercise_id,
  ex.name AS exercise_name,
  ex.bodyweight_dominant,
  l.implement_kind,
  l.set_number,
  l.position,
  l.set_type,
  l.prescription_id,
  l.substituted_prescription_id,
  l.reps,
  l.reps_inferred,
  l.load_status,
  l.load_value,
  l.load_unit,
  l.load_basis,
  l.unilateral,
  l.load_implement_id,
  l.bar_value,
  l.bar_unit,
  l.plates,
  l.rir_status,
  l.rir_low,
  l.rir_high,
  l.duration_s,
  l.distance_value,
  l.distance_unit,
  l.steps,
  l.state,
  l.total_load_kg,
  l.implements_sharing,
  CASE WHEN l.total_load_kg > 0 AND l.reps IS NOT NULL THEN l.total_load_kg * l.reps END AS volume_kg,
  CASE WHEN l.total_load_kg > 0 AND l.rir_status = 'recorded' AND l.rir_high = 0 AND l.reps BETWEEN 1 AND 12
            AND ex.bodyweight_dominant = 0
       THEN (l.total_load_kg / l.implements_sharing) * (1 + l.reps / 30.0) END AS e1rm_kg
FROM loaded AS l
JOIN session AS se ON se.id = l.session_id
JOIN exercise AS ex ON ex.id = l.exercise_id;
