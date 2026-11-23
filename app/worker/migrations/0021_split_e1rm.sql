-- Migration number: 0021 	 2026-10-06
-- The split e1RM convention (replaces 0017's per-implement-everywhere rule).
--
-- e1RM is a TOTAL for barbells and plate-loaded machines (plates per side
-- on a bar or sled, or plates only): one lift, one e1RM. It is PER HAND,
-- PER SIDE or PER LEG for dumbbells and cables: a per_hand or per_leg set
-- (unless unilateral) and a per_side set on a cable split it in two.
-- Volume and the total still count every limb. The kind is the set's
-- implement's, or the exercise's kind of implement when the set names
-- none (imported sets). The domain package's implementsSharing applies the
-- same rule; a Worker test keeps them in step.

DROP VIEW v_set;

-- v_set as in 0019; implements_sharing now follows the implement's kind.
CREATE VIEW v_set AS
WITH loaded AS (
  SELECT
    st.*,
    coalesce(im.kind, ex.implement_kind) AS implement_kind,
    CASE st.load_basis
      WHEN 'total' THEN st.load_value * (CASE st.load_unit WHEN 'lb' THEN 0.45359237 ELSE 1.0 END)
      WHEN 'per_side' THEN 2 * st.load_value * (CASE st.load_unit WHEN 'lb' THEN 0.45359237 ELSE 1.0 END)
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
