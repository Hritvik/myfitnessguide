-- Migration number: 0039     2026-11-23
-- Structured prep and a durable prep schedule (handover, 23 Nov 2026).
--
-- A recipe's prep knowledge used to live only in `prep_type` / `method`
-- prose, so a meal plan could not say "soak this now for Wednesday". A
-- `recipe_prep_step` is one ordered operation with a lead window, who does
-- it, and whether it can be batched. The action is the operation ("Soak",
-- "Pressure-cook"); the food and amount are structured so two simultaneous
-- soaks can merge into one task with a combined quantity.
--
-- `prep_task` is the schedule a saved plan derives, plus its durable state
-- (decision 169). It is keyed to a plan revision; a successor copies the
-- rows forward by `task_key`, so a revision does not reset a done soak.
-- Content is immutable; only `status` may change.

CREATE TABLE recipe_prep_step (
  id              INTEGER PRIMARY KEY,
  recipe_id       INTEGER NOT NULL REFERENCES recipe (id),
  position        INTEGER NOT NULL CHECK (position >= 1),
  action          TEXT    NOT NULL CHECK (length(trim(action)) BETWEEN 1 AND 200),
  lead            TEXT    NOT NULL CHECK (lead IN (
                    'same_meal', 'minutes_before', 'hours_before', 'evening_before', 'day_before')),
  lead_min_h      REAL    CHECK (lead_min_h IS NULL OR lead_min_h >= 0),
  lead_max_h      REAL    CHECK (lead_max_h IS NULL OR lead_max_h >= 0),
  duration_min    INTEGER CHECK (duration_min IS NULL OR duration_min > 0),
  who             TEXT    NOT NULL CHECK (who IN ('eater', 'cook', 'anyone')),
  batchable       INTEGER NOT NULL DEFAULT 0 CHECK (batchable IN (0, 1)),
  keeps_days      REAL    CHECK (keeps_days IS NULL OR keeps_days >= 0),
  -- Steps that are prepared together share a batch group ("wed-pulses"),
  -- so a soak is not merged with another pulse soaked on a different night.
  batch_group     TEXT    CHECK (batch_group IS NULL OR length(trim(batch_group)) BETWEEN 1 AND 100),
  -- How many days of consumers one batch may cover (a soak and its cook
  -- share a batch horizon even though the soaked thing keeps only a day).
  batch_days      REAL    CHECK (batch_days IS NULL OR batch_days >= 0),
  storage         TEXT    CHECK (storage IS NULL OR storage IN ('fridge', 'freezer', 'counter')),
  -- Whether a batch beyond the fridge life can be frozen instead of split.
  freezer_ok      INTEGER NOT NULL DEFAULT 0 CHECK (freezer_ok IN (0, 1)),
  food_source_id  INTEGER REFERENCES food_source (id),
  amount_value    REAL    CHECK (amount_value IS NULL OR amount_value > 0),
  amount_unit     TEXT    CHECK (amount_unit IS NULL OR amount_unit IN ('g', 'ml', 'piece')),
  note            TEXT    CHECK (note IS NULL OR length(note) <= 1000),
  CHECK (lead_max_h IS NULL OR lead_min_h IS NULL OR lead_max_h >= lead_min_h),
  CHECK ((amount_value IS NULL) = (amount_unit IS NULL)),
  UNIQUE (recipe_id, position)
) STRICT;

CREATE INDEX recipe_prep_step_by_recipe ON recipe_prep_step (recipe_id, position);

CREATE TABLE prep_task (
  id              INTEGER PRIMARY KEY,
  household_id    INTEGER NOT NULL REFERENCES household (id),
  meal_plan_id    INTEGER NOT NULL REFERENCES meal_plan (id),
  task_key        TEXT    NOT NULL CHECK (length(task_key) BETWEEN 1 AND 300),
  action          TEXT    NOT NULL CHECK (length(trim(action)) BETWEEN 1 AND 200),
  who             TEXT    NOT NULL CHECK (who IN ('eater', 'cook', 'anyone')),
  status          TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped')),
  due_on          TEXT    NOT NULL CHECK (date(due_on) IS due_on),
  -- The window is household-local wall clock (YYYY-MM-DDTHH:MM), the form
  -- the member reads; `due_on` stays the calendar date for ordering.
  window_start    TEXT    NOT NULL CHECK (window_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]'),
  window_end      TEXT    NOT NULL CHECK (window_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]' AND window_end >= window_start),
  settled_on      TEXT    CHECK (settled_on IS NULL OR date(settled_on) IS settled_on),
  settled_by      INTEGER REFERENCES member (id),
  settled_reason  TEXT    CHECK (settled_reason IS NULL OR length(trim(settled_reason)) BETWEEN 1 AND 1000),
  canonical_json  TEXT    NOT NULL CHECK (json_valid(canonical_json) AND length(canonical_json) <= 100000),
  created_at      TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS created_at),
  UNIQUE (meal_plan_id, task_key),
  CHECK ((status = 'pending') = (settled_on IS NULL)),
  CHECK ((settled_on IS NULL) = (settled_reason IS NULL))
) STRICT;

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
