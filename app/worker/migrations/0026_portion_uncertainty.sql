-- Migration number: 0026 	 2026-10-06
-- A portion's ± : its dominant uncertainty (what it is) and its size in
-- kcal for that member's share, so the pot ask can say "estimated ±35,
-- mostly ladle size". Like provenance (schema decision 31), it lives on the
-- portion, not on the portion's intake item, whose own columns stay NULL.
--
-- Additive: two nullable columns, no table rebuild; every existing portion
-- reads NULL (no size given). The pairing CHECK sits on the second column,
-- so it is checked once both exist.
ALTER TABLE portion ADD COLUMN dominant_uncertainty TEXT
  CHECK (dominant_uncertainty IS NULL OR length(trim(dominant_uncertainty)) > 0);
ALTER TABLE portion ADD COLUMN dominant_uncertainty_kcal REAL
  CHECK ((dominant_uncertainty_kcal IS NULL OR dominant_uncertainty_kcal >= 0)
         AND (dominant_uncertainty IS NULL) = (dominant_uncertainty_kcal IS NULL));

-- v_intake_item as in 0010, with a portion item's ± taken from its portion
-- (as its provenance already is). Views hold no data; v_day_intake reads
-- v_intake_item, so it is dropped first and recreated unchanged.
DROP VIEW v_day_intake;
DROP VIEW v_intake_item;

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
    p.component_id, vc.cook_id, p.provenance AS portion_provenance,
    p.dominant_uncertainty AS portion_uncertainty, p.dominant_uncertainty_kcal AS portion_uncertainty_kcal
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
  coalesce(provenance, portion_provenance) AS provenance, confidence,
  CASE WHEN dominant_uncertainty IS NULL THEN portion_uncertainty ELSE dominant_uncertainty END AS dominant_uncertainty,
  CASE WHEN dominant_uncertainty IS NULL THEN portion_uncertainty_kcal ELSE dominant_uncertainty_kcal END AS dominant_uncertainty_kcal,
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

-- v_day_intake exactly as in 0010.
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
