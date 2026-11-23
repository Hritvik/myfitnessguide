import { addDays } from "../src/dates";
import type { NutritionDayOut, NutritionTrends, NutritionWeekOut } from "../src/types";

export const TODAY = "2026-10-06";
const whole = (value: number) => ({ value, known: 6, of: 6, complete: true });
export function dayOut(date: string, over: Partial<NutritionDayOut> = {}): NutritionDayOut {
  return {
    date, status: "complete", logged: true, source: "items", counted: true, not_counted: null, item_count: 6, draft_items: 0,
    kcal: whole(1900), protein: whole(120), carbs: whole(230), fat: whole(55),
    target: { kcal: 2200, protein: 140, carbs: 275, fat: 60 }, macro_kcal: { protein: 480, carbs: 920, fat: 495 },
    cost: { min: 180, max: 210, priced_items: 6, items: 6, complete: true }, cost_per_25g_protein: { min: 37.5, max: 43.75, priced_protein_g: 120 }, cost_missing: null,
    ...over,
  };
}
export function weekOut(week_start: string, over: Partial<NutritionWeekOut> = {}): NutritionWeekOut {
  return {
    week_start, week_end: addDays(week_start, 6),
    days: { in_range: 7, counted: 5, logged: 6, complete: 4, partial: 1, unlogged: 1, today_open: 0, open_counted: 1 },
    average: { kcal: { value: 1900, days: 5 }, protein: { value: 120, days: 5 }, carbs: { value: 230, days: 5 }, fat: { value: 55, days: 5 } },
    target_average: { kcal: 2200, protein: 140, carbs: 275, fat: 60 },
    macro_split: { protein: 0.25, carbs: 0.49, fat: 0.26 }, cost: { min: 180, max: 210, days: 5 }, cost_per_25g_protein: { min: 37.5, max: 43.75 }, cost_items: { priced: 30, of: 32 },
    ...over,
  };
}
export function page(from: string, weeks: number, over: Partial<NutritionTrends> = {}): NutritionTrends {
  const days = Array.from({ length: weeks * 7 }, (_, i) => dayOut(addDays(from, i)));
  return {
    member: "Asha", from, to: addDays(from, weeks * 7 - 1), today: TODAY, pages: [], capped: false, first_logged_on: "2026-01-04",
    days, weeks: Array.from({ length: weeks }, (_, i) => weekOut(addDays(from, i * 7))), ...over,
  };
}
