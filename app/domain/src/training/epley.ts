import { round1 } from "../rounding";

/**
 * Epley one-rep-max estimate on TOTAL load: w * (1 + reps / 30), to 1 dp.
 * Null when either input is missing. Callers pass the true total load,
 * never a rounded display value (the 12 Aug bench inconsistency).
 */
export function e1rm(totalLoadKg: number | null, reps: number | null): number | null {
  if (totalLoadKg === null || reps === null) return null;
  return round1(totalLoadKg * (1 + reps / 30));
}

/** Total load x reps, to 1 dp. Null when either input is missing. */
export function volume(totalLoadKg: number | null, reps: number | null): number | null {
  if (totalLoadKg === null || reps === null) return null;
  return round1(totalLoadKg * reps);
}
