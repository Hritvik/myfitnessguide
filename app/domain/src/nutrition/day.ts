import type {
  DayTotals,
  LeftLine,
  LeftToday,
  Macro,
  NutrientTotals,
  Nutrients,
  ResolvedTarget,
  Target,
} from "../types";
import { sumNutrients, totalsFrom } from "./totals";

/** Atwater factors, kcal per gram. */
export const KCAL_PER_G: Readonly<Record<Macro, number>> = { protein: 4, carbs: 4, fat: 9 };
const MACROS: readonly Macro[] = ["protein", "fat", "carbs"];

/**
 * A person's day totals from their intake items, with coverage. A legacy
 * manual DAY TOTAL counts only on a day with no items; a day with both
 * uses the items and reports the conflict.
 */
export function dayTotals(items: readonly { nutrients: NutrientTotals }[], manualDayTotal?: Nutrients): DayTotals {
  if (items.length > 0) {
    return { source: "items", totals: sumNutrients(items.map((i) => i.nutrients)), conflict: manualDayTotal !== undefined };
  }
  if (manualDayTotal !== undefined) return { source: "manual_day_total", totals: totalsFrom(manualDayTotal), conflict: false };
  return { source: "empty", totals: {}, conflict: false };
}

/**
 * Resolve floors and the remainder macro (Guide 34-35). At most one macro
 * may be the remainder: whatever kcal the others leave, at Atwater 4/4/9.
 * Throws RangeError for a target that cannot be resolved.
 */
export function resolveTarget(target: Target): ResolvedTarget {
  const remainders = MACROS.filter((m) => "remainder" in target[m]);
  if (remainders.length > 1) throw new RangeError(`only one macro can be the remainder; got ${remainders.join(", ")}`);

  const out = { kcal: target.kcal } as ResolvedTarget;
  let used = 0;
  for (const m of MACROS) {
    const t = target[m];
    if ("goal" in t) {
      out[m] = { goal: t.goal, floor: t.floor ?? null };
      used += t.goal * KCAL_PER_G[m];
    }
  }
  const remainder = remainders[0];
  if (remainder !== undefined) {
    const goal = (target.kcal - used) / KCAL_PER_G[remainder];
    if (goal < 0) throw new RangeError(`the other targets exceed ${target.kcal} kcal, leaving ${remainder} negative`);
    out[remainder] = { goal, floor: target[remainder].floor ?? null };
  }
  return out;
}

function line(goal: number, floor: number | null, totals: NutrientTotals, key: string): LeftLine {
  const t = totals[key];
  const consumed = t?.value ?? 0;
  return {
    goal,
    consumed,
    left: goal - consumed,
    floor,
    floorLeft: floor === null ? null : Math.max(0, floor - consumed),
    coverage: { known: t?.known ?? 0, of: t?.of ?? 0 },
  };
}

/** What is left today of each target, and how far below each floor. */
export function leftToday(target: Target, totals: NutrientTotals): LeftToday {
  const resolved = resolveTarget(target);
  return {
    kcal: line(resolved.kcal, null, totals, "kcal"),
    protein: line(resolved.protein.goal, resolved.protein.floor, totals, "protein"),
    fat: line(resolved.fat.goal, resolved.fat.floor, totals, "fat"),
    carbs: line(resolved.carbs.goal, resolved.carbs.floor, totals, "carbs"),
  };
}

/** Warn when a kcal target sits below BMR (Kabir 10); `by` is how far below. */
export function belowBmr(kcalTarget: number, bmrKcal: number): { below: boolean; by: number } {
  const by = bmrKcal - kcalTarget;
  return by > 0 ? { below: true, by } : { below: false, by: 0 };
}
