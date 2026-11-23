-- Migration number: 0009 	 2026-10-05
-- Curated read views for `query`: training.
--
-- `query` reads views only, never raw tables. Views compute only what SQL
-- computes simply; anything that needs a rule (snapping, progression,
-- coverage, per-hand / per-leg totals) belongs to the domain package.
--
-- 1 lb = 0.45359237 kg exactly. Nothing is rounded here.

-- Sets with their exact total load, volume and e1RM (Epley).
--   total: 'total' basis = value; 'per_side' = 2 x value + bar.
--          'per_hand' / 'per_leg' are left NULL for the domain package.
--   volume: total x reps, only for a positive total.
--   e1RM:  total x (1 + reps / 30), only at RIR 0 with 1-12 reps.
CREATE VIEW v_set AS
WITH loaded AS (
  SELECT
    st.*,
    CASE st.load_basis
      WHEN 'total' THEN st.load_value * (CASE st.load_unit WHEN 'lb' THEN 0.45359237 ELSE 1.0 END)
      WHEN 'per_side' THEN 2 * st.load_value * (CASE st.load_unit WHEN 'lb' THEN 0.45359237 ELSE 1.0 END)
                           + coalesce(st.bar_value * (CASE st.bar_unit WHEN 'lb' THEN 0.45359237 ELSE 1.0 END), 0)
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
  l.set_number,
  l.set_type,
  l.prescription_id,
  l.substituted_prescription_id,
  l.reps,
  l.load_status,
  l.load_value,
  l.load_unit,
  l.load_basis,
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
       THEN l.total_load_kg * (1 + l.reps / 30.0) END AS e1rm_kg
FROM loaded AS l
JOIN session AS se ON se.id = l.session_id
JOIN exercise AS ex ON ex.id = l.exercise_id;

-- Sessions with computed volume (every set type except warm-up), the
-- training week from the member's anchor, and the phase covering the date.
CREATE VIEW v_session AS
SELECT
  se.id,
  se.member_id,
  m.name AS member_name,
  se.performed_on,
  -- Integer floor division by 7, without relying on the math extension.
  CASE WHEN m.week_anchor_date IS NOT NULL THEN (
    WITH d(days) AS (SELECT CAST(julianday(se.performed_on) - julianday(m.week_anchor_date) AS INTEGER))
    SELECT CASE WHEN days >= 0 THEN days / 7 ELSE -((6 - days) / 7) END + 1 FROM d
  ) END AS week,
  (SELECT p.name FROM phase AS p
    WHERE p.member_id = se.member_id AND p.starts_on <= se.performed_on
      AND (p.ends_on IS NULL OR p.ends_on >= se.performed_on)
    ORDER BY p.starts_on DESC LIMIT 1) AS phase_name,
  se.gym_id,
  se.session_type,
  se.template_id,
  tpl.name AS template_name,
  se.started_at,
  se.ended_at,
  se.energy_kcal,
  se.state,
  (SELECT count(*) FROM v_set AS v WHERE v.session_id = se.id) AS set_count,
  (SELECT sum(v.volume_kg) FROM v_set AS v WHERE v.session_id = se.id AND v.set_type <> 'warm_up') AS volume_kg,
  (SELECT count(*) FROM v_set AS v
    WHERE v.session_id = se.id AND v.load_status = 'entered' AND v.total_load_kg IS NULL) AS sets_load_uncomputed
FROM session AS se
JOIN member AS m ON m.id = se.member_id
LEFT JOIN session_template AS tpl ON tpl.id = se.template_id;

-- Prescriptions with their current load: the latest load change, else the
-- starting load.
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
  p.sets,
  p.rep_low,
  p.rep_high,
  p.rir_target_low,
  p.rir_target_high,
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

-- Cardio blocks with pace derived from duration and distance.
CREATE VIEW v_cardio_block AS
SELECT
  b.*,
  se.member_id,
  se.performed_on,
  se.state AS session_state,
  CASE WHEN b.duration_s IS NOT NULL AND b.distance_value IS NOT NULL
       THEN (b.duration_s / 60.0) / (b.distance_value * CASE b.distance_unit WHEN 'm' THEN 0.001 WHEN 'mi' THEN 1.609344 ELSE 1.0 END)
  END AS pace_min_per_km
FROM cardio_block AS b
JOIN session AS se ON se.id = b.session_id;
