import { totalsFrom } from "@myfitnessguide/domain";
import { describe, expect, it } from "vitest";
import type { Member } from "../src/context";
import {
  countedDay,
  dayViewFrom,
  nutritionDay,
  nutritionWeek,
  type DayInputs,
  type IntakeRow,
  type ItemWithNutrients,
  type NutritionDay,
} from "../src/nutrition";

const TODAY = "2026-10-05";
const member = { id: 1, name: "Hritvik" } as Member;
let nextId = 0;
const item = (n: Record<string, number | null>, state = "confirmed"): ItemWithNutrients => ({
  row: { id: ++nextId, state } as IntakeRow,
  nutrients: totalsFrom(n),
});
const TARGET: DayInputs["target"] = {
  row: { id: 1, member_id: 1, effective_from: "2026-01-01", provenance: "agent", reasoning: "invented" },
  values: [
    { nutrient: "kcal", kind: "target", value: 2200 },
    { nutrient: "protein_g", kind: "target", value: 140 },
    { nutrient: "fat_g", kind: "target", value: 60 },
    { nutrient: "carbs_g", kind: "remainder", value: null },
  ],
};
const MEAL = { kcal: 600, protein: 40, carbs: 70, fat: 18, cost_min_inr: 60, cost_max_inr: 80 };

function day(date: string, items: ItemWithNutrients[], status: DayInputs["status"] = null, target: DayInputs["target"] = TARGET): NutritionDay {
  return nutritionDay(dayViewFrom(member, date, { items, status, skipped: [], target }), items, TODAY);
}
const closed = (status: "complete" | "partial" | "open") => ({ status, manual_total_kcal: null });

describe("countedDay and each day's flags", () => {
  it("counts logged past open or complete days, but not gaps, partials, open today, or future days", () => {
    expect(day("2026-10-01", [item(MEAL)], closed("complete"))).toMatchObject({ status: "complete", logged: true, counted: true, not_counted: null });
    expect(day("2026-10-01", [item(MEAL)])).toMatchObject({ status: "open", counted: true, not_counted: null });
    expect(day("2026-10-01", [])).toMatchObject({ logged: false, source: "empty", counted: false, not_counted: "unlogged" });
    expect(day("2026-10-01", [item(MEAL)], closed("partial"))).toMatchObject({ status: "partial", counted: false, not_counted: "partial" });
    expect(day(TODAY, [item(MEAL)])).toMatchObject({ status: "open", counted: false, not_counted: "today_open" });
    expect(day(TODAY, [item(MEAL)], closed("complete"))).toMatchObject({ counted: true });
    expect(day("2026-10-06", [])).toEqual({
      date: "2026-10-06", status: "future", logged: false, source: "empty", counted: false, not_counted: "future", item_count: 0, draft_items: 0,
      kcal: null, protein: null, carbs: null, fat: null, target: null, macro_kcal: null, cost: null, cost_per_25g_protein: null, cost_missing: null,
    });
    expect(countedDay({ date: "2026-10-01", day_status: "open", source: "manual_day_total" }, TODAY)).toBe(true);
  });

  it("preserves nutrient coverage and only emits macro kcal for complete macros", () => {
    const d = day("2026-10-01", [item(MEAL), item({ kcal: 200, protein: null, carbs: 20, fat: 10 })]);
    expect(d.kcal).toEqual({ value: 800, known: 2, of: 2, complete: true });
    expect(d.protein).toEqual({ value: 40, known: 1, of: 2, complete: false });
    expect(d.macro_kcal).toBeNull();
  });

  it("resolves remainder targets and macro kcal at 4/4/9", () => {
    const d = day("2026-10-01", [item(MEAL)]);
    expect(d.target).toEqual({ kcal: 2200, protein: 140, carbs: (2200 - 140 * 4 - 60 * 9) / 4, fat: 60 });
    expect(d.macro_kcal).toEqual({ protein: 160, carbs: 280, fat: 162 });
    expect(day("2026-10-01", [item(MEAL)], null, null).target).toBeNull();
  });

  it("uses a legacy manual total when there are no items and prefers items when present", () => {
    const manual = { status: "complete", manual_total_kcal: 2000, manual_total_protein_g: 120, manual_total_carbs_g: 230, manual_total_fat_g: 65 };
    expect(day("2026-10-01", [], manual)).toMatchObject({ source: "manual_day_total", logged: true, counted: true, cost: null, cost_missing: "manual_day_total" });
    expect(day("2026-10-01", [], manual).kcal).toEqual({ value: 2000, known: 1, of: 1, complete: true });
    expect(day("2026-10-01", [item(MEAL)], manual)).toMatchObject({ source: "items", cost_missing: null });
  });
});

describe("nutrition cost folds", () => {
  it("uses only fully priced items with known protein for cost per 25 g", () => {
    const d = day("2026-10-01", [
      item({ kcal: 300, protein: 20, carbs: 30, fat: 8, cost_min_inr: 40, cost_max_inr: 50 }),
      item({ kcal: 400, protein: 60, carbs: 5, fat: 20 }),
    ]);
    expect(d.cost).toEqual({ min: 40, max: 50, priced_items: 1, items: 2, complete: false });
    expect(d.cost_per_25g_protein).toEqual({ min: 50, max: 62.5, priced_protein_g: 20 });
    expect(d.cost_missing).toBeNull();
  });

  it("treats a zero-priced item as priced and explains genuinely missing cost", () => {
    const zero = day("2026-10-01", [item({ kcal: 100, protein: 5, carbs: 10, fat: 2, cost_min_inr: 0, cost_max_inr: 0 })]);
    expect(zero.cost).toEqual({ min: 0, max: 0, priced_items: 1, items: 1, complete: true });
    expect(zero.cost_per_25g_protein).toEqual({ min: 0, max: 0, priced_protein_g: 5 });
    expect(day("2026-10-01", [item({ kcal: 300, protein: 20, carbs: 30, fat: 8 })])).toMatchObject({ cost: null, cost_missing: "nothing_priced" });
    expect(day("2026-10-01", [item({ kcal: 120, protein: 0, carbs: 0, fat: 13, cost_min_inr: 10, cost_max_inr: 12 })])).toMatchObject({ cost_per_25g_protein: null, cost_missing: "no_protein_in_priced_items" });
  });
});

describe("nutritionWeek", () => {
  const DATES = ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"];
  const at = (i: number) => DATES[i] as string;
  const week = (days: NutritionDay[]) => nutritionWeek("2026-09-27", days);

  it("counts every day state, including logged and complete", () => {
    const days = [day(at(0), [item(MEAL)], closed("complete")), day(at(1), [item(MEAL)]), day(at(2), []), day(at(3), [item(MEAL)], closed("partial")), day(at(4), [item(MEAL)], closed("complete")), day(at(5), [], closed("complete")), day(at(6), [item(MEAL)])];
    expect(week(days).days).toEqual({ in_range: 7, counted: 4, logged: 5, complete: 3, partial: 1, unlogged: 2, today_open: 0, open_counted: 2 });
    expect(week(days).week_end).toBe("2026-10-03");
  });

  it("averages each complete nutrient and its targets over the same counted days", () => {
    const w = week([day(at(0), [item(MEAL)]), day(at(1), [item({ ...MEAL, protein: 60 })]), day(at(2), [item({ ...MEAL, protein: null })]), day(at(3), [item({ ...MEAL, kcal: 9999 })], closed("partial"))]);
    expect(w.average.kcal).toEqual({ value: 600, days: 3 });
    expect(w.average.protein).toEqual({ value: 50, days: 2 });
    expect(w.target_average.protein).toBe(140);
  });

  it("uses null rather than zero when no day is countable", () => {
    const w = week([day(at(0), []), day(at(1), [item(MEAL)], closed("partial"))]);
    expect(w.average).toEqual({ kcal: null, protein: null, carbs: null, fat: null });
    expect(w.target_average).toEqual({ kcal: null, protein: null, carbs: null, fat: null });
    expect(w.macro_split).toBeNull();
    expect(w.cost).toBeNull();
    expect(w.cost_items).toEqual({ priced: 1, of: 1 });
  });

  it("splits macro energy into shares that sum to one", () => {
    const split = week([day(at(0), [item(MEAL)])]).macro_split!;
    expect(split.protein + split.carbs + split.fat).toBeCloseTo(1, 12);
    expect(split.protein).toBeCloseTo(160 / (160 + 280 + 162), 12);
  });

  it("averages fully costed days and weights cost per protein across priced items", () => {
    const a = day(at(0), [item({ kcal: 300, protein: 20, carbs: 30, fat: 8, cost_min_inr: 40, cost_max_inr: 50 })]);
    const b = day(at(1), [item({ kcal: 300, protein: 60, carbs: 30, fat: 8, cost_min_inr: 60, cost_max_inr: 90 })]);
    const partial = day(at(2), [item({ kcal: 300, protein: 20, carbs: 30, fat: 8, cost_min_inr: 10, cost_max_inr: 10 }), item({ kcal: 100, protein: 5, carbs: 5, fat: 5 })]);
    const w = week([a, b, partial]);
    expect(w.cost).toEqual({ min: 50, max: 70, days: 2 });
    expect(w.cost_per_25g_protein!.min).toBeCloseTo(27.5, 9);
    expect(w.cost_per_25g_protein!.max).toBeCloseTo(37.5, 9);
    expect(w.cost_items).toEqual({ priced: 3, of: 4 });
  });
});
