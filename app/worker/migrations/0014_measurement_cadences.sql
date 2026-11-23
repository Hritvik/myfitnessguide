-- Migration number: 0014 	 2026-10-06
-- Measurement cadences: how often each thing worth nudging about should
-- happen for a member (the old gap_registry), stored as data so the
-- `staleness` tool can compute what is overdue.
--
-- The source says where "last done" comes from:
--   reading    the member's latest reading of `metric` (in `body_state`
--              when given, so a fed weight is no fasted weight);
--   cardio_hr  the latest cardio block with a heart rate;
--   exercise   the latest set of `exercise_id`;
--   manual     `last_done_on`, set by hand (progress photos, which the
--              schema doesn't hold).

CREATE TABLE measurement_cadence (
  id            INTEGER PRIMARY KEY,
  member_id     INTEGER NOT NULL REFERENCES member (id),
  name          TEXT    NOT NULL CHECK (name GLOB '[a-z]*' AND name NOT GLOB '*[^a-z0-9_]*'),
  every_days    INTEGER NOT NULL CHECK (every_days BETWEEN 1 AND 366),
  source        TEXT    NOT NULL CHECK (source IN ('reading', 'cardio_hr', 'exercise', 'manual')),
  metric        TEXT    REFERENCES metric (code),
  body_state    TEXT    CHECK (body_state IN ('fasted', 'fed', 'post_exercise')),
  exercise_id   INTEGER REFERENCES exercise (id),
  last_done_on  TEXT    CHECK (date(last_done_on) IS last_done_on),
  message       TEXT    NOT NULL CHECK (length(trim(message)) > 0),
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  CHECK ((source = 'reading') = (metric IS NOT NULL)),
  CHECK (body_state IS NULL OR source = 'reading'),
  CHECK ((source = 'exercise') = (exercise_id IS NOT NULL)),
  CHECK (last_done_on IS NULL OR source = 'manual'),
  UNIQUE (member_id, name)
) STRICT;
