import { dayNumber, weekdayOf } from "../dates";
import type { FallbackCoverage, GapPrescription, IsoDate, StimulusTags, Weekday } from "../types";

/**
 * Prescriptions never performed since they were prescribed: GAPS, carried
 * forward until done (Handover 13 (4)). An ordinary skip of something done
 * before is not returned: there are no cross-session make-ups. `performed`
 * is every working set's exercise and date. Oldest prescription first.
 */
export function neverPerformedGaps<P extends GapPrescription>(
  prescriptions: readonly P[],
  performed: readonly { exerciseId: string; date: IsoDate }[],
): P[] {
  return prescriptions
    .filter(
      (p) => !performed.some((s) => s.exerciseId === p.exerciseId && dayNumber(s.date) >= dayNumber(p.prescribedOn)),
    )
    .sort((a, b) => dayNumber(a.prescribedOn) - dayNumber(b.prescribedOn));
}

const STIMULUS_KEYS: readonly (keyof StimulusTags)[] = ["mechanics", "position"];

/**
 * Whether doing `fallback` in place of `prescribed` counts as coverage
 * (Handover 13 (2)): only when every stimulus tag matches. A tag missing on
 * either side is a mismatch, never assumed to match.
 */
export function fallbackCoverage(prescribed: StimulusTags, fallback: StimulusTags): FallbackCoverage {
  const mismatches = STIMULUS_KEYS.filter(
    (k) => prescribed[k] === undefined || fallback[k] === undefined || prescribed[k] !== fallback[k],
  );
  return { covered: mismatches.length === 0, mismatches };
}

/** Whether a stated weekday matches the date it is written against. */
export function checkWeekday(date: IsoDate, stated: Weekday): { consistent: boolean; actual: Weekday } {
  const actual = weekdayOf(date);
  return { consistent: actual === stated, actual };
}
