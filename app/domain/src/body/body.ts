import { addDays, dayNumber, weekStart } from "../dates";
import type { BodyReading, EnergyAvailability, GoalVerdict, IsoDate } from "../types";

const EPS = 1e-9;

/**
 * The 7-day fasted average: fasted readings from date-6 to date inclusive.
 * Readings before the latest method change on or before `date` are left
 * out, since trends never draw across one. Null when there are none.
 */
export function sevenDayAverage(
  readings: readonly BodyReading[],
  date: IsoDate,
  methodChanges: readonly IsoDate[] = [],
): number | null {
  const end = dayNumber(date);
  const lastChange = Math.max(-Infinity, ...methodChanges.map(dayNumber).filter((d) => d <= end));
  const start = Math.max(dayNumber(addDays(date, -6)), lastChange);
  const window = readings.filter((r) => r.fasted === true && dayNumber(r.date) >= start && dayNumber(r.date) <= end);
  if (window.length === 0) return null;
  return window.reduce((sum, r) => sum + r.value, 0) / window.length;
}

/** Waist:height from the person's stored height, both in the same unit. */
export function waistToHeight(waist: number, height: number): number {
  return waist / height;
}

/** A change within one resolution step of the instrument is not a change. */
export function isRealChange(previous: number, next: number, resolution: number): boolean {
  return Math.abs(next - previous) > resolution + EPS;
}

/**
 * Split a series into segments at each method change, so no trend line is
 * drawn across one. A reading on a change date starts the new segment.
 * Readings are sorted by date; empty segments are dropped.
 */
export function trendSegments<R extends { date: IsoDate }>(readings: readonly R[], methodChanges: readonly IsoDate[]): R[][] {
  const sorted = [...readings].sort((a, b) => dayNumber(a.date) - dayNumber(b.date));
  const changes = [...methodChanges].map(dayNumber).sort((a, b) => a - b);
  const segments: R[][] = Array.from({ length: changes.length + 1 }, () => []);
  for (const r of sorted) {
    const d = dayNumber(r.date);
    const index = changes.filter((c) => c <= d).length;
    segments[index]?.push(r);
  }
  return segments.filter((s) => s.length > 0);
}

/** Below this many kcal per kg of fat-free mass, energy availability is flagged. */
export const LOW_EA_KCAL_PER_KG_FFM = 25;

/** Energy availability = (intake - exercise kcal) / fat-free mass (Handover 16 p6b). */
export function energyAvailability(input: { intakeKcal: number; exerciseKcal: number; ffmKg: number }): EnergyAvailability {
  if (!(input.ffmKg > 0)) throw new RangeError("fat-free mass must be positive");
  const value = (input.intakeKcal - input.exerciseKcal) / input.ffmKg;
  return { value, low: value < LOW_EA_KCAL_PER_KG_FFM };
}

/** Consecutive weekly readings outside the band before a goal is "behind". */
export const BEHIND_AFTER_WEEKS = 3;

/**
 * Goal verdict (Guide 18-20). Compare the week's latest reading with that
 * week's goal point, never an interpolated line. Within `band` (default
 * 1.0) is on track. Beyond it on the good side is ahead at once. Beyond it
 * on the bad side is behind only after three consecutive calendar weeks of
 * readings outside the band; until then it is on track, with the count.
 * With `asOf`, the week judged is the one holding `asOf`, using readings up to it.
 */
export function goalVerdict(
  readings: readonly { date: IsoDate; value: number }[],
  goalPoints: readonly { date: IsoDate; value: number }[],
  options: { direction: "decrease" | "increase"; band?: number; asOf?: IsoDate },
): GoalVerdict {
  const band = options.band ?? 1.0;
  const sign = options.direction === "decrease" ? 1 : -1;

  // With asOf, judge the week holding it, from the readings up to it; without, the latest week with a reading.
  const asOf = options.asOf;
  const considered = asOf === undefined ? readings : readings.filter((r) => dayNumber(r.date) <= dayNumber(asOf));
  const latestByWeek = new Map<IsoDate, { date: IsoDate; value: number }>();
  for (const r of considered) {
    const week = weekStart(r.date);
    const held = latestByWeek.get(week);
    // Readings come in date then entry order: of two on one day the later wins, as a chart shows it last (decision 50).
    if (!held || dayNumber(r.date) >= dayNumber(held.date)) latestByWeek.set(week, r);
  }
  const goalByWeek = new Map(goalPoints.map((g) => [weekStart(g.date), g.value] as const));

  let week: IsoDate | undefined;
  if (asOf !== undefined) {
    week = weekStart(asOf);
    const held = latestByWeek.get(week);
    const g = goalByWeek.get(week);
    if (g === undefined) return { verdict: "no_goal_point", week, reading: held?.value ?? null, goal: null, deviation: null, weeksBehind: 0 };
    if (held === undefined) return { verdict: "no_reading", week, reading: null, goal: g, deviation: null, weeksBehind: 0 };
  } else {
    const weeks = [...latestByWeek.keys()].sort((a, b) => dayNumber(a) - dayNumber(b));
    week = weeks[weeks.length - 1];
    if (week === undefined) {
      return { verdict: "no_reading", week: null, reading: null, goal: null, deviation: null, weeksBehind: 0 };
    }
  }
  const reading = (latestByWeek.get(week) as { value: number }).value;
  const goal = goalByWeek.get(week);
  if (goal === undefined) {
    return { verdict: "no_goal_point", week, reading, goal: null, deviation: null, weeksBehind: 0 };
  }
  const deviation = reading - goal;

  const behindIn = (w: IsoDate): boolean => {
    const r = latestByWeek.get(w);
    const g = goalByWeek.get(w);
    return r !== undefined && g !== undefined && sign * (r.value - g) > band + EPS;
  };
  let weeksBehind = 0;
  for (let w = week; behindIn(w); w = addDays(w, -7)) weeksBehind++;

  let verdict: GoalVerdict["verdict"];
  if (Math.abs(deviation) <= band + EPS) verdict = "on_track";
  else if (sign * deviation < 0) verdict = "ahead";
  else verdict = weeksBehind >= BEHIND_AFTER_WEEKS ? "behind" : "on_track";
  return { verdict, week, reading, goal, deviation, weeksBehind };
}
