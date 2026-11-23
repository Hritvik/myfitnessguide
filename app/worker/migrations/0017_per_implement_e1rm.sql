-- Migration number: 0017 	 2026-10-06
-- The per-implement e1RM convention (rulings on hritvik/Log!30, 48, 88, 329).
--
-- e1RM is on the load one implement moves: one hand's dumbbell (per_hand),
-- one leg (per_leg), one side's stack or plates (per_side, half the bar
-- included). Volume and the total still count every limb. A per_leg set of
-- a single-leg exercise covers both legs unless it is marked unilateral, so
-- it is doubled like a per_hand set. The domain package's setDerived applies
-- the same rule (implementsSharing).

DROP VIEW v_set;

-- Sets with their exact total load, volume and e1RM (Epley).
--   total: 'total' basis = value; 'per_side' = 2 x value + bar;
--          'per_hand' / 'per_leg' = 2 x value, or 1 x value when unilateral.
--   implements_sharing: how many implements share that total (1 for a
--          total or a unilateral set, else 2).
--   volume: total x reps, only for a positive total.
--   e1RM:  (total / implements_sharing) x (1 + reps / 30), only at RIR 0
--          with 1-12 reps, and never on a bodyweight-dominant exercise.
CREATE VIEW v_set AS
WITH loaded AS (
  SELECT
    st.*,
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
      WHEN st.load_basis = 'total' THEN 1
      WHEN st.load_basis IN ('per_hand', 'per_leg') AND st.unilateral = 1 THEN 1
      ELSE 2
    END AS implements_sharing
  FROM session_set AS st
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
  l.set_number,
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
