-- Migration number: 0019 	 2026-10-06
-- An explicit running order for a session's sets.
--
-- `set_number` counts the sets of one exercise; it can't say that a block
-- of floor work ran before the machines (a ruling can put rows recovered
-- later in a pointer row's place). `position` is the set's
-- place in the whole session, 1-based and unique per session. The API
-- appends by default and can insert at a position, moving later sets down.
-- Existing sets are numbered in the order they were logged (id order).

ALTER TABLE session_set ADD COLUMN position INTEGER CHECK (position >= 1);

UPDATE session_set SET position = (
  SELECT count(*) FROM session_set AS s2 WHERE s2.session_id = session_set.session_id AND s2.id <= session_set.id
);

CREATE UNIQUE INDEX session_set_position ON session_set (session_id, position);

DROP VIEW v_set;

-- v_set as in 0017, with the set's position.
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
