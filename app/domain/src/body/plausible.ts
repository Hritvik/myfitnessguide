/**
 * Whether a body reading is plausible (click test P1-2), in the metric's
 * canonical unit (kg, cm, mmHg, bpm, h, pct, score). Two rules, as the
 * training side's implausible-load check: a range per metric that no adult
 * reading falls outside, and, for a weight, height or circumference (which
 * change slowly), a ratio against the member's last reading of it beyond
 * which a unit slip (in for cm, lb for kg, mm for cm) is likelier than a real
 * change. A result is a question for the member, never a refusal.
 */
export interface ReadingBounds {
  low: number;
  high: number;
}

export type ImplausibleReading = { kind: "out_of_range"; low: number; high: number } | { kind: "far_from_last"; previous: number; ratio: number };

/** Wide adult ranges, canonical units. */
export const READING_BOUNDS: Readonly<Record<string, ReadingBounds>> = {
  weight: { low: 20, high: 300 },
  height: { low: 100, high: 230 },
  waist_navel: { low: 40, high: 200 },
  abdomen_widest: { low: 40, high: 200 },
  hips: { low: 40, high: 200 },
  chest: { low: 50, high: 200 },
  shoulders: { low: 60, high: 200 },
  arm: { low: 15, high: 70 },
  thigh: { low: 25, high: 110 },
  neck: { low: 20, high: 70 },
  skinfold_chest: { low: 0.2, high: 8 },
  skinfold_abdomen: { low: 0.2, high: 8 },
  skinfold_thigh: { low: 0.2, high: 8 },
  bp_systolic: { low: 60, high: 260 },
  bp_diastolic: { low: 30, high: 160 },
  resting_hr: { low: 25, high: 160 },
  sleep: { low: 0.5, high: 16 },
  bia_skeletal_muscle_mass: { low: 8, high: 80 },
  bia_body_fat_mass: { low: 1, high: 200 },
  bia_body_fat_pct: { low: 2, high: 70 },
  bia_fat_free_mass: { low: 15, high: 150 },
  bia_visceral_fat: { low: 1, high: 60 },
};

/** Metrics that change slowly enough for the last-reading check. */
const SLOW: ReadonlySet<string> = new Set(["weight", "height", "waist_navel", "abdomen_widest", "hips", "chest", "shoulders", "arm", "thigh", "neck"]);

/** Past this ratio to the last reading (either way), a slow metric is asked about. */
export const READING_RATIO = 1.25;

export function implausibleReading(metric: string, value: number, previous: number | null): ImplausibleReading | null {
  const b = READING_BOUNDS[metric];
  if (!b) return null;
  if (value < b.low || value > b.high) return { kind: "out_of_range", low: b.low, high: b.high };
  if (previous === null || previous <= 0 || !SLOW.has(metric)) return null;
  const ratio = value / previous;
  return ratio > READING_RATIO || ratio < 1 / READING_RATIO ? { kind: "far_from_last", previous, ratio } : null;
}
