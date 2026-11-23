import { describe, expect, it } from "vitest";
import { buildNutrition, nutritionFrom, type NutritionData } from "../src/nutrition";
import type { NutritionDayOut, NutritionTrends } from "../src/types";
import { dayOut, page, TODAY, weekOut } from "./trends-fixtures";

const data = (first: NutritionTrends, pages: NutritionData["pages"] = [], range: NutritionData["range"] = "4w"): NutritionData => ({ viewing: "Asha", today: TODAY, range, first, pages });

describe("nutritionFrom", () => {
  it("asks for 4 weeks, 12 weeks, 6 months, 1 year, or all history", () => {
    expect(nutritionFrom("4w", TODAY)).toBe("2026-09-15");
    expect(nutritionFrom("12w", TODAY)).toBe("2026-07-21");
    // The two longer spans the spec names: 6 months and 1 year, both on whole weeks.
    expect(nutritionFrom("6m", TODAY)).toBe("2026-04-14");
    expect(nutritionFrom("1y", TODAY)).toBe("2025-10-13");
    expect(nutritionFrom("all", TODAY)).toBeNull();
  });
});

describe("buildNutrition", () => {
  it("orders older pages before the newest and shows newest weekly rows first", () => {
    const view = buildNutrition(data(page("2026-09-13", 4), [{ from: "2026-08-16", to: "2026-09-12", data: page("2026-08-16", 4) }, { from: "2026-07-19", to: "2026-08-15", data: page("2026-07-19", 4) }], "12w"));
    expect(view.charts[0]?.from).toBe("2026-07-19");
    expect(view.charts[0]?.bars.map((b) => b.date)).toEqual([...view.charts[0]!.bars.map((b) => b.date)].sort());
    expect(view.charts[0]?.weeks).toHaveLength(12);
    expect(view.weekly[0]?.week).toBe("Sun 4 Oct");
  });

  it("maps day states to honest marks and wording", () => {
    const first = page("2026-09-27", 2);
    const at = (date: string, over: Partial<NutritionDayOut>) => (first.days[first.days.findIndex((d) => d.date === date)] = dayOut(date, over));
    at("2026-09-28", { logged: false, source: "empty", counted: false, not_counted: "unlogged", kcal: null, protein: null, carbs: null, fat: null, cost: null, cost_per_25g_protein: null });
    at("2026-09-29", { status: "partial", counted: false, not_counted: "partial" });
    at("2026-09-30", { status: "open" });
    at("2026-10-01", { kcal: { value: 1850, known: 5, of: 6, complete: false } });
    at("2026-10-02", { source: "manual_day_total", cost: null, cost_missing: "manual_day_total" });
    at("2026-10-03", { target: null });
    at("2026-10-06", { status: "open", counted: false, not_counted: "today_open" });
    at("2026-10-07", { status: "future", logged: false, source: "empty", counted: false, not_counted: "future", kcal: null });
    const kcal = buildNutrition(data(first)).charts[0]!;
    const bar = (date: string) => kcal.bars.find((b) => b.date === date);
    const row = (date: string) => kcal.table.find((r) => r.iso === date);
    expect(bar("2026-09-28")).toMatchObject({ mark: "unlogged", value: null });
    expect(row("2026-09-28")).toMatchObject({ value: "—", note: "Not logged" });
    expect(bar("2026-09-29")?.mark).toBe("outline");
    expect(row("2026-09-29")?.note).toBe("Partial: not in the average");
    expect(row("2026-09-30")?.note).toBe("Not closed");
    expect(bar("2026-10-01")).toMatchObject({ mark: "open", label: "at least" });
    expect(row("2026-10-01")?.value).toBe("≥ 1,850 kcal");
    expect(row("2026-10-02")?.note).toBe("Day total");
    expect(row("2026-10-03")?.target).toBe("No target");
    expect(bar("2026-10-06")).toMatchObject({ mark: "outline", label: "so far" });
    expect(row("2026-10-07")).toBeUndefined();
  });

  it("uses weekly marks beyond 12 weeks while keeping daily table values", () => {
    const view = buildNutrition(data(page("2026-07-12", 13), [], "all"));
    expect(view.charts[0]).toMatchObject({ weeklyOnly: true, bars: [] });
    expect(view.charts[0]?.table).toHaveLength(91);
    expect(view.charts[0]?.summary).toMatch(/Weekly averages; daily values in the table\./);
  });

  it("preserves missing weeks and API-provided averages without recomputing", () => {
    const first = page("2026-09-27", 2);
    first.weeks[0] = weekOut("2026-09-27", { average: { kcal: null, protein: null, carbs: null, fat: null }, target_average: { kcal: null, protein: null, carbs: null, fat: null }, macro_split: null });
    first.weeks[1] = weekOut("2026-10-04", { average: { kcal: { value: 12345, days: 2 }, protein: { value: 1, days: 2 }, carbs: null, fat: null } });
    const view = buildNutrition(data(first));
    expect(view.charts[0]?.weeks[0]).toMatchObject({ value: null, target: null });
    expect(view.charts[0]?.weeks[1]?.value).toBe(12345);
    expect(view.split.weeks[0]).toMatchObject({ shares: null, text: "Not enough complete days" });
    expect(view.weekly[0]).toMatchObject({ kcal: "12,345 / 2,200 kcal", days: "5 of 7" });
  });

  it("holds failed pages as gaps", () => {
    const view = buildNutrition(data(page("2026-09-13", 4), [{ from: "2026-08-16", to: "2026-09-12", failed: true }], "12w"));
    expect(view.charts[0]?.failed).toEqual([{ from: "2026-08-16", to: "2026-09-12" }]);
    expect(view.charts[0]?.bars.some((b) => b.date >= "2026-08-16" && b.date <= "2026-09-12")).toBe(false);
    expect(view.weekly.at(-1)).toMatchObject({ failed: true, week: "Sun 16 Aug – Sat 12 Sep" });
  });

  it("distinguishes incomplete and absent cost data", () => {
    const first = page("2026-09-27", 2);
    first.days[3] = dayOut("2026-09-30", { cost: { min: 180, max: 200, priced_items: 5, items: 7, complete: false } });
    const cost = buildNutrition(data(first)).cost;
    expect(cost.daily.bars.find((b) => b.date === "2026-09-30")).toMatchObject({ atLeast: true });
    expect(cost.daily.table.find((r) => r.iso === "2026-09-30")?.cost).toBe("≥ ₹180, priced 5 of 7");
    expect(cost.daily.summary).toMatch(/priced 30 of 32 items/);
    const none = page("2026-09-27", 1);
    none.days = none.days.map((d) => ({ ...d, cost: null, cost_per_25g_protein: null, cost_missing: "nothing_priced" as const }));
    none.weeks = none.weeks.map((w) => ({ ...w, cost: null, cost_per_25g_protein: null, cost_items: null }));
    expect(buildNutrition(data(none)).cost.empty).toBe("No prices in the catalogue for what was eaten in this range");
  });

  it("does not claim the whole range is unpriced when a page failed", () => {
    const loaded = page("2026-09-13", 4);
    loaded.days = loaded.days.map((value) => ({ ...value, cost: null, cost_per_25g_protein: null, cost_missing: "nothing_priced" as const }));
    loaded.weeks = loaded.weeks.map((week) => ({ ...week, cost: null, cost_per_25g_protein: null, cost_items: null }));
    const cost = buildNutrition(data(loaded, [{ from: "2026-08-16", to: "2026-09-12", failed: true }], "12w")).cost;
    expect(cost.empty).toBeNull();
    expect(cost.daily.failed).toEqual([{ from: "2026-08-16", to: "2026-09-12" }]);
  });

  it("shows capped and never-logged states", () => {
    expect(buildNutrition(data({ ...page("2026-09-13", 4), capped: true }, [], "all")).notice).toBe("Showing the last 2 years");
    expect(buildNutrition(data({ ...page("2026-09-27", 1), first_logged_on: null, days: [], weeks: [], from: null, to: null })).empty).toBe("Nothing logged yet.");
  });
});
