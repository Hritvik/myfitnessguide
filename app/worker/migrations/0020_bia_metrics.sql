-- Migration number: 0020 	 2026-10-06
-- BIA body water and BIA BMR (Hritvik's rulings on hritvik/Body!13, AF
-- and AH: add the metrics). BMR is energy, a dimension the unit and metric
-- tables didn't have, so both are rebuilt with it (SQLite can't change a
-- CHECK in place) and gain the unit kcal. The reading triggers and the two
-- views that read them are dropped and recreated around the rebuild; the
-- views are unchanged except that energy's canonical unit is kcal. Applied
-- before any data is loaded.

PRAGMA defer_foreign_keys = true;

DROP VIEW v_weight_7d;
DROP VIEW v_reading;
DROP TRIGGER reading_unit_fits_metric_insert;
DROP TRIGGER reading_unit_fits_metric_update;

CREATE TABLE unit_new (
  code       TEXT PRIMARY KEY,
  dimension  TEXT NOT NULL CHECK (dimension IN ('mass', 'length', 'pressure', 'heart_rate', 'duration', 'percent', 'score', 'energy'))
) STRICT;
INSERT INTO unit_new (code, dimension) SELECT code, dimension FROM unit;
INSERT INTO unit_new (code, dimension) VALUES ('kcal', 'energy');
DROP TABLE unit;
ALTER TABLE unit_new RENAME TO unit;

CREATE TABLE metric_new (
  code       TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z0-9_]*'),
  label      TEXT NOT NULL,
  dimension  TEXT NOT NULL CHECK (dimension IN ('mass', 'length', 'pressure', 'heart_rate', 'duration', 'percent', 'score', 'energy'))
) STRICT;
INSERT INTO metric_new (code, label, dimension) SELECT code, label, dimension FROM metric;
INSERT INTO metric_new (code, label, dimension) VALUES
  ('bia_body_water_kg', 'BIA body water', 'mass'),
  ('bia_bmr_kcal', 'BIA basal metabolic rate', 'energy');
DROP TABLE metric;
ALTER TABLE metric_new RENAME TO metric;

CREATE TRIGGER reading_unit_fits_metric_insert BEFORE INSERT ON reading
WHEN EXISTS (SELECT 1 FROM unit WHERE code = NEW.unit)
 AND EXISTS (SELECT 1 FROM metric WHERE code = NEW.metric)
 AND (SELECT dimension FROM unit WHERE code = NEW.unit) <> (SELECT dimension FROM metric WHERE code = NEW.metric)
BEGIN
  SELECT RAISE(ABORT, 'unit does not fit metric');
END;

CREATE TRIGGER reading_unit_fits_metric_update BEFORE UPDATE OF unit, metric ON reading
WHEN EXISTS (SELECT 1 FROM unit WHERE code = NEW.unit)
 AND EXISTS (SELECT 1 FROM metric WHERE code = NEW.metric)
 AND (SELECT dimension FROM unit WHERE code = NEW.unit) <> (SELECT dimension FROM metric WHERE code = NEW.metric)
BEGIN
  SELECT RAISE(ABORT, 'unit does not fit metric');
END;


-- Readings in the metric's canonical unit (as 0011; energy is kcal).
CREATE VIEW v_reading AS
SELECT
  r.id, r.member_id, r.metric, mt.dimension, r.measured_on, r.measured_at_time, r.value, r.unit,
  r.value * CASE r.unit WHEN 'lb' THEN 0.45359237 WHEN 'mm' THEN 0.1 WHEN 'in' THEN 2.54 WHEN 'min' THEN 1 / 60.0 ELSE 1.0 END
    AS value_canonical,
  CASE mt.dimension WHEN 'mass' THEN 'kg' WHEN 'length' THEN 'cm' WHEN 'pressure' THEN 'mmHg'
                    WHEN 'heart_rate' THEN 'bpm' WHEN 'duration' THEN 'h' WHEN 'percent' THEN 'pct'
                    WHEN 'energy' THEN 'kcal' ELSE 'score' END
    AS canonical_unit,
  r.side, r.body_state, r.resolution, r.measurer, r.measurer_member_id, r.method, r.conditions, r.suspect,
  r.suspect_reason, r.note, r.state,
  (SELECT max(mc.changed_on) FROM method_change AS mc
    WHERE mc.member_id = r.member_id AND mc.metric = r.metric AND mc.changed_on <= r.measured_on) AS segment_start
FROM reading AS r
JOIN metric AS mt ON mt.code = r.metric;


-- 7-day fasted weight average (as 0011).
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
