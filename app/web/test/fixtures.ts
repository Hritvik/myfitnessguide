// Invented sample data in the shapes the Worker returns. No household data.
import { CANARIES, type Canary } from "../scripts/canaries";
import type { Outcome } from "../src/api";
import type { Who } from "../src/load";
import type { DayCook, DayMeals, DayTotals, MealItem, NeedsYou, SessionsList, TodayData } from "../src/types";

const line = (goal: number, consumed: number, floor: number | null = null) => ({
  goal, consumed, left: goal - consumed, floor, floorLeft: floor === null ? null : Math.max(0, floor - consumed),
});

export function totals(over: Partial<DayTotals> = {}): DayTotals {
  return {
    member: "Asha", date: "2026-10-06", day_status: "open", item_count: 6, draft_items: 1,
    so_far: {
      kcal: { value: 1194.4, known: 6, of: 6 }, protein: { value: 89.2, known: 6, of: 6 },
      carbs: { value: 115.3, known: 6, of: 6 }, fat: { value: 40.6, known: 6, of: 6 },
    },
    left: { kcal: line(1600, 1194.4), protein: line(140, 89.2), carbs: line(120, 115.3), fat: line(55, 40.6, 45) },
    target_values: [
      { nutrient: "kcal", kind: "target", value: 1600 },
      { nutrient: "protein_g", kind: "target", value: 140 },
      { nutrient: "fat_g", kind: "target", value: 55 },
      { nutrient: "fat_g", kind: "floor", value: 45 },
      { nutrient: "carbs_g", kind: "remainder", value: null },
    ],
    ...over,
  };
}

export function item(over: Partial<MealItem> = {}): MealItem {
  return {
    table: "intake_item", id: 1, source_kind: "food_source", name: "Oats", label: null, amount: { value: 50, unit: "g" },
    portion_id: null, kcal: 190, protein: 7, provenance: "weighed", plus_minus_kcal: null, uncertainty: null, state: "confirmed", logged_by: null,
    ...over,
  };
}

export function meals(over: Partial<DayMeals> = {}): DayMeals {
  return {
    member: "Asha", date: "2026-10-06", day_status: "open",
    slots: [
      { slot: "breakfast", state: "eaten", totals: { kcal: 438.2, protein: 37.4 }, items: [item(), item({ id: 2, name: "Whey isolate", amount: { value: 1, unit: "measure", measure: "scoop" }, provenance: "label" })] },
      {
        slot: "lunch", state: "eaten", totals: { kcal: 656, protein: 42 },
        items: [
          item({ id: 3, source_kind: "portion", name: "Masoor dal", amount: { fraction: 0.38 }, portion_id: 7, provenance: "estimated", state: "draft", logged_by: { kind: "member", name: "Kabir" } }),
          item({ id: 4, source_kind: "manual", name: "Paneer bhurji", label: "1 bowl", amount: null, provenance: "estimated", plus_minus_kcal: 120, uncertainty: "bowl size" }),
        ],
      },
      { slot: "snack", state: "skipped", totals: null, items: [] },
      { slot: "dinner", state: "nothing_yet", totals: null, items: [] },
    ],
    estimate: { plus_minus_kcal: 120, estimated_items: 2, estimated_without_size: 1, dominant: { name: "1 bowl", description: "bowl size", kcal: 120 } },
    honesty: { imported: false, typed_macros: { items: 0, kcal: 0, share: null, high: false } },
    ...over,
  };
}

export function dalCook(over: Partial<DayCook> = {}): DayCook {
  return {
    cook_id: 11, name: "Masoor dal", cooked_on: "2026-10-06", meal_slot: "lunch", logged_by: { kind: "member", name: "Kabir" },
    components: [{
      component_id: 21, name: "whole",
      shares: [
        { portion_id: 7, member: "Asha", you: true, fraction: 0.38, weighed_g: null, provenance: "estimated", state: "draft" },
        { portion_id: 8, member: "Kabir", you: false, fraction: 0.34, weighed_g: null, provenance: "estimated", state: "confirmed" },
      ],
      remainder: { fraction: 0.28000000000000004, status: "unaccounted" },
    }],
    absent: ["Noor"],
    ask: {
      portion_id: 7, component_id: 21, fraction: 0.38, kcal: 180.4, plus_minus_kcal: 60, uncertainty: "ladle size", provenance: "estimated",
      logged_by: { kind: "member", name: "Kabir" }, records: [{ table: "portion", id: 7 }],
    },
    ...over,
  };
}

export function today(over: Partial<TodayData> = {}): TodayData {
  return {
    me: "Asha", members: ["Asha", "Kabir", "Noor"], today: "2026-10-06", viewing: "Asha", date: "2026-10-06",
    totals: totals(), meals: meals(), cooks: { member: "Asha", date: "2026-10-06", cooks: [dalCook()] },
    needs: null, timeZone: "Asia/Kolkata",
    next: { programming_mode: "prescribed", session: "Lower A", date: "2026-10-08" },
    waiting: [],
    ...over,
  };
}

export type Replies = Record<string, Outcome | ((input: Record<string, unknown>) => Outcome)>;

export function fake(replies: Replies) {
  const calls: { tool: string; input: Record<string, unknown> }[] = [];
  const call = async (tool: string, input: Record<string, unknown>): Promise<Outcome> => {
    calls.push({ tool, input });
    const r = replies[tool];
    if (!r) throw new Error(`unexpected call ${tool}`);
    return typeof r === "function" ? r(input) : r;
  };
  return { calls, call };
}

export const ok = (data: object): Outcome => ({ kind: "ok", data: { status: "ok", ...data } });

export const WHO: Who = { member: "Asha", members: ["Asha", "Kabir", "Noor"], today: "2026-10-06", time: "13:05", time_zone: "Asia/Kolkata" };

export const full: Replies = {
  day_totals: ok(totals()),
  day_meals: ok(meals()),
  day_cooks: ok({ member: "Asha", date: "2026-10-06", cooks: [dalCook()] }),
  needs_you: ok({ member: "Asha", date: "2026-10-06", cards: [], more: [] }),
  next_prescription: ok({ programming_mode: "prescribed", session: "Lower A", date: "2026-10-08" }),
  inbox_entries: ok({ entries: [], truncated: false }),
};


export function needs(over: Partial<NeedsYou> = {}): NeedsYou {
  return {
    member: "Asha", date: "2026-10-06",
    cards: [
      { rule: "drafts", count: 2, oldest: { table: "intake_item", id: 5, deadline: "2026-10-07T07:30:00Z", waits: null }, message: "m" },
      { rule: "remainder", cook_id: 11, cook: "Masoor dal", component_id: 21, component: null, fraction: 0.28, message: "m" },
      { rule: "yesterday_open", date: "2026-10-05", items: 4, message: "m" },
    ],
    more: [
      { rule: "load", session: "Upper A", date: "2026-10-08", prescriptions: [{ prescription_id: 1, exercise: "Row", state: { kind: "ready" } }, { prescription_id: 2, exercise: "Press", state: { kind: "check_at_gym" } }], message: "m" },
      { rule: "flag", flag_id: 3, subject: "Repeat the iron panel", due_on: "2026-10-10", more: 1, message: "m" },
      { rule: "measurement", cadence: "waist", last: null, message: "Waist is overdue." },
    ],
    ...over,
  };
}

/** The stress household's one-word dinner foods (wide-layout spec §7), named as the `--long` sample names them. */
const STRESS_WORDS = ["Ragi", "Bajra", "Jowar", "Moong", "Chana", "Urad", "Toor", "Besan", "Suji", "Makhana"] as const;

/**
 * The stress household's shapes (wide-layout spec §7) as view-model inputs,
 * the same invented data `npm run seed:sample -- --long` serves: Asha's
 * 11-item dinner (the last, 2 pieces of Tofu, with unknown kcal and protein),
 * Kabir with no target and nothing logged, 23 sessions, and one-word names.
 * Kabir here is a simplified empty case: the `--long` seed also gives him
 * pot portions (the shared dal and the leftovers' pots), so the app shows
 * him with items but no target.
 * `canaries`: the Private shape the `--long` seed writes (e2e spec §3).
 */
export function stressHousehold(): { today: TodayData; kabir: TodayData; sessions: SessionsList; names: { food: string; recipe: string; gym: string }; canaries: readonly Canary[] } {
  const dinner = [
    ...STRESS_WORDS.map((name, i) => item({ id: 100 + i, name, amount: { value: 30 + 5 * i, unit: "g" }, kcal: 100 + 7 * i, protein: 3 + i })),
    item({ id: 110, name: "Tofu", amount: { value: 2, unit: "piece" }, kcal: null, protein: null, provenance: "counted" }),
  ];
  const empty = (slot: string) => ({ slot, state: "nothing_yet" as const, totals: null, items: [] });
  const day = (back: number) => new Date(Date.parse("2026-10-06T00:00:00Z") - back * 86_400_000).toISOString().slice(0, 10);
  return {
    // Tofu by the piece: the dinner's and the day's sums leave it out, and say so (ticket 72).
    today: today({
      totals: totals({ unknown_items: { kcal: 1, protein: 1, carbs: 1, fat: 1 } }),
      meals: meals({ slots: [...meals().slots.slice(0, 3), { slot: "dinner", state: "eaten", totals: { kcal: 1315, protein: 75, unknown_items: { kcal: 1, protein: 1 } }, items: dinner }] }),
    }),
    kabir: today({
      viewing: "Kabir",
      totals: totals({ member: "Kabir", item_count: 0, draft_items: 0, so_far: {}, left: null, target_values: [] }),
      meals: meals({
        member: "Kabir",
        slots: ["breakfast", "lunch", "snack", "dinner"].map(empty),
        estimate: { plus_minus_kcal: null, estimated_items: 0, estimated_without_size: 0, dominant: null },
      }),
      cooks: { member: "Kabir", date: "2026-10-06", cooks: [] },
      needs: null,
    }),
    sessions: {
      member: "Asha",
      from: day(84),
      to: "2026-10-06",
      sessions: Array.from({ length: 23 }, (_, i) => ({
        id: 500 + i, date: day(12 + 3 * i), session_type: "strength", template: "Upper A", gym: "Ox", state: "confirmed", imported: false,
        working_sets: 6, volume_kg: 2400, records: [], cardio: null, energy_kcal: null, sets: [],
      })),
    },
    names: { food: "Ragi", recipe: "Upma", gym: "Ox" },
    canaries: CANARIES,
  };
}
