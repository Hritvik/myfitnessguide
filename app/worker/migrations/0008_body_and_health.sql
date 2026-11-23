-- Migration number: 0008 	 2026-10-05
-- Body readings (one per row), method changes, heart-rate zones, blood
-- draws and lab results, flags, targets and goal points.
--
-- Bloods, body readings and flags are visible only to their owner in the
-- app; that is enforced by the API, not here.

-- Units a reading or goal can be entered in, by dimension.
CREATE TABLE unit (
  code       TEXT PRIMARY KEY,
  dimension  TEXT NOT NULL CHECK (dimension IN ('mass', 'length', 'pressure', 'heart_rate', 'duration', 'percent', 'score'))
) STRICT;

INSERT INTO unit (code, dimension) VALUES
  ('kg', 'mass'), ('lb', 'mass'),
  ('cm', 'length'), ('mm', 'length'), ('in', 'length'),
  ('mmHg', 'pressure'),
  ('bpm', 'heart_rate'),
  ('h', 'duration'), ('min', 'duration'),
  ('pct', 'percent'),
  ('score', 'score');

-- The metrics a reading can measure. Height is a reading too, so
-- waist:height uses the stored height, never a hard-coded one.
CREATE TABLE metric (
  code       TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z0-9_]*'),
  label      TEXT NOT NULL,
  dimension  TEXT NOT NULL CHECK (dimension IN ('mass', 'length', 'pressure', 'heart_rate', 'duration', 'percent', 'score'))
) STRICT;

INSERT INTO metric (code, label, dimension) VALUES
  ('weight', 'Body weight', 'mass'),
  ('height', 'Height', 'length'),
  ('waist_navel', 'Waist at navel', 'length'),
  ('abdomen_widest', 'Abdomen at widest', 'length'),
  ('shoulders', 'Shoulder circumference', 'length'),
  ('chest', 'Chest', 'length'),
  ('arm', 'Arm', 'length'),
  ('thigh', 'Thigh', 'length'),
  ('hips', 'Hips', 'length'),
  ('neck', 'Neck', 'length'),
  ('skinfold_chest', 'Skinfold, chest', 'length'),
  ('skinfold_abdomen', 'Skinfold, abdomen', 'length'),
  ('skinfold_thigh', 'Skinfold, thigh', 'length'),
  ('bp_systolic', 'Blood pressure, systolic', 'pressure'),
  ('bp_diastolic', 'Blood pressure, diastolic', 'pressure'),
  ('resting_hr', 'Resting heart rate', 'heart_rate'),
  ('sleep', 'Sleep', 'duration'),
  ('bia_skeletal_muscle_mass', 'BIA skeletal muscle mass', 'mass'),
  ('bia_body_fat_mass', 'BIA body fat mass', 'mass'),
  ('bia_body_fat_pct', 'BIA body fat', 'percent'),
  ('bia_fat_free_mass', 'BIA fat-free mass', 'mass'),
  ('bia_visceral_fat', 'BIA visceral fat rating', 'score');

-- One measurement of one metric for one member at one time.
CREATE TABLE reading (
  id                  INTEGER PRIMARY KEY,
  member_id           INTEGER NOT NULL REFERENCES member (id),
  metric              TEXT    NOT NULL REFERENCES metric (code),
  measured_on         TEXT    NOT NULL CHECK (date(measured_on) IS measured_on),
  -- NULL = time not recorded.
  measured_at_time    TEXT    CHECK (time(measured_at_time) IS measured_at_time),
  value               REAL    NOT NULL,
  -- The unit as entered; conversion is computed.
  unit                TEXT    NOT NULL REFERENCES unit (code),
  side                TEXT    CHECK (side IN ('left', 'right')),
  -- Body state at measurement. Named body_state because `state` is the
  -- draft/confirmed state on every record table.
  body_state          TEXT    NOT NULL CHECK (body_state IN ('fasted', 'fed', 'post_exercise', 'not_recorded')),
  -- The instrument's step (0.05 kg, 0.5 cm). A change within one step is
  -- not a change. NULL = not recorded.
  resolution          REAL    CHECK (resolution > 0),
  measurer            TEXT    NOT NULL CHECK (measurer IN ('self', 'member', 'professional', 'not_recorded')),
  measurer_member_id  INTEGER REFERENCES member (id),
  method              TEXT,
  conditions          TEXT,
  suspect             INTEGER NOT NULL DEFAULT 0 CHECK (suspect IN (0, 1)),
  suspect_reason      TEXT    CHECK (length(trim(suspect_reason)) > 0),
  note                TEXT,
  state               TEXT    NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'confirmed')),
  confirmed_at        TEXT    CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', confirmed_at) IS confirmed_at),
  CHECK ((measurer = 'member') = (measurer_member_id IS NOT NULL)),
  CHECK (suspect = (suspect_reason IS NOT NULL)),
  CHECK ((state = 'confirmed') = (confirmed_at IS NOT NULL))
) STRICT;

CREATE INDEX reading_by_member_metric ON reading (member_id, metric, measured_on);

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

-- From this date a metric or an exercise is measured differently; trends
-- never draw across it.
CREATE TABLE method_change (
  id           INTEGER PRIMARY KEY,
  member_id    INTEGER NOT NULL REFERENCES member (id),
  metric       TEXT    REFERENCES metric (code),
  exercise_id  INTEGER REFERENCES exercise (id),
  changed_on   TEXT    NOT NULL CHECK (date(changed_on) IS changed_on),
  note         TEXT    NOT NULL CHECK (length(trim(note)) > 0),
  CHECK ((metric IS NULL) <> (exercise_id IS NULL))
) STRICT;

CREATE INDEX method_change_by_member ON method_change (member_id, changed_on);

-- Member heart-rate zones, provisional until the drift test replaces them.
CREATE TABLE hr_zone (
  id         INTEGER PRIMARY KEY,
  member_id  INTEGER NOT NULL REFERENCES member (id),
  zone       INTEGER NOT NULL CHECK (zone BETWEEN 1 AND 5),
  low_bpm    INTEGER NOT NULL CHECK (low_bpm BETWEEN 30 AND 250),
  high_bpm   INTEGER NOT NULL CHECK (high_bpm BETWEEN 30 AND 250),
  status     TEXT    NOT NULL CHECK (status IN ('provisional', 'tested')),
  set_on     TEXT    NOT NULL CHECK (date(set_on) IS set_on),
  basis      TEXT,
  CHECK (low_bpm <= high_bpm),
  UNIQUE (member_id, zone, set_on)
) STRICT;

CREATE TABLE blood_draw (
  id            INTEGER PRIMARY KEY,
  member_id     INTEGER NOT NULL REFERENCES member (id),
  drawn_on      TEXT    NOT NULL CHECK (date(drawn_on) IS drawn_on),
  lab           TEXT    NOT NULL CHECK (length(trim(lab)) > 0),
  -- NULL = not recorded.
  fasting       INTEGER CHECK (fasting IN (0, 1)),
  note          TEXT,
  state         TEXT    NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'confirmed')),
  confirmed_at  TEXT    CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', confirmed_at) IS confirmed_at),
  CHECK ((state = 'confirmed') = (confirmed_at IS NOT NULL))
) STRICT;

-- One marker from a draw. Numeric (value, optional comparator such as
-- '<0.5', unit) or qualitative (value_text). Change and status are computed.
CREATE TABLE lab_result (
  id          INTEGER PRIMARY KEY,
  draw_id     INTEGER NOT NULL REFERENCES blood_draw (id),
  marker      TEXT    NOT NULL COLLATE NOCASE CHECK (length(trim(marker)) > 0),
  value       REAL,
  comparator  TEXT    CHECK (comparator IN ('<', '<=', '>', '>=')),
  value_text  TEXT    CHECK (length(trim(value_text)) > 0),
  unit        TEXT    CHECK (length(trim(unit)) > 0),
  ref_low     REAL,
  ref_high    REAL,
  ref_text    TEXT,
  note        TEXT,
  CHECK (value IS NOT NULL OR value_text IS NOT NULL),
  CHECK (comparator IS NULL OR value IS NOT NULL),
  CHECK (value IS NULL OR unit IS NOT NULL),
  CHECK (ref_low IS NULL OR ref_high IS NULL OR ref_low <= ref_high),
  UNIQUE (draw_id, marker)
) STRICT;

-- An open or resolved item that must not be lost.
CREATE TABLE flag (
  id           INTEGER PRIMARY KEY,
  member_id    INTEGER NOT NULL REFERENCES member (id),
  subtype      TEXT    NOT NULL CHECK (subtype IN ('health_watch', 'restriction', 'event', 'data')),
  subject      TEXT    NOT NULL CHECK (length(trim(subject)) > 0),
  raised_on    TEXT    NOT NULL CHECK (date(raised_on) IS raised_on),
  due_on       TEXT    CHECK (date(due_on) IS due_on),
  status       TEXT    NOT NULL CHECK (status IN ('open', 'resolved')),
  resolved_on  TEXT    CHECK (date(resolved_on) IS resolved_on),
  resolution   TEXT,
  note         TEXT,
  CHECK ((status = 'resolved') = (resolved_on IS NOT NULL)),
  CHECK (resolved_on IS NULL OR resolved_on >= raised_on),
  CHECK (due_on IS NULL OR due_on >= raised_on)
) STRICT;

CREATE INDEX flag_open ON flag (member_id, status);

-- A dated set of intake targets with its reasoning. A target holds until
-- the next one's effective_from.
CREATE TABLE target (
  id              INTEGER PRIMARY KEY,
  member_id       INTEGER NOT NULL REFERENCES member (id),
  effective_from  TEXT    NOT NULL CHECK (date(effective_from) IS effective_from),
  provenance      TEXT    NOT NULL CHECK (provenance IN ('agent', 'member', 'professional', 'import')),
  reasoning       TEXT    NOT NULL CHECK (length(trim(reasoning)) > 0),
  created_at      TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS created_at),
  UNIQUE (member_id, effective_from)
) STRICT;

-- One nutrient's value in a target. 'floor' and 'ceiling' bound it,
-- 'remainder' means "whatever is left of kcal" (no stored value), and
-- 'reference_intake' carries the RDA block.
CREATE TABLE target_value (
  target_id  INTEGER NOT NULL REFERENCES target (id),
  nutrient   TEXT    NOT NULL CHECK (nutrient IN (
               'kcal', 'protein_g', 'carbs_g', 'fat_g', 'fibre_g', 'sodium_mg', 'iron_mg', 'b12_ug',
               'calcium_mg', 'magnesium_mg', 'potassium_mg', 'sat_fat_g', 'total_sugars_g', 'vitamin_c_mg')),
  kind       TEXT    NOT NULL CHECK (kind IN ('target', 'floor', 'ceiling', 'remainder', 'reference_intake')),
  value      REAL    CHECK (value >= 0),
  CHECK ((kind = 'remainder') = (value IS NULL)),
  PRIMARY KEY (target_id, nutrient, kind)
) STRICT;

-- A dated target value on a member's trajectory, for a body metric or an
-- exercise's e1RM. A point goal has value_low = value_high.
CREATE TABLE goal_point (
  id           INTEGER PRIMARY KEY,
  member_id    INTEGER NOT NULL REFERENCES member (id),
  metric       TEXT    REFERENCES metric (code),
  exercise_id  INTEGER REFERENCES exercise (id),
  week_of      TEXT    NOT NULL CHECK (date(week_of) IS week_of),
  tier         TEXT    NOT NULL CHECK (tier IN ('planned', 'stretch')),
  basis        TEXT    NOT NULL CHECK (basis IN ('absolute', 'bodyweight_multiple')),
  value_low    REAL    NOT NULL,
  value_high   REAL    NOT NULL,
  -- NULL only for a bodyweight multiple.
  unit         TEXT    REFERENCES unit (code),
  headline     INTEGER NOT NULL DEFAULT 0 CHECK (headline IN (0, 1)),
  note         TEXT,
  CHECK ((metric IS NULL) <> (exercise_id IS NULL)),
  CHECK (value_low <= value_high),
  CHECK ((basis = 'bodyweight_multiple') = (unit IS NULL))
) STRICT;

CREATE INDEX goal_point_by_member ON goal_point (member_id, week_of);
