-- Migration number: 0015 	 2026-10-06
-- Bodyweight-dominant exercises get no e1RM.
--
-- On a goblet squat with a 10 kg dumbbell, bodyweight is most of what
-- moves, so an Epley estimate off the dumbbell is a fiction. The exercise
-- says so, and v_set leaves e1RM empty for it, as the domain package's
-- setDerived does. Volume still comes from the external load.
--
-- v_set also gains the set's reps_inferred (0013) and the exercise's flag.

ALTER TABLE exercise ADD COLUMN bodyweight_dominant INTEGER NOT NULL DEFAULT 0
  CHECK (bodyweight_dominant IN (0, 1));

DROP VIEW v_set;

-- Sets with their exact total load, volume and e1RM (Epley).
--   total: 'total' basis = value; 'per_side' = 2 x value + bar;
--          'per_hand' / 'per_leg' = 2 x value, or 1 x value when unilateral.
--   volume: total x reps, only for a positive total.
--   e1RM:  total x (1 + reps / 30), only at RIR 0 with 1-12 reps, and
--          never on a bodyweight-dominant exercise.
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
    END AS total_load_kg
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
  CASE WHEN l.total_load_kg > 0 AND l.reps IS NOT NULL THEN l.total_load_kg * l.reps END AS volume_kg,
  CASE WHEN l.total_load_kg > 0 AND l.rir_status = 'recorded' AND l.rir_high = 0 AND l.reps BETWEEN 1 AND 12
            AND ex.bodyweight_dominant = 0
       THEN l.total_load_kg * (1 + l.reps / 30.0) END AS e1rm_kg
FROM loaded AS l
JOIN session AS se ON se.id = l.session_id
JOIN exercise AS ex ON ex.id = l.exercise_id;
