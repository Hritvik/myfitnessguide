-- Migration number: 0010 	 2026-10-05
-- Curated read views for `query`: nutrition.
--
-- A quantity converts to multiples of its food source's reference amount
-- only when its unit is the reference unit or a measure of that source.
-- Anything else is left NULL (and counted as uncomputed), never guessed.
-- A total that includes an uncomputed line is NULL, not an undercount.
-- Micronutrients, coverage, protein bands, cost and targets are computed by
-- the domain package (day_totals).

CREATE VIEW v_recipe_line AS
WITH f AS (
  SELECT rl.*, fs.name AS food_source_name, fs.kcal AS fs_kcal, fs.protein_g AS fs_protein_g,
         fs.carbs_g AS fs_carbs_g, fs.fat_g AS fs_fat_g,
         CASE WHEN rl.amount_unit = 'measure' THEN rl.amount_value * ms.amount / fs.reference_amount
              WHEN rl.amount_unit = fs.reference_unit THEN rl.amount_value / fs.reference_amount END AS factor
  FROM recipe_line AS rl
  JOIN food_source AS fs ON fs.id = rl.food_source_id
  LEFT JOIN measure AS ms ON ms.id = rl.measure_id
)
SELECT id, recipe_id, position, food_source_id, food_source_name, amount_value, amount_unit, measure_id, link_status, note,
       factor * fs_kcal AS kcal, factor * fs_protein_g AS protein_g, factor * fs_carbs_g AS carbs_g, factor * fs_fat_g AS fat_g
FROM f;

-- Recipes with per-serving macros: manual when flagged, else derived from
-- the lines. derived = 0 marks the manual (not yet derived) ones.
CREATE VIEW v_recipe AS
WITH lines AS (
  SELECT recipe_id, count(*) AS line_count, count(*) - count(kcal) AS uncomputed_lines,
         sum(kcal) AS kcal, sum(protein_g) AS protein_g, sum(carbs_g) AS carbs_g, sum(fat_g) AS fat_g
  FROM v_recipe_line GROUP BY recipe_id
)
SELECT
  r.id, r.ref, r.name, r.kind, r.servings, r.meal_type, r.prep_type, r.source_assumptions,
  1 - r.manual_macros AS derived,
  r.manual_macros_reason,
  coalesce(l.line_count, 0) AS line_count,
  coalesce(l.uncomputed_lines, 0) AS uncomputed_lines,
  CASE WHEN r.manual_macros = 1 THEN r.manual_kcal
       WHEN l.line_count > 0 AND l.uncomputed_lines = 0 THEN l.kcal / r.servings END AS kcal_per_serving,
  CASE WHEN r.manual_macros = 1 THEN r.manual_protein_g
       WHEN l.line_count > 0 AND l.uncomputed_lines = 0 THEN l.protein_g / r.servings END AS protein_g_per_serving,
  CASE WHEN r.manual_macros = 1 THEN r.manual_carbs_g
       WHEN l.line_count > 0 AND l.uncomputed_lines = 0 THEN l.carbs_g / r.servings END AS carbs_g_per_serving,
  CASE WHEN r.manual_macros = 1 THEN r.manual_fat_g
       WHEN l.line_count > 0 AND l.uncomputed_lines = 0 THEN l.fat_g / r.servings END AS fat_g_per_serving
FROM recipe AS r
LEFT JOIN lines AS l ON l.recipe_id = r.id;

CREATE VIEW v_cook_line AS
WITH f AS (
  SELECT cl.*, fs.name AS food_source_name, fs.kcal AS fs_kcal, fs.protein_g AS fs_protein_g,
         fs.carbs_g AS fs_carbs_g, fs.fat_g AS fs_fat_g,
         CASE WHEN cl.amount_unit = 'measure' THEN cl.amount_value * ms.amount / fs.reference_amount
              WHEN cl.amount_unit = fs.reference_unit THEN cl.amount_value / fs.reference_amount END AS factor
  FROM cook_line AS cl
  JOIN food_source AS fs ON fs.id = cl.food_source_id
  LEFT JOIN measure AS ms ON ms.id = cl.measure_id
)
SELECT id, component_id, position, food_source_id, food_source_name, amount_value, amount_unit, measure_id, provenance, note,
       factor * fs_kcal AS kcal, factor * fs_protein_g AS protein_g, factor * fs_carbs_g AS carbs_g, factor * fs_fat_g AS fat_g
FROM f;

-- Components with their whole-component macros and how much of them the
-- portions account for. accounted_fraction is NULL when a weighed portion
-- exists but the cooked weight is unknown. 1 - accounted_fraction, less any
-- disposition, is the unaccounted remainder.
CREATE VIEW v_component AS
WITH lines AS (
  SELECT component_id, count(*) AS line_count, count(*) - count(kcal) AS uncomputed_lines,
         sum(kcal) AS kcal, sum(protein_g) AS protein_g, sum(carbs_g) AS carbs_g, sum(fat_g) AS fat_g
  FROM v_cook_line GROUP BY component_id
),
shares AS (
  SELECT component_id, count(*) AS portion_count,
         coalesce(sum(fraction), 0) AS fraction_sum,
         sum(weighed_g) AS weighed_g_sum
  FROM portion GROUP BY component_id
)
SELECT
  c.id, c.cook_id, k.cooked_on, k.name AS cook_name, k.state AS cook_state, c.position, c.name, c.cooked_weight_g,
  c.cooked_weight_provenance,
  coalesce(l.line_count, 0) AS line_count,
  coalesce(l.uncomputed_lines, 0) AS uncomputed_lines,
  CASE WHEN l.line_count > 0 AND l.uncomputed_lines = 0 THEN l.kcal END AS kcal,
  CASE WHEN l.line_count > 0 AND l.uncomputed_lines = 0 THEN l.protein_g END AS protein_g,
  CASE WHEN l.line_count > 0 AND l.uncomputed_lines = 0 THEN l.carbs_g END AS carbs_g,
  CASE WHEN l.line_count > 0 AND l.uncomputed_lines = 0 THEN l.fat_g END AS fat_g,
  coalesce(s.portion_count, 0) AS portion_count,
  CASE WHEN s.weighed_g_sum IS NULL THEN coalesce(s.fraction_sum, 0)
       WHEN c.cooked_weight_g IS NOT NULL THEN s.fraction_sum + s.weighed_g_sum / c.cooked_weight_g END AS accounted_fraction,
  (SELECT count(*) FROM remainder_disposition AS d WHERE d.component_id = c.id) AS disposition_count
FROM component AS c
JOIN cook AS k ON k.id = c.cook_id
LEFT JOIN lines AS l ON l.component_id = c.id
LEFT JOIN shares AS s ON s.component_id = c.id;

-- Intake items with computed macros, whatever their source.
CREATE VIEW v_intake_item AS
WITH base AS (
  SELECT
    i.*,
    m.name AS member_name,
    CASE i.source_kind
      WHEN 'food_source' THEN
        CASE WHEN i.amount_unit = 'measure' THEN i.amount_value * ms.amount / fs.reference_amount
             WHEN i.amount_unit = fs.reference_unit THEN i.amount_value / fs.reference_amount END
      WHEN 'portion' THEN
        CASE p.kind WHEN 'fraction' THEN p.fraction WHEN 'weighed' THEN p.weighed_g / vc.cooked_weight_g END
      WHEN 'recipe' THEN i.recipe_servings
    END AS factor,
    fs.kcal AS fs_kcal, fs.protein_g AS fs_protein_g, fs.carbs_g AS fs_carbs_g, fs.fat_g AS fs_fat_g,
    vc.kcal AS c_kcal, vc.protein_g AS c_protein_g, vc.carbs_g AS c_carbs_g, vc.fat_g AS c_fat_g,
    vr.kcal_per_serving AS r_kcal, vr.protein_g_per_serving AS r_protein_g,
    vr.carbs_g_per_serving AS r_carbs_g, vr.fat_g_per_serving AS r_fat_g,
    p.component_id, vc.cook_id, p.provenance AS portion_provenance
  FROM intake_item AS i
  JOIN member AS m ON m.id = i.member_id
  LEFT JOIN food_source AS fs ON fs.id = i.food_source_id
  LEFT JOIN measure AS ms ON ms.id = i.measure_id
  LEFT JOIN portion AS p ON p.id = i.portion_id
  LEFT JOIN v_component AS vc ON vc.id = p.component_id
  LEFT JOIN v_recipe AS vr ON vr.id = i.recipe_id
)
SELECT
  id, member_id, member_name, eaten_on, meal_slot, household_meal_id, source_kind, food_source_id, amount_value,
  amount_unit, measure_id, portion_id, component_id, cook_id, recipe_id, recipe_servings, manual_reason,
  coalesce(provenance, portion_provenance) AS provenance, confidence, dominant_uncertainty, dominant_uncertainty_kcal,
  label, note, state,
  CASE source_kind WHEN 'manual' THEN manual_kcal WHEN 'food_source' THEN factor * fs_kcal
                   WHEN 'portion' THEN factor * c_kcal WHEN 'recipe' THEN factor * r_kcal END AS kcal,
  CASE source_kind WHEN 'manual' THEN manual_protein_g WHEN 'food_source' THEN factor * fs_protein_g
                   WHEN 'portion' THEN factor * c_protein_g WHEN 'recipe' THEN factor * r_protein_g END AS protein_g,
  CASE source_kind WHEN 'manual' THEN manual_carbs_g WHEN 'food_source' THEN factor * fs_carbs_g
                   WHEN 'portion' THEN factor * c_carbs_g WHEN 'recipe' THEN factor * r_carbs_g END AS carbs_g,
  CASE source_kind WHEN 'manual' THEN manual_fat_g WHEN 'food_source' THEN factor * fs_fat_g
                   WHEN 'portion' THEN factor * c_fat_g WHEN 'recipe' THEN factor * r_fat_g END AS fat_g
FROM base;

-- A member's day: status (open when never set), item counts, and macro
-- sums. A day with no items uses its legacy manual total, if any. Sums
-- include drafts; draft_items says how many.
CREATE VIEW v_day_intake AS
WITH days AS (
  SELECT member_id, eaten_on AS day FROM intake_item
  UNION
  SELECT member_id, day FROM day_status
),
items AS (
  SELECT member_id, eaten_on AS day, count(*) AS item_count, count(*) - count(kcal) AS uncomputed_items,
         sum(state = 'draft') AS draft_items,
         sum(kcal) AS kcal, sum(protein_g) AS protein_g, sum(carbs_g) AS carbs_g, sum(fat_g) AS fat_g
  FROM v_intake_item GROUP BY member_id, eaten_on
)
SELECT
  d.member_id,
  d.day,
  coalesce(ds.status, 'open') AS status,
  coalesce(i.item_count, 0) AS item_count,
  coalesce(i.draft_items, 0) AS draft_items,
  coalesce(i.uncomputed_items, 0) AS uncomputed_items,
  CASE WHEN i.item_count IS NULL AND ds.manual_total_kcal IS NOT NULL THEN 1 ELSE 0 END AS uses_manual_total,
  CASE WHEN i.item_count IS NULL THEN ds.manual_total_kcal ELSE i.kcal END AS kcal,
  CASE WHEN i.item_count IS NULL THEN ds.manual_total_protein_g ELSE i.protein_g END AS protein_g,
  CASE WHEN i.item_count IS NULL THEN ds.manual_total_carbs_g ELSE i.carbs_g END AS carbs_g,
  CASE WHEN i.item_count IS NULL THEN ds.manual_total_fat_g ELSE i.fat_g END AS fat_g
FROM days AS d
LEFT JOIN items AS i ON i.member_id = d.member_id AND i.day = d.day
LEFT JOIN day_status AS ds ON ds.member_id = d.member_id AND ds.day = d.day;
