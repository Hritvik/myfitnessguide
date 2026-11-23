import { describe, expect, it } from "vitest";
import { TestDb } from "./db";
import { foodSource, household, recipe, type Household } from "./fixtures";

// Worked examples (per 100 g): rice dry 360 kcal / 7 P / 79 C / 0.6 F;
// curd 60 kcal / 3.1 P / 4.7 C / 3.3 F; egg (shelled) 143 kcal / 12.6 P / 0.7 C / 9.5 F.
function catalogue(t: TestDb, h: Household) {
  const rice = foodSource(t, h, { name: "Rice", state: "dry", kcal: 360, protein_g: 7, carbs_g: 79, fat_g: 0.6 });
  const curd = foodSource(t, h, { name: "Curd", state: "as_sold", kcal: 60, protein_g: 3.1, carbs_g: 4.7, fat_g: 3.3 });
  const egg = foodSource(t, h, { name: "Egg", state: "shelled", kcal: 143, protein_g: 12.6, carbs_g: 0.7, fat_g: 9.5 });
  const oneEgg = t.insert("measure", { food_source_id: egg, name: "1 egg", amount: 50 });
  return { rice, curd, egg, oneEgg };
}

const day = { eaten_on: "2026-10-05", meal_slot: "lunch", confidence: "medium", state: "draft" };

function riceCook(t: TestDb, h: Household, rice: number) {
  const cook = t.insert("cook", { household_id: h.id, cooked_on: "2026-10-05", name: "Rice pot", state: "draft" });
  const component = t.insert("component", {
    cook_id: cook, position: 1, name: "rice", cooked_weight_g: 720, cooked_weight_provenance: "weighed",
  });
  t.insert("cook_line", { component_id: component, position: 1, food_source_id: rice, amount_value: 240, amount_unit: "g", provenance: "weighed" });
  return component;
}

function portionItem(t: TestDb, member: number, component: number, share: Record<string, unknown>) {
  const portion = t.insert("portion", { component_id: component, member_id: member, provenance: "estimated", state: "draft", ...share });
  return t.insert("intake_item", { ...day, member_id: member, source_kind: "portion", portion_id: portion });
}

const kcal = (t: TestDb, id: number) => t.get("SELECT kcal FROM v_intake_item WHERE id = ?", id)!.kcal as number | null;

describe("v_intake_item", () => {
  it("computes a food source amount against its reference amount", () => {
    const t = new TestDb();
    const h = household(t);
    const { curd } = catalogue(t, h);
    const id = t.insert("intake_item", {
      ...day, member_id: h.hritvik, source_kind: "food_source", food_source_id: curd, amount_value: 150, amount_unit: "g", provenance: "weighed",
    });
    expect(t.get("SELECT kcal, protein_g, carbs_g, fat_g FROM v_intake_item WHERE id = ?", id)).toEqual({
      kcal: 90, protein_g: expect.closeTo(4.65, 10), carbs_g: expect.closeTo(7.05, 10), fat_g: expect.closeTo(4.95, 10),
    });
  });

  it("converts a measure to the reference amount: 2 eggs at 50 g each", () => {
    const t = new TestDb();
    const h = household(t);
    const { egg, oneEgg } = catalogue(t, h);
    const id = t.insert("intake_item", {
      ...day, member_id: h.hritvik, source_kind: "food_source", food_source_id: egg, amount_value: 2, amount_unit: "measure",
      measure_id: oneEgg, provenance: "counted",
    });
    expect(kcal(t, id)).toBeCloseTo(143, 10);
  });

  it("leaves an amount in the wrong unit uncomputed rather than guessing", () => {
    const t = new TestDb();
    const h = household(t);
    const { curd } = catalogue(t, h);
    const id = t.insert("intake_item", {
      ...day, member_id: h.hritvik, source_kind: "food_source", food_source_id: curd, amount_value: 150, amount_unit: "ml", provenance: "estimated",
    });
    expect(kcal(t, id)).toBeNull();
  });

  it("computes a portion from the cook: 240 g dry rice is 864 kcal, 40% is 345.6, 200 g of 720 g cooked is 240", () => {
    const t = new TestDb();
    const h = household(t);
    const { rice } = catalogue(t, h);
    const component = riceCook(t, h, rice);
    expect(kcal(t, portionItem(t, h.hritvik, component, { kind: "fraction", fraction: 0.4 }))).toBeCloseTo(345.6, 10);
    expect(kcal(t, portionItem(t, h.asha, component, { kind: "weighed", weighed_g: 200 }))).toBeCloseTo(240, 10);
  });

  it("computes a recipe by servings, from its lines or from its manual macros", () => {
    const t = new TestDb();
    const h = household(t);
    const { rice } = catalogue(t, h);
    const derived = recipe(t, h, { servings: 2 });
    t.insert("recipe_line", { recipe_id: derived, position: 1, food_source_id: rice, amount_value: 80, amount_unit: "g" });
    const manual = recipe(t, h, {
      ref: "R049", manual_macros: 1, manual_kcal: 299.5, manual_protein_g: 10.9, manual_carbs_g: 48.4, manual_fat_g: 6.5,
      manual_macros_reason: "not yet derived",
    });
    const item = (r: number, servings: number) =>
      t.insert("intake_item", { ...day, member_id: h.hritvik, source_kind: "recipe", recipe_id: r, recipe_servings: servings, provenance: "reconstructed" });
    expect(kcal(t, item(derived, 1))).toBeCloseTo(144, 10);
    expect(kcal(t, item(manual, 1.5))).toBeCloseTo(449.25, 10);
  });

  it("passes manual macros through", () => {
    const t = new TestDb();
    const h = household(t);
    const id = t.insert("intake_item", {
      ...day, member_id: h.asha, source_kind: "manual", provenance: "label", manual_kcal: 210, manual_protein_g: 6,
      manual_carbs_g: 30, manual_fat_g: 7, manual_reason: "restaurant",
    });
    expect(t.get("SELECT kcal, protein_g, carbs_g, fat_g FROM v_intake_item WHERE id = ?", id))
      .toEqual({ kcal: 210, protein_g: 6, carbs_g: 30, fat_g: 7 });
  });
});

describe("v_component", () => {
  it("shows the share of a component that portions account for, so a remainder stays visible", () => {
    const t = new TestDb();
    const h = household(t);
    const { rice } = catalogue(t, h);
    const component = riceCook(t, h, rice);
    portionItem(t, h.hritvik, component, { kind: "fraction", fraction: 0.4 });
    portionItem(t, h.asha, component, { kind: "weighed", weighed_g: 216 });
    expect(t.get("SELECT kcal, portion_count, accounted_fraction, disposition_count FROM v_component WHERE id = ?", component))
      .toEqual({ kcal: 864, portion_count: 2, accounted_fraction: expect.closeTo(0.7, 10), disposition_count: 0 });
  });
});

describe("v_day_intake", () => {
  it("sums a member's items for a day, with the day status", () => {
    const t = new TestDb();
    const h = household(t);
    const { curd } = catalogue(t, h);
    const item = { ...day, member_id: h.hritvik, source_kind: "food_source", food_source_id: curd, amount_unit: "g", provenance: "weighed" };
    t.insert("intake_item", { ...item, amount_value: 100 });
    t.insert("intake_item", { ...item, amount_value: 200 });
    t.insert("day_status", { member_id: h.hritvik, day: "2026-10-05", status: "partial" });
    expect(t.get("SELECT status, item_count, kcal, uncomputed_items, uses_manual_total FROM v_day_intake WHERE member_id = ? AND day = ?", h.hritvik, "2026-10-05"))
      .toEqual({ status: "partial", item_count: 2, kcal: 180, uncomputed_items: 0, uses_manual_total: 0 });
  });

  it("uses a legacy day-level manual total only on a day with no items", () => {
    const t = new TestDb();
    const h = household(t);
    t.insert("day_status", {
      member_id: h.hritvik, day: "2026-08-01", status: "complete", manual_total_kcal: 3081, manual_total_protein_g: 150,
      manual_total_carbs_g: 350, manual_total_fat_g: 100, manual_total_reason: "legacy DAY TOTAL",
    });
    expect(t.get("SELECT item_count, kcal, protein_g, uses_manual_total FROM v_day_intake WHERE member_id = ? AND day = ?", h.hritvik, "2026-08-01"))
      .toEqual({ item_count: 0, kcal: 3081, protein_g: 150, uses_manual_total: 1 });
  });

  it("shows a day that was never closed as open", () => {
    const t = new TestDb();
    const h = household(t);
    t.insert("intake_item", {
      ...day, member_id: h.asha, source_kind: "manual", provenance: "estimated", manual_kcal: 100, manual_protein_g: 1,
      manual_carbs_g: 1, manual_fat_g: 1, manual_reason: "x",
    });
    expect(t.get("SELECT status FROM v_day_intake WHERE member_id = ?", h.asha)).toEqual({ status: "open" });
  });
});
