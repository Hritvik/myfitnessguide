-- Migration number: 0040     2026-11-23
-- D1 refuses the long GLOB format checks 0039 put on prep_task.window_start
-- and window_end (its LIKE/GLOB pattern limit is far below stock SQLite's).
-- Every save with a prep task reached that CHECK and failed with
-- "LIKE or GLOB pattern too complex". The table is rebuilt with a
-- pattern-free format check: 16 characters and strftime's own parse of the
-- value equal to the value. The old table's rows are copied, then the
-- indexes and triggers are recreated.
--
-- This is a production repair: 0039 is already applied, so it stays as
-- written; the final schema is what the lint test checks.

DROP TRIGGER IF EXISTS prep_task_same_household;
DROP TRIGGER IF EXISTS prep_task_content_is_immutable;
DROP TRIGGER IF EXISTS prep_task_is_not_deleted;
DROP INDEX IF EXISTS prep_task_by_plan_status;
DROP INDEX IF EXISTS prep_task_by_household_due;

ALTER TABLE prep_task RENAME TO prep_task_before_0040;

CREATE TABLE prep_task (
  id              INTEGER PRIMARY KEY,
  household_id    INTEGER NOT NULL REFERENCES household (id),
  meal_plan_id    INTEGER NOT NULL REFERENCES meal_plan (id),
  task_key        TEXT    NOT NULL CHECK (length(task_key) BETWEEN 1 AND 300),
  action          TEXT    NOT NULL CHECK (length(trim(action)) BETWEEN 1 AND 200),
  who             TEXT    NOT NULL CHECK (who IN ('eater', 'cook', 'anyone')),
  status          TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped')),
  due_on          TEXT    NOT NULL CHECK (date(due_on) IS due_on),
  -- Household-local wall clock (YYYY-MM-DDTHH:MM), checked without a
  -- pattern: exactly 16 characters, and strftime reads the value back
  -- unchanged.
  window_start    TEXT    NOT NULL CHECK (length(window_start) = 16 AND strftime('%Y-%m-%dT%H:%M', window_start) IS window_start),
  window_end      TEXT    NOT NULL CHECK (length(window_end) = 16 AND strftime('%Y-%m-%dT%H:%M', window_end) IS window_end AND window_end >= window_start),
  settled_on      TEXT    CHECK (settled_on IS NULL OR date(settled_on) IS settled_on),
  settled_by      INTEGER REFERENCES member (id),
  settled_reason  TEXT    CHECK (settled_reason IS NULL OR length(trim(settled_reason)) BETWEEN 1 AND 1000),
  canonical_json  TEXT    NOT NULL CHECK (json_valid(canonical_json) AND length(canonical_json) <= 100000),
  created_at      TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS created_at),
  UNIQUE (meal_plan_id, task_key),
  CHECK ((status = 'pending') = (settled_on IS NULL)),
  CHECK ((settled_on IS NULL) = (settled_reason IS NULL))
) STRICT;

INSERT INTO prep_task (
  id, household_id, meal_plan_id, task_key, action, who, status, due_on,
  window_start, window_end, settled_on, settled_by, settled_reason,
  canonical_json, created_at
)
SELECT
  id, household_id, meal_plan_id, task_key, action, who, status, due_on,
  window_start, window_end, settled_on, settled_by, settled_reason,
  canonical_json, created_at
FROM prep_task_before_0040;

DROP TABLE prep_task_before_0040;

CREATE INDEX prep_task_by_plan_status ON prep_task (meal_plan_id, status);
CREATE INDEX prep_task_by_household_due ON prep_task (household_id, due_on);

CREATE TRIGGER prep_task_same_household
BEFORE INSERT ON prep_task
WHEN NOT EXISTS (
  SELECT 1 FROM meal_plan p WHERE p.id = NEW.meal_plan_id AND p.household_id = NEW.household_id
)
BEGIN
  SELECT RAISE(ABORT, 'prep_task_other_household');
END;

CREATE TRIGGER prep_task_content_is_immutable
BEFORE UPDATE OF household_id, meal_plan_id, task_key, action, who, due_on,
  window_start, window_end, canonical_json, created_at ON prep_task
BEGIN
  SELECT RAISE(ABORT, 'prep_task_is_immutable');
END;

CREATE TRIGGER prep_task_is_not_deleted
BEFORE DELETE ON prep_task
BEGIN
  SELECT RAISE(ABORT, 'prep_task_is_immutable');
END;
