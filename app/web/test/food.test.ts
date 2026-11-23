import { describe, expect, it } from "vitest";
import { buildPicker, draftFor, noMatchLine, type Pick, switchState, foodItem, foodPlan, newFoodPlan, potPlan, potShare, previewLine, switchMeasure, foodCheck, FOOD_KCAL_ASK, USUAL_RATIO_ASK, askedFor, oneAtATime } from "../src/food";
import type { FoodSourceDetail } from "../src/types";
import type { CatalogueHit, DayCooks, RecentItems, WhatIf } from "../src/types";
import { totals } from "./fixtures";

const recents: RecentItems = {
  member: "Asha", from: "2026-09-07", to: "2026-10-06",
  items: [
    { kind: "food_source", name: "Oats", ref: "FS010", state: "dry", count: 9, last_on: "2026-10-06", usual: { food: "FS010", value: 50, unit: "g" } },
    { kind: "recipe", name: "Poha", ref: "R003", count: 4, last_on: "2026-10-04", usual: { recipe: "R003", servings: 1.5 } },
  ],
  exercises: [],
};
const cooks = (shares: { member: string }[], status: "unaccounted" | "leftover" = "unaccounted"): DayCooks => ({
  member: "Asha", date: "2026-10-06",
  cooks: [{
    cook_id: 4, name: "Rajma", cooked_on: "2026-10-06", meal_slot: "lunch", logged_by: null, absent: [], ask: null,
    components: [{ component_id: 9, name: "whole", shares: shares.map((s, i) => ({ portion_id: i + 1, member: s.member, you: false, fraction: 0.3, weighed_g: null, provenance: "estimated", state: "confirmed" })), remainder: { fraction: 0.4, status } }],
  }],
});
const hits: CatalogueHit[] = [
  { kind: "food_source", id: 1, ref: "FS001", name: "Rice", state: "dry", aliases: [], score: 100 },
  { kind: "food_source", id: 2, ref: "FS002", name: "Rice", state: "cooked", aliases: ["chawal"], score: 100 },
  { kind: "recipe", id: 7, ref: "R007", name: "Rice kheer", recipe_kind: "dish", aliases: [], score: 80 },
  { kind: "recipe", id: 8, ref: "R008", name: "Rice bowl idea", recipe_kind: "idea", aliases: [], score: 60 },
];

describe("buildPicker", () => {
  it("opens with today's pots the member hasn't a share of, then recents with their usual amount", () => {
    const rows = buildPicker(recents, cooks([{ member: "Kabir" }]), null, "Asha");
    expect(rows.map((r) => [r.group, r.label, r.detail])).toEqual([
      ["Today's pots", "Rajma", "40% not eaten yet"],
      ["Recent", "Oats (dry)", "usually 50 g"],
      ["Recent", "Poha", "usually 1.5 servings"],
    ]);
  });

  it("rounds a usual amount in grams or ml to a whole number, and prefills it so (click test P2-2)", () => {
    const thirds: RecentItems = { ...recents, items: [
      { kind: "food_source", name: "Chia seeds", ref: "FS020", state: "as_sold", count: 3, last_on: "2026-10-06", usual: { food: "FS020", value: 8.3333, unit: "g" } },
      { kind: "food_source", name: "Egg", ref: "FS016", state: "in_shell", count: 3, last_on: "2026-10-06", usual: { food: "FS016", value: 1.3333, measure: "large" } },
    ] };
    const rows = buildPicker(thirds, null, null, "Asha");
    expect(rows.map((r) => r.detail)).toEqual(["usually 8 g", "usually 1.33 large"]);
    expect(draftFor(rows[0]!.pick as Exclude<Pick, { kind: "pot" }>).value).toBe("8");
  });

  it("says when a search finds nothing to log (click test P2-3)", () => {
    expect(noMatchLine("dahi", [], [])).toBe("Nothing matches \"dahi\". Add it as a new food below, or teach the word to a food in the Catalogue's Words.");
    expect(noMatchLine("rice", [], [hits[3]!])).toBe("Nothing matches \"rice\" that can be logged here: \"Rice bowl idea\" is a recipe idea, not a dish. Add it as a new food below, or teach the word to a food in the Catalogue's Words.");
    expect(noMatchLine("rice", buildPicker(null, null, hits, "Asha"), hits)).toBeNull();
    expect(noMatchLine("rice", [], null)).toBeNull();
  });

  it("leaves out a pot the member already has a share of, or whose rest is settled", () => {
    expect(buildPicker(recents, cooks([{ member: "Asha" }]), null, "Asha").some((r) => r.group === "Today's pots")).toBe(false);
    expect(buildPicker(recents, cooks([], "leftover"), null, "Asha").some((r) => r.group === "Today's pots")).toBe(false);
  });

  it("shows search results instead while typing: foods with their state and learned words, dishes but not ideas", () => {
    const rows = buildPicker(recents, null, hits, "Asha");
    expect(rows.map((r) => [r.label, r.detail])).toEqual([["Rice (dry)", null], ["Rice (cooked)", "also \"chawal\""], ["Rice kheer", null]]);
  });

  it("tolerates hits without aliases", () => {
    const bare = [{ kind: "food_source", id: 1, ref: "FS001", name: "Rice", state: "dry", score: 1 }] as unknown as CatalogueHit[];
    expect(buildPicker(null, null, bare, "Asha").map((r) => [r.label, r.detail])).toEqual([["Rice (dry)", null]]);
  });

  it("offline, filters what is already loaded instead of searching", () => {
    expect(buildPicker(recents, null, null, "Asha", "poh").map((r) => r.label)).toEqual(["Poha"]);
  });
});

describe("foodItem", () => {
  const oats = { kind: "food" as const, ref: "FS010", name: "Oats", state: "dry", usual: { value: 50, unit: "g" } };

  it("starts from the member's usual amount", () => {
    expect(draftFor(oats)).toMatchObject({ value: "50", unit: "g", measure: null, provenance: "estimated" });
  });

  it("builds a log_intake item by ref, with confidence from provenance and an optional ± kcal", () => {
    expect(foodItem(oats, { ...draftFor(oats), value: "60", provenance: "weighed" })).toEqual({ item: { source: "food", food: "FS010", value: 60, unit: "g", provenance: "weighed", confidence: "high" } });
    expect(foodItem(oats, { ...draftFor(oats), measure: "katori", unit: null, uncertainty: "katori size", uncertaintyKcal: "40" })).toEqual({
      item: { source: "food", food: "FS010", value: 50, measure: "katori", provenance: "estimated", confidence: "low", dominant_uncertainty: { description: "katori size", kcal: 40 } },
    });
  });

  it("counted is medium confidence, per the household rubric", () => {
    expect(foodItem(oats, { ...draftFor(oats), provenance: "counted" })).toMatchObject({ item: { confidence: "medium" } });
  });

  it("switching state starts a fresh amount, keeping how it was measured", () => {
    const d = { ...draftFor(oats), measure: "katori", unit: null, provenance: "weighed" as const };
    const next = switchState(oats, d, "FS011", "cooked");
    expect(next.pick).toMatchObject({ ref: "FS011", state: "cooked", usual: null });
    expect(next.draft).toMatchObject({ value: "", unit: null, measure: null, provenance: "weighed" });
  });

  it("takes recipes by servings", () => {
    expect(foodItem({ kind: "recipe", ref: "R003", name: "Poha", usual: 1.5 }, { ...draftFor({ kind: "recipe", ref: "R003", name: "Poha", usual: 1.5 }) })).toEqual({
      item: { source: "recipe", recipe: "R003", servings: 1.5, provenance: "estimated", confidence: "low" },
    });
  });

  it("asks for what is missing, never filling it in", () => {
    expect(foodItem(oats, { ...draftFor(oats), value: "" })).toEqual({ error: "Enter how much." });
    expect(foodItem(oats, { ...draftFor(oats), value: "0" })).toEqual({ error: "Enter how much." });
    expect(foodItem(oats, { ...draftFor(oats), unit: null, measure: null })).toEqual({ error: "Choose a measure, or grams." });
    expect(foodItem(oats, { ...draftFor(oats), uncertainty: "size", uncertaintyKcal: "lots" })).toEqual({ error: "Enter the ± as a number of kcal." });
  });
});

describe("previewLine", () => {
  const w = (left: number): WhatIf => ({
    items: [{ nutrients: { kcal: { value: 190.4, known: 1, of: 1 }, protein: { value: 6.8, known: 1, of: 1 } } }],
    day: totals({ left: { ...totals().left!, kcal: { goal: 1600, consumed: 1600 - left, left, floor: null, floorLeft: null } } }),
  });

  it("says the left after it is at most, when the day leaves out unknown items (ticket 72)", () => {
    const base = w(405.6);
    expect(previewLine({ ...base, day: { ...base.day, unknown_items: { kcal: 1, protein: 1, carbs: 1, fat: 1 } } })).toBe(
      "This: 190 kcal and 7 g protein. Left today after it: at most 406 kcal and at most 51 g protein · 1 item unknown.",
    );
  });

  it("reads the API's numbers, rounded for display", () => {
    expect(previewLine(w(405.6))).toBe("This: 190 kcal and 7 g protein. Left today after it: 406 kcal and 51 g protein.");
  });

  it("says over by for protein too, never a negative", () => {
    const base = w(-120);
    const protein = { ...base.day.left!.protein, left: -5 };
    expect(previewLine({ ...base, day: { ...base.day, left: { ...base.day.left!, protein } } })).toContain("over by 120 kcal, and over by 5 g protein.");
  });

  it("says over by, never a negative left", () => {
    expect(previewLine(w(-120))).toBe("This: 190 kcal and 7 g protein. Left today after it: over by 120 kcal, and 51 g protein left.");
  });
});

describe("plans", () => {
  it("logs one item in one log_intake call with its own key", () => {
    const plan = foodPlan("Asha", "2026-10-06", "lunch", { source: "food", food: "FS010", value: 50, unit: "g", provenance: "estimated", confidence: "low" });
    expect(plan.steps).toEqual([{ tool: "log_intake", input: { member: "Asha", date: "2026-10-06", meal_slot: "lunch", items: [{ source: "food", food: "FS010", value: 50, unit: "g", provenance: "estimated", confidence: "low" }], idempotency_key: expect.any(String) } }]);
    expect(plan.done).toBe("Logged.");
  });

  it("says what it logged and where, and whose draft it is for another member (click test P2-5)", () => {
    const item = { source: "food", food: "FS010", value: 50, unit: "g" };
    expect(foodPlan("Asha", "2026-10-06", "lunch", item, { what: "Oats (dry), 50 g", me: "Asha" }).done).toBe("Logged Oats (dry), 50 g to Lunch.");
    expect(foodPlan("Kabir", "2026-10-06", "pre_workout", item, { what: "Oats (dry), 50 g", me: "Asha" }).done).toBe("Logged Oats (dry), 50 g to Kabir's Pre-workout, as a draft for Kabir to confirm.");
    expect(potPlan(9, "Asha", "2026-10-06", "dinner", { fraction: 0.25 }, "estimated", { what: "25% of Rajma", me: "Asha" }).done).toBe("Logged 25% of Rajma to Dinner.");
  });

  it("takes a share of a pot as eaten, by percent or grams", () => {
    expect(potShare("percent", "25")).toEqual({ fraction: 0.25 });
    expect(potShare("grams", "180")).toEqual({ weighed_g: 180 });
    expect(potShare("percent", "120")).toEqual({ error: "Enter a share from 1 to 100%." });
    // A trailing % is read as the leftover's share reads it (ticket 67); grams take no %.
    expect(potShare("percent", "50%")).toEqual({ fraction: 0.5 });
    expect(potShare("percent", " 50 % ")).toEqual({ fraction: 0.5 });
    expect(potShare("percent", "%")).toEqual({ error: "Enter a share from 1 to 100%." });
    expect(potShare("grams", "50%")).toEqual({ error: "Enter the grams." });
    expect(potPlan(9, "Asha", "2026-10-06", "dinner", { fraction: 0.25 }, "estimated").steps[0]).toEqual({
      tool: "mark_remainder", input: { component_id: 9, disposition: "eaten", member: "Asha", fraction: 0.25, provenance: "estimated", date: "2026-10-06", meal_slot: "dinner", idempotency_key: expect.any(String) },
    });
  });

  it("adds a new food per 100 g, and passes the label's word when the energy check asks", () => {
    const f = { name: "Peanut chikki", state: "as_sold", per: "g" as const, kcal: "520", protein: "15", carbs: "55", fat: "26", measureName: "piece", measureAmount: "25" };
    expect(newFoodPlan(f)).toMatchObject({ steps: [{ tool: "upsert_food_source", input: { name: "Peanut chikki", state: "as_sold", reference_amount: 100, reference_unit: "g", kcal: 520, protein_g: 15, carbs_g: 55, fat_g: 26, measures: [{ name: "piece", amount: 25 }] } }], done: "Added Peanut chikki." });
    expect((newFoodPlan(f, "The label says 520") as { steps: { input: Record<string, unknown> }[] }).steps[0]?.input.energy_override_reason).toBe("The label says 520");
    expect(newFoodPlan({ ...f, kcal: "" })).toEqual({ error: "Enter kcal, protein, carbs and fat per 100 g." });
  });

  it("asks for a half-typed measure instead of saving the food without it (ticket 67, property test)", () => {
    const f = { name: "Test chikki", state: "as_sold", per: "g" as const, kcal: "520", protein: "15", carbs: "55", fat: "26", measureName: "piece", measureAmount: "" };
    const ask = { error: "Name the measure and how many g it holds, or leave both empty." };
    expect(newFoodPlan(f)).toEqual(ask);
    expect(newFoodPlan({ ...f, measureAmount: "25g" })).toEqual(ask);
    expect(newFoodPlan({ ...f, measureAmount: "-25" })).toEqual(ask);
    expect(newFoodPlan({ ...f, measureName: " ", measureAmount: "25" })).toEqual(ask);
    expect((newFoodPlan({ ...f, measureName: "", measureAmount: " " }) as { steps: { input: Record<string, unknown> }[] }).steps[0]?.input).not.toHaveProperty("measures");
  });
});

describe("switchMeasure (click test P1-1)", () => {
  const banana: FoodSourceDetail = { id: 3, ref: "FS003", name: "Banana", state: "raw", reference_amount: 100, reference_unit: "g", measures: [{ name: "medium", amount: 118 }, { name: "small", amount: 90 }] };
  const base = { provenance: "estimated" as const, uncertainty: "", uncertaintyKcal: "" };

  it("picking a measure converts the amount to that measure, so 118 g becomes 1 medium, never 118 medium", () => {
    const d = switchMeasure({ ...base, value: "118", unit: "g", measure: null }, banana, { measure: "medium" });
    expect(d).toMatchObject({ value: "1", measure: "medium", unit: null });
  });

  it("back to grams converts the count to grams: 2 medium is 236 g, not 2 g", () => {
    const d = switchMeasure({ ...base, value: "2", unit: null, measure: "medium" }, banana, { unit: "g" });
    expect(d).toMatchObject({ value: "236", unit: "g", measure: null });
  });

  it("measure to measure keeps the quantity (2 medium is 2.62 small), at most two decimals", () => {
    expect(switchMeasure({ ...base, value: "2", unit: null, measure: "medium" }, banana, { measure: "small" })).toMatchObject({ value: "2.62", measure: "small" });
  });

  it("with no amount typed (or one that isn't a number) a measure starts at 1 and a unit stays empty", () => {
    expect(switchMeasure({ ...base, value: "", unit: null, measure: null }, banana, { measure: "medium" })).toMatchObject({ value: "1", measure: "medium" });
    expect(switchMeasure({ ...base, value: "abc", unit: null, measure: "medium" }, banana, { unit: "g" })).toMatchObject({ value: "", unit: "g" });
  });

  it("a piece food's measures have no known size in pieces: a measure starts at 1, pieces at 1", () => {
    const egg: FoodSourceDetail = { ...banana, reference_unit: "piece", measures: [{ name: "large", amount: 60 }] };
    expect(switchMeasure({ ...base, value: "3", unit: "piece", measure: null }, egg, { measure: "large" })).toMatchObject({ value: "1", measure: "large" });
    expect(switchMeasure({ ...base, value: "2", unit: null, measure: "large" }, egg, { unit: "piece" })).toMatchObject({ value: "1", unit: "piece" });
  });

  it("keeps how it was measured and the uncertainty", () => {
    const d = switchMeasure({ provenance: "weighed", uncertainty: "ripeness", uncertaintyKcal: "10", value: "118", unit: "g", measure: null }, banana, { measure: "medium" });
    expect(d).toMatchObject({ provenance: "weighed", uncertainty: "ripeness", uncertaintyKcal: "10" });
  });
});

describe("foodCheck: an implausible amount asks before saving (click test P1-1)", () => {
  const draft = (value: string, more: Partial<{ unit: string | null; measure: string | null }> = {}) => ({ provenance: "estimated" as const, uncertainty: "", uncertaintyKcal: "", value, unit: null, measure: "medium", ...more });

  it("one item over the kcal line asks, naming the kcal", () => {
    expect(FOOD_KCAL_ASK).toBe(1500);
    expect(foodCheck(12390, draft("118"), null)).toBe("That is 12,390 kcal for one item. Is the amount right?");
  });

  it("an ordinary amount doesn't ask", () => {
    expect(foodCheck(105, draft("1"), { value: 1, measure: "medium" })).toBeNull();
    expect(foodCheck(null, draft("1"), null)).toBeNull();
  });

  it("an amount far above the member's usual in the same measure asks, even offline (no kcal)", () => {
    expect(USUAL_RATIO_ASK).toBe(4);
    expect(foodCheck(null, draft("10"), { value: 2, measure: "medium" })).toBe("That is 5 times your usual 2 medium. Is the amount right?");
    expect(foodCheck(null, draft("5000", { unit: "g", measure: null }), { value: 120, unit: "g" })).toBe("That is 41.67 times your usual 120 g. Is the amount right?");
    // A different measure from the usual one can't be compared, and below the ratio is fine.
    expect(foodCheck(null, draft("10"), { value: 120, unit: "g" })).toBeNull();
    expect(foodCheck(null, draft("7"), { value: 2, measure: "medium" })).toBeNull();
  });

  it("the kcal line is said first when both apply", () => {
    expect(foodCheck(4450, draft("5000", { unit: "g", measure: null }), { value: 120, unit: "g" })).toBe("That is 4,450 kcal for one item. Is the amount right?");
  });
});

describe("the Save's check runs once per tap (review round)", () => {
  it("a second tap while the check runs is ignored, so one plan (one key) is sent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let sends = 0;
    const guarded = oneAtATime(async () => {
      await gate;
      sends += 1;
    });
    const first = guarded.run();
    const second = guarded.run();
    expect(guarded.running()).toBe(true);
    release();
    await Promise.all([first, second]);
    expect(sends).toBe(1);
    expect(guarded.running()).toBe(false);
    await guarded.run();
    expect(sends).toBe(2);
  });

  it("the question shows only for the item it was asked about, so Save anyway never sends an older amount", () => {
    const asking = { key: '{"value":118}', text: "That is 12,392 kcal for one item. Is the amount right?" };
    expect(askedFor(asking, '{"value":118}')).toBe(asking.text);
    expect(askedFor(asking, '{"value":1}')).toBeNull();
    expect(askedFor(null, '{"value":118}')).toBeNull();
  });
});
