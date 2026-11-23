import { dayNumber } from "../dates";
import type { ImplausibleLoad, IsoDate } from "../types";
import { LB_PER_KG } from "./units";

/** A load this far from the reference, either way, is worth questioning. */
export const IMPLAUSIBLE_RATIO = 1.6;
/** How close a ratio must be to a known factor to name it as the cause. */
const CAUSE_TOLERANCE = 0.05;

const CAUSES: readonly { factor: number; cause: ImplausibleLoad["likelyCause"] }[] = [
  { factor: LB_PER_KG, cause: "lb_entered_as_kg" },
  { factor: 1 / LB_PER_KG, cause: "kg_entered_as_lb" },
  { factor: 2, cause: "basis_doubled" },
  { factor: 0.5, cause: "basis_halved" },
];

/**
 * Warn when a new total load is implausible against the exercise's history
 * (Guide 111). The reference is the heaviest set of the most recent date in
 * the history. Assisted (negative) loads compare by size. Returns null when
 * plausible or when there is no history. A warning never blocks a write.
 */
export function implausibleLoad(
  totalKg: number,
  history: readonly { date: IsoDate; totalKg: number }[],
): ImplausibleLoad | null {
  if (history.length === 0) return null;
  const latest = Math.max(...history.map((h) => dayNumber(h.date)));
  const recent = history.filter((h) => dayNumber(h.date) === latest);
  const referenceKg = recent.reduce((a, b) => (Math.abs(b.totalKg) > Math.abs(a) ? b.totalKg : a), 0);
  const referenceAbs = Math.abs(referenceKg);
  if (referenceAbs === 0) return null;

  const ratio = Math.abs(totalKg) / referenceAbs;
  if (ratio < IMPLAUSIBLE_RATIO && ratio > 1 / IMPLAUSIBLE_RATIO) return null;

  const named = CAUSES.find((c) => Math.abs(ratio / c.factor - 1) <= CAUSE_TOLERANCE);
  return { ratio, referenceKg, likelyCause: named ? named.cause : "unknown" };
}
