/**
 * Closing a day (spec addendum 7 Oct 2026, B): on your own day, the meals
 * with nothing logged can be marked skipped, and the day closed as complete
 * or partial, in one set_day_status write. The status and the meals are
 * day_meals'; this only words them.
 */
import { day, list, slotLabel } from "./format";
import { waitingFor } from "./today";
import type { TodayData } from "./types";
import { planStep, type Plan } from "./writes";

export type DayStatus = "open" | "complete" | "partial";

export interface DayClose {
  status: DayStatus;
  heading: string;
  text: string;
  /** The meals with nothing logged and no Tell Claude text waiting; `skipped` is what the API has. */
  meals: { slot: string; label: string; skipped: boolean }[];
}

const OPEN = "When this day's logging is done, close it, so a meal with nothing logged never reads as a low-intake day.";

export function buildDayClose(data: TodayData): DayClose | null {
  if (data.me === null || data.viewing !== data.me) return null;
  const said = data.meals.day_status;
  const status: DayStatus = said === "complete" || said === "partial" ? said : "open";
  // A meal with a Tell Claude text still waiting is not offered as skipped: its food is on the way (decision 75).
  const meals = data.meals.slots
    .filter((s) => s.state !== "eaten" && waitingFor(data, s.slot).length === 0)
    .map((s) => ({ slot: s.slot, label: slotLabel(s.slot), skipped: s.state === "skipped" }));
  if (status === "open") return { status, heading: "Close the day", text: OPEN, meals };
  const skipped = data.meals.slots.filter((s) => s.state === "skipped").map((s) => slotLabel(s.slot));
  const how = status === "complete" ? "Closed: everything eaten is logged." : "Closed: some of what was eaten isn't logged.";
  return { status, heading: "Day closed", text: `${how}${skipped.length > 0 ? ` Skipped: ${list(skipped)}.` : ""}`, meals };
}

/**
 * The skipped meals to send: the member's ticks still offered, in the
 * panel's order. A meal ticked and then logged from the "+" sheet has left
 * `close.meals` (it is eaten now), so it is never sent as skipped.
 */
export function skippedToSend(close: DayClose, chosen: readonly string[]): string[] {
  return close.meals.filter((m) => chosen.includes(m.slot)).map((m) => m.slot);
}

/** One set_day_status. Closing saves the skipped meals with it; reopening leaves them as they are. */
export function dayStatusPlan(member: string, date: string, status: DayStatus, skipped: readonly string[]): Plan {
  if (status === "open") return { steps: [planStep("set_day_status", { member, date, status })], done: "Reopened." };
  return { steps: [planStep("set_day_status", { member, date, status, skipped_meals: [...skipped] })], done: "Day closed." };
}

/**
 * Unticking a meal the API has as skipped, on an open day (a reopened one):
 * one set_day_status that keeps the day open with the other skips, so the
 * meal stops reading "skipped" now, not at the next close. A tick the
 * member made here is the panel's own until the close sends it: null.
 */
export function unskipPlan(member: string, date: string, close: DayClose, slot: string): Plan | null {
  const meal = close.meals.find((m) => m.slot === slot);
  if (close.status !== "open" || !meal?.skipped) return null;
  const rest = close.meals.filter((m) => m.skipped && m.slot !== slot).map((m) => m.slot);
  return { steps: [planStep("set_day_status", { member, date, status: "open", skipped_meals: rest })], done: `${meal.label} is no longer skipped.` };
}

/** Closing with offered meals neither logged nor ticked asks once, since they will read "not recorded"; null when nothing is left so. */
export function closeAsk(close: DayClose, ticked: readonly string[]): string | null {
  const left = close.meals.filter((m) => !ticked.includes(m.slot)).map((m) => m.label);
  if (left.length === 0) return null;
  const one = left.length === 1;
  return `${list(left)} ${one ? "has" : "have"} nothing logged and ${one ? "isn't" : "aren't"} marked skipped, so ${one ? "it" : "they"} will read "not recorded". Close the day anyway?`;
}

/** The "+" sheet's word on a closed day: logging there counts and leaves it closed (only its member reopens it, on Today). */
export function closedDayNotice(status: string, date: string, forMember: string, me: string): string | null {
  if (status !== "complete" && status !== "partial") return null;
  const how = status === "complete" ? "everything is logged" : "some of it isn't logged";
  const own = forMember === me;
  return `${own ? "" : `${forMember}'s `}${day(date)} is closed: ${how}. What you log here counts, and the day stays closed${own ? "; reopen it on Today if more is coming" : ""}.`;
}
