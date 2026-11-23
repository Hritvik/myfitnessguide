import { roundHalfEven } from "../rounding";
import type { WholeUnits } from "../types";

/** The international pound, exactly. */
export const KG_PER_LB = 0.45359237;
export const LB_PER_KG = 1 / KG_PER_LB;
export const DEFAULT_BAR_KG = 20;

// The sheet stored loads in kg rounded to 1 dp, so a stored value can sit up
// to 0.05 kg from the true load: 0.11 lb. Every lb-side check tolerates at
// least that, or a genuine 12.5 lb dumbbell (stored 5.7, truly 5.6699)
// fails to round-trip. kg-side checks stay tight.
const LB_TOL = 0.12;
const KG_INT_TOL = 0.05;
const KG_HALF_TOL = 0.06;

/** Snap value to the nearest multiple of step, if within tol. */
function near(value: number, step: number, tol: number): number | null {
  const snapped = Math.round(value / step) * step;
  return Math.abs(value - snapped) <= tol ? snapped : null;
}

/**
 * Express a kg load the way it is actually loaded on the floor (R13).
 *
 * Resolution order is deliberate:
 *   1. barbell context whose plates resolve to clean pounds -> combination
 *   2. whole kg    (stack machines, most cables)
 *   3. whole lb    (5 lb and 10 lb dumbbells)
 *   4. half kg     (12.5, 17.5, 32.5 stack increments)
 *   5. half lb     (7.5 lb, 12.5 lb dumbbells)
 *   6. fall back to kg, to 2 dp
 *
 * This reads a rounded legacy kg value back into floor units. With an
 * implement inventory, prefer snapToImplement.
 */
export function wholeUnits(
  kg: number | null,
  options: { context?: "barbell"; barKg?: number } = {},
): WholeUnits | null {
  if (kg === null) return null;
  const barKg = options.barKg ?? DEFAULT_BAR_KG;

  if (options.context === "barbell") {
    const plateTotal = kg - barKg;
    if (plateTotal > 0.05) {
      const perSideLb = (plateTotal * LB_PER_KG) / 2;
      const snapped = near(perSideLb, 0.5, LB_TOL);
      if (snapped !== null) {
        return { unit: "combination", description: `${barKg} kg bar + ${snapped} lb per side` };
      }
    }
  }

  let snapped = near(kg, 1, KG_INT_TOL);
  if (snapped !== null) return { unit: "kg", value: snapped };

  const lb = kg * LB_PER_KG;
  snapped = near(lb, 1, LB_TOL);
  if (snapped !== null) return { unit: "lb", value: snapped };

  snapped = near(kg, 0.5, KG_HALF_TOL);
  if (snapped !== null) return { unit: "kg", value: snapped };

  snapped = near(lb, 0.5, LB_TOL);
  if (snapped !== null) return { unit: "lb", value: snapped };

  return { unit: "kg", value: roundHalfEven(kg, 2) };
}
