-- Migration number: 0011 	 2026-10-05
-- Curated read views for `query`: readings with trends, bloods, flags,
-- targets, goals, member notes, and the catalogue and training reference
-- data. Owner-only visibility of health data is applied by the API.

-- Readings converted to the metric's canonical unit, with the start of the
-- method segment they belong to (the latest method change on or before the
-- reading; NULL = before any change). Trends never cross a segment.
CREATE VIEW v_reading AS
SELECT
  r.id, r.member_id, r.metric, mt.dimension, r.measured_on, r.measured_at_time, r.value, r.unit,
  r.value * CASE r.unit WHEN 'lb' THEN 0.45359237 WHEN 'mm' THEN 0.1 WHEN 'in' THEN 2.54 WHEN 'min' THEN 1 / 60.0 ELSE 1.0 END
    AS value_canonical,
  CASE mt.dimension WHEN 'mass' THEN 'kg' WHEN 'length' THEN 'cm' WHEN 'pressure' THEN 'mmHg'
                    WHEN 'heart_rate' THEN 'bpm' WHEN 'duration' THEN 'h' WHEN 'percent' THEN 'pct' ELSE 'score' END
    AS canonical_unit,
  r.side, r.body_state, r.resolution, r.measurer, r.measurer_member_id, r.method, r.conditions, r.suspect,
  r.suspect_reason, r.note, r.state,
  (SELECT max(mc.changed_on) FROM method_change AS mc
    WHERE mc.member_id = r.member_id AND mc.metric = r.metric AND mc.changed_on <= r.measured_on) AS segment_start
FROM reading AS r
JOIN metric AS mt ON mt.code = r.metric;

-- 7-day fasted weight average: fasted readings from day-6 to day, within the
-- day's method segment. One row per member and day with a fasted reading.
CREATE VIEW v_weight_7d AS
WITH fasted AS (
  SELECT member_id, measured_on, value_canonical, segment_start
  FROM v_reading WHERE metric = 'weight' AND body_state = 'fasted'
),
days AS (
  SELECT DISTINCT member_id, measured_on AS day, segment_start FROM fasted
)
SELECT
  d.member_id,
  d.day,
  avg(f.value_canonical) AS avg_kg,
  count(*) AS reading_count
FROM days AS d
JOIN fasted AS f
  ON f.member_id = d.member_id
 AND f.measured_on BETWEEN date(d.day, '-6 days') AND d.day
 AND (d.segment_start IS NULL OR f.measured_on >= d.segment_start)
GROUP BY d.member_id, d.day;

-- Lab results with their draw and a status against that lab's range.
CREATE VIEW v_lab_result AS
SELECT
  lr.id, bd.member_id, lr.draw_id, bd.drawn_on, bd.lab, bd.state AS draw_state, lr.marker, lr.value, lr.comparator,
  lr.value_text, lr.unit, lr.ref_low, lr.ref_high, lr.ref_text, lr.note,
  CASE WHEN lr.value IS NULL OR lr.comparator IS NOT NULL THEN NULL
       WHEN lr.ref_low IS NOT NULL AND lr.value < lr.ref_low THEN 'below'
       WHEN lr.ref_high IS NOT NULL AND lr.value > lr.ref_high THEN 'above'
       WHEN lr.ref_low IS NOT NULL OR lr.ref_high IS NOT NULL THEN 'within' END AS status
FROM lab_result AS lr
JOIN blood_draw AS bd ON bd.id = lr.draw_id;

CREATE VIEW v_flag AS
SELECT f.*, m.name AS member_name FROM flag AS f JOIN member AS m ON m.id = f.member_id;

-- Target values, one row each, with the date the target stopped applying.
CREATE VIEW v_target AS
WITH spans AS (
  SELECT t.*, lead(t.effective_from) OVER (PARTITION BY t.member_id ORDER BY t.effective_from) AS effective_to
  FROM target AS t
)
SELECT s.id AS target_id, s.member_id, s.effective_from, s.effective_to, s.provenance, s.reasoning,
       tv.nutrient, tv.kind, tv.value
FROM spans AS s
JOIN target_value AS tv ON tv.target_id = s.id;

CREATE VIEW v_goal_point AS
SELECT g.*, ex.name AS exercise_name
FROM goal_point AS g
LEFT JOIN exercise AS ex ON ex.id = g.exercise_id;

CREATE VIEW v_hr_zone AS
SELECT * FROM hr_zone;

CREATE VIEW v_method_change AS
SELECT * FROM method_change;

-- Each note at its latest version.
CREATE VIEW v_member_note AS
SELECT n.id, n.household_id, n.member_id, n.topic, n.subject_table, n.subject_id, v.version, v.body,
       v.created_at AS version_created_at
FROM member_note AS n
JOIN member_note_version AS v
  ON v.note_id = n.id
 AND v.version = (SELECT max(version) FROM member_note_version WHERE note_id = n.id);

CREATE VIEW v_phase AS
SELECT * FROM phase;

CREATE VIEW v_food_source AS
SELECT * FROM food_source;

CREATE VIEW v_measure AS
SELECT ms.*, fs.name AS food_source_name, fs.state AS food_source_state, fs.reference_unit
FROM measure AS ms JOIN food_source AS fs ON fs.id = ms.food_source_id;

CREATE VIEW v_yield AS
SELECT y.*, a.name AS from_name, a.state AS from_state, b.name AS to_name, b.state AS to_state
FROM yield AS y
JOIN food_source AS a ON a.id = y.from_food_source_id
JOIN food_source AS b ON b.id = y.to_food_source_id;

CREATE VIEW v_exercise AS
SELECT
  e.id, e.name, e.implement_kind, e.note,
  (SELECT group_concat(alias, ', ') FROM (SELECT alias FROM exercise_alias WHERE exercise_id = e.id ORDER BY alias)) AS aliases,
  (SELECT group_concat(tag, ', ') FROM (SELECT tag FROM exercise_tag WHERE exercise_id = e.id AND kind = 'movement_pattern' ORDER BY tag))
    AS movement_patterns,
  (SELECT group_concat(tag, ', ') FROM (SELECT tag FROM exercise_tag WHERE exercise_id = e.id AND kind = 'stimulus' ORDER BY tag))
    AS stimulus_tags
FROM exercise AS e;

CREATE VIEW v_implement AS
SELECT i.*, g.name AS gym_name,
       (SELECT group_concat(load, ', ') FROM (SELECT load FROM implement_load WHERE implement_id = i.id ORDER BY load)) AS loads
FROM implement AS i
JOIN gym AS g ON g.id = i.gym_id;
