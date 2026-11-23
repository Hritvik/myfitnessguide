-- Migration number: 0006 	 2026-10-05
-- The household catalogue: food sources, measures, yields, recipes and
-- recipe lines. Lines join food sources by id, never by name.
--
-- Micronutrients: NULL = unknown, 0 = measured zero.
-- A quantity as entered is (amount_value, amount_unit[, measure_id]):
-- 'g' / 'ml' / 'piece' must match the food source's reference unit (checked
-- by the API); 'measure' names one of the source's measures.

CREATE TABLE food_source (
  id                INTEGER PRIMARY KEY,
  household_id      INTEGER NOT NULL REFERENCES household (id),
  -- Stable human key carried over from Sheets (FS001...).
  ref               TEXT    NOT NULL UNIQUE CHECK (length(trim(ref)) > 0),
  name              TEXT    NOT NULL COLLATE NOCASE CHECK (length(trim(name)) > 0),
  -- Each state is a separate source, linked by a yield. Never guessed.
  state             TEXT    NOT NULL CHECK (state IN (
                      'as_sold', 'raw', 'dry', 'cooked', 'soaked', 'drained', 'shelled', 'in_shell')),
  reference_amount  REAL    NOT NULL CHECK (reference_amount > 0),
  reference_unit    TEXT    NOT NULL CHECK (reference_unit IN ('g', 'ml', 'piece')),
  kcal              REAL    NOT NULL CHECK (kcal >= 0),
  protein_g         REAL    NOT NULL CHECK (protein_g >= 0),
  carbs_g           REAL    NOT NULL CHECK (carbs_g >= 0),
  fat_g             REAL    NOT NULL CHECK (fat_g >= 0),
  sodium_mg         REAL    CHECK (sodium_mg >= 0),
  fibre_g           REAL    CHECK (fibre_g >= 0),
  iron_mg           REAL    CHECK (iron_mg >= 0),
  b12_ug            REAL    CHECK (b12_ug >= 0),
  calcium_mg        REAL    CHECK (calcium_mg >= 0),
  magnesium_mg      REAL    CHECK (magnesium_mg >= 0),
  potassium_mg      REAL    CHECK (potassium_mg >= 0),
  sat_fat_g         REAL    CHECK (sat_fat_g >= 0),
  total_sugars_g    REAL    CHECK (total_sugars_g >= 0),
  vitamin_c_mg      REAL    CHECK (vitamin_c_mg >= 0),
  protein_band      TEXT    CHECK (protein_band IN ('complete', 'partial', 'incomplete', 'negligible')),
  protein_quality   TEXT,
  -- Price per reference amount, in INR.
  price_min_inr     REAL    CHECK (price_min_inr >= 0),
  price_max_inr     REAL    CHECK (price_max_inr >= 0),
  primary_category  TEXT,
  tags              TEXT,
  last_checked_on   TEXT    CHECK (date(last_checked_on) IS last_checked_on),
  assumptions       TEXT,
  CHECK ((price_min_inr IS NULL) = (price_max_inr IS NULL)),
  CHECK (price_min_inr IS NULL OR price_min_inr <= price_max_inr),
  UNIQUE (household_id, name, state)
) STRICT;

-- A named unit of one food source (1 tsp, 1 egg shelled), as an amount of
-- its reference unit.
CREATE TABLE measure (
  id              INTEGER PRIMARY KEY,
  food_source_id  INTEGER NOT NULL REFERENCES food_source (id),
  name            TEXT    NOT NULL COLLATE NOCASE CHECK (length(trim(name)) > 0),
  amount          REAL    NOT NULL CHECK (amount > 0),
  UNIQUE (food_source_id, name)
) STRICT;

-- Conversion between two states of the same food: 1 unit of `from` gives
-- factor units of `to`, after discarding discarded_fraction (egg yolks).
CREATE TABLE yield (
  id                   INTEGER PRIMARY KEY,
  from_food_source_id  INTEGER NOT NULL REFERENCES food_source (id),
  to_food_source_id    INTEGER NOT NULL REFERENCES food_source (id),
  factor               REAL    NOT NULL CHECK (factor > 0),
  discarded_fraction   REAL    NOT NULL DEFAULT 0 CHECK (discarded_fraction >= 0 AND discarded_fraction < 1),
  note                 TEXT,
  CHECK (from_food_source_id <> to_food_source_id),
  UNIQUE (from_food_source_id, to_food_source_id)
) STRICT;

-- A reusable template of ingredient lines. kind 'idea' is a meal idea that
-- is never eaten or counted. Manual macros are per serving, carry a reason,
-- and mark the recipe as not derived (R049 and the 35 typed recipes).
CREATE TABLE recipe (
  id                    INTEGER PRIMARY KEY,
  household_id          INTEGER NOT NULL REFERENCES household (id),
  ref                   TEXT    NOT NULL UNIQUE CHECK (length(trim(ref)) > 0),
  name                  TEXT    NOT NULL COLLATE NOCASE CHECK (length(trim(name)) > 0),
  kind                  TEXT    NOT NULL CHECK (kind IN ('dish', 'idea')),
  -- How many servings the lines make.
  servings              REAL    NOT NULL DEFAULT 1 CHECK (servings > 0),
  meal_type             TEXT,
  prep_type             TEXT,
  method                TEXT,
  source_assumptions    TEXT,
  manual_macros         INTEGER NOT NULL DEFAULT 0 CHECK (manual_macros IN (0, 1)),
  manual_kcal           REAL    CHECK (manual_kcal >= 0),
  manual_protein_g      REAL    CHECK (manual_protein_g >= 0),
  manual_carbs_g        REAL    CHECK (manual_carbs_g >= 0),
  manual_fat_g          REAL    CHECK (manual_fat_g >= 0),
  manual_macros_reason  TEXT    CHECK (length(trim(manual_macros_reason)) > 0),
  CHECK (manual_macros = (manual_kcal IS NOT NULL)),
  CHECK (manual_macros = (manual_protein_g IS NOT NULL)),
  CHECK (manual_macros = (manual_carbs_g IS NOT NULL)),
  CHECK (manual_macros = (manual_fat_g IS NOT NULL)),
  CHECK (manual_macros = (manual_macros_reason IS NOT NULL)),
  -- Recipe dedupe: one name per household.
  UNIQUE (household_id, name)
) STRICT;

CREATE TABLE recipe_line (
  id              INTEGER PRIMARY KEY,
  recipe_id       INTEGER NOT NULL REFERENCES recipe (id),
  position        INTEGER NOT NULL CHECK (position >= 1),
  food_source_id  INTEGER NOT NULL REFERENCES food_source (id),
  amount_value    REAL    NOT NULL CHECK (amount_value > 0),
  amount_unit     TEXT    NOT NULL CHECK (amount_unit IN ('g', 'ml', 'piece', 'measure')),
  measure_id      INTEGER REFERENCES measure (id),
  link_status     TEXT    CHECK (link_status IN ('confirmed', 'assumed')),
  note            TEXT,
  CHECK ((amount_unit = 'measure') = (measure_id IS NOT NULL)),
  UNIQUE (recipe_id, position)
) STRICT;
