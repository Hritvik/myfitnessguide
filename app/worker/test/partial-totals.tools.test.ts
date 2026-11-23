// Ticket 72: a total that leaves out an item nobody can value says how many
// it left out. Each day read, each meal's total, each week day and each
// household row carries `unknown_items`, per nutrient, beside its sum.
import { describe, expect, it } from "vitest";
import { knownValue, unknownItems } from "../src/nutrition";
import { setup, type Harness } from "./harness";
import { seedCatalogue, seedTraining } from "./seed";

const TODAY = "2026-10-05";
const curd = (value: number) => ({ source: "food", food: "curd", value, unit: "g", provenance: "weighed", confidence: "high" });

async function ready() {
  const x = setup();
  seedTraining(x);
  await seedCatalogue(x);
  await x.ok("set_target", {
    member: "Hritvik", effective_from: "2026-09-01", provenance: "member", reasoning: "Test target",
    values: [
      { nutrient: "kcal", kind: "target", value: 2000 }, { nutrient: "protein_g", kind: "target", value: 150 },
      { nutrient: "fat_g", kind: "target", value: 60 }, { nutrient: "carbs_g", kind: "remainder" },
    ],
  });
  return x;
}

/**
 * Curd is weighed in g: 2 pieces of it can't be converted, so its nutrients are unknown. Written as a row:
 * log_intake refuses a unit the food can't convert (the sample's stress household does the same, with Tofu).
 */
function unknownCurd(x: Harness, slot = "lunch") {
  const curdId = (x.t.all("SELECT id FROM food_source WHERE name = 'Curd'")[0] as { id: number }).id;
  x.t.insert("intake_item", {
    member_id: x.h.hritvik, eaten_on: TODAY, meal_slot: slot, source_kind: "food_source", food_source_id: curdId,
    amount_value: 2, amount_unit: "piece", provenance: "counted", confidence: "low", state: "confirmed", confirmed_at: `${TODAY}T00:00:00Z`,
  });
}

describe("unknown_items: a partial total says what it leaves out", () => {
  it("day_meals: a meal's totals count the items they leave out, per nutrient", async () => {
    const x = await ready();
    await x.ok("log_intake", { member: "Hritvik", date: TODAY, meal_slot: "lunch", items: [curd(500)] });
    await x.ok("log_intake", { member: "Hritvik", date: TODAY, meal_slot: "breakfast", items: [curd(100)] });
    unknownCurd(x);
    const body = await x.ok("day_meals", { member: "Hritvik", date: TODAY }, "hritvik");
    const lunch = body.slots.find((s: { slot: string }) => s.slot === "lunch");
    const breakfast = body.slots.find((s: { slot: string }) => s.slot === "breakfast");
    expect(lunch.items.map((i: { kcal: number | null }) => i.kcal === null)).toEqual([false, true]);
    expect(lunch.totals.kcal).toBeGreaterThan(0);
    expect(lunch.totals.unknown_items).toEqual({ kcal: 1, protein: 1, any: 1 });
    expect(breakfast.totals.unknown_items).toEqual({ kcal: 0, protein: 0, any: 0 });
  });

  it("day_meals: a meal of only unknown items has no total, and still counts them", async () => {
    const x = await ready();
    unknownCurd(x, "dinner");
    const body = await x.ok("day_meals", { member: "Hritvik", date: TODAY }, "hritvik");
    const dinner = body.slots.find((s: { slot: string }) => s.slot === "dinner");
    expect(dinner.totals).toEqual({ kcal: null, protein: null, unknown_items: { kcal: 1, protein: 1, any: 1 } });
  });

  it("day_totals: the day counts its unknown items beside so_far and left", async () => {
    const x = await ready();
    await x.ok("log_intake", { member: "Hritvik", date: TODAY, meal_slot: "lunch", items: [curd(500)] });
    unknownCurd(x);
    const body = await x.ok("day_totals", { member: "Hritvik", date: TODAY }, "hritvik");
    expect(body.unknown_items).toEqual({ kcal: 1, protein: 1, carbs: 1, fat: 1, any: 1 });
    // The sum is of what is known: the left reads as at most this much.
    expect(body.so_far.kcal).toMatchObject({ known: 1, of: 2 });
  });

  it("day_totals: a day of only unknown items still counts them, though nothing is known", async () => {
    const x = await ready();
    unknownCurd(x);
    const body = await x.ok("day_totals", { member: "Hritvik", date: TODAY }, "hritvik");
    expect(body.so_far).toEqual({});
    expect(body.left.kcal.left).toBe(2000);
    expect(body.unknown_items).toEqual({ kcal: 1, protein: 1, carbs: 1, fat: 1, any: 1 });
  });

  it("day_totals: a complete day counts none", async () => {
    const x = await ready();
    await x.ok("log_intake", { member: "Hritvik", date: TODAY, meal_slot: "lunch", items: [curd(500)] });
    const body = await x.ok("day_totals", { member: "Hritvik", date: TODAY }, "hritvik");
    expect(body.unknown_items).toEqual({ kcal: 0, protein: 0, carbs: 0, fat: 0, any: 0 });
  });

  it("week_summary: each day counts the items its kcal and protein leave out", async () => {
    const x = await ready();
    await x.ok("log_intake", { member: "Hritvik", date: TODAY, meal_slot: "lunch", items: [curd(500)] });
    unknownCurd(x);
    const body = await x.ok("week_summary", { member: "Hritvik", week: TODAY }, "hritvik");
    const today = body.days.find((d: { date: string }) => d.date === TODAY);
    expect(today.unknown_items).toEqual({ kcal: 1, protein: 1, any: 1 });
    expect(body.days.find((d: { date: string }) => d.date !== TODAY).unknown_items).toEqual({ kcal: 0, protein: 0, any: 0 });
  });

  it("household_overview: each member's row counts the items their left leaves out", async () => {
    const x = await ready();
    await x.ok("log_intake", { member: "Hritvik", date: TODAY, meal_slot: "lunch", items: [curd(500)] });
    unknownCurd(x);
    const body = await x.ok("household_overview", {}, "hritvik");
    const rows = body.members as { member: string; unknown_items: unknown }[];
    expect(rows.find((m) => m.member === "Hritvik")?.unknown_items).toEqual({ kcal: 1, protein: 1, any: 1 });
    expect(rows.find((m) => m.member === "Asha")?.unknown_items).toEqual({ kcal: 0, protein: 0, any: 0 });
  });

  it("what_if: the day after the item counts the day's unknown items", async () => {
    const x = await ready();
    unknownCurd(x);
    const body = await x.ok("what_if", { member: "Hritvik", date: TODAY, items: [curd(100)] }, "hritvik");
    expect(body.day.unknown_items).toEqual({ kcal: 1, protein: 1, carbs: 1, fat: 1, any: 1 });
  });
});

describe("a partly known item, and a count of items with any macro unknown (review P2-2..P2-4)", () => {
  it("day_meals: a recipe item with one unconvertible line is partial, and counts as unknown in its meal", async () => {
    const x = await ready();
    await x.ok("upsert_recipe", { name: "Invented curd rice", kind: "dish", servings: 1, lines: [{ food: "peas", value: 200, unit: "g" }] });
    await x.ok("log_intake", { member: "Hritvik", date: TODAY, meal_slot: "lunch", items: [{ source: "recipe", recipe: "Invented curd rice", servings: 1, provenance: "estimated", confidence: "medium" }] });
    await x.ok("log_intake", { member: "Hritvik", date: TODAY, meal_slot: "lunch", items: [curd(100)] });
    // A second line nobody can convert (Curd by the piece), written as a row: upsert_recipe refuses it.
    const recipeId = (x.t.all("SELECT id FROM recipe WHERE name = 'Invented curd rice'")[0] as { id: number }).id;
    const curdId = (x.t.all("SELECT id FROM food_source WHERE name = 'Curd'")[0] as { id: number }).id;
    x.t.insert("recipe_line", { recipe_id: recipeId, position: 2, food_source_id: curdId, amount_value: 2, amount_unit: "piece" });
    const body = await x.ok("day_meals", { member: "Hritvik", date: TODAY }, "hritvik");
    const lunch = body.slots.find((s: { slot: string }) => s.slot === "lunch");
    const [rice, plain] = lunch.items;
    expect(rice.kcal).toBeGreaterThan(0);
    expect(rice.partial).toEqual({ kcal: true, protein: true });
    expect(plain.partial).toEqual({ kcal: false, protein: false });
    expect(lunch.totals.unknown_items).toEqual({ kcal: 1, protein: 1, any: 1 });
  });

  it("an item nobody can value is unknown, not partial", async () => {
    const x = await ready();
    unknownCurd(x);
    const body = await x.ok("day_meals", { member: "Hritvik", date: TODAY }, "hritvik");
    const lunch = body.slots.find((s: { slot: string }) => s.slot === "lunch");
    expect(lunch.items[0]).toMatchObject({ kcal: null, protein: null, partial: { kcal: false, protein: false } });
  });

  it("unknownItems: `any` counts each item once, whichever macro it lacks (a carbs-only unknown too)", () => {
    const whole = { value: 10, known: 1, of: 1 };
    const items: { nutrients: Record<string, { value: number; known: number; of: number }> }[] = [
      { nutrients: { kcal: whole, protein: whole, carbs: { value: 0, known: 0, of: 1 }, fat: whole } },
      { nutrients: { kcal: whole, protein: whole, carbs: whole, fat: whole } },
      { nutrients: {} },
    ];
    expect(unknownItems(items, ["kcal", "protein", "carbs", "fat"])).toEqual({ kcal: 1, protein: 1, carbs: 2, fat: 1, any: 2 });
  });

  it("knownValue: a sum known for none of its parts is null, never 0", () => {
    expect(knownValue({ protein: { value: 0, known: 0, of: 2 } }, "protein")).toBeNull();
    expect(knownValue({ protein: { value: 0, known: 1, of: 1 } }, "protein")).toBe(0);
    expect(knownValue({ protein: { value: 12, known: 1, of: 2 } }, "protein")).toBe(12);
    expect(knownValue({}, "protein")).toBeNull();
  });
});

describe("week_summary: energy availability never leans on a partial day (ticket 74)", () => {
  const ffm = (x: Harness) =>
    x.ok("log_reading", { member: "Hritvik", date: "2026-10-01", metric: "bia_fat_free_mass", value: 60, unit: "kg", body_state: "fasted" });

  it("a day with an item of unknown energy is left out of the average, so it can't raise the low flag", async () => {
    const x = await ready();
    await ffm(x);
    // Sun 4 Oct: 2400 kcal, all known (40 kcal/kg over 60 kg, not low).
    await x.ok("log_intake", { member: "Hritvik", date: "2026-10-04", meal_slot: "lunch", items: [curd(4000)] });
    // Mon 5 Oct: 300 kcal known and an item nobody can value. Averaged in, it would read 22.5 and flag low.
    await x.ok("log_intake", { member: "Hritvik", date: TODAY, meal_slot: "lunch", items: [curd(500)] });
    unknownCurd(x);
    const body = await x.ok("week_summary", { member: "Hritvik", week: TODAY }, "hritvik");
    expect(body.energy_availability).toMatchObject({ low: false, days_counted: 1, partial_days_excluded: 1 });
    expect(body.energy_availability.value).toBeCloseTo(2400 / 60, 9);
    expect(body.energy_availability.intake_kcal_per_day).toBeCloseTo(2400, 9);
  });

  it("a week whose every logged day is partial has no energy availability, and says why", async () => {
    const x = await ready();
    await ffm(x);
    await x.ok("log_intake", { member: "Hritvik", date: TODAY, meal_slot: "lunch", items: [curd(500)] });
    unknownCurd(x);
    const body = await x.ok("week_summary", { member: "Hritvik", week: TODAY }, "hritvik");
    expect(body.energy_availability).toBeNull();
    expect(body.energy_availability_missing).toBe("every day logged this week has an item of unknown energy");
  });

  it("a complete week excludes no day", async () => {
    const x = await ready();
    await ffm(x);
    await x.ok("log_intake", { member: "Hritvik", date: TODAY, meal_slot: "lunch", items: [curd(500)] });
    const body = await x.ok("week_summary", { member: "Hritvik", week: TODAY }, "hritvik");
    expect(body.energy_availability).toMatchObject({ days_counted: 1, partial_days_excluded: 0 });
  });
});
