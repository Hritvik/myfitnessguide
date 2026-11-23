import { describe, expect, it } from "vitest";
import { TestDb } from "./db";
import { foodSource, household, recipe } from "./fixtures";

describe("food sources", () => {
  it("hold nutrients per a typed reference amount in one state", () => {
    const t = new TestDb();
    const h = household(t);
    foodSource(t, h, { ref: "FS001", name: "Rice", state: "dry", reference_amount: 100, reference_unit: "g" });
    foodSource(t, h, { ref: "FS002", name: "Rice", state: "cooked", reference_amount: 100, reference_unit: "g" });
    expect(() => foodSource(t, h, { ref: "FS003", name: "Rice", state: "dry" })).toThrow(/UNIQUE/);
    expect(() => foodSource(t, h, { ref: "FS001", name: "Oats", state: "dry" })).toThrow(/UNIQUE/);
  });

  it("reject a missing or unknown state, unit or a non-positive reference amount", () => {
    const t = new TestDb();
    const h = household(t);
    expect(() => foodSource(t, h, { state: null })).toThrow(/NOT NULL/);
    expect(() => foodSource(t, h, { state: "mushy" })).toThrow(/CHECK/);
    expect(() => foodSource(t, h, { reference_unit: "cup" })).toThrow(/CHECK/);
    expect(() => foodSource(t, h, { reference_amount: 0 })).toThrow(/CHECK/);
  });

  it("keep an unknown micronutrient (blank) apart from a measured zero", () => {
    const t = new TestDb();
    const h = household(t);
    const id = foodSource(t, h, { sodium_mg: null, iron_mg: 0 });
    expect(t.get("SELECT sodium_mg, iron_mg FROM food_source WHERE id = ?", id)).toEqual({ sodium_mg: null, iron_mg: 0 });
    expect(() => foodSource(t, h, { iron_mg: -1 })).toThrow(/CHECK/);
  });

  it("price is a min and max together, min not above max", () => {
    const t = new TestDb();
    const h = household(t);
    expect(() => foodSource(t, h, { price_min_inr: 10 })).toThrow(/CHECK/);
    expect(() => foodSource(t, h, { price_min_inr: 12, price_max_inr: 10 })).toThrow(/CHECK/);
    expect(foodSource(t, h, { price_min_inr: 10, price_max_inr: 12 })).toBeGreaterThan(0);
  });

  it("reject an unknown protein band", () => {
    const t = new TestDb();
    const h = household(t);
    expect(() => foodSource(t, h, { protein_band: "great" })).toThrow(/CHECK/);
  });
});

describe("measures and yields", () => {
  it("a measure converts a named unit to the reference amount", () => {
    const t = new TestDb();
    const h = household(t);
    const egg = foodSource(t, h, { name: "Egg", state: "shelled" });
    t.insert("measure", { food_source_id: egg, name: "1 egg", amount: 50 });
    expect(() => t.insert("measure", { food_source_id: egg, name: "1 egg", amount: 55 })).toThrow(/UNIQUE/);
    expect(() => t.insert("measure", { food_source_id: egg, name: "half", amount: 0 })).toThrow(/CHECK/);
  });

  it("a yield links two states with a factor and a discarded fraction below 1", () => {
    const t = new TestDb();
    const h = household(t);
    const dry = foodSource(t, h, { name: "Rice", state: "dry" });
    const cooked = foodSource(t, h, { name: "Rice", state: "cooked" });
    const whole = foodSource(t, h, { name: "Egg", state: "in_shell" });
    const white = foodSource(t, h, { name: "Egg white", state: "shelled" });
    t.insert("yield", { from_food_source_id: dry, to_food_source_id: cooked, factor: 3, discarded_fraction: 0 });
    t.insert("yield", { from_food_source_id: whole, to_food_source_id: white, factor: 1, discarded_fraction: 0.4 });
    expect(() => t.insert("yield", { from_food_source_id: dry, to_food_source_id: dry, factor: 1 })).toThrow(/CHECK/);
    expect(() => t.insert("yield", { from_food_source_id: cooked, to_food_source_id: dry, factor: 0 })).toThrow(/CHECK/);
    expect(() =>
      t.insert("yield", { from_food_source_id: cooked, to_food_source_id: dry, factor: 1, discarded_fraction: 1 }),
    ).toThrow(/CHECK/);
  });
});

describe("recipes", () => {
  it("are dishes or ideas, and lines join food sources by id with a typed amount", () => {
    const t = new TestDb();
    const h = household(t);
    const r = recipe(t, h, { ref: "R050", kind: "dish" });
    const rice = foodSource(t, h, { name: "Rice", state: "dry" });
    t.insert("recipe_line", { recipe_id: r, position: 1, food_source_id: rice, amount_value: 80, amount_unit: "g" });
    expect(() =>
      t.insert("recipe_line", { recipe_id: r, position: 2, food_source_id: rice, amount_value: 80 }),
    ).toThrow(/NOT NULL|CHECK/);
    expect(() =>
      t.insert("recipe_line", { recipe_id: r, position: 2, food_source_id: rice, amount_value: 1, amount_unit: "measure" }),
    ).toThrow(/CHECK/);
    expect(() => recipe(t, h, { kind: "dessert" })).toThrow(/CHECK/);
  });

  it("manual macros need all four values and a reason, and only then", () => {
    const t = new TestDb();
    const h = household(t);
    const manual = { manual_macros: 1, manual_kcal: 299.5, manual_protein_g: 10.9, manual_carbs_g: 48.4, manual_fat_g: 6.5 };
    expect(() => recipe(t, h, manual)).toThrow(/CHECK/);
    expect(() => recipe(t, h, { ...manual, manual_fat_g: null, manual_macros_reason: "typed" })).toThrow(/CHECK/);
    expect(() => recipe(t, h, { manual_macros: 0, manual_kcal: 100 })).toThrow(/CHECK/);
    expect(recipe(t, h, { ...manual, ref: "R049", manual_macros_reason: "not yet derived" })).toBeGreaterThan(0);
  });

  it("servings must be positive", () => {
    const t = new TestDb();
    const h = household(t);
    expect(() => recipe(t, h, { servings: 0 })).toThrow(/CHECK/);
  });
});
