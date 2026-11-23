import type { IsoDate, Weekday } from "./types";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

export const WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Days since 1970-01-01 for an ISO date. Throws RangeError if malformed. */
export function dayNumber(date: IsoDate): number {
  const match = ISO_DATE.exec(date);
  if (!match) throw new RangeError(`${date} is not an ISO date (YYYY-MM-DD)`);
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(y, m - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new RangeError(`${date} is not a real calendar date`);
  }
  return ms / MS_PER_DAY;
}

/** The ISO date for a day number. */
export function fromDayNumber(day: number): IsoDate {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromDayNumber(dayNumber(date) + days);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return dayNumber(to) - dayNumber(from);
}

export function weekdayOf(date: IsoDate): Weekday {
  // 1970-01-01 was a Thursday.
  const index = (((dayNumber(date) + 4) % 7) + 7) % 7;
  return WEEKDAYS[index] as Weekday;
}

/** The Sunday that starts the calendar week containing `date`. */
export function weekStart(date: IsoDate): IsoDate {
  return addDays(date, -WEEKDAYS.indexOf(weekdayOf(date)));
}
