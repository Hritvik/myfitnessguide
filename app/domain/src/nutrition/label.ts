import type { LabelEnergyCheck } from "../types";
import { KCAL_PER_G } from "./day";

/** The tolerance: 10% of the stated energy, or this many kcal when that is larger. */
export const LABEL_ENERGY_MIN_TOLERANCE_KCAL = 15;
export const LABEL_ENERGY_TOLERANCE_FRACTION = 0.1;

/**
 * Whether a label's macros reconcile with its stated energy by Atwater
 * (4 kcal per g protein and carbs, 9 per g fat), within max(10% of the
 * stated kcal, 15 kcal). A miss usually means a missing macro or a wrong
 * reference amount. `differenceKcal` is Atwater minus stated.
 */
export function labelEnergyCheck(label: { kcal: number; protein: number; carbs: number; fat: number }): LabelEnergyCheck {
  const atwaterKcal = label.protein * KCAL_PER_G.protein + label.carbs * KCAL_PER_G.carbs + label.fat * KCAL_PER_G.fat;
  const differenceKcal = atwaterKcal - label.kcal;
  const toleranceKcal = Math.max(LABEL_ENERGY_TOLERANCE_FRACTION * label.kcal, LABEL_ENERGY_MIN_TOLERANCE_KCAL);
  return { reconciles: Math.abs(differenceKcal) <= toleranceKcal + 1e-9, atwaterKcal, differenceKcal, toleranceKcal };
}
