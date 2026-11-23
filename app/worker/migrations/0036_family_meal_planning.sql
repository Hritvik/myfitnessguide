-- A meal plan records intention only. Its resolved proposal is immutable;
-- edits, archive and restore operations create a linked successor.
CREATE TABLE meal_plan (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES household (id),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  effective_from TEXT NOT NULL CHECK (date(effective_from) IS effective_from),
  effective_to TEXT NOT NULL CHECK (date(effective_to) IS effective_to AND effective_to >= effective_from),
  canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json) AND length(canonical_json) <= 1500000),
  preview_json TEXT NOT NULL CHECK (json_valid(preview_json) AND length(preview_json) <= 1500000),
  supersedes_meal_plan_id INTEGER REFERENCES meal_plan (id),
  superseded_at TEXT CHECK (superseded_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%SZ', superseded_at) IS superseded_at),
  superseded_reason TEXT CHECK (
    (superseded_reason IS NULL) = (superseded_at IS NULL)
    AND (superseded_reason IS NULL OR length(trim(superseded_reason)) BETWEEN 1 AND 1000)
  ),
  archived_at TEXT CHECK (archived_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%SZ', archived_at) IS archived_at),
  archived_reason TEXT CHECK (
    (archived_reason IS NULL) = (archived_at IS NULL)
    AND (archived_reason IS NULL OR length(trim(archived_reason)) BETWEEN 1 AND 1000)
  ),
  change_reason TEXT NOT NULL CHECK (length(trim(change_reason)) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS created_at),
  UNIQUE (household_id, id),
  UNIQUE (supersedes_meal_plan_id)
) STRICT;

CREATE INDEX meal_plan_household_dates ON meal_plan (household_id, effective_from, effective_to);
CREATE INDEX meal_plan_household_current ON meal_plan (household_id, superseded_at, archived_at, status);

CREATE TRIGGER meal_plan_successor_same_household
BEFORE INSERT ON meal_plan
WHEN NEW.supersedes_meal_plan_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM meal_plan predecessor
   WHERE predecessor.id = NEW.supersedes_meal_plan_id
     AND predecessor.household_id = NEW.household_id
     AND predecessor.revision + 1 = NEW.revision
 )
BEGIN
  SELECT RAISE(ABORT, 'meal_plan_invalid_successor');
END;

CREATE TRIGGER meal_plan_active_no_overlap_insert
BEFORE INSERT ON meal_plan
WHEN NEW.status = 'active' AND NEW.archived_at IS NULL
 AND EXISTS (
   SELECT 1 FROM meal_plan existing
   WHERE existing.household_id = NEW.household_id
     AND existing.status = 'active'
     AND existing.archived_at IS NULL
     AND existing.superseded_at IS NULL
     AND existing.effective_from <= NEW.effective_to
     AND existing.effective_to >= NEW.effective_from
 )
BEGIN
  SELECT RAISE(ABORT, 'meal_plan_overlap');
END;

CREATE TRIGGER meal_plan_content_is_immutable
BEFORE UPDATE OF household_id, name, status, revision, effective_from, effective_to,
  canonical_json, preview_json, supersedes_meal_plan_id, archived_at, archived_reason,
  change_reason, created_at ON meal_plan
BEGIN
  SELECT RAISE(ABORT, 'meal_plan_is_immutable');
END;

CREATE TABLE meal_plan_entry (
  id INTEGER PRIMARY KEY,
  meal_plan_id INTEGER NOT NULL REFERENCES meal_plan (id),
  position INTEGER NOT NULL CHECK (position > 0),
  planned_on TEXT NOT NULL CHECK (date(planned_on) IS planned_on),
  meal_slot TEXT NOT NULL CHECK (length(trim(meal_slot)) BETWEEN 1 AND 200),
  note TEXT CHECK (note IS NULL OR length(note) <= 1000),
  canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json) AND length(canonical_json) <= 1500000),
  UNIQUE (meal_plan_id, position),
  UNIQUE (meal_plan_id, planned_on, meal_slot)
) STRICT;

CREATE TABLE meal_plan_component (
  id INTEGER PRIMARY KEY,
  meal_plan_entry_id INTEGER NOT NULL REFERENCES meal_plan_entry (id),
  position INTEGER NOT NULL CHECK (position > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json) AND length(canonical_json) <= 1500000),
  UNIQUE (meal_plan_entry_id, position)
) STRICT;

CREATE TABLE meal_plan_ingredient_snapshot (
  id INTEGER PRIMARY KEY,
  meal_plan_component_id INTEGER NOT NULL REFERENCES meal_plan_component (id),
  position INTEGER NOT NULL CHECK (position > 0),
  canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json) AND length(canonical_json) <= 100000),
  UNIQUE (meal_plan_component_id, position)
) STRICT;

CREATE TABLE meal_plan_allocation (
  id INTEGER PRIMARY KEY,
  meal_plan_component_id INTEGER NOT NULL REFERENCES meal_plan_component (id),
  member_id INTEGER NOT NULL REFERENCES member (id),
  position INTEGER NOT NULL CHECK (position > 0),
  canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json) AND length(canonical_json) <= 100000),
  UNIQUE (meal_plan_component_id, position),
  UNIQUE (meal_plan_component_id, member_id)
) STRICT;

CREATE TRIGGER meal_plan_allocation_same_household
BEFORE INSERT ON meal_plan_allocation
WHEN NOT EXISTS (
  SELECT 1
  FROM member m
  JOIN meal_plan_component c ON c.id = NEW.meal_plan_component_id
  JOIN meal_plan_entry e ON e.id = c.meal_plan_entry_id
  JOIN meal_plan p ON p.id = e.meal_plan_id
  WHERE m.id = NEW.member_id AND m.household_id = p.household_id
)
BEGIN
  SELECT RAISE(ABORT, 'meal_plan_allocation_other_household');
END;

CREATE TRIGGER meal_plan_entry_is_immutable BEFORE UPDATE ON meal_plan_entry BEGIN SELECT RAISE(ABORT, 'meal_plan_graph_is_immutable'); END;
CREATE TRIGGER meal_plan_entry_is_not_deleted BEFORE DELETE ON meal_plan_entry BEGIN SELECT RAISE(ABORT, 'meal_plan_graph_is_immutable'); END;
CREATE TRIGGER meal_plan_component_is_immutable BEFORE UPDATE ON meal_plan_component BEGIN SELECT RAISE(ABORT, 'meal_plan_graph_is_immutable'); END;
CREATE TRIGGER meal_plan_component_is_not_deleted BEFORE DELETE ON meal_plan_component BEGIN SELECT RAISE(ABORT, 'meal_plan_graph_is_immutable'); END;
CREATE TRIGGER meal_plan_ingredient_is_immutable BEFORE UPDATE ON meal_plan_ingredient_snapshot BEGIN SELECT RAISE(ABORT, 'meal_plan_graph_is_immutable'); END;
CREATE TRIGGER meal_plan_ingredient_is_not_deleted BEFORE DELETE ON meal_plan_ingredient_snapshot BEGIN SELECT RAISE(ABORT, 'meal_plan_graph_is_immutable'); END;
CREATE TRIGGER meal_plan_allocation_is_immutable BEFORE UPDATE ON meal_plan_allocation BEGIN SELECT RAISE(ABORT, 'meal_plan_graph_is_immutable'); END;
CREATE TRIGGER meal_plan_allocation_is_not_deleted BEFORE DELETE ON meal_plan_allocation BEGIN SELECT RAISE(ABORT, 'meal_plan_graph_is_immutable'); END;
