import { describe, expect, it } from "vitest";
import { NOW, TestDb } from "./db";
import { foodSource, household, recipe } from "./fixtures";

function cookWithComponent(t: TestDb, householdId: number) {
  const cook = t.insert("cook", { household_id: householdId, cooked_on: "2026-10-05", name: "Fried rice", state: "draft" });
  const component = t.insert("component", { cook_id: cook, position: 1, name: "rice" });
  return { cook, component };
}

describe("cooks, components and cook lines", () => {
  it("a cook holds actual quantities per component, each with provenance", () => {
    const t = new TestDb();
    const h = household(t);
    const rice = foodSource(t, h, { name: "Rice", state: "dry" });
    const { component } = cookWithComponent(t, h.id);
    const line = { component_id: component, position: 1, food_source_id: rice, amount_value: 240, amount_unit: "g" };
    expect(t.insert("cook_line", { ...line, provenance: "weighed" })).toBeGreaterThan(0);
    expect(() => t.insert("cook_line", { ...line, position: 2, provenance: null })).toThrow(/NOT NULL/);
    expect(() => t.insert("cook_line", { ...line, position: 2, provenance: "guessed" })).toThrow(/CHECK/);
    expect(() => t.insert("cook_line", { ...line, position: 2, amount_unit: null, provenance: "weighed" })).toThrow(/NOT NULL/);
  });

  it("a component's cooked weight carries its provenance", () => {
    const t = new TestDb();
    const h = household(t);
    const { cook } = cookWithComponent(t, h.id);
    expect(() => t.insert("component", { cook_id: cook, position: 2, name: "raita", cooked_weight_g: 400 })).toThrow(/CHECK/);
    expect(
      t.insert("component", { cook_id: cook, position: 2, name: "raita", cooked_weight_g: 400, cooked_weight_provenance: "weighed" }),
    ).toBeGreaterThan(0);
    expect(() => t.insert("component", { cook_id: cook, position: 3, name: "rice" })).toThrow(/UNIQUE/);
  });
});

describe("portions", () => {
  it("are a fraction of at most 1, or a weighed amount, never both", () => {
    const t = new TestDb();
    const h = household(t);
    const { component } = cookWithComponent(t, h.id);
    const p = { component_id: component, provenance: "estimated", state: "draft" };
    expect(t.insert("portion", { ...p, member_id: h.hritvik, kind: "fraction", fraction: 0.4 })).toBeGreaterThan(0);
    expect(() => t.insert("portion", { ...p, member_id: h.asha, kind: "fraction", fraction: 1.2 })).toThrow(/CHECK/);
    expect(() => t.insert("portion", { ...p, member_id: h.asha, kind: "fraction", fraction: -0.1 })).toThrow(/CHECK/);
    expect(() => t.insert("portion", { ...p, member_id: h.asha, kind: "fraction" })).toThrow(/CHECK/);
    expect(() => t.insert("portion", { ...p, member_id: h.asha, kind: "weighed", fraction: 0.3, weighed_g: 200 })).toThrow(/CHECK/);
    expect(t.insert("portion", { ...p, member_id: h.asha, kind: "weighed", weighed_g: 200 })).toBeGreaterThan(0);
  });

  it("a portion of 0 is a real portion, distinct from no portion", () => {
    const t = new TestDb();
    const h = household(t);
    const { component } = cookWithComponent(t, h.id);
    t.insert("portion", { component_id: component, member_id: h.kabir, kind: "fraction", fraction: 0, provenance: "counted", state: "draft" });
    expect(t.all("SELECT member_id FROM portion WHERE component_id = ?", component)).toEqual([{ member_id: h.kabir }]);
  });

  it("one portion per member per component", () => {
    const t = new TestDb();
    const h = household(t);
    const { component } = cookWithComponent(t, h.id);
    const p = { component_id: component, member_id: h.hritvik, kind: "fraction", fraction: 0.5, provenance: "estimated", state: "draft" };
    t.insert("portion", p);
    expect(() => t.insert("portion", p)).toThrow(/UNIQUE/);
  });
});

describe("remainder dispositions", () => {
  it("mark what no portion accounts for as leftover or discarded", () => {
    const t = new TestDb();
    const h = household(t);
    const { component } = cookWithComponent(t, h.id);
    const d = { component_id: component, recorded_on: "2026-10-05", provenance: "estimated" };
    expect(t.insert("remainder_disposition", { ...d, disposition: "leftover", amount_kind: "rest" })).toBeGreaterThan(0);
    expect(t.insert("remainder_disposition", { ...d, disposition: "discarded", amount_kind: "fraction", fraction: 0.1 })).toBeGreaterThan(0);
    expect(() => t.insert("remainder_disposition", { ...d, disposition: "lost", amount_kind: "rest" })).toThrow(/CHECK/);
    expect(() => t.insert("remainder_disposition", { ...d, disposition: "leftover", amount_kind: "fraction", fraction: 1.5 })).toThrow(/CHECK/);
    expect(() => t.insert("remainder_disposition", { ...d, disposition: "leftover", amount_kind: "rest", weighed_g: 100 })).toThrow(/CHECK/);
  });
});

describe("household meals", () => {
  it("group cooks and direct items for one meal occasion", () => {
    const t = new TestDb();
    const h = household(t);
    const meal = t.insert("household_meal", { household_id: h.id, eaten_on: "2026-10-05", meal_slot: "dinner", state: "draft" });
    const { cook } = cookWithComponent(t, h.id);
    t.insert("household_meal_cook", { household_meal_id: meal, cook_id: cook });
    expect(() => t.insert("household_meal_cook", { household_meal_id: meal, cook_id: cook })).toThrow(/UNIQUE|PRIMARY/);
    expect(() => t.insert("household_meal", { household_id: h.id, eaten_on: "2026-10-05", meal_slot: "elevenses", state: "draft" }))
      .toThrow(/CHECK/);
  });
});

describe("intake items", () => {
  function base(memberId: number) {
    return { member_id: memberId, eaten_on: "2026-10-05", meal_slot: "lunch", confidence: "medium", state: "draft" };
  }

  it("a food source with a typed amount and provenance", () => {
    const t = new TestDb();
    const h = household(t);
    const curd = foodSource(t, h, { name: "Curd", state: "as_sold" });
    const item = { ...base(h.hritvik), source_kind: "food_source", food_source_id: curd, provenance: "weighed" };
    expect(t.insert("intake_item", { ...item, amount_value: 150, amount_unit: "g" })).toBeGreaterThan(0);
    expect(() => t.insert("intake_item", { ...item, amount_value: 150 })).toThrow(/CHECK/);
    expect(() => t.insert("intake_item", { ...item, amount_value: 150, amount_unit: "bowl" })).toThrow(/CHECK/);
    expect(() => t.insert("intake_item", { ...item, amount_value: 150, amount_unit: "g", provenance: null })).toThrow(/CHECK/);
    expect(() => t.insert("intake_item", { ...item, amount_value: 0, amount_unit: "g" })).toThrow(/CHECK/);
  });

  it("a portion of a cook, whose provenance lives on the portion", () => {
    const t = new TestDb();
    const h = household(t);
    const { component } = cookWithComponent(t, h.id);
    const portion = t.insert("portion", {
      component_id: component, member_id: h.hritvik, kind: "fraction", fraction: 0.4, provenance: "estimated", state: "draft",
    });
    const item = { ...base(h.hritvik), source_kind: "portion", portion_id: portion };
    expect(() => t.insert("intake_item", { ...item, provenance: "estimated" })).toThrow(/CHECK/);
    expect(t.insert("intake_item", item)).toBeGreaterThan(0);
    expect(() => t.insert("intake_item", item)).toThrow(/UNIQUE/);
  });

  it("manual macros need all four values and a reason", () => {
    const t = new TestDb();
    const h = household(t);
    const item = {
      ...base(h.asha), source_kind: "manual", provenance: "label", manual_kcal: 210, manual_protein_g: 6,
      manual_carbs_g: 30, manual_fat_g: 7,
    };
    expect(() => t.insert("intake_item", item)).toThrow(/CHECK/);
    expect(() => t.insert("intake_item", { ...item, manual_fat_g: null, manual_reason: "label" })).toThrow(/CHECK/);
    expect(t.insert("intake_item", { ...item, manual_reason: "restaurant, no ref" })).toBeGreaterThan(0);
  });

  it("a recipe eaten by servings (legacy R refs)", () => {
    const t = new TestDb();
    const h = household(t);
    const r = recipe(t, h);
    const item = { ...base(h.hritvik), source_kind: "recipe", recipe_id: r, provenance: "reconstructed" };
    expect(() => t.insert("intake_item", item)).toThrow(/CHECK/);
    expect(t.insert("intake_item", { ...item, recipe_servings: 1.5 })).toBeGreaterThan(0);
  });

  it("refuses to mix sources in one item", () => {
    const t = new TestDb();
    const h = household(t);
    const curd = foodSource(t, h);
    expect(() =>
      t.insert("intake_item", {
        ...base(h.hritvik), source_kind: "food_source", food_source_id: curd, amount_value: 100, amount_unit: "g",
        provenance: "weighed", manual_kcal: 50,
      }),
    ).toThrow(/CHECK/);
  });

  it("confidence is high, medium or low, and the dominant uncertainty has a description and a ± kcal", () => {
    const t = new TestDb();
    const h = household(t);
    const item = {
      ...base(h.hritvik), source_kind: "manual", provenance: "estimated", manual_kcal: 500, manual_protein_g: 20,
      manual_carbs_g: 60, manual_fat_g: 20, manual_reason: "eating out",
    };
    expect(() => t.insert("intake_item", { ...item, confidence: "N/A" })).toThrow(/CHECK/);
    expect(() => t.insert("intake_item", { ...item, dominant_uncertainty: "oil used" })).toThrow(/CHECK/);
    expect(() => t.insert("intake_item", { ...item, dominant_uncertainty: "oil used", dominant_uncertainty_kcal: -5 })).toThrow(/CHECK/);
    expect(t.insert("intake_item", { ...item, dominant_uncertainty: "oil used", dominant_uncertainty_kcal: 120 })).toBeGreaterThan(0);
  });

  it("confirmed items carry their confirmation time", () => {
    const t = new TestDb();
    const h = household(t);
    const item = {
      ...base(h.hritvik), source_kind: "manual", provenance: "estimated", manual_kcal: 1, manual_protein_g: 0,
      manual_carbs_g: 0, manual_fat_g: 0, manual_reason: "x",
    };
    expect(() => t.insert("intake_item", { ...item, state: "confirmed" })).toThrow(/CHECK/);
    expect(t.insert("intake_item", { ...item, state: "confirmed", confirmed_at: NOW })).toBeGreaterThan(0);
  });
});

describe("day status", () => {
  it("is open, complete or partial, once per member and day", () => {
    const t = new TestDb();
    const h = household(t);
    t.insert("day_status", { member_id: h.hritvik, day: "2026-10-05", status: "open" });
    expect(() => t.insert("day_status", { member_id: h.hritvik, day: "2026-10-05", status: "complete" })).toThrow(/UNIQUE|PRIMARY/);
    expect(() => t.insert("day_status", { member_id: h.asha, day: "2026-10-05", status: "closed" })).toThrow(/CHECK/);
  });

  it("holds a legacy day-level manual total only as a complete group with a reason", () => {
    const t = new TestDb();
    const h = household(t);
    const d = { member_id: h.hritvik, day: "2026-08-01", status: "complete" };
    expect(() => t.insert("day_status", { ...d, manual_total_kcal: 3081 })).toThrow(/CHECK/);
    expect(
      t.insert("day_status", {
        ...d, manual_total_kcal: 3081, manual_total_protein_g: 150, manual_total_carbs_g: 350, manual_total_fat_g: 100,
        manual_total_reason: "legacy DAY TOTAL row",
      }),
    ).toBeGreaterThan(0);
  });

  it("a meal can be marked skipped", () => {
    const t = new TestDb();
    const h = household(t);
    t.insert("skipped_meal", { member_id: h.hritvik, day: "2026-10-05", meal_slot: "breakfast" });
    expect(() => t.insert("skipped_meal", { member_id: h.hritvik, day: "2026-10-05", meal_slot: "breakfast" })).toThrow(/UNIQUE|PRIMARY/);
  });
});
