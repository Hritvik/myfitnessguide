import type { Nutrients, NutrientTotals } from "../types";

/**
 * Totals with coverage from one flat record: each nutrient is one
 * contribution, known when it has a number (0 included), unknown when null.
 */
export function totalsFrom(nutrients: Nutrients): NutrientTotals {
  const out: Record<string, { value: number; known: number; of: number }> = {};
  for (const [key, value] of Object.entries(nutrients)) {
    const known = typeof value === "number";
    out[key] = { value: known ? value : 0, known: known ? 1 : 0, of: 1 };
  }
  return out;
}

/** Scale every nutrient's value; coverage counts are unchanged. */
export function scaleTotals(totals: NutrientTotals, factor: number): NutrientTotals {
  const out: Record<string, { value: number; known: number; of: number }> = {};
  for (const [key, t] of Object.entries(totals)) out[key] = { ...t, value: t.value * factor };
  return out;
}

/**
 * Sum totals. A nutrient absent from one part counts as unknown there, so
 * coverage (known / of) shows how much of the sum is real.
 */
export function sumNutrients(parts: readonly NutrientTotals[]): NutrientTotals {
  const keys = new Set(parts.flatMap((p) => Object.keys(p)));
  const out: Record<string, { value: number; known: number; of: number }> = {};
  for (const key of keys) {
    let value = 0;
    let known = 0;
    let of = 0;
    for (const part of parts) {
      const t = part[key];
      if (t) {
        value += t.value;
        known += t.known;
        of += t.of;
      } else {
        of += 1;
      }
    }
    out[key] = { value, known, of };
  }
  return out;
}

/** Nutrients for `multiples` reference amounts of a source. */
export function scaleNutrients(nutrients: Nutrients, multiples: number): NutrientTotals {
  return scaleTotals(totalsFrom(nutrients), multiples);
}
