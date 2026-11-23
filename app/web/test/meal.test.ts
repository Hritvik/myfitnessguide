import { describe, expect, it } from "vitest";
import { referenceChip } from "../src/food";
import { afterSave, needsCookedWeight, newLine, blankMeal, fromRecipe, mealInput, mealPlan, previewLines, recipeChanges, type MealDraft } from "../src/meal";
import { plainQuestion } from "../src/writes";
import type { FoodSourceDetail, PreviewMeal, RecipeDetail } from "../src/types";

const recipe: RecipeDetail = {
  id: 3, ref: "R003", name: "Rajma", kind: "dish", servings: 4,
  lines: [
    { id: 31, position: 1, ref: "FS020", name: "Rajma", state: "soaked", amount_value: 250, amount_unit: "g", measure: null },
    { id: 32, position: 2, ref: "FS005", name: "Mustard oil", state: "as_sold", amount_value: 2, amount_unit: "measure", measure: "tsp" },
  ],
};

const eaten = (d: MealDraft): MealDraft => ({ ...d, eaters: { Asha: { mode: "percent", value: "40" }, Kabir: { mode: "grams", value: "250" } } });

describe("the household meal", () => {
  it("leaves an unselected member out: absent, not a portion of 0", () => {
    const out = mealInput(eaten(fromRecipe(recipe)), "2026-10-06", "dinner");
    expect(out).toEqual({
      input: {
        date: "2026-10-06", meal_slot: "dinner",
        cooks: [{
          name: "Rajma", recipe: "R003",
          portions: [{ member: "Asha", fraction: 0.4, provenance: "estimated" }, { member: "Kabir", weighed_g: 250, provenance: "estimated" }],
        }],
      },
    });
  });

  it("sends every line once a line changes, edited ones as estimated and the others as inferred", () => {
    const d = eaten(fromRecipe(recipe));
    d.lines[0] = { ...(d.lines[0] as MealDraft["lines"][number]), value: "300", edited: true };
    const out = mealInput(d, "2026-10-06", "dinner") as { input: { cooks: { lines: unknown[] }[] } };
    expect(out.input.cooks[0]?.lines).toEqual([
      { food: "FS020", value: 300, unit: "g", provenance: "estimated" },
      { food: "FS005", value: 2, measure: "tsp", provenance: "inferred" },
    ]);
  });

  it("asks who ate, and for each share", () => {
    expect(mealInput(fromRecipe(recipe), "2026-10-06", "dinner")).toEqual({ error: "Choose who ate, and how much." });
    expect(mealInput({ ...fromRecipe(recipe), eaters: { Asha: { mode: "percent", value: "" } } }, "2026-10-06", "dinner")).toEqual({ error: "Enter Asha's share." });
    expect(mealInput({ ...blankMeal(), eaters: { Asha: { mode: "percent", value: "50" } } }, "2026-10-06", "dinner")).toEqual({ error: "Name the dish." });
  });
});

describe("a share in grams", () => {
  const cookOf = (d: MealDraft) => (mealInput(d, "2026-10-06", "dinner") as { input: { cooks: Record<string, unknown>[] } }).input.cooks[0];

  it("sends the whole pot's weighed weight with a grams share", () => {
    const d = { ...eaten(fromRecipe(recipe)), cookedWeight: "1200" };
    expect(needsCookedWeight(d)).toBe(true);
    expect(cookOf(d)).toMatchObject({ cooked_weight_g: 1200, cooked_weight_provenance: "weighed", portions: [{ member: "Asha", fraction: 0.4 }, { member: "Kabir", weighed_g: 250 }] });
  });

  it("without the pot's weight sends the grams share as it is, so the API asks for the weight in plain words", () => {
    const d = eaten(fromRecipe(recipe));
    expect(cookOf(d)).not.toHaveProperty("cooked_weight_g");
    expect(cookOf(d)).not.toHaveProperty("cooked_weight_provenance");
    expect(plainQuestion("cooked_weight_needed", "The Rajma has no cooked weight yet, so 250 g of it can't be worked out.")).toBe(
      "The Rajma has no cooked weight yet, so 250 g of it can't be worked out.",
    );
    expect(plainQuestion("cooked_weight_needed", "")).toBe(
      "This pot has no cooked weight yet, so a share in grams can't be worked out. Give the share in %, or weigh the whole pot first.",
    );
  });

  it("asks for a usable weight, and ignores the field when every share is a percent", () => {
    expect(mealInput({ ...eaten(fromRecipe(recipe)), cookedWeight: "heavy" }, "2026-10-06", "dinner")).toEqual({ error: "Enter the whole pot's weight in grams." });
    const percent: MealDraft = { ...fromRecipe(recipe), eaters: { Asha: { mode: "percent", value: "50" } }, cookedWeight: "900" };
    expect(needsCookedWeight(percent)).toBe(false);
    expect(cookOf(percent)).not.toHaveProperty("cooked_weight_g");
  });
});

describe("keep these changes?", () => {
  it("doesn't ask when nothing changed, or when there is no recipe", () => {
    expect(recipeChanges(fromRecipe(recipe))).toBeNull();
    expect(recipeChanges({ ...blankMeal(), name: "Khichdi" })).toBeNull();
  });

  it("finds removed, added and amended lines; a changed unit is a remove and an add", () => {
    const d = fromRecipe(recipe);
    d.lines = [
      { ...(d.lines[0] as MealDraft["lines"][number]), value: "300", edited: true },
      { key: "new-1", lineId: null, ref: "FS030", label: "Ginger (raw)", value: "10", unit: "g", measure: null, edited: true },
    ];
    expect(recipeChanges(d)).toEqual({ removed: [32], added: [d.lines[1]], amended: [{ lineId: 31, value: 300 }] });
    const unit = fromRecipe(recipe);
    unit.lines[1] = { ...(unit.lines[1] as MealDraft["lines"][number]), measure: null, unit: "ml", value: "8", edited: true };
    expect(recipeChanges(unit)).toEqual({ removed: [32], added: [unit.lines[1]], amended: [] });
  });

  it("just this time: one household_meal call", () => {
    const d = eaten(fromRecipe(recipe));
    d.lines[0] = { ...(d.lines[0] as MealDraft["lines"][number]), value: "300", edited: true };
    const plan = mealPlan(d, "2026-10-06", "dinner", "once") as { steps: { tool: string }[]; done: string };
    expect(plan.steps.map((s) => s.tool)).toEqual(["household_meal"]);
    expect(plan.done).toBe("Logged Rajma to Dinner.");
  });

  it("update for everyone: the meal first, then each recipe change with a reason, every step its own key", () => {
    const d = eaten(fromRecipe(recipe));
    d.lines = [{ ...(d.lines[0] as MealDraft["lines"][number]), value: "300", edited: true }, { key: "new-1", lineId: null, ref: "FS030", label: "Ginger (raw)", value: "10", unit: "g", measure: null, edited: true }];
    const plan = mealPlan(d, "2026-10-06", "dinner", "update") as { steps: { tool: string; input: Record<string, unknown> }[]; done: string };
    expect(plan.steps.map((s) => s.tool)).toEqual(["household_meal", "remove_recipe_line", "add_recipe_line", "amend"]);
    expect(plan.steps[1]?.input).toMatchObject({ recipe: "R003", line_id: 32, reason: "Changed when cooking on 2026-10-06 (dinner)" });
    expect(plan.steps[2]?.input).toMatchObject({ recipe: "R003", line: { food: "FS030", value: 10, unit: "g" } });
    expect(plan.steps[3]?.input).toMatchObject({ record: { table: "recipe_line", id: 31 }, changes: { amount_value: 300 } });
    expect(new Set(plan.steps.map((s) => s.input.idempotency_key)).size).toBe(4);
    expect(plan.done).toBe("Logged, and Rajma is updated for everyone.");
  });

  it("save as new: the meal, then a new recipe from these lines, under a name the member gives", () => {
    const d = eaten(fromRecipe(recipe));
    d.lines[0] = { ...(d.lines[0] as MealDraft["lines"][number]), value: "300", edited: true };
    expect(mealPlan(d, "2026-10-06", "dinner", "new")).toEqual({ error: "Name the new recipe." });
    const plan = mealPlan(d, "2026-10-06", "dinner", "new", "Rajma, big batch") as { steps: { tool: string; input: Record<string, unknown> }[] };
    expect(plan.steps.map((s) => s.tool)).toEqual(["household_meal", "upsert_recipe"]);
    expect(plan.steps[1]?.input).toMatchObject({ name: "Rajma, big batch", kind: "dish", servings: 4, lines: [{ food: "FS020", value: 300, unit: "g" }, { food: "FS005", value: 2, measure: "tsp" }] });
  });
});

describe("previewLines", () => {
  it("words the API's portions and remainder", () => {
    const p: PreviewMeal = {
      cooks: [{
        name: "Rajma", recipe_id: 3, components: [], lines: [], totals: {},
        portions: [{ member: "Asha", component: "whole", kind: "fraction", fraction: 0.4, weighed_g: null, nutrients: { kcal: { value: 251.2, known: 1, of: 1 }, protein: { value: 14.4, known: 1, of: 1 } } }],
        remainder: [{ component: "whole", fraction: 0.6, status: "unaccounted" }],
      }],
      items: [],
      members: {},
    };
    expect(previewLines(p)).toEqual(["Asha: 40%, 251 kcal and 14 g protein.", "60% of Rajma not eaten yet."]);
  });
});

describe("an added ingredient", () => {
  const oil: FoodSourceDetail = { id: 5, ref: "FS005", name: "Mustard oil", state: "as_sold", reference_amount: 100, reference_unit: "ml", measures: [{ name: "tsp", amount: 5 }] };
  it("takes the measure or unit chosen, not always grams", () => {
    expect(newLine(oil, 0, "2", "new-1")).toEqual({ key: "new-1", lineId: null, ref: "FS005", label: "Mustard oil (as sold)", value: "2", unit: null, measure: "tsp", edited: true });
    expect(newLine(oil, 1, "10", "new-2")).toMatchObject({ unit: "ml", measure: null });
    expect(newLine(oil, 1, "", "new-3")).toEqual({ error: "Enter how much Mustard oil." });
  });

  it("starts on the food's own unit, as the Food tab does, so a bare number is never a measure (click test P2-6)", () => {
    expect(newLine(oil, referenceChip(oil), "10", "new-4")).toMatchObject({ unit: "ml", measure: null });
  });
});

describe("after a Save that did not finish", () => {
  it("keeps the plan once the meal has landed, so the meal is never written twice", () => {
    expect(afterSave({ status: { state: "question" }, results: [{}] })).toEqual({ hold: true, replan: false });
    expect(afterSave({ status: { state: "signed_out" }, results: [{}, {}] })).toEqual({ hold: true, replan: false });
    expect(afterSave({ status: { state: "question" }, results: [] })).toEqual({ hold: false, replan: true });
    expect(afterSave({ status: { state: "saved" }, results: [{}] })).toEqual({ hold: false, replan: true });
  });
});

describe("previewLines in grams", () => {
  it("shows a weighed share as grams", () => {
    const p = { cooks: [{ name: "Rajma", recipe_id: 3, components: [], lines: [], totals: {}, portions: [{ member: "Kabir", component: "whole", kind: "weighed", fraction: 0.3, weighed_g: 250, nutrients: null }], remainder: [] }], items: [], members: {} } as PreviewMeal;
    expect(previewLines(p)[0]).toContain("250 g");
  });
});
