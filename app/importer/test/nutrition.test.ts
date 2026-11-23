// Nutrition rows -> intake items through log_intake; legacy DAY TOTAL rows
// and NONE rows -> day status through set_day_status.
import { describe, expect, it } from "vitest";
import { rehearse } from "../src/rehearse";
import { basePeople, f, food, FOOD_HEADER, intake, members, NUTRITION_HEADER, recipe, RECIPES_HEADER, snapshot } from "./fixture";

const base = {
  People: basePeople(),
  "Food Sources": [
    FOOD_HEADER,
    food({ ref: "FS001", name: "Test whey", serving: "1 scoop (30 g)", kcal: 120, protein: 24, carbs: 3, fat: 1 }),
    food({ ref: "FS002", name: "Test banana", serving: "1 medium (~120 g)", kcal: 100, protein: 1.2, carbs: 25, fat: 0.3 }),
  ],
  Recipes: [RECIPES_HEADER, recipe({ ref: "R001", name: "Test dal", macros: [200, 10, 25, 6], derivation: "stored" })],
};

const D1 = 46240; // 2026-08-06
const D2 = 46241;
const D3 = 46242;

function run(rows: unknown[][]) {
  return rehearse({ snapshot: snapshot({ base, hritvik: { Nutrition: [NUTRITION_HEADER, ...rows] } } as never), members: members() });
}

describe("nutrition rows", () => {
  it("logs a food by ref and servings, a recipe by servings, and a ref-less row as manual macros", async () => {
    const r = await run([
      intake({ date: D1, meal: "Breakfast", item: "Whey", qtyText: "1.5 scoops", macros: [f("=..", 180), f("=..", 36), f("=..", 4.5), f("=..", 1.5)], confidence: "High", source: "Confirmed / label", person: "Hritvik", ref: "FS001", qty: 1.5 }),
      intake({ date: D1, meal: "Lunch", item: "Dal", macros: [f("=..", 400), f("=..", 20), f("=..", 50), f("=..", 12)], person: "Hritvik", ref: "R001", qty: 2 }),
      intake({ date: D1, meal: "Evening", item: "Shake", qtyText: "1 glass", macros: [300, 10, 40, 9], confidence: "Low", person: "Hritvik" }),
    ]);
    expect(r.db.all("SELECT eaten_on, meal_slot, source_kind, amount_value, amount_unit, recipe_servings, provenance, confidence, label, state, round(kcal, 3) AS kcal FROM v_intake_item ORDER BY id")).toEqual([
      { eaten_on: "2026-08-06", meal_slot: "breakfast", source_kind: "food_source", amount_value: 45, amount_unit: "g", recipe_servings: null, provenance: "label", confidence: "high", label: "Whey (1.5 scoops)", state: "confirmed", kcal: 180 },
      { eaten_on: "2026-08-06", meal_slot: "lunch", source_kind: "recipe", amount_value: null, amount_unit: null, recipe_servings: 2, provenance: "estimated", confidence: "medium", label: "Dal", state: "confirmed", kcal: 400 },
      { eaten_on: "2026-08-06", meal_slot: "snack", source_kind: "manual", amount_value: null, amount_unit: null, recipe_servings: null, provenance: "estimated", confidence: "low", label: "Shake (1 glass)", state: "confirmed", kcal: 300 },
    ]);
    expect(r.db.all("SELECT json_extract(resolver_detail, '$.origin.row') AS row FROM write_log WHERE tool = 'log_intake' ORDER BY id")).toEqual([{ row: 2 }, { row: 3 }, { row: 4 }]);
  });

  it("turns a legacy DAY TOTAL into the day's manual total (mechanical), and asks when the day also has items (semantic)", async () => {
    const r = await run([
      intake({ date: D1, meal: "DAY TOTAL", item: "", macros: [1900, 80, 220, 70], confidence: "N/A", source: "Legacy total", person: "Hritvik" }),
      intake({ date: D2, meal: "Lunch", item: "Banana", person: "Hritvik", ref: "FS002", qty: 1, macros: [f("=..", 100), f("=..", 1.2), f("=..", 25), f("=..", 0.3)] }),
      intake({ date: D2, meal: "DAY TOTAL", item: "", macros: [2000, 90, 240, 75], person: "Hritvik" }),
    ]);
    expect(r.db.all("SELECT day, status, uses_manual_total, kcal FROM v_day_intake ORDER BY day")).toEqual([
      { day: "2026-08-06", status: "complete", uses_manual_total: 1, kcal: 1900 },
      { day: "2026-08-07", status: "complete", uses_manual_total: 0, kcal: 100 },
    ]);
    expect(r.rulings.find((x) => x.id === "hritvik/Nutrition!2/legacy_day_total")).toMatchObject({ kind: "mechanical", decision: "accepted" });
    expect(r.rulings.find((x) => x.id === "hritvik/Nutrition!4/day_total_with_items")).toMatchObject({ kind: "semantic", decision: "pending", day: "2026-08-07" });
  });

  it("reads numbers and dates stored as text, mechanically", async () => {
    const r = await run([intake({ date: "2026-08-08", meal: "Snack", item: "Banana", person: "Hritvik", ref: "FS002", qty: "2" })]);
    expect(r.db.get("SELECT eaten_on, amount_value, amount_unit FROM intake_item")).toEqual({ eaten_on: "2026-08-08", amount_value: 240, amount_unit: "g" });
    expect(r.rulings.find((x) => x.id === "hritvik/Nutrition!2/stored_as_text")).toMatchObject({ kind: "mechanical", proposal: { columns: ["A", "N"] } });
  });

  it("asks about a meal stored as a time, proposing the slot for that hour", async () => {
    const r = await run([intake({ date: D3, meal: 0.625, item: "Chips", macros: [270, 3, 30, 15], person: "Hritvik" })]);
    expect(r.rulings.find((x) => x.id === "hritvik/Nutrition!2/meal_slot")).toMatchObject({ kind: "semantic", decision: "pending", proposal: "lunch" });
    expect(r.db.get("SELECT meal_slot FROM intake_item")).toEqual({ meal_slot: "lunch" });
  });

  it("records a NONE row as a skipped meal, and an unknown ref as a semantic ruling", async () => {
    const r = await run([
      intake({ date: D3, meal: "Breakfast", item: "NONE", macros: [0, 0, 0, 0], person: "Hritvik" }),
      intake({ date: D3, meal: "Lunch", item: "Mystery", person: "Hritvik", ref: "FS404", qty: 1, macros: [f("=..", ""), f("=..", ""), f("=..", ""), f("=..", "")] }),
    ]);
    expect(r.db.all("SELECT day, meal_slot FROM skipped_meal")).toEqual([{ day: "2026-08-08", meal_slot: "breakfast" }]);
    expect(r.rulings.find((x) => x.id === "hritvik/Nutrition!3/unknown_ref")).toMatchObject({ kind: "semantic", proposal: null });
    expect(r.db.get("SELECT count(*) AS n FROM intake_item")).toEqual({ n: 0 });
  });
});
