-- Migration number: 0037     2026-10-27
-- Set corrections and compound sets (session 48, 26 Oct 2026).
--
-- A set is one logical effort, which may have several physical segments
-- (a drop set, a rest-pause cluster). `segments` holds them; the row's own
-- load/reps stay the opening segment, so every existing reader, constraint
-- and view keeps working for a simple set and still sees something true
-- for a compound one. `structure` names the shape, and `rir_scope` says
-- whether the RIR belongs to the whole set or to one segment.
--
-- A carry may be recorded per side (`sides`), with `distance_basis` saying
-- whether `distance_value` is the total or the distance each side covered.
--
-- `version` is the optimistic-concurrency precondition for update_set: a
-- correction names the version it read, and a stale one is refused instead
-- of overwriting someone else's change.
--
-- Nothing existing is rewritten: every new column is NULL or its default
-- on the rows already stored.

ALTER TABLE session_set ADD COLUMN structure TEXT NOT NULL DEFAULT 'simple'
  CHECK (structure IN ('simple', 'drop_set', 'rest_pause', 'superset', 'cluster'));

-- The physical segments, in order: [{sequence, load:{value,unit,basis?,plates?}, reps, rir?}].
-- At least two: one segment is a simple set, which stores no segments.
ALTER TABLE session_set ADD COLUMN segments TEXT
  CHECK (segments IS NULL OR (json_valid(segments) AND json_type(segments) = 'array' AND json_array_length(segments) > 1));

ALTER TABLE session_set ADD COLUMN rir_scope TEXT
  CHECK (rir_scope IS NULL OR rir_scope IN ('segment', 'complete_set'));

-- A loaded carry: how it was held. NULL for everything that is not a carry.
ALTER TABLE session_set ADD COLUMN carry_type TEXT
  CHECK (carry_type IS NULL OR carry_type IN ('farmer', 'suitcase', 'front_rack', 'other'));

-- A per-side performance: [{side:'left'|'right', distance_m?, reps?, duration_s?}].
ALTER TABLE session_set ADD COLUMN sides TEXT
  CHECK (sides IS NULL OR (json_valid(sides) AND json_type(sides) = 'array' AND json_array_length(sides) > 0));

ALTER TABLE session_set ADD COLUMN distance_basis TEXT
  CHECK (distance_basis IS NULL OR distance_basis IN ('total', 'per_side'));

ALTER TABLE session_set ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);

-- Why a set is still a draft, so a stale draft can be found and re-checked
-- instead of staying invisible: an off-list load (the usual case), RIR still
-- missing, the member's review pending, or a bulk report to confirm.
ALTER TABLE session_set ADD COLUMN draft_reason TEXT
  CHECK (draft_reason IS NULL OR draft_reason IN ('off_list', 'rir_needed', 'awaiting_member', 'review'));

-- The household's other words for an implement ("plates" at a gym whose
-- rack is a plate-loaded leg press, "the 35s" for a dumbbell rack). They
-- live in the one alias store, so one word still means one thing across
-- every kind; `learn_alias` and `forget_alias` already version the change.
-- SQLite cannot widen a CHECK in place, so the table is rebuilt with the
-- same ids and rows, then its index is recreated. v_exercise reads the
-- store, so it is dropped and recreated around the rebuild.
DROP VIEW v_exercise;

CREATE TABLE alias_new (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household (id),
  alias         TEXT    NOT NULL COLLATE NOCASE CHECK (length(trim(alias)) > 0 AND alias = trim(alias)),
  kind          TEXT    NOT NULL CHECK (kind IN ('food_source', 'recipe', 'exercise', 'workout', 'implement')),
  target_id     INTEGER NOT NULL,
  created_by    INTEGER REFERENCES member (id),
  created_at    TEXT    NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', created_at) IS created_at),
  UNIQUE (household_id, alias)
) STRICT;

INSERT INTO alias_new (id, household_id, alias, kind, target_id, created_by, created_at)
SELECT id, household_id, alias, kind, target_id, created_by, created_at FROM alias;

DROP TABLE alias;
ALTER TABLE alias_new RENAME TO alias;
CREATE INDEX alias_by_target ON alias (kind, target_id);

-- v_exercise as in 0030, unchanged: its aliases from the alias store.
CREATE VIEW v_exercise AS
SELECT
  e.id, e.name, e.implement_kind, e.note,
  (SELECT group_concat(alias, ', ') FROM (SELECT alias FROM alias WHERE kind = 'exercise' AND target_id = e.id ORDER BY alias)) AS aliases,
  (SELECT group_concat(tag, ', ') FROM (SELECT tag FROM exercise_tag WHERE exercise_id = e.id AND kind = 'movement_pattern' ORDER BY tag))
    AS movement_patterns,
  (SELECT group_concat(tag, ', ') FROM (SELECT tag FROM exercise_tag WHERE exercise_id = e.id AND kind = 'stimulus' ORDER BY tag))
    AS stimulus_tags
FROM exercise AS e;

DROP VIEW v_set;

-- v_set as in 0033, with the compound-set and carry columns appended, and
-- volume summed across a compound set's segments instead of counting only
-- the opening one. A simple set computes exactly as before.
CREATE VIEW v_set AS
WITH loaded AS (
  SELECT
    st.*,
    coalesce(im.kind, ex.implement_kind) AS implement_kind,
    im.loading AS implement_loading,
    ex.bodyweight_dominant AS load_bodyweight_dominant,
    CASE st.load_basis
      WHEN 'total' THEN st.load_value * (CASE st.load_unit WHEN 'lb' THEN 0.45359237 ELSE 1.0 END)
      WHEN 'per_side' THEN 2 * coalesce(
                             (SELECT sum(json_extract(p.value, '$.count') * json_extract(p.value, '$.value')
                                         * (CASE json_extract(p.value, '$.unit') WHEN 'lb' THEN 0.45359237 ELSE 1.0 END))
                              FROM json_each(st.plates) AS p),
                             st.load_value * (CASE st.load_unit WHEN 'lb' THEN 0.45359237 ELSE 1.0 END))
                           + coalesce(st.bar_value * (CASE st.bar_unit WHEN 'lb' THEN 0.45359237 ELSE 1.0 END), 0)
      WHEN 'per_hand' THEN (CASE st.unilateral WHEN 1 THEN 1 ELSE 2 END) * st.load_value
                           * (CASE st.load_unit WHEN 'lb' THEN 0.45359237 ELSE 1.0 END)
      WHEN 'per_leg' THEN (CASE st.unilateral WHEN 1 THEN 1 ELSE 2 END) * st.load_value
                          * (CASE st.load_unit WHEN 'lb' THEN 0.45359237 ELSE 1.0 END)
    END AS total_load_kg,
    CASE
      WHEN st.load_basis IN ('per_hand', 'per_leg') AND st.unilateral = 0 THEN 2
      WHEN st.load_basis = 'per_side' AND coalesce(im.kind, ex.implement_kind) = 'cable' THEN 2
      ELSE 1
    END AS implements_sharing
  FROM session_set AS st
  JOIN exercise AS ex ON ex.id = st.exercise_id
  LEFT JOIN implement AS im ON im.id = st.load_implement_id
), derived AS (
  SELECT
    l.*,
    CASE
      WHEN l.total_load_kg IS NULL OR l.total_load_kg <= 0 OR l.load_bodyweight_dominant = 1 OR l.implement_loading = 'plates_only' THEN 0
      ELSE 1
    END AS comparable,
    -- Every segment's load in kg, by its own basis (the set's when it has none).
    CASE WHEN l.segments IS NULL THEN NULL ELSE (
      SELECT sum(
               json_extract(s.value, '$.load.value')
               * (CASE coalesce(json_extract(s.value, '$.load.unit'), l.load_unit) WHEN 'lb' THEN 0.45359237 ELSE 1.0 END)
               * (CASE coalesce(json_extract(s.value, '$.load.basis'), l.load_basis)
                    WHEN 'per_side' THEN 2
                    WHEN 'per_hand' THEN (CASE l.unilateral WHEN 1 THEN 1 ELSE 2 END)
                    WHEN 'per_leg' THEN (CASE l.unilateral WHEN 1 THEN 1 ELSE 2 END)
                    ELSE 1 END)
               * coalesce(json_extract(s.value, '$.reps'), 0)
             )
      FROM json_each(l.segments) AS s
    ) END AS segments_volume_kg,
    CASE WHEN l.segments IS NULL THEN NULL ELSE (
      SELECT sum(json_extract(s.value, '$.reps')) FROM json_each(l.segments) AS s
    ) END AS segments_reps
  FROM loaded AS l
)
SELECT
  l.id,
  l.session_id,
  se.member_id,
  se.performed_on,
  se.state AS session_state,
  l.exercise_id,
  ex.name AS exercise_name,
  ex.bodyweight_dominant,
  l.implement_kind,
  l.set_number,
  l.position,
  l.set_type,
  l.prescription_id,
  l.substituted_prescription_id,
  l.reps,
  l.reps_inferred,
  l.load_status,
  l.load_value,
  l.load_unit,
  l.load_basis,
  l.unilateral,
  l.load_implement_id,
  l.bar_value,
  l.bar_unit,
  l.plates,
  l.rir_status,
  l.rir_low,
  l.rir_high,
  l.duration_s,
  l.distance_value,
  l.distance_unit,
  l.steps,
  l.state,
  l.total_load_kg,
  l.implements_sharing,
  CASE WHEN l.segments_volume_kg IS NOT NULL THEN l.segments_volume_kg
       WHEN l.total_load_kg > 0 AND l.reps IS NOT NULL THEN l.total_load_kg * l.reps END AS volume_kg,
  CASE WHEN l.total_load_kg > 0 AND l.rir_status = 'recorded' AND l.rir_high = 0 AND l.reps BETWEEN 1 AND 12
            AND ex.bodyweight_dominant = 0
       THEN (l.total_load_kg / l.implements_sharing) * (1 + l.reps / 30.0) END AS e1rm_kg,
  CASE WHEN l.comparable = 1 AND l.rir_status = 'recorded' AND l.reps >= 1
            AND l.reps + l.rir_low <= 12
       THEN (l.total_load_kg / l.implements_sharing) * (1 + (l.reps + l.rir_low) / 30.0) END AS e1rm_rir_kg,
  l.comparable,
  l.structure,
  l.segments,
  l.rir_scope,
  l.carry_type,
  l.sides,
  l.distance_basis,
  l.version,
  l.draft_reason,
  coalesce(l.segments_reps, l.reps) AS total_reps
FROM derived AS l
JOIN session AS se ON se.id = l.session_id
JOIN exercise AS ex ON ex.id = l.exercise_id;
