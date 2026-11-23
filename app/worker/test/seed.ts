// Catalogue and training reference data, created through the tools where a
// tool exists, so tests exercise the same path the agent does. The API
// allocates refs in creation order: rice dry FS001 ... peas FS006.
import { NOW } from "./db";
import type { Harness } from "./harness";

export async function seedCatalogue(x: Harness) {
  const rice_dry = await x.ok("upsert_food_source", {
    name: "Rice", state: "dry", reference_amount: 100, reference_unit: "g",
    kcal: 360, protein_g: 7, carbs_g: 79, fat_g: 0.6, iron_mg: 0.8, protein_band: "incomplete",
    price_min_inr: 6, price_max_inr: 8,
  });
  const rice_cooked = await x.ok("upsert_food_source", {
    name: "Rice", state: "cooked", reference_amount: 100, reference_unit: "g",
    kcal: 120, protein_g: 2.4, carbs_g: 26.3, fat_g: 0.2, protein_band: "incomplete",
    yields_from: [{ from: "FS001", factor: 3 }],
  });
  const egg = await x.ok("upsert_food_source", {
    name: "Egg", state: "shelled", reference_amount: 100, reference_unit: "g",
    kcal: 143, protein_g: 12.6, carbs_g: 0.7, fat_g: 9.5, b12_ug: 0.9, protein_band: "complete",
    measures: [{ name: "egg", amount: 50 }],
  });
  const curd = await x.ok("upsert_food_source", {
    name: "Curd", state: "as_sold", reference_amount: 100, reference_unit: "g",
    kcal: 60, protein_g: 3.5, carbs_g: 4.7, fat_g: 3.1, calcium_mg: 120, protein_band: "complete",
  });
  const oil = await x.ok("upsert_food_source", {
    name: "Mustard oil", state: "as_sold", reference_amount: 100, reference_unit: "ml",
    kcal: 884, protein_g: 0, carbs_g: 0, fat_g: 100, measures: [{ name: "tsp", amount: 4.5 }],
  });
  const peas = await x.ok("upsert_food_source", {
    name: "Peas", state: "raw", reference_amount: 100, reference_unit: "g",
    kcal: 81, protein_g: 5.4, carbs_g: 14.5, fat_g: 0.4, protein_band: "partial",
  });
  return { rice_dry, rice_cooked, egg, curd, oil, peas };
}

/** Gym, implements with inventories, and exercises with aliases and tags. */
export function seedTraining(x: Harness) {
  const { t, h } = x;
  const gym = t.insert("gym", { household_id: h.id, name: "Cult Koramangala" });
  t.run("UPDATE member SET home_gym_id = ?, week_anchor_date = '2026-07-26' WHERE id = ?", gym, h.hritvik);
  const ashaGym = t.insert("gym", { household_id: h.id, name: "Asha's gym" });
  t.run("UPDATE member SET home_gym_id = ? WHERE id = ?", ashaGym, h.asha);
  const imp = (name: string, kind: string, unit: string, loading: string, loads: number[], complete = 1) => {
    const id = t.insert("implement", { gym_id: gym, name, kind, unit, loading, load_list_complete: complete });
    for (const load of loads) t.insert("implement_load", { implement_id: id, load, unit });
    return id;
  };
  const barbell = imp("Olympic bar and plates", "barbell", "lb", "per_side", [0, 2.5, 5, 7.5, 10, 12.5, 15, 17.5, 20, 25, 30, 35, 45]);
  const dumbbells = imp("Dumbbells", "dumbbell", "kg", "total", [2.5, 5, 7.5, 10, 12.5, 15, 17.5, 20]);
  const stack = imp("Lat pulldown stack", "cable", "kg", "total", [20, 25, 30, 35, 40, 45, 50, 55, 60]);
  const fixedBars = imp("Fixed bars", "fixed_bar", "kg", "total", [10, 15, 20], 0);
  const ex = (name: string, kind: string, aliases: string[] = [], tags: [string, string][] = []) => {
    const id = t.insert("exercise", { household_id: h.id, name, implement_kind: kind });
    for (const alias of aliases) t.insert("alias", { household_id: h.id, alias, kind: "exercise", target_id: id, created_at: NOW });
    for (const [k, tag] of tags) t.insert("exercise_tag", { exercise_id: id, kind: k, tag });
    return id;
  };
  const bench = ex("Barbell bench press", "barbell", ["bench", "flat bench"], [
    ["movement_pattern", "horizontal_push"], ["stimulus", "compound"], ["stimulus", "mid"],
  ]);
  const dbBench = ex("Dumbbell bench press", "dumbbell", ["db bench"], [
    ["movement_pattern", "horizontal_push"], ["stimulus", "compound"], ["stimulus", "mid"],
  ]);
  const pushup = ex("Push-up", "bodyweight", ["pushups"], [
    ["movement_pattern", "horizontal_push"], ["stimulus", "compound"], ["stimulus", "shortened"],
  ]);
  const pulldown = ex("Cable lat pulldown", "cable", ["lat pulldown", "pulldown"], [
    ["movement_pattern", "vertical_pull"], ["stimulus", "compound"], ["stimulus", "lengthened"],
  ]);
  const curl = ex("Dumbbell curl", "dumbbell", ["db curl", "bicep curl"], [["stimulus", "isolation"], ["stimulus", "shortened"]]);
  const calf = ex("Single-leg calf raise", "dumbbell", ["calf raise"]);
  const walk = ex("Treadmill walk", "cardio_machine", ["incline walk"]);
  return { gym, ashaGym, barbell, dumbbells, stack, fixedBars, bench, dbBench, pushup, pulldown, curl, calf, walk };
}
