import { daysBetween } from "./dates";
import type { IsoDate, StalenessItem } from "./types";

/**
 * The most overdue items worth raising, capped at `limit` (R5). `last: null`
 * means never performed, which always outranks anything merely overdue.
 * Items inside their interval are not returned. Ties keep input order.
 */
export function stalenessTop(items: readonly StalenessItem[], today: IsoDate, limit = 2): string[] {
  const overdue: { late: number; message: string }[] = [];
  for (const item of items) {
    if (item.last === null) {
      overdue.push({ late: Number.POSITIVE_INFINITY, message: item.message });
      continue;
    }
    const late = daysBetween(item.last, today) - item.everyDays;
    if (late > 0) overdue.push({ late, message: item.message });
  }
  return overdue
    .sort((a, b) => b.late - a.late)
    .slice(0, limit)
    .map((o) => o.message);
}
