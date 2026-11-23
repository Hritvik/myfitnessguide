-- Migration number: 0007 	 2026-10-05
-- Cooks, components, cook lines, portions, remainder dispositions, household
-- meals, intake items, day status and skipped meals.
--
-- Provenance attaches to every quantity: each cook line, each portion share,
-- each direct intake amount. A portion stores only its share; every eater's
-- macros are recomputed from the cook.

CREATE TABLE household_meal (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household (id),
  eaten_on      TEXT    NOT NULL CHECK (date(eaten_on) IS eaten_on),
  meal_slot     TEXT    NOT NULL CHECK (meal_slot IN ('breakfast', 'lunch', 'dinner', 'snack', 'pre_workout', 'post_workout')),
  note          TEXT,
  state         TEXT    NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'confirmed')),
  confirmed_at  TEXT    CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', confirmed_at) IS confirmed_at),
  CHECK ((state = 'confirmed') = (confirmed_at IS NOT NULL))
) STRICT;

-- One real preparation of food on a date, optionally from a recipe.
CREATE TABLE cook (
  id            INTEGER PRIMARY KEY,
  household_id  INTEGER NOT NULL REFERENCES household (id),
  cooked_on     TEXT    NOT NULL CHECK (date(cooked_on) IS cooked_on),
  recipe_id     INTEGER REFERENCES recipe (id),
  name          TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  note          TEXT,
  state         TEXT    NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'confirmed')),
  confirmed_at  TEXT    CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', confirmed_at) IS confirmed_at),
  CHECK ((state = 'confirmed') = (confirmed_at IS NOT NULL))
) STRICT;

CREATE TABLE household_meal_cook (
  household_meal_id  INTEGER NOT NULL REFERENCES household_meal (id),
  cook_id            INTEGER NOT NULL REFERENCES cook (id),
  PRIMARY KEY (household_meal_id, cook_id)
) STRICT;

-- A separately shared part of a cook. Every cook has at least one (the API
-- creates a single 'whole' component when none is named). The cooked
-- weight, when known, is per component.
CREATE TABLE component (
  id                        INTEGER PRIMARY KEY,
  cook_id                   INTEGER NOT NULL REFERENCES cook (id),
  position                  INTEGER NOT NULL CHECK (position >= 1),
  name                      TEXT    NOT NULL COLLATE NOCASE CHECK (length(trim(name)) > 0),
  cooked_weight_g           REAL    CHECK (cooked_weight_g > 0),
  cooked_weight_provenance  TEXT    CHECK (cooked_weight_provenance IN (
                              'weighed', 'counted', 'label', 'estimated', 'inferred', 'reconstructed')),
  CHECK ((cooked_weight_g IS NULL) = (cooked_weight_provenance IS NULL)),
  UNIQUE (cook_id, name),
  UNIQUE (cook_id, position)
) STRICT;

CREATE TABLE cook_line (
  id              INTEGER PRIMARY KEY,
  component_id    INTEGER NOT NULL REFERENCES component (id),
  position        INTEGER NOT NULL CHECK (position >= 1),
  food_source_id  INTEGER NOT NULL REFERENCES food_source (id),
  amount_value    REAL    NOT NULL CHECK (amount_value > 0),
  amount_unit     TEXT    NOT NULL CHECK (amount_unit IN ('g', 'ml', 'piece', 'measure')),
  measure_id      INTEGER REFERENCES measure (id),
  provenance      TEXT    NOT NULL CHECK (provenance IN (
                    'weighed', 'counted', 'label', 'estimated', 'inferred', 'reconstructed')),
  note            TEXT,
  CHECK ((amount_unit = 'measure') = (measure_id IS NOT NULL)),
  UNIQUE (component_id, position)
) STRICT;

-- One member's share of one component. A member who wasn't there has no
-- row; a fraction of 0 is a real portion of nothing.
CREATE TABLE portion (
  id            INTEGER PRIMARY KEY,
  component_id  INTEGER NOT NULL REFERENCES component (id),
  member_id     INTEGER NOT NULL REFERENCES member (id),
  kind          TEXT    NOT NULL CHECK (kind IN ('fraction', 'weighed')),
  fraction      REAL    CHECK (fraction >= 0 AND fraction <= 1),
  weighed_g     REAL    CHECK (weighed_g >= 0),
  provenance    TEXT    NOT NULL CHECK (provenance IN (
                  'weighed', 'counted', 'label', 'estimated', 'inferred', 'reconstructed')),
  state         TEXT    NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'confirmed')),
  confirmed_at  TEXT    CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', confirmed_at) IS confirmed_at),
  CHECK ((kind = 'fraction') = (fraction IS NOT NULL)),
  CHECK ((kind = 'weighed') = (weighed_g IS NOT NULL)),
  CHECK ((state = 'confirmed') = (confirmed_at IS NOT NULL)),
  UNIQUE (component_id, member_id)
) STRICT;

-- What happened to the part of a component no portion accounts for. Until a
-- row exists, the remainder is shown as unaccounted. "Eaten by someone" is a
-- new portion, not a disposition. amount_kind 'rest' = whatever is left.
CREATE TABLE remainder_disposition (
  id            INTEGER PRIMARY KEY,
  component_id  INTEGER NOT NULL REFERENCES component (id),
  disposition   TEXT    NOT NULL CHECK (disposition IN ('leftover', 'discarded')),
  amount_kind   TEXT    NOT NULL CHECK (amount_kind IN ('rest', 'fraction', 'weighed')),
  fraction      REAL    CHECK (fraction > 0 AND fraction <= 1),
  weighed_g     REAL    CHECK (weighed_g > 0),
  recorded_on   TEXT    NOT NULL CHECK (date(recorded_on) IS recorded_on),
  provenance    TEXT    NOT NULL CHECK (provenance IN (
                  'weighed', 'counted', 'label', 'estimated', 'inferred', 'reconstructed')),
  note          TEXT,
  CHECK ((amount_kind = 'fraction') = (fraction IS NOT NULL)),
  CHECK ((amount_kind = 'weighed') = (weighed_g IS NOT NULL))
) STRICT;

-- One thing a member ate: a food source with an amount, a portion, a recipe
-- by servings (legacy R refs), or manual macros with a reason.
CREATE TABLE intake_item (
  id                         INTEGER PRIMARY KEY,
  member_id                  INTEGER NOT NULL REFERENCES member (id),
  eaten_on                   TEXT    NOT NULL CHECK (date(eaten_on) IS eaten_on),
  meal_slot                  TEXT    NOT NULL CHECK (meal_slot IN ('breakfast', 'lunch', 'dinner', 'snack', 'pre_workout', 'post_workout')),
  household_meal_id          INTEGER REFERENCES household_meal (id),
  source_kind                TEXT    NOT NULL CHECK (source_kind IN ('food_source', 'portion', 'recipe', 'manual')),
  food_source_id             INTEGER REFERENCES food_source (id),
  amount_value               REAL    CHECK (amount_value > 0),
  amount_unit                TEXT    CHECK (amount_unit IN ('g', 'ml', 'piece', 'measure')),
  measure_id                 INTEGER REFERENCES measure (id),
  portion_id                 INTEGER UNIQUE REFERENCES portion (id),
  recipe_id                  INTEGER REFERENCES recipe (id),
  recipe_servings            REAL    CHECK (recipe_servings > 0),
  manual_kcal                REAL    CHECK (manual_kcal >= 0),
  manual_protein_g           REAL    CHECK (manual_protein_g >= 0),
  manual_carbs_g             REAL    CHECK (manual_carbs_g >= 0),
  manual_fat_g               REAL    CHECK (manual_fat_g >= 0),
  manual_reason              TEXT    CHECK (length(trim(manual_reason)) > 0),
  -- On the portion for a portion item; required on every other item.
  provenance                 TEXT    CHECK (provenance IN (
                               'weighed', 'counted', 'label', 'estimated', 'inferred', 'reconstructed')),
  confidence                 TEXT    NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  dominant_uncertainty       TEXT    CHECK (length(trim(dominant_uncertainty)) > 0),
  dominant_uncertainty_kcal  REAL    CHECK (dominant_uncertainty_kcal >= 0),
  -- The item as the member said it ("2 medium").
  label                      TEXT,
  note                       TEXT,
  state                      TEXT    NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'confirmed')),
  confirmed_at               TEXT    CHECK (strftime('%Y-%m-%dT%H:%M:%SZ', confirmed_at) IS confirmed_at),
  CHECK ((source_kind = 'food_source') = (food_source_id IS NOT NULL)),
  CHECK ((food_source_id IS NULL) = (amount_value IS NULL)),
  CHECK ((food_source_id IS NULL) = (amount_unit IS NULL)),
  CHECK ((coalesce(amount_unit, '') = 'measure') = (measure_id IS NOT NULL)),
  CHECK ((source_kind = 'portion') = (portion_id IS NOT NULL)),
  CHECK ((source_kind = 'recipe') = (recipe_id IS NOT NULL)),
  CHECK ((recipe_id IS NULL) = (recipe_servings IS NULL)),
  CHECK ((source_kind = 'manual') = (manual_kcal IS NOT NULL)),
  CHECK ((source_kind = 'manual') = (manual_protein_g IS NOT NULL)),
  CHECK ((source_kind = 'manual') = (manual_carbs_g IS NOT NULL)),
  CHECK ((source_kind = 'manual') = (manual_fat_g IS NOT NULL)),
  CHECK ((source_kind = 'manual') = (manual_reason IS NOT NULL)),
  CHECK ((source_kind = 'portion') = (provenance IS NULL)),
  CHECK ((dominant_uncertainty IS NULL) = (dominant_uncertainty_kcal IS NULL)),
  CHECK ((state = 'confirmed') = (confirmed_at IS NOT NULL))
) STRICT;

CREATE INDEX intake_item_by_day ON intake_item (member_id, eaten_on);

-- Whether a member's day of intake is open, complete or partial. The legacy
-- DAY TOTAL rows become a day-level manual total, used only on days with no
-- items (a day with both goes to an import ruling).
CREATE TABLE day_status (
  member_id               INTEGER NOT NULL REFERENCES member (id),
  day                     TEXT    NOT NULL CHECK (date(day) IS day),
  status                  TEXT    NOT NULL CHECK (status IN ('open', 'complete', 'partial')),
  manual_total_kcal       REAL    CHECK (manual_total_kcal >= 0),
  manual_total_protein_g  REAL    CHECK (manual_total_protein_g >= 0),
  manual_total_carbs_g    REAL    CHECK (manual_total_carbs_g >= 0),
  manual_total_fat_g      REAL    CHECK (manual_total_fat_g >= 0),
  manual_total_reason     TEXT    CHECK (length(trim(manual_total_reason)) > 0),
  CHECK ((manual_total_kcal IS NULL) = (manual_total_protein_g IS NULL)),
  CHECK ((manual_total_kcal IS NULL) = (manual_total_carbs_g IS NULL)),
  CHECK ((manual_total_kcal IS NULL) = (manual_total_fat_g IS NULL)),
  CHECK ((manual_total_kcal IS NULL) = (manual_total_reason IS NULL)),
  PRIMARY KEY (member_id, day)
) STRICT;

CREATE TABLE skipped_meal (
  member_id  INTEGER NOT NULL REFERENCES member (id),
  day        TEXT    NOT NULL CHECK (date(day) IS day),
  meal_slot  TEXT    NOT NULL CHECK (meal_slot IN ('breakfast', 'lunch', 'dinner', 'snack', 'pre_workout', 'post_workout')),
  PRIMARY KEY (member_id, day, meal_slot)
) STRICT;
