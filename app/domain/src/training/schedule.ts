import { addDays, dayNumber, weekdayOf } from "../dates";
import type { IsoDate, NextSession, Schedule } from "../types";

export const ROTATION: readonly string[] = ["Upper A", "Lower A", "Upper B", "Lower B"];

/** The session that follows `last` in the rotation (R16). */
export function nextInRotation(last: string, rotation: readonly string[] = ROTATION): string {
  const index = rotation.indexOf(last);
  if (index === -1) throw new RangeError(`${last} is not in the rotation ${rotation.join(", ")}`);
  return rotation[(index + 1) % rotation.length] as string;
}

/** Days to look ahead for a weekday plan: two full weeks covers any swap. */
const LOOKAHEAD_DAYS = 14;

/**
 * The next session a programme's schedule calls for. A rotation follows the
 * last session logged and has no date. A fixed weekday plan gives the first
 * planned day from today (or tomorrow, once today is trained), with one-off
 * swaps replacing that date's session; the two never combine.
 */
export function nextSession(
  schedule: Schedule,
  context: { today: IsoDate; last: { session: string; date: IsoDate } | null },
): NextSession | null {
  if (schedule.kind === "rotation") {
    const first = schedule.order[0];
    if (first === undefined) return null;
    const session = context.last ? nextInRotation(context.last.session, schedule.order) : first;
    return { session, date: null };
  }

  const trainedToday = context.last !== null && dayNumber(context.last.date) >= dayNumber(context.today);
  const start = trainedToday ? 1 : 0;
  for (let offset = start; offset < start + LOOKAHEAD_DAYS; offset++) {
    const date = addDays(context.today, offset);
    const swap = schedule.swaps.find((s) => s.date === date);
    const session = swap ? swap.session : schedule.days[weekdayOf(date)];
    if (session) return { session, date };
  }
  return null;
}
