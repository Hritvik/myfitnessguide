-- Migration number: 0030 	 2026-10-06
-- App input (docs/superpowers/specs/2026-10-06-app-input-design.md):
--   * one alias store for food sources, recipes, exercises and workouts
--     (§6). The exercise aliases are copied into it with their ids and
--     v_exercise is recreated over it. exercise_alias stays, unread by the
--     new Worker, so the Worker live between this migration and the deploy
--     (or restored by a rollback) keeps working; a later migration drops it;
--   * saved workouts and their lines, and a session's workout (§5);
--   * the Inbox's entries (§8), app feedback (§9) and the router's stats (§7).
-- Additive: nothing is dropped but v_exercise, recreated with the same columns.

CREATE TABLE alias (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household (id),
  -- One meaning per word: unique ignoring case across every kind.
  alias         TEXT    NOT NULL COLLATE NOCASE CHECK (length(trim(alias)) > 0 AND alias = trim(alias)),
  kind          TEXT    NOT NULL CHECK (kind IN ('food_source', 'recipe', 'exercise', 'workout')),
  -- The food_source, recipe, exercise or workout the word names (by kind).
  target_id     INTEGER NOT NULL,
  -- Who taught it: the member in the app, or the member the agent was
  -- talking with. NULL for aliases moved from exercise_alias or imported.
  created_by    INTEGER REFERENCES member (id),
  created_at    TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS created_at),
  UNIQUE (household_id, alias)
) STRICT;

CREATE INDEX alias_by_target ON alias (kind, target_id);

INSERT INTO alias (id, household_id, alias, kind, target_id, created_by, created_at)
SELECT a.id, e.household_id, trim(a.alias), 'exercise', a.exercise_id, NULL, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
FROM exercise_alias AS a JOIN exercise AS e ON e.id = a.exercise_id;

DROP VIEW v_exercise;

-- v_exercise as in 0011, its aliases now from the alias store (same columns,
-- so the query tool reads it the same under either Worker).
CREATE VIEW v_exercise AS
SELECT
  e.id, e.name, e.implement_kind, e.note,
  (SELECT group_concat(alias, ', ') FROM (SELECT alias FROM alias WHERE kind = 'exercise' AND target_id = e.id ORDER BY alias)) AS aliases,
  (SELECT group_concat(tag, ', ') FROM (SELECT tag FROM exercise_tag WHERE exercise_id = e.id AND kind = 'movement_pattern' ORDER BY tag))
    AS movement_patterns,
  (SELECT group_concat(tag, ', ') FROM (SELECT tag FROM exercise_tag WHERE exercise_id = e.id AND kind = 'stimulus' ORDER BY tag))
    AS stimulus_tags
FROM exercise AS e;

-- A saved list of exercises with default sets, reps and loads, logged in
-- one go: the training counterpart of a recipe. Household-level.
CREATE TABLE workout (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household (id),
  name          TEXT    NOT NULL COLLATE NOCASE CHECK (length(trim(name)) > 0),
  note          TEXT,
  created_at    TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS created_at),
  UNIQUE (household_id, name)
) STRICT;

CREATE TABLE workout_line (
  id              INTEGER PRIMARY KEY,
  workout_id      INTEGER NOT NULL REFERENCES workout (id),
  position        INTEGER NOT NULL CHECK (position >= 1),
  exercise_id     INTEGER NOT NULL REFERENCES exercise (id),
  -- A substitution needs a prescription, which a workout doesn't have.
  set_type        TEXT    NOT NULL DEFAULT 'working' CHECK (set_type IN ('warm_up', 'working', 'back_off', 'calibration')),
  sets            INTEGER NOT NULL CHECK (sets BETWEEN 1 AND 20),
  target_kind     TEXT    NOT NULL CHECK (target_kind IN ('reps', 'duration', 'distance')),
  rep_low         INTEGER CHECK (rep_low BETWEEN 0 AND 200),
  rep_high        INTEGER CHECK (rep_high BETWEEN 0 AND 200),
  duration_s      INTEGER CHECK (duration_s > 0),
  distance_value  REAL    CHECK (distance_value > 0),
  distance_unit   TEXT    CHECK (distance_unit IN ('m', 'km', 'mi')),
  -- The default load: NULL = none given; 'none' = bodyweight; 'value' =
  -- a value, unit and basis; 'plates' = plates per side (units may mix)
  -- on a bar, with load_value / load_unit their per-side sum, as
  -- session_set stores a composition.
  load_kind       TEXT    CHECK (load_kind IN ('value', 'plates', 'none')),
  load_value      REAL    CHECK (abs(load_value) < 1000),
  load_unit       TEXT    CHECK (load_unit IN ('kg', 'lb')),
  load_basis      TEXT    CHECK (load_basis IN ('total', 'per_side', 'per_hand', 'per_leg')),
  bar_value       REAL    CHECK (bar_value >= 0 AND bar_value < 100),
  bar_unit        TEXT    CHECK (bar_unit IN ('kg', 'lb')),
  plates          TEXT    CHECK (plates IS NULL OR (json_valid(plates) AND json_type(plates) = 'array')),
  rir_low         INTEGER CHECK (rir_low BETWEEN 0 AND 10),
  rir_high        INTEGER CHECK (rir_high BETWEEN 0 AND 10),
  rest_s          INTEGER CHECK (rest_s > 0),
  note            TEXT,
  CHECK ((rep_low IS NULL) = (rep_high IS NULL)),
  CHECK ((target_kind = 'reps') = (rep_low IS NOT NULL)),
  CHECK (rep_low IS NULL OR rep_low <= rep_high),
  CHECK ((target_kind = 'duration') = (duration_s IS NOT NULL)),
  CHECK ((target_kind = 'distance') = (distance_value IS NOT NULL)),
  CHECK ((distance_value IS NULL) = (distance_unit IS NULL)),
  CHECK ((coalesce(load_kind, '') IN ('value', 'plates')) = (load_value IS NOT NULL)),
  CHECK ((load_value IS NULL) = (load_unit IS NULL) AND (load_value IS NULL) = (load_basis IS NULL)),
  CHECK ((coalesce(load_kind, '') = 'plates') = (plates IS NOT NULL)),
  CHECK (coalesce(load_kind, '') <> 'plates' OR load_basis = 'per_side'),
  CHECK ((bar_value IS NULL) = (bar_unit IS NULL)),
  CHECK (bar_value IS NULL OR load_basis = 'per_side'),
  CHECK ((rir_low IS NULL) = (rir_high IS NULL)),
  CHECK (rir_low IS NULL OR rir_low <= rir_high),
  UNIQUE (workout_id, position)
) STRICT;

-- The workout a session was logged from. A session follows a programme
-- template or a workout, never both.
ALTER TABLE session ADD COLUMN workout_id INTEGER REFERENCES workout (id) CHECK (workout_id IS NULL OR template_id IS NULL);

CREATE INDEX session_by_workout ON session (workout_id);

-- Free text the router couldn't resolve, waiting for the gym-inbox skill.
CREATE TABLE inbox_entry (
  id               INTEGER PRIMARY KEY,
  member_id        INTEGER NOT NULL REFERENCES member (id),
  entry_on         TEXT    NOT NULL CHECK (date(entry_on) IS entry_on),
  meal_slot        TEXT    CHECK (meal_slot IN ('breakfast', 'lunch', 'dinner', 'snack', 'pre_workout', 'post_workout')),
  text             TEXT    NOT NULL CHECK (length(trim(text)) > 0),
  -- The unresolved spans: [{text, start, end}], offsets into text.
  spans            TEXT    NOT NULL CHECK (json_valid(spans) AND json_type(spans) = 'array' AND json_array_length(spans) > 0),
  status           TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'rejected')),
  resolution_note  TEXT,
  -- The records the resolution wrote: [{table, id}].
  records          TEXT    CHECK (records IS NULL OR (json_valid(records) AND json_type(records) = 'array')),
  created_by       INTEGER REFERENCES member (id),
  created_at       TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS created_at),
  resolved_at      TEXT    CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', resolved_at) IS resolved_at),
  CHECK ((status = 'pending') = (resolved_at IS NULL)),
  CHECK (status = 'pending' OR length(trim(coalesce(resolution_note, ''))) > 0)
) STRICT;

CREATE INDEX inbox_entry_by_status ON inbox_entry (status, member_id, entry_on);

-- An entry is closed once: a second close, even a concurrent one, aborts its batch.
CREATE TRIGGER inbox_entry_closes_once BEFORE UPDATE OF status ON inbox_entry
WHEN OLD.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'inbox_entry_not_pending');
END;

-- Feedback about the app itself, for requirements review.
CREATE TABLE feedback (
  id           INTEGER PRIMARY KEY,
  member_id    INTEGER NOT NULL REFERENCES member (id),
  type         TEXT    NOT NULL CHECK (type IN ('bug', 'idea', 'confusing')),
  text         TEXT    NOT NULL CHECK (length(trim(text)) > 0),
  -- Attached by the app: route, date viewed, app version, viewport class, timestamp.
  context      TEXT    NOT NULL CHECK (json_valid(context) AND json_type(context) = 'object'),
  status       TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'discussed', 'ticketed', 'done', 'wont_do')),
  triage_note  TEXT,
  created_at   TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS created_at),
  CHECK (status = 'new' OR length(trim(coalesce(triage_note, ''))) > 0)
) STRICT;

CREATE INDEX feedback_by_status ON feedback (status, member_id);

-- What the router saved without Claude, per write: pieces saved unedited,
-- edited by the member, and sent to the Inbox. Written only for writes
-- from the app (agent calls are excluded from the metric); never versioned,
-- since the write log row is its provenance.
CREATE TABLE route_stat (
  id           INTEGER PRIMARY KEY,
  member_id    INTEGER NOT NULL REFERENCES member (id),
  write_id     INTEGER NOT NULL REFERENCES write_log (id),
  recorded_on  TEXT    NOT NULL CHECK (date(recorded_on) IS recorded_on),
  unedited     INTEGER NOT NULL CHECK (unedited >= 0),
  edited       INTEGER NOT NULL CHECK (edited >= 0),
  inbox        INTEGER NOT NULL CHECK (inbox >= 0),
  CHECK (unedited + edited + inbox > 0)
) STRICT;

CREATE INDEX route_stat_by_member ON route_stat (member_id, recorded_on);
