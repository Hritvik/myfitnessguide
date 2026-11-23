-- Migration number: 0005 	 2026-10-05
-- Sessions, sets and cardio blocks. Logged-only training (record-only
-- members) uses the same tables with no template and no prescription.
--
-- Total load, volume, e1RM and pace are never stored; see the views.

CREATE TABLE session (
  id            INTEGER PRIMARY KEY,
  member_id     INTEGER NOT NULL REFERENCES member (id),
  performed_on  TEXT    NOT NULL CHECK (date(performed_on) IS performed_on),
  -- Required for strength; cardio may be outdoors and a class (dance) is a
  -- non-gym activity.
  gym_id        INTEGER REFERENCES gym (id),
  session_type  TEXT    NOT NULL CHECK (session_type IN ('strength', 'cardio', 'class')),
  template_id   INTEGER REFERENCES session_template (id),
  started_at    TEXT    CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', started_at) IS started_at),
  ended_at      TEXT    CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', ended_at) IS ended_at),
  -- Energy cost of a class or cardio session as entered (counts toward
  -- energy availability). NULL = not recorded.
  energy_kcal   REAL    CHECK (energy_kcal BETWEEN 0 AND 5000),
  note          TEXT,
  state         TEXT    NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'confirmed')),
  confirmed_at  TEXT    CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', confirmed_at) IS confirmed_at),
  CHECK (session_type <> 'strength' OR gym_id IS NOT NULL),
  CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
  CHECK ((state = 'confirmed') = (confirmed_at IS NOT NULL))
) STRICT;

CREATE INDEX session_by_member ON session (member_id, performed_on);

-- One effort within a session. Named session_set because SET is an SQL
-- keyword; the domain term is Set.
CREATE TABLE session_set (
  id                           INTEGER PRIMARY KEY,
  session_id                   INTEGER NOT NULL REFERENCES session (id),
  exercise_id                  INTEGER NOT NULL REFERENCES exercise (id),
  set_number                   INTEGER NOT NULL CHECK (set_number >= 1),
  set_type                     TEXT    NOT NULL CHECK (set_type IN ('warm_up', 'working', 'back_off', 'substitution', 'calibration')),
  prescription_id              INTEGER REFERENCES prescription (id),
  substituted_prescription_id  INTEGER REFERENCES prescription (id),
  reps                         INTEGER CHECK (reps BETWEEN 0 AND 200),
  -- Load as entered. 'none' = no external load (bodyweight);
  -- 'not_recorded' = never captured; 'entered' = the group below is present.
  -- An entered 0 is a real zero.
  load_status                  TEXT    NOT NULL CHECK (load_status IN ('entered', 'none', 'not_recorded')),
  load_value                   REAL    CHECK (abs(load_value) < 1000),
  load_unit                    TEXT    CHECK (load_unit IN ('kg', 'lb')),
  load_basis                   TEXT    CHECK (load_basis IN ('total', 'per_side', 'per_hand', 'per_leg')),
  load_implement_id            INTEGER REFERENCES implement (id),
  -- Plate-loaded lifts: the bar (in its own unit) plus plates per side.
  bar_value                    REAL    CHECK (bar_value >= 0 AND bar_value < 100),
  bar_unit                     TEXT    CHECK (bar_unit IN ('kg', 'lb')),
  -- RIR as a range. NULL status = blank (a draft only); 'not_recorded' =
  -- never captured (imported or record-only); 'recorded' = range present.
  rir_status                   TEXT    CHECK (rir_status IN ('recorded', 'not_recorded')),
  rir_low                      INTEGER CHECK (rir_low BETWEEN 0 AND 10),
  rir_high                     INTEGER CHECK (rir_high BETWEEN 0 AND 10),
  duration_s                   INTEGER CHECK (duration_s > 0),
  distance_value               REAL    CHECK (distance_value > 0),
  distance_unit                TEXT    CHECK (distance_unit IN ('m', 'km', 'mi')),
  steps                        INTEGER CHECK (steps > 0),
  note                         TEXT,
  state                        TEXT    NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'confirmed')),
  confirmed_at                 TEXT    CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', confirmed_at) IS confirmed_at),
  CHECK ((load_status = 'entered') = (load_value IS NOT NULL)),
  CHECK ((load_value IS NULL) = (load_unit IS NULL) AND (load_value IS NULL) = (load_basis IS NULL)),
  CHECK (load_implement_id IS NULL OR load_value IS NOT NULL),
  CHECK ((bar_value IS NULL) = (bar_unit IS NULL)),
  CHECK (bar_value IS NULL OR load_basis = 'per_side'),
  CHECK ((coalesce(rir_status, '') = 'recorded') = (rir_low IS NOT NULL)),
  CHECK ((rir_low IS NULL) = (rir_high IS NULL)),
  CHECK (rir_low IS NULL OR rir_low <= rir_high),
  -- RIR is required to confirm: a confirmed set is recorded or not recorded,
  -- never blank. (Whether 'not_recorded' may be confirmed live depends on the
  -- member's programming mode, which the API checks.)
  CHECK (state = 'draft' OR rir_status IS NOT NULL),
  CHECK ((set_type = 'substitution') = (substituted_prescription_id IS NOT NULL)),
  CHECK (reps IS NOT NULL OR duration_s IS NOT NULL OR distance_value IS NOT NULL OR steps IS NOT NULL),
  CHECK ((distance_value IS NULL) = (distance_unit IS NULL)),
  CHECK ((state = 'confirmed') = (confirmed_at IS NOT NULL)),
  UNIQUE (session_id, exercise_id, set_number)
) STRICT;

CREATE INDEX session_set_by_exercise ON session_set (exercise_id);

-- One segment of a cardio session. Pace is derived, never stored. Steps are
-- a separate quantity from distance.
CREATE TABLE cardio_block (
  id              INTEGER PRIMARY KEY,
  session_id      INTEGER NOT NULL REFERENCES session (id),
  position        INTEGER NOT NULL CHECK (position >= 1),
  kind            TEXT    NOT NULL CHECK (kind IN ('warm_up', 'steady', 'interval', 'recovery', 'cool_down')),
  activity        TEXT,
  duration_s      INTEGER CHECK (duration_s > 0),
  speed_value     REAL    CHECK (speed_value >= 0 AND speed_value < 100),
  speed_unit      TEXT    CHECK (speed_unit IN ('km/h', 'mph')),
  incline_pct     REAL    CHECK (incline_pct BETWEEN -10 AND 40),
  distance_value  REAL    CHECK (distance_value > 0),
  distance_unit   TEXT    CHECK (distance_unit IN ('m', 'km', 'mi')),
  steps           INTEGER CHECK (steps > 0),
  avg_hr          INTEGER CHECK (avg_hr BETWEEN 30 AND 250),
  max_hr          INTEGER CHECK (max_hr BETWEEN 30 AND 250),
  hr_device       TEXT,
  rpe             REAL    CHECK (rpe BETWEEN 0 AND 10),
  -- NULL = not recorded.
  conversational  INTEGER CHECK (conversational IN (0, 1)),
  rounds          INTEGER CHECK (rounds >= 1),
  recovery_hr     INTEGER CHECK (recovery_hr BETWEEN 30 AND 250),
  note            TEXT,
  CHECK ((speed_value IS NULL) = (speed_unit IS NULL)),
  CHECK ((distance_value IS NULL) = (distance_unit IS NULL)),
  CHECK (avg_hr IS NULL OR max_hr IS NULL OR avg_hr <= max_hr),
  UNIQUE (session_id, position)
) STRICT;
