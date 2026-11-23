// Food Sources and Recipes -> the household catalogue, through
// upsert_food_source and upsert_recipe.
import { describe, expect, it } from "vitest";
import { rehearse } from "../src/rehearse";
import { basePeople, f, food, FOOD_HEADER, line, members, recipe, RECIPES_HEADER, RI_HEADER, snapshot } from "./fixture";

const foods = [
  FOOD_HEADER,
  food({ ref: "FS001", name: "Test whey", serving: "1 scoop (30 g)", kcal: 120, protein: 24, carbs: 3, fat: 1, priceMin: f("=ROUND(3000/30,2)", 100), priceMax: 120 }),
  food({ ref: "FS002", name: "Test oats", serving: "100 g dry", kcal: 380, protein: 13, carbs: 68, fat: 6.5, category: "Carb", sodium: 2 }),
  food({ ref: "FS003", name: "Whole egg", serving: "1 large egg", kcal: 70, protein: 6, carbs: 0.5, fat: 5 }),
  food({ ref: "FS004", name: "Test rice, cooked", serving: "100 g", kcal: 130, protein: 2.7, carbs: 28, fat: 0.3, category: "Carb" }),
  food({ ref: "FS005", name: "Test burrito bowl", serving: "1 bowl", kcal: "279", protein: "4.4", carbs: "28.1", fat: "18.4", category: "Mixed meal" }),
  food({ ref: "FS006", name: "Puffed test rice", serving: "100 g", kcal: 400, protein: 6, carbs: 90, fat: 0.5, category: "Carb" }),
  food({ ref: "FS007", name: "Test milk", serving: "250 mL", kcal: 88, protein: 8.5, carbs: 12.5, fat: 0.3 }),
];

const base = (extra: Record<string, unknown[][]> = {}) => ({ base: { People: basePeople(), "Food Sources": foods, ...extra } as never });

describe("food sources", () => {
  it("maps each serving to a typed reference amount, a state and a measure", async () => {
    const r = await rehearse({ snapshot: snapshot(base()), members: members() });
    expect(r.db.all("SELECT ref, state, reference_amount, reference_unit, kcal, price_min_inr, price_max_inr FROM food_source ORDER BY ref")).toEqual([
      { ref: "FS001", state: "as_sold", reference_amount: 30, reference_unit: "g", kcal: 120, price_min_inr: 100, price_max_inr: 120 },
      { ref: "FS002", state: "dry", reference_amount: 100, reference_unit: "g", kcal: 380, price_min_inr: null, price_max_inr: null },
      { ref: "FS003", state: "shelled", reference_amount: 1, reference_unit: "piece", kcal: 70, price_min_inr: null, price_max_inr: null },
      { ref: "FS004", state: "cooked", reference_amount: 100, reference_unit: "g", kcal: 130, price_min_inr: null, price_max_inr: null },
      { ref: "FS005", state: "as_sold", reference_amount: 1, reference_unit: "piece", kcal: 279, price_min_inr: null, price_max_inr: null },
      { ref: "FS006", state: "as_sold", reference_amount: 100, reference_unit: "g", kcal: 400, price_min_inr: null, price_max_inr: null },
      { ref: "FS007", state: "as_sold", reference_amount: 250, reference_unit: "ml", kcal: 88, price_min_inr: null, price_max_inr: null },
    ]);
    expect(r.db.all("SELECT m.name, m.amount FROM measure m")).toEqual([{ name: "scoop", amount: 30 }]);
    expect(r.db.get("SELECT sodium_mg, iron_mg FROM food_source WHERE ref = 'FS002'")).toEqual({ sodium_mg: 2, iron_mg: null });
  });

  it("records numbers stored as text as mechanical, and an unclear staple's state as semantic", async () => {
    const r = await rehearse({ snapshot: snapshot(base()), members: members() });
    expect(r.rulings.find((x) => x.id === "base/Food Sources!6/stored_as_text")).toMatchObject({ kind: "mechanical", decision: "accepted" });
    expect(r.rulings.find((x) => x.id === "base/Food Sources!7/unclear_food_state")).toMatchObject({ kind: "semantic", decision: "pending", proposal: "as_sold" });
    expect(r.rulings.filter((x) => x.code === "unclear_food_state")).toHaveLength(1);
  });

  it("applies an override decided in rulings.yaml", async () => {
    const first = await rehearse({ snapshot: snapshot(base()), members: members() });
    const decided = first.rulings.map((x) => (x.code === "unclear_food_state" ? { ...x, decision: "accepted" as const, decided_by: "Hritvik", override: "dry" } : x));
    const second = await rehearse({ snapshot: snapshot(base()), members: members(), previousRulings: decided });
    expect(second.db.get("SELECT state FROM food_source WHERE ref = 'FS006'")).toEqual({ state: "dry" });
    expect(second.rulings.find((x) => x.code === "unclear_food_state")).toMatchObject({ decision: "accepted", decided_by: "Hritvik", override: "dry" });
  });
});

describe("food sources: the label energy check", () => {
  // 4 x 10 + 4 x 10 + 9 x 0 = 80 kcal of macros against 300 stated: a macro is missing.
  const odd = food({ ref: "FS008", name: "Test bar", serving: "1 bar", kcal: 300, protein: 10, carbs: 10, fat: 0 });
  const withOdd = () => ({ base: { People: basePeople(), "Food Sources": [...foods, odd] } as never });

  it("a source whose macros don't reconcile is a semantic ruling, imported as typed (with the override reason) while pending", async () => {
    const r = await rehearse({ snapshot: snapshot(withOdd()), members: members() });
    const ruling = r.rulings.find((x) => x.id === "base/Food Sources!9/label_energy_mismatch");
    expect(ruling).toMatchObject({ kind: "semantic", decision: "pending" });
    expect(ruling?.problem).toMatch(/80 kcal/);
    const row = r.db.get<{ kcal: number; energy_override_reason: string }>("SELECT kcal, energy_override_reason FROM food_source WHERE ref = 'FS008'");
    expect(row?.kcal).toBe(300);
    expect(row?.energy_override_reason).toMatch(/imported as typed/i);
    expect(r.rulings.filter((x) => x.code === "label_energy_mismatch")).toHaveLength(1);
  });

  it("a rejected ruling leaves the source out", async () => {
    const first = await rehearse({ snapshot: snapshot(withOdd()), members: members() });
    const decided = first.rulings.map((x) => (x.code === "label_energy_mismatch" ? { ...x, decision: "rejected" as const, decided_by: "Hritvik" } : x));
    const second = await rehearse({ snapshot: snapshot(withOdd()), members: members(), previousRulings: decided });
    expect(second.db.get("SELECT count(*) AS n FROM food_source WHERE ref = 'FS008'")).toEqual({ n: 0 });
  });
});

describe("recipes", () => {
  const recipes = [
    RECIPES_HEADER,
    recipe({ ref: "R001", name: "Idea bowl", macros: [500, 30, 60, 10], derivation: "stored", kind: "meal plan" }),
    recipe({ ref: "R002", name: "Oat whey bowl", macros: [f("=SUMIF(...)", 310), f("=SUMIF(...)", 30.5), f("=SUMIF(...)", 37), f("=SUMIF(...)", 4.25)], derivation: "derived" }),
    recipe({ ref: "R003", name: "Stored curry", macros: [250, 8, 20, 15], derivation: "stored" }),
  ];
  const lines = [RI_HEADER, line("Oat whey bowl", "FS002", 0.5, "R002"), line("Oat whey bowl", "FS001", 1, "R002"), line("Stored curry", "FS999", 1, "R003")];

  it("derives recipes from their lines by ref, keeps stored ones as manual macros, and meal plans as ideas", async () => {
    const r = await rehearse({ snapshot: snapshot(base({ Recipes: recipes, "Recipe Ingredients": lines })), members: members() });
    expect(r.db.all("SELECT ref, kind, derived, line_count, kcal_per_serving, protein_g_per_serving FROM v_recipe ORDER BY ref")).toEqual([
      { ref: "R001", kind: "idea", derived: 0, line_count: 0, kcal_per_serving: 500, protein_g_per_serving: 30 },
      { ref: "R002", kind: "dish", derived: 1, line_count: 2, kcal_per_serving: 310, protein_g_per_serving: 30.5 },
      { ref: "R003", kind: "dish", derived: 0, line_count: 0, kcal_per_serving: 250, protein_g_per_serving: 8 },
    ]);
    expect(r.db.all("SELECT amount_value, amount_unit FROM recipe_line ORDER BY position")).toEqual([
      { amount_value: 50, amount_unit: "g" },
      { amount_value: 30, amount_unit: "g" },
    ]);
    expect(r.rulings.find((x) => x.id === "base/Recipe Ingredients!4/unknown_food")).toMatchObject({ kind: "semantic", proposal: null });
  });
});
