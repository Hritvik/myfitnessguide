import { describe, expect, it } from "vitest";
import {
  barPlan, gymRows, implementRows, loadsPlan, plateRows, recordPlatesPlan, addLineRow, createdHref, NEW_FOOD_START, NEW_RECIPE_START, addLinePlan, editPlan, energyAsked, reachLine, reachText, statusAboveOverride, otherStates, WORD_TAKEN, afterSave, EMPTY_LIST, foodHint, withPages, addMeasurePlan, addYieldPlan, allRows, amendPlan, appendPage, changedFields, FOOD_FIELDS, foodRows, foodView, forgetWordPlan,
  lineAmountPlan, listEmpty, newFoodPlan, newRecipePlan, parseField, parseNumberList, recipeLines, recipeRows, recipeView, removeLinePlan, savedText, searchKinds,
  searchRows, startFields, teachWordPlan, usedBy, visibleRows, withOverride, RECIPE_FIELDS, wordsFor, addWorkoutLinePlan, removeWorkoutLinePlan, workoutLineText, workoutRows, exerciseRows, implementWord, lastDoneText, type FieldSpec,
  foodSuggestions,
} from "../src/catalogue";
import type { Dependents, FoodRecord, Inventory, Learned, RecipeRecord, WorkoutLineOut, WorkoutOut } from "../src/types";

// Invented foods only.
function food(over: Partial<FoodRecord> = {}): FoodRecord {
  return {
    id: 41, ref: "FS041", name: "Rajma", state: "cooked", reference_amount: 100, reference_unit: "g",
    kcal: 127, protein_g: 8.7, carbs_g: 22.8, fat_g: 0.5,
    sodium_mg: null, fibre_g: 6.4, iron_mg: 2.9, b12_ug: null, calcium_mg: 35, magnesium_mg: null, potassium_mg: null, sat_fat_g: 0, total_sugars_g: null, vitamin_c_mg: null,
    protein_band: "partial", price_min_inr: 10, price_max_inr: 14, primary_category: "pulses", tags: null, last_checked_on: "2026-08-12", energy_override_reason: null,
    measures: [{ name: "katori", amount: 150 }], yields_from: [{ from_ref: "FS040", from_state: "dry", factor: 2.4, discarded_fraction: 0 }],
    cost_per_25g_protein_inr: { min: 28.7, max: 40.2 },
    ...over,
  };
}

const words: Learned["aliases"] = [
  { id: 5, alias: "rajma", kind: "food_source", target_id: 41, target: "Rajma (cooked, FS041)", created_by: "Asha", created_at: "2026-10-02T00:00:00Z" },
  { id: 6, alias: "pb", kind: "food_source", target_id: 9, target: "Peanut butter (as_sold, FS009)", created_by: "Asha", created_at: "2026-10-02T00:00:00Z" },
  { id: 7, alias: "kidney beans", kind: "recipe", target_id: 41, target: "Rajma curry (R041)", created_by: null, created_at: "2026-10-02T00:00:00Z" },
];

describe("the list", () => {
  it("names a food in words with its reference measure, never its ref, and links by the ref", () => {
    const rows = foodRows([
      { id: 41, ref: "FS041", name: "Rajma", state: "cooked", reference_amount: 100, reference_unit: "g" },
      { id: 7, ref: "FS007", name: "Phulka", state: "cooked", reference_amount: 1, reference_unit: "piece" },
      { id: 8, ref: "FS008", name: "Toned milk", state: "as_sold", reference_amount: 100, reference_unit: "ml" },
    ]);
    expect(rows).toEqual([
      { key: "food:41", label: "Rajma (cooked)", hint: "food", href: "/catalogue/food/FS041" },
      { key: "food:7", label: "Phulka (cooked)", hint: "food · per piece", href: "/catalogue/food/FS007" },
      { key: "food:8", label: "Toned milk (as sold)", hint: "food", href: "/catalogue/food/FS008" },
    ]);
    expect(rows.map((r) => `${r.label} ${r.hint}`).join(" ")).not.toMatch(/FS0/);
  });

  it("gives a recipe its line count, and an idea says so", () => {
    expect(recipeRows([
      { id: 14, ref: "R014", name: "Rajma curry", kind: "dish", servings: 6, lines: 6 },
      { id: 15, ref: "R015", name: "Sprout chaat", kind: "idea", servings: 1, lines: 0 },
      { id: 16, ref: "R016", name: "Plain dal", kind: "dish", servings: 2, lines: 1 },
    ]).map((r) => [r.label, r.hint, r.href])).toEqual([
      ["Rajma curry", "recipe · 6 lines", "/catalogue/recipe/R014"],
      ["Sprout chaat", "recipe idea", "/catalogue/recipe/R015"],
      ["Plain dal", "recipe · 1 line", "/catalogue/recipe/R016"],
    ]);
  });

  it("merges foods and recipes by name for All, without case", () => {
    const merged = allRows(foodRows([{ id: 41, ref: "FS041", name: "Rajma", state: "cooked", reference_amount: 100, reference_unit: "g" }]), recipeRows([{ id: 14, ref: "R014", name: "paneer bhurji", kind: "dish", servings: 2, lines: 4 }]));
    expect(merged.map((r) => r.label)).toEqual(["paneer bhurji", "Rajma (cooked)"]);
  });

  it("adds a page without repeating a row the household added meanwhile", () => {
    const page1 = foodRows([{ id: 1, ref: "FS001", name: "A", state: "raw", reference_amount: 100, reference_unit: "g" }, { id: 2, ref: "FS002", name: "B", state: "raw", reference_amount: 100, reference_unit: "g" }]);
    const page2 = foodRows([{ id: 2, ref: "FS002", name: "B", state: "raw", reference_amount: 100, reference_unit: "g" }, { id: 3, ref: "FS003", name: "C", state: "raw", reference_amount: 100, reference_unit: "g" }]);
    expect(appendPage(page1, page2).map((r) => r.key)).toEqual(["food:1", "food:2", "food:3"]);
  });

  it("searches the kinds the chip names, and words a hit as the list does", () => {
    expect([searchKinds("all"), searchKinds("food"), searchKinds("recipe")]).toEqual([["food_source", "recipe"], ["food_source"], ["recipe"]]);
    expect(searchRows([
      { kind: "food_source", id: 41, ref: "FS041", name: "Rajma", state: "cooked", aliases: ["rajma"], score: 1 },
      { kind: "recipe", id: 14, ref: "R014", name: "Rajma curry", recipe_kind: "dish", aliases: [], score: 0.8 },
    ])).toEqual([
      { key: "food:41", label: "Rajma (cooked)", hint: "food", href: "/catalogue/food/FS041" },
      { key: "recipe:14", label: "Rajma curry", hint: "recipe", href: "/catalogue/recipe/R014" },
    ]);
  });
});

describe("the food record", () => {
  it("shows the name and state in words, the values, measures, yields, price and words; never the ref", () => {
    const view = foodView(food(), words);
    expect(view.title).toBe("Rajma (cooked)");
    expect(view.facts).toBe("Cooked · checked Wed 12 Aug");
    expect(view.per).toBe("Per 100 g");
    expect(view.macros).toEqual([
      { key: "kcal", label: "Energy", value: "127 kcal" },
      { key: "protein_g", label: "Protein", value: "8.7 g" },
      { key: "carbs_g", label: "Carbs", value: "22.8 g" },
      { key: "fat_g", label: "Fat", value: "0.5 g" },
    ]);
    expect(view.measures).toEqual(["1 katori = 150 g"]);
    expect(view.yields).toEqual(["From dry: × 2.4"]);
    expect(view.price).toBe("₹29–40 per 25 g protein");
    expect(view.words).toEqual([{ id: 5, word: "rajma" }]);
    expect(JSON.stringify(view)).not.toContain("FS04");
  });

  it("says unknown for a micronutrient nobody measured, never 0, and 0 for a measured zero", () => {
    const micro = (key: string) => foodView(food(), []).micros.find((m) => m.key === key)?.value;
    expect(micro("b12_ug")).toBe("unknown");
    expect(micro("sat_fat_g")).toBe("0 g");
    expect(micro("iron_mg")).toBe("2.9 mg");
  });

  it("says per piece, and leaves out a price nobody gave", () => {
    const view = foodView(food({ reference_amount: 1, reference_unit: "piece", cost_per_25g_protein_inr: null, last_checked_on: null }), []);
    expect([view.per, view.price, view.facts]).toEqual(["Per 1 piece", null, "Cooked"]);
  });
});

describe("Used by", () => {
  const deps = (over: Partial<Dependents> = {}): Dependents => ({
    kind: "food_source", ref: "FS041", recipes: [{ ref: "R014", name: "Rajma curry" }],
    cooks: [{ id: 1, name: "Rajma", cooked_on: "2026-08-20" }, { id: 2, name: "Rajma", cooked_on: "2026-10-01" }],
    intake_items: 31, intake_dates: { first: "2026-08-12", last: "2026-10-06" }, yields: [], ...over,
  });

  it("names what a change reaches, with the logged items' dates, and says the days aren't frozen", () => {
    expect(usedBy(deps())).toEqual({
      lines: ["Recipe Rajma curry", "31 logged items, Wed 12 Aug to Tue 6 Oct", "2 cooks, since Thu 20 Aug"],
      reach: "Logged days are worked out from the catalogue, not frozen: changing this changes them.",
      empty: false,
    });
  });

  it("dates the cooks from the earliest, whatever order they come in", () => {
    const cooks = [{ id: 2, name: "Rajma", cooked_on: "2026-10-01" }, { id: 3, name: "Rajma", cooked_on: "2026-07-03" }, { id: 1, name: "Rajma", cooked_on: "2026-08-20" }];
    expect(usedBy(deps({ recipes: [], intake_items: 0, intake_dates: null, cooks })).lines).toEqual(["3 cooks, since Fri 3 Jul"]);
  });

  it("gives the logged items no dates when the API gave none", () => {
    expect(usedBy(deps({ recipes: [], cooks: [], intake_dates: null })).lines).toEqual(["31 logged items"]);
  });

  it("says one day once, and says plainly when nothing uses it", () => {
    expect(usedBy(deps({ recipes: [], cooks: [], intake_items: 1, intake_dates: { first: "2026-10-06", last: "2026-10-06" } })).lines).toEqual(["1 logged item, on Tue 6 Oct"]);
    expect(usedBy(deps({ recipes: [], cooks: [], intake_items: 0, intake_dates: null }))).toEqual({ lines: [], reach: "Nothing uses it yet.", empty: true });
  });
});

describe("fields as typed", () => {
  const spec = (kind: FieldSpec["kind"]): FieldSpec => ({ key: "x", label: "Iron", kind });

  // Review Focus 1: numbers typed the way people type them.
  it("reads a number exactly, refusing what isn't one, and never makes a blank micronutrient 0", () => {
    expect(parseField(spec("optional"), "")).toEqual({ value: null });
    expect(parseField(spec("optional"), "   ")).toEqual({ value: null });
    expect(parseField(spec("optional"), "0")).toEqual({ value: 0 });
    expect(parseField(spec("optional"), " 8.70 ")).toEqual({ value: 8.7 });
    expect(parseField(spec("optional"), ".5")).toEqual({ value: 0.5 });
    for (const bad of ["1,200", "8.7g", "-3", "abc", "1e3", "Infinity", "8..7"]) {
      expect(parseField(spec("optional"), bad), bad).toEqual({ error: "Iron must be a number, like 8.7, or blank if not known." });
    }
    expect(parseField(spec("number"), "")).toEqual({ error: "Iron can't be blank; enter 0 if there is none." });
    expect(parseField(spec("positive"), "0")).toEqual({ error: "Iron must be more than 0." });
    expect(parseField(spec("name"), "  ")).toEqual({ error: "Iron can't be blank." });
    expect(parseField(spec("text"), "  ")).toEqual({ value: null });
    expect(parseField({ key: "state", label: "State", kind: "choice", options: ["dry", "cooked"] }, "fried")).toEqual({ error: "Choose a state." });
  });

  it("refuses digits too many for a number, which would read as Infinity and be sent as null (ticket 67, property test)", () => {
    const huge = "9".repeat(400);
    expect(parseField(spec("positive"), huge)).toEqual({ error: "Iron must be a number, like 8.7." });
    expect(parseField(spec("optional"), huge)).toEqual({ error: "Iron must be a number, like 8.7, or blank if not known." });
    expect(lineAmountPlan(3, huge, 100, "Weighed it")).toEqual({ error: "Amount must be a number, like 8.7." });
    expect(parseNumberList(`2.5, ${huge}`)).toEqual({ error: "Use numbers separated by commas, like 2.5, 5, 10." });
    expect(parseField(spec("positive"), "9".repeat(300))).toEqual({ value: Number("9".repeat(300)) });
  });
});

describe("editing a food", () => {
  const start = startFields(FOOD_FIELDS, food());

  it("starts from the stored values, unknowns blank", () => {
    expect([start.name, start.protein_g, start.b12_ug, start.sat_fat_g, start.tags]).toEqual(["Rajma", "8.7", "", "0", ""]);
  });

  it("sends only the fields the member changed", () => {
    expect(changedFields(FOOD_FIELDS, start, { ...start, protein_g: "9.1" })).toEqual({ changes: { protein_g: 9.1 } });
  });

  it("sends an emptied micronutrient as null (unknown), never 0", () => {
    expect(changedFields(FOOD_FIELDS, start, { ...start, iron_mg: "" })).toEqual({ changes: { iron_mg: null } });
  });

  it("doesn't send a value retyped the same, and says when nothing changed", () => {
    expect(changedFields(FOOD_FIELDS, start, { ...start, protein_g: "8.70", name: " Rajma " })).toEqual({ error: "Nothing changed.", field: "name" });
  });

  it("names the field a bad value is in, and never validates a field nobody touched", () => {
    expect(changedFields(FOOD_FIELDS, start, { ...start, kcal: "lots" })).toEqual({ error: "Energy must be a number, like 8.7.", field: "kcal" });
    expect(changedFields(FOOD_FIELDS, { ...start, carbs_g: "not a number" }, { ...start, carbs_g: "not a number", fat_g: "0.6" })).toEqual({ changes: { fat_g: 0.6 } });
  });

  it("needs a reason the member writes, and sends it as written", () => {
    expect(amendPlan({ table: "food_source", id: 41 }, { protein_g: 9.1 }, "", "Saved.")).toEqual({ error: "Say why: the reason goes in its history." });
    const plan = amendPlan({ table: "food_source", id: 41 }, { protein_g: 9.1 }, " new pack label ", "Saved.");
    expect(plan).toMatchObject({ steps: [{ tool: "amend", input: { record: { table: "food_source", id: 41 }, changes: { protein_g: 9.1 }, reason: "new pack label" } }], done: "Saved." });
    expect("steps" in plan && plan.steps[0]?.input.idempotency_key).toMatch(/^amend-/);
  });

  it("says what was saved, before and after", () => {
    expect(savedText(FOOD_FIELDS, start, { protein_g: 9.1, iron_mg: null })).toBe("Saved: Protein 8.7 → 9.1; Iron 2.9 → unknown.");
  });

  it("adds an override reason only when the member gives one", () => {
    expect(withOverride({ kcal: 140 }, "  ")).toEqual({ error: "Say why to keep these values, for example: the label says so." });
    expect(withOverride({ kcal: 140 }, "the label says so")).toEqual({ changes: { kcal: 140, energy_override_reason: "the label says so" } });
  });
});

describe("a new food", () => {
  const fields = { name: "Sattu", state: "as_sold", reference_amount: "100", reference_unit: "g", kcal: "400", protein_g: "22", carbs_g: "65", fat_g: "6", iron_mg: "", price_min_inr: "" };

  it("sends upsert_food_source with the values given and no ref (the API allocates it)", () => {
    const plan = newFoodPlan(fields, "a new pack", null);
    expect(plan).toMatchObject({ steps: [{ tool: "upsert_food_source", input: { name: "Sattu", state: "as_sold", reference_amount: 100, reference_unit: "g", kcal: 400, protein_g: 22, carbs_g: 65, fat_g: 6, reason: "a new pack" } }], done: "Added Sattu (as sold)." });
    const input = "steps" in plan ? plan.steps[0]?.input : {};
    expect(input).not.toHaveProperty("ref");
    expect(input).not.toHaveProperty("iron_mg");
  });

  it("refuses a missing reason, an unknown state, and a reference amount of 0", () => {
    expect(newFoodPlan(fields, " ", null)).toEqual({ error: "Say why: the reason goes in its history.", field: "reason" });
    expect(newFoodPlan({ ...fields, state: "fried" }, "x", null)).toEqual({ error: "Choose a state.", field: "state" });
    expect(newFoodPlan({ ...fields, reference_amount: "0" }, "x", null)).toEqual({ error: "Per how much must be more than 0.", field: "reference_amount" });
  });

  it("carries the override reason once the API asked", () => {
    expect(newFoodPlan(fields, "x", "the label says so")).toMatchObject({ steps: [{ input: { energy_override_reason: "the label says so" } }] });
  });
});

describe("a new recipe", () => {
  it("reads its lines from the form, skipping empty rows, and sends upsert_recipe", () => {
    const fields = { name: "Rajma curry", servings: "6", meal_type: "lunch", method: "", lines: "3", "line-0-food": "Rajma", "line-0-value": "300", "line-0-unit": "g", "line-1-food": "", "line-1-value": "", "line-1-unit": "g", "line-2-food": "Ghee", "line-2-value": "10", "line-2-unit": "g" };
    expect(recipeLines(fields)).toEqual([{ food: "Rajma", value: "300", unit: "g" }, { food: "Ghee", value: "10", unit: "g" }]);
    expect(newRecipePlan(fields, "how we make it")).toMatchObject({
      steps: [{ tool: "upsert_recipe", input: { name: "Rajma curry", kind: "dish", servings: 6, meal_type: "lunch", lines: [{ food: "Rajma", value: 300, unit: "g" }, { food: "Ghee", value: 10, unit: "g" }], reason: "how we make it" } }],
      done: "Added Rajma curry.",
    });
  });

  it("answers an ambiguous food with the line's state, and sends no state when it is left blank", () => {
    const fields = { name: "Porridge", servings: "1", lines: "2", "line-0-food": "Oats", "line-0-value": "40", "line-0-unit": "g", "line-0-state": "dry", "line-1-food": "Milk", "line-1-value": "200", "line-1-unit": "ml", "line-1-state": "" };
    expect(recipeLines(fields)).toEqual([{ food: "Oats", value: "40", unit: "g", state: "dry" }, { food: "Milk", value: "200", unit: "ml" }]);
    const plan = newRecipePlan(fields, "breakfast");
    expect(plan).toMatchObject({ steps: [{ input: { lines: [{ food: "Oats", value: 40, unit: "g", state: "dry" }, { food: "Milk", value: 200, unit: "ml" }] } }] });
    if ("error" in plan) throw new Error(plan.error);
    expect(JSON.stringify((plan.steps[0]!.input.lines as unknown[])[1])).not.toContain("state");
  });

  it("needs a line, a whole amount for each, and a reason", () => {
    expect(newRecipePlan({ name: "Empty", servings: "1", lines: "1" }, "x")).toEqual({ error: "Add at least one line: a food and how much." });
    expect(newRecipePlan({ name: "Bad", servings: "1", lines: "1", "line-0-food": "Rajma", "line-0-value": "lots", "line-0-unit": "g" }, "x")).toEqual({ error: "Line 1: the amount must be a number above 0." });
    expect(newRecipePlan({ name: "Ok", servings: "1", lines: "1", "line-0-food": "Rajma", "line-0-value": "100", "line-0-unit": "g" }, "")).toEqual({ error: "Say why: the reason goes in its history." });
  });
});

describe("the recipe record", () => {
  const recipe = (over: Partial<RecipeRecord> = {}): RecipeRecord => ({
    id: 14, ref: "R014", name: "Rajma curry", kind: "dish", servings: 6, meal_type: "lunch", prep_type: "batch", method: "Soak, then pressure-cook.", derived: true, manual_macros_reason: null,
    per_serving: { kcal: { value: 312.4, known: 5, of: 6 }, protein: { value: 14.2, known: 5, of: 6 }, carbs: { value: 46, known: 5, of: 6 }, fat: { value: 8.1, known: 5, of: 6 } },
    lines: [
      { id: 101, position: 1, ref: "FS040", name: "Rajma", state: "dry", amount_value: 300, amount_unit: "g", measure: null },
      { id: 102, position: 2, ref: "FS050", name: "Ghee", state: "as_sold", amount_value: 2, amount_unit: "measure", measure: "spoon" },
    ],
    ...over,
  });

  it("shows servings, meal type, method, the lines in words and the server's per-serving totals", () => {
    expect(recipeView(recipe())).toEqual({
      title: "Rajma curry",
      facts: "6 servings · lunch · batch",
      method: "Soak, then pressure-cook.",
      lines: [
        { id: 101, position: 1, food: "Rajma (dry)", amount: "300 g", value: 300 },
        { id: 102, position: 2, food: "Ghee (as sold)", amount: "2 spoon", value: 2 },
      ],
      perServing: "Per serving (5 of 6 lines counted): 312 kcal · 14 g protein · 46 g carbs · 8 g fat",
      manual: null,
    });
  });

  it("shows a complete total as complete, and a partial one as partial", () => {
    const whole = { kcal: { value: 312, known: 6, of: 6 }, protein: { value: 14, known: 6, of: 6 }, carbs: { value: 46, known: 6, of: 6 }, fat: { value: 8, known: 6, of: 6 } };
    expect(recipeView(recipe({ per_serving: whole })).perServing).toBe("Per serving: 312 kcal · 14 g protein · 46 g carbs · 8 g fat");
    // Each nutrient says its own count when it differs from the headline's.
    const mixed = { ...whole, kcal: { value: 312, known: 5, of: 6 }, protein: { value: 14, known: 4, of: 6 } };
    expect(recipeView(recipe({ per_serving: mixed })).perServing).toBe("Per serving (4 of 6 lines counted): 312 kcal (5 of 6) · 14 g protein · 46 g carbs · 8 g fat");
  });

  it("a nutrient nobody has says so with its unit in the right place, never 'unknown g protein'", () => {
    const some = { kcal: { value: 312, known: 6, of: 6 }, carbs: { value: 46, known: 6, of: 6 } };
    const text = recipeView(recipe({ per_serving: some })).perServing as string;
    expect(text).toBe("Per serving: 312 kcal · protein unknown · 46 g carbs · fat unknown");
    expect(text).not.toMatch(/unknown g/);
    expect(recipeView(recipe({ per_serving: null })).perServing).toBe("Per serving: unknown");
    expect(recipeView(recipe({ per_serving: null, lines: [] })).perServing).toBeNull();
  });

  it("a nutrient the server counted on none of the lines is unknown, not 0", () => {
    const none = { kcal: { value: 300, known: 2, of: 2 }, protein: { value: 0, known: 0, of: 2 }, carbs: { value: 40, known: 2, of: 2 }, fat: { value: 5, known: 2, of: 2 } };
    expect(recipeView(recipe({ per_serving: none })).perServing).toBe("Per serving: 300 kcal · protein unknown · 40 g carbs · 5 g fat");
  });

  it("a recipe typed by hand shows no count of lines", () => {
    const manual = { kcal: { value: 400, known: 1, of: 1 }, protein: { value: 20, known: 1, of: 1 } };
    expect(recipeView(recipe({ derived: false, lines: [], per_serving: manual })).perServing).toBe("Per serving: 400 kcal · 20 g protein · carbs unknown · fat unknown");
  });

  it("says when its macros are typed by hand, and why", () => {
    expect(recipeView(recipe({ derived: false, manual_macros_reason: "from the menu card", lines: [] })).manual).toBe("Macros typed by hand: from the menu card.");
    // A reason that already ends a sentence isn't stopped twice (click test P2-25).
    expect(recipeView(recipe({ derived: false, manual_macros_reason: "the label's fibre is absent.", lines: [] })).manual).toBe("Macros typed by hand: the label's fibre is absent.");
  });

  it("adds, removes and changes a line through the recipe's ref, each with a reason", () => {
    expect(addLinePlan("R014", { food: "Onion", value: "200", unit: "g" }, "always has it")).toMatchObject({ steps: [{ tool: "add_recipe_line", input: { recipe: "R014", line: { food: "Onion", value: 200, unit: "g" }, reason: "always has it" } }] });
    expect(addLinePlan("R014", { food: "Oats", value: "30", unit: "g", state: "dry" }, "thickener")).toMatchObject({ steps: [{ input: { line: { food: "Oats", value: 30, unit: "g", state: "dry" } } }] });
    expect(JSON.stringify(addLinePlan("R014", { food: "Oats", value: "30", unit: "g", state: "" }, "thickener"))).not.toContain("state");
    expect(addLinePlan("R014", { food: " ", value: "200", unit: "g" }, "x")).toEqual({ error: "Which food?" });
    expect(removeLinePlan("R014", 102, "Ghee (as sold)", "")).toEqual({ error: "Say why: the reason goes in its history." });
    expect(removeLinePlan("R014", 102, "Ghee (as sold)", "no ghee now")).toMatchObject({ steps: [{ tool: "remove_recipe_line", input: { recipe: "R014", line_id: 102, reason: "no ghee now" } }], done: "Removed Ghee (as sold)." });
    expect(lineAmountPlan(101, "300", 300, "x")).toEqual({ error: "Nothing changed." });
    expect(lineAmountPlan(101, "250", 300, "less rajma")).toMatchObject({ steps: [{ tool: "amend", input: { record: { table: "recipe_line", id: 101 }, changes: { amount_value: 250 }, reason: "less rajma" } }] });
  });
});

describe("a food's measures, yields and words", () => {
  it("adds a measure with its amount in the reference unit", () => {
    expect(addMeasurePlan("FS041", { name: " katori ", amount: "150" }, "weighed one")).toMatchObject({ steps: [{ tool: "add_measure", input: { food: "FS041", name: "katori", amount: 150, reason: "weighed one" } }], done: "Added 1 katori." });
    expect(addMeasurePlan("FS041", { name: "katori", amount: "0" }, "x")).toEqual({ error: "Amount must be more than 0." });
  });

  it("adds a yield from another state, the thrown-away share as a percent", () => {
    expect(addYieldPlan("FS041", { from: "FS040", factor: "2.4", discarded: "" }, "weighed")).toMatchObject({ steps: [{ tool: "add_yield", input: { food: "FS041", from: "FS040", factor: 2.4, reason: "weighed" } }] });
    expect(addYieldPlan("FS041", { from: "FS040", factor: "1", discarded: "15" }, "yolks out")).toMatchObject({ steps: [{ input: { discarded_fraction: 0.15 } }] });
    expect(addYieldPlan("FS041", { from: "", factor: "2", discarded: "" }, "x")).toEqual({ error: "Which state does it come from?" });
    expect(addYieldPlan("FS041", { from: "FS040", factor: "2", discarded: "100" }, "x")).toEqual({ error: "Thrown away must be a percent from 0 to 99." });
  });

  it("teaches a word (replacing an old meaning only when asked) and forgets one, each with a reason", () => {
    expect(teachWordPlan("food_source", "FS041", { word: " rajma " }, "what we call it", false)).toMatchObject({ steps: [{ tool: "learn_alias", input: { alias: "rajma", kind: "food_source", target: "FS041", reason: "what we call it" } }], done: "Learned \"rajma\"." });
    const plan = teachWordPlan("food_source", "FS041", { word: "rajma" }, "x", false);
    expect("steps" in plan && plan.steps[0]?.input).not.toHaveProperty("replace");
    expect(teachWordPlan("food_source", "FS041", { word: "rajma" }, "x", true)).toMatchObject({ steps: [{ input: { replace: true } }] });
    expect(forgetWordPlan(5, "rajma", "")).toEqual({ error: "Say why: the reason goes in its history." });
    expect(forgetWordPlan(5, "rajma", "nobody says it")).toMatchObject({ steps: [{ tool: "forget_alias", input: { id: 5, reason: "nobody says it" } }], done: "Forgot \"rajma\"." });
  });
});

describe("a list of numbers", () => {
  it("reads values separated by commas or spaces, once each, refusing anything else", () => {
    expect(parseNumberList("2.5, 5 7.5,,10")).toEqual({ values: [2.5, 5, 7.5, 10] });
    expect(parseNumberList("5, 5")).toEqual({ values: [5] });
    expect(parseNumberList(" ")).toEqual({ error: "Give at least one value." });
    expect(parseNumberList("5, ten")).toEqual({ error: "Use numbers separated by commas, like 2.5, 5, 10." });
  });
});

describe("what the list shows", () => {
  const f = foodRows([{ id: 41, ref: "FS041", name: "Rajma", state: "cooked", reference_amount: 100, reference_unit: "g" }]);
  const r = recipeRows([{ id: 14, ref: "R014", name: "Paneer bhurji", kind: "dish", servings: 2, lines: 4 }]);
  const hits = recipeRows([{ id: 15, ref: "R015", name: "Rajma curry", kind: "dish", servings: 6, lines: 6 }]);

  it("shows the search's hits while there is a query, else the chip's list", () => {
    expect(visibleRows("food", true, f, r, hits)).toEqual(hits);
    expect(visibleRows("food", false, f, r, hits)).toEqual(f);
    expect(visibleRows("recipe", false, f, r, hits)).toEqual(r);
    expect(visibleRows("all", false, f, r, hits).map((x) => x.label)).toEqual(["Paneer bhurji", "Rajma (cooked)"]);
  });

  it("says plainly when there is nothing to show", () => {
    expect(listEmpty("all", "xyzzy", 0)).toBe("Nothing matches \"xyzzy\".");
    expect(listEmpty("food", "", 0)).toBe("No foods yet.");
    expect(listEmpty("recipe", "", 0)).toBe("No recipes yet.");
    expect(listEmpty("all", "", 0)).toBe("Nothing in the catalogue yet.");
    expect(listEmpty("all", "", 3)).toBeNull();
  });
});

describe("a food's hint", () => {
  it("hides the default reference and shows anything else", () => {
    expect(foodHint(100, "g")).toBe("food");
    expect(foodHint(100, "ml")).toBe("food");
    expect(foodHint(1, "piece")).toBe("food · per piece");
    expect(foodHint(30, "g")).toBe("food · per 30 g");
    expect(foodHint(250, "ml")).toBe("food · per 250 ml");
  });
});

describe("what the list remembers", () => {
  const page = { rows: [{ key: "food:1", label: "Invented food 1", hint: "food", href: "/catalogue/food/FS001" }], next: 400 };
  it("keeps pages by kind, forgets one kind, and drops every page on a Save but keeps the query and chip", () => {
    const m = withPages(withPages({ ...EMPTY_LIST, query: "dal", chip: "food" }, "food_source", page), "recipe", page);
    expect(Object.keys(m.pages)).toEqual(["food_source", "recipe"]);
    expect(Object.keys(withPages(m, "recipe", null).pages)).toEqual(["food_source"]);
    expect(afterSave(m)).toEqual({ query: "dal", chip: "food", pages: {} });
  });
});

describe("a yield's other states", () => {
  it("offers the same food's other states, by state in words, never another food or itself", () => {
    expect(otherStates([
      { kind: "food_source", id: 40, ref: "FS040", name: "Rajma", state: "dry", aliases: [], score: 1 },
      { kind: "food_source", id: 41, ref: "FS041", name: "Rajma", state: "cooked", aliases: [], score: 1 },
      { kind: "food_source", id: 42, ref: "FS042", name: "rajma", state: "soaked", aliases: [], score: 1 },
      { kind: "food_source", id: 50, ref: "FS050", name: "Rajma masala", state: "as_sold", aliases: [], score: 0.6 },
      { kind: "recipe", id: 14, ref: "R014", name: "Rajma", recipe_kind: "dish", aliases: [], score: 1 },
    ], { id: 41, name: "Rajma" })).toEqual([
      { ref: "FS040", label: "dry" },
      { ref: "FS042", label: "soaked" },
    ]);
  });

  it("answers a taken word with a choice, never silently", () => {
    expect(WORD_TAKEN).toEqual({ reason: "alias_taken", options: [{ label: "Replace it", answer: "replace" }, { label: "Keep the existing one", answer: null }] });
  });
});

describe("Save on an edit", () => {
  const start = startFields(FOOD_FIELDS, food());
  const record = { table: "food_source", id: 41 };
  const draft = (fields: Record<string, string>, reason = "new pack label", override: string | null = null) => ({ start, fields: { ...start, ...fields }, reason, override });

  it("sends one amend with only the changed fields, an emptied micronutrient as null", () => {
    const plan = editPlan(FOOD_FIELDS, record, draft({ protein_g: "9.1", iron_mg: "" }), false);
    expect(plan).toMatchObject({ steps: [{ tool: "amend", input: { record, changes: { protein_g: 9.1, iron_mg: null }, reason: "new pack label" } }], done: "Saved: Protein 8.7 → 9.1; Iron 2.9 → unknown." });
    expect("steps" in plan && Object.keys(plan.steps[0]?.input.changes as object)).toEqual(["protein_g", "iron_mg"]);
  });

  it("refuses without a reason, and says which field is wrong", () => {
    expect(editPlan(FOOD_FIELDS, record, draft({ protein_g: "9.1" }, " "), false)).toEqual({ error: "Say why: the reason goes in its history.", field: "reason" });
    expect(editPlan(FOOD_FIELDS, record, draft({ fat_g: "-1" }), false)).toEqual({ error: "Fat must be a number, like 8.7.", field: "fat_g" });
  });

  it("once the API asked about the energy, needs the override reason and sends it with the changes", () => {
    expect(editPlan(FOOD_FIELDS, record, draft({ kcal: "200" }), true)).toEqual({ error: "Say why to keep these values, for example: the label says so.", field: "override" });
    expect(editPlan(FOOD_FIELDS, record, draft({ kcal: "200" }, "label", "the label says so"), true)).toMatchObject({ steps: [{ input: { changes: { kcal: 200, energy_override_reason: "the label says so" } } }] });
  });

  // Plan review #4: a quiet re-read must not turn someone else's change into mine.
  it("diffs against the values the edit started from, so a change made underneath an open edit is never sent back", () => {
    const opened = draft({ name: "Rajma masala" });
    // Meanwhile someone else saved protein 9.5; the record re-read quietly, and the form still shows 8.7.
    const reread = startFields(FOOD_FIELDS, food({ protein_g: 9.5 }));
    expect(reread.protein_g).toBe("9.5");
    const plan = editPlan(FOOD_FIELDS, record, opened, false);
    expect("steps" in plan && plan.steps[0]?.input.changes).toEqual({ name: "Rajma masala" });
  });

  it("knows the energy question when it sees it", () => {
    expect(energyAsked({ state: "question", message: "q", reason: "energy_mismatch" })).toBe(true);
    expect(energyAsked({ state: "question", message: "q", reason: "name_is_an_alias" })).toBe(false);
    expect(energyAsked(null)).toBe(false);
  });

  it("treats blank to 0 as a change (a measured zero), and whitespace on a blank optional field as none", () => {
    const zero = editPlan(FOOD_FIELDS, record, draft({ b12_ug: "0" }), false);
    expect("steps" in zero && zero.steps[0]?.input.changes).toEqual({ b12_ug: 0 });
    expect("steps" in zero && zero.done).toBe("Saved: B12 unknown → 0.");
    expect(editPlan(FOOD_FIELDS, record, draft({ b12_ug: "   ", sodium_mg: " " }), false)).toEqual({ error: "Nothing changed.", field: "name" });
  });

  it("sends a cleared text field as null", () => {
    const plan = editPlan(FOOD_FIELDS, record, draft({ primary_category: "  " }), false);
    expect("steps" in plan && plan.steps[0]?.input.changes).toEqual({ primary_category: null });
    expect("steps" in plan && plan.done).toBe("Saved: Category pulses → none.");
  });

  it("says a text field that was blank as just its new value", () => {
    const plan = editPlan(FOOD_FIELDS, record, draft({ tags: "high fibre" }), false);
    expect("steps" in plan && plan.done).toBe("Saved: Tags: high fibre.");
  });
});

describe("near Save", () => {
  const deps = (over: Partial<Dependents> = {}): Dependents => ({ kind: "food_source", ref: "FS041", recipes: [], cooks: [], intake_items: 0, intake_dates: null, yields: [], ...over });

  it("says what a Save reaches: logged items, cooks, then the recipe by name", () => {
    const cooks = [1, 2, 3, 4].map((id) => ({ id, name: "Rajma curry", cooked_on: "2026-10-0" + id }));
    expect(reachText(deps({ intake_items: 31, cooks, recipes: [{ ref: "R041", name: "Rajma curry" }] }))).toBe("Changes 31 logged items, 4 cooks and the Rajma curry recipe.");
    expect(reachText(deps({ recipes: [{ ref: "R041", name: "Rajma curry" }, { ref: "R042", name: "Rajma rice" }] }))).toBe("Changes the Rajma curry and Rajma rice recipes.");
  });

  it("says when nothing uses it", () => {
    expect(reachText(deps())).toBe("Nothing uses it yet.");
  });

  it("puts the energy question above the override field it asks for, and any other status after the buttons", () => {
    expect(statusAboveOverride({ state: "question", message: "q", reason: "energy_mismatch" })).toBe(true);
    expect(statusAboveOverride({ state: "question", message: "q", reason: "duplicate_food_source" })).toBe(false);
    expect(statusAboveOverride({ state: "failed", message: "Not saved." })).toBe(false);
    expect(statusAboveOverride(null)).toBe(false);
  });
});

describe("the reach line as the dependents load", () => {
  const ready: Dependents = { kind: "food_source", ref: "FS041", recipes: [], cooks: [{ id: 1, name: "Rajma curry", cooked_on: "2026-10-01" }], intake_items: 0, intake_dates: null, yields: [] };
  it("checks while loading, says the reach once ready, and warns only on a failure", () => {
    expect(reachLine({ kind: "loading" })).toBe("Checking what uses it…");
    expect(reachLine({ kind: "ready", data: ready })).toBe("Changes 1 cook.");
    expect(reachLine({ kind: "error" })).toBe("What uses it didn't load; it may reach logged days.");
    expect(reachLine({ kind: "offline" })).toBe("What uses it didn't load; it may reach logged days.");
  });
});

describe("new records", () => {
  it("start with a state and a reference amount, and nothing in the reason", () => {
    expect(NEW_FOOD_START).toEqual({ state: "as_sold", reference_amount: "100", reference_unit: "g" });
    expect(NEW_RECIPE_START).toEqual({ servings: "1", lines: "1", "line-0-unit": "g" });
    expect(NEW_FOOD_START).not.toHaveProperty("reason");
  });

  it("add a line row to the recipe form", () => {
    expect(addLineRow({ ...NEW_RECIPE_START, "line-0-food": "Rajma" })).toEqual({ servings: "1", lines: "2", "line-0-unit": "g", "line-0-food": "Rajma", "line-1-unit": "g" });
  });

  it("open the saved record by the ref the API allocated", () => {
    expect(createdHref("food", { food_source: { ref: "FS088", name: "Sattu" } })).toBe("/catalogue/food/FS088");
    expect(createdHref("recipe", { recipe: { ref: "R021" } })).toBe("/catalogue/recipe/R021");
    expect(createdHref("food", undefined)).toBeNull();
  });
});

describe("a recipe's own fields and words", () => {
  const start = { name: "Rajma curry", servings: "6", meal_type: "lunch", method: "Soak, then pressure-cook." };
  const record = { table: "recipe", id: 14 };

  it("sends only what changed; a cleared method is null, servings must be above 0", () => {
    expect(editPlan(RECIPE_FIELDS, record, { start, fields: { ...start, method: "", servings: "4" }, reason: "smaller pot", override: null }, false)).toMatchObject({
      steps: [{ tool: "amend", input: { record, changes: { servings: 4, method: null }, reason: "smaller pot" } }],
    });
    expect(editPlan(RECIPE_FIELDS, record, { start, fields: { ...start, servings: "0" }, reason: "x", override: null }, false)).toEqual({ error: "Servings must be more than 0.", field: "servings" });
  });

  it("lists the words taught for one record of one kind", () => {
    expect(wordsFor(words, "recipe", 41)).toEqual([{ id: 7, word: "kidney beans" }]);
    expect(wordsFor(words, "food_source", 41)).toEqual([{ id: 5, word: "rajma" }]);
  });
});

describe("workouts", () => {
  const line = (over: Partial<WorkoutLineOut> = {}): WorkoutLineOut => ({
    id: 3, position: 1, exercise: "Goblet squat", set_type: "working", sets: 3, target: { kind: "reps", low: 10, high: 12 },
    load: { value: 16, unit: "kg", basis: "total", bar: null, plates: null }, rir: { low: 1, high: 2 }, rest_s: 90, note: null, ...over,
  });
  const workout: WorkoutOut = { id: 2, name: "Hotel legs", note: null, aliases: [], last_used: "2026-10-03", lines: [line(), line({ id: 4, position: 2, exercise: "Push-up", sets: 2, target: { kind: "reps", low: 12, high: 15 }, load: "none", rir: null, rest_s: null })] };

  it("lists each workout with its line count and when you last used it", () => {
    expect(workoutRows([workout, { ...workout, id: 5, name: "Travel upper", last_used: null, lines: [line()] }])).toEqual([
      { key: "workout:2", label: "Hotel legs", hint: "2 lines · last Sat 3 Oct", href: "/catalogue/workouts/2" },
      { key: "workout:5", label: "Travel upper", hint: "1 line", href: "/catalogue/workouts/5" },
    ]);
  });

  it("words a line in one sentence: sets × target, load, RIR, rest, and a set type that isn't working", () => {
    expect(workoutLineText(line())).toBe("Goblet squat: 3 × 10–12, 16 kg, RIR 1–2, rest 90 s");
    expect(workoutLineText(workout.lines[1] as WorkoutLineOut)).toBe("Push-up: 2 × 12–15, bodyweight");
    expect(workoutLineText(line({ target: { kind: "duration", seconds: 45 }, load: null, rir: { low: 2, high: 2 }, rest_s: null, set_type: "warm_up" }))).toBe("Goblet squat: 3 × 45 s, RIR 2 (warm up)");
    expect(workoutLineText(line({ target: { kind: "distance", value: 1.5, unit: "km" }, load: null, rir: null, rest_s: null }))).toBe("Goblet squat: 3 × 1.5 km");
  });

  it("adds a line (whole sets and reps, low to high) and removes one, each with a reason", () => {
    expect(addWorkoutLinePlan(2, { exercise: "Lunge", sets: "3", low: "8", high: "10" }, "hotel has no rack")).toMatchObject({
      steps: [{ tool: "add_workout_line", input: { workout: 2, line: { exercise: "Lunge", sets: 3, reps: { low: 8, high: 10 } }, reason: "hotel has no rack" } }],
      done: "Added Lunge.",
    });
    expect(addWorkoutLinePlan(2, { exercise: "Lunge", sets: "3", low: "10", high: "8" }, "x")).toEqual({ error: "Reps run low to high, like 8 to 10." });
    expect(addWorkoutLinePlan(2, { exercise: "Lunge", sets: "2.5", low: "8", high: "10" }, "x")).toEqual({ error: "Sets is a whole number from 1 to 20." });
    expect(addWorkoutLinePlan(2, { exercise: " ", sets: "3", low: "8", high: "10" }, "x")).toEqual({ error: "Which exercise?" });
    expect(addWorkoutLinePlan(2, { exercise: "Lunge", sets: "3", low: "8", high: "10" }, "")).toEqual({ error: "Say why: the reason goes in its history." });
    expect(removeWorkoutLinePlan(4, "Push-up", "no room")).toMatchObject({ steps: [{ tool: "remove_workout_line", input: { line_id: 4, reason: "no room" } }], done: "Removed Push-up." });
  });
});

describe("exercises", () => {
  it("lists each with its implement in words and when you last did it", () => {
    expect(exerciseRows([
      { id: 2, name: "Cable row", implement_kind: "cable", last_done: "2026-10-03" },
      { id: 9, name: "Goblet squat", implement_kind: "dumbbell", last_done: null },
    ])).toEqual([
      { key: "exercise:2", label: "Cable row", hint: "cable · last Sat 3 Oct", href: "/catalogue/exercises/2" },
      { key: "exercise:9", label: "Goblet squat", hint: "dumbbells · not done yet", href: "/catalogue/exercises/9" },
    ]);
    expect([implementWord("plate_loaded"), implementWord("cardio_machine"), implementWord("sled_track")]).toEqual(["plate-loaded", "cardio machine", "sled track"]);
  });

  it("says when you last did it with the API's days since", () => {
    expect(lastDoneText({ member: "Asha", exercise: "Cable row", last: "2026-10-03", days_since: 3 })).toBe("Last done Sat 3 Oct, 3 days ago.");
    expect(lastDoneText({ member: "Asha", exercise: "Cable row", last: "2026-10-06", days_since: 0 })).toBe("Last done Tue 6 Oct, today.");
    expect(lastDoneText({ member: "Asha", exercise: "Cable row", last: "2026-10-05", days_since: 1 })).toBe("Last done Mon 5 Oct, 1 day ago.");
    expect(lastDoneText({ member: "Asha", exercise: "Cable row", last: null, days_since: null })).toBe("Not done yet.");
  });

  it("picks only the words taught for that exercise", () => {
    const aliases: Learned["aliases"] = [
      { id: 1, alias: "lpd", kind: "exercise", target_id: 2, target: "Cable row", created_by: "Asha", created_at: "2026-10-02T00:00:00Z" },
      { id: 2, alias: "row", kind: "exercise", target_id: 3, target: "Other", created_by: null, created_at: "2026-10-02T00:00:00Z" },
      { id: 3, alias: "pb", kind: "food_source", target_id: 2, target: "Food", created_by: null, created_at: "2026-10-02T00:00:00Z" },
    ];
    expect(wordsFor(aliases, "exercise", 2)).toEqual([{ id: 1, word: "lpd" }]);
  });
});

describe("gyms and equipment", () => {
  const inv: Inventory = {
    gym: "Sample gym", gym_id: 1,
    plates: [
      { unit: "kg", complete: false, note: null, plates: [{ value: 20, status: "confirmed" }, { value: 10, status: "confirmed" }, { value: 1.25, status: "absent" }, { value: 5, status: "inferred" }] },
      { unit: "lb", complete: true, note: null, plates: [{ value: 5, status: "confirmed" }] },
    ],
    implements: [
      { id: 2, name: "Dumbbells", kind: "dumbbell", unit: "kg", loading: "total", load_list_complete: false, bar: null, loads: [{ value: 2.5, unit: "kg" }, { value: 5, unit: "kg" }, { value: 10, unit: "lb" }], absent: [{ value: 15, unit: "kg" }], plates: null },
      { id: 1, name: "Olympic bar", kind: "barbell", unit: "kg", loading: "per_side", load_list_complete: true, bar: { value: 20, unit: "kg" }, loads: null, absent: [], plates: {} },
    ],
  };

  it("lists the gyms with their equipment count", () => {
    expect(gymRows([{ id: 1, name: "Sample gym", equipment: 4 }])).toEqual([{ key: "gym:1", label: "Sample gym", hint: "4 pieces of equipment", href: "/catalogue/gyms/1" }]);
  });

  it("words each piece: its loads by unit, what isn't there, an incomplete list, a bar's weight", () => {
    expect(implementRows(inv)).toEqual([
      { id: 2, name: "Dumbbells", loads: "2.5, 5 kg; 10 lb", note: "Not here: 15 kg. The list may be missing some loads.", bar: null, barred: false, unit: "kg" },
      { id: 1, name: "Olympic bar", loads: "From the gym's plates", note: null, bar: "Bar 20 kg", barred: true, unit: "kg" },
    ]);
  });

  it("words the plates per unit: seen, not seen, and whether that is all of them", () => {
    expect(plateRows(inv)).toEqual([
      "kg: 20, 10 (5 not checked); no 1.25. May be missing some.",
      "lb: 5. That is all of them.",
    ]);
  });

  it("adds or removes loads in the piece's unit, each with a reason", () => {
    expect(loadsPlan("remove_implement_load", 2, "kg", "15", "not at the gym")).toMatchObject({ steps: [{ tool: "remove_implement_load", input: { implement_id: 2, loads: [{ value: 15, unit: "kg" }], reason: "not at the gym" } }], done: "Removed 15 kg." });
    expect(loadsPlan("add_implement_load", 2, "kg", "17.5, 20", "seen today")).toMatchObject({ steps: [{ tool: "add_implement_load", input: { loads: [{ value: 17.5, unit: "kg" }, { value: 20, unit: "kg" }] } }], done: "Added 17.5, 20 kg." });
    expect(loadsPlan("add_implement_load", 2, "kg", "", "x")).toEqual({ error: "Give at least one value." });
    expect(loadsPlan("add_implement_load", 2, "kg", "20", " ")).toEqual({ error: "Say why: the reason goes in its history." });
  });

  it("records plates seen and not seen, and changes a bar's weight through amend", () => {
    expect(recordPlatesPlan(1, "kg", "1.25, 2.5", "", "checked the rack")).toMatchObject({ steps: [{ tool: "record_plates", input: { gym: 1, unit: "kg", available: [1.25, 2.5], reason: "checked the rack" } }] });
    expect(recordPlatesPlan(1, "kg", "", "", "x")).toEqual({ error: "Give the plates seen, or the ones not there." });
    expect(recordPlatesPlan(1, "kg", "5", "5", "x")).toEqual({ error: "5 can't be both there and not there." });
    expect(barPlan(1, "15", "kg", "it's a 15 kg bar")).toMatchObject({ steps: [{ tool: "amend", input: { record: { table: "implement", id: 1 }, changes: { bar_value: 15, bar_unit: "kg" }, reason: "it's a 15 kg bar" } }], done: "Bar set to 15 kg." });
    expect(barPlan(1, "0", "kg", "x")).toEqual({ error: "The bar's weight must be more than 0." });
  });
});

describe("a recipe line's food, suggested (click test P2-25)", () => {
  it("offers the catalogue's food names for what is typed, each once, in the API's order", () => {
    const hits = [
      { kind: "food_source" as const, id: 1, ref: "FS001", name: "Onion, raw", state: "raw", aliases: [], score: 60 },
      { kind: "food_source" as const, id: 2, ref: "FS002", name: "Rice", state: "dry", aliases: [], score: 40 },
      { kind: "food_source" as const, id: 3, ref: "FS003", name: "Rice", state: "cooked", aliases: [], score: 40 },
      { kind: "recipe" as const, id: 7, ref: "R007", name: "Onion pakora", recipe_kind: "dish", aliases: [], score: 60 },
    ];
    expect(foodSuggestions(hits)).toEqual(["Onion, raw", "Rice"]);
  });
});
