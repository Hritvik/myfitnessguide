-- Migration number: 0033     2026-10-16
-- Chart primitives: RIR-adjusted e1RM and comparability on v_set, plus
-- household-visible exercise method changes. Body method changes remain in
-- the existing owner-only v_method_change view. This is additive: no stored
-- row changes and the strict e1rm_kg calculation is unchanged.

DROP VIEW v_set;

-- v_set as in 0023, with e1rm_rir_kg and comparable appended.
CREATE VIEW v_set AS
WITH loaded AS (
  SELECT
    st.*,
    coalesce(im.kind, ex.implement_kind) AS implement_kind,
    im.loading AS implement_loading,
    ex.bodyweight_dominant AS load_bodyweight_dominant,
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
), derived AS (
  SELECT
    l.*,
    CASE
      WHEN l.total_load_kg IS NULL OR l.total_load_kg <= 0 OR l.load_bodyweight_dominant = 1 OR l.implement_loading = 'plates_only' THEN 0
      ELSE 1
    END AS comparable
  FROM loaded AS l
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
       THEN (l.total_load_kg / l.implements_sharing) * (1 + l.reps / 30.0) END AS e1rm_kg,
  CASE WHEN l.comparable = 1 AND l.rir_status = 'recorded' AND l.reps >= 1
            AND l.reps + l.rir_low <= 12
       THEN (l.total_load_kg / l.implements_sharing) * (1 + (l.reps + l.rir_low) / 30.0) END AS e1rm_rir_kg,
  l.comparable
FROM derived AS l
JOIN session AS se ON se.id = l.session_id
JOIN exercise AS ex ON ex.id = l.exercise_id;

-- Exercise method changes are household-visible training data. The existing
-- v_method_change remains the complete, owner-only body/health view.
CREATE VIEW v_exercise_method_change AS
SELECT * FROM method_change WHERE exercise_id IS NOT NULL;
