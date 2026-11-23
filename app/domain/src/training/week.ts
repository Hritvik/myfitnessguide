import { daysBetween } from "../dates";
import type { IsoDate } from "../types";

/**
 * Hritvik's week 1 began Sunday 2026-07-26. The app keeps an anchor per
 * person; this is the default because it is the one the Sheets data used.
 */
export const WEEK1_ANCHOR: IsoDate = "2026-07-26";

/**
 * Programme week number for a date, 1-based. Throws RangeError for a date
 * before the anchor, which would otherwise silently be week 0 or negative.
 */
export function weekOf(date: IsoDate, anchor: IsoDate = WEEK1_ANCHOR): number {
  const delta = daysBetween(anchor, date);
  if (delta < 0) throw new RangeError(`${date} is before the programme anchor ${anchor}`);
  return Math.floor(delta / 7) + 1;
}
