/**
 * The Reading tab (spec addendum 7 Oct 2026, A): one body reading of your
 * own. The metrics, their units, the sides and the last reading come from
 * reading_metrics; the change, the 7-day average and waist to height after
 * a Save come from log_reading. Nothing is computed here, and a weight's
 * body state and a sided metric's side are always asked.
 */
import { day, qty } from "./format";
import type { LoggedReading, ReadingMetric, ReadingMetrics } from "./types";
import { planStep, type Plan } from "./writes";
import { typedNumber } from "./typed";

export const BODY_STATES = [
  { value: "fasted", label: "Fasted" },
  { value: "fed", label: "Fed" },
  { value: "post_exercise", label: "After exercise" },
  { value: "not_recorded", label: "Not recorded" },
] as const;
export type BodyState = (typeof BODY_STATES)[number]["value"];

export interface ReadingDraft {
  metric: string | null;
  value: string;
  unit: string | null;
  bodyState: BodyState | null;
  side: "left" | "right" | null;
}

export function readingDraft(metric: string | null, bodyState: BodyState | null): ReadingDraft {
  return { metric, value: "", unit: null, bodyState, side: null };
}

/** Display order: the metrics you have logged, most recent first, then the rest by label. */
export function metricOptions(m: ReadingMetrics): ReadingMetric[] {
  const logged = m.metrics
    .filter((x) => x.last !== null)
    .sort((a, b) => (b.last?.date ?? "").localeCompare(a.last?.date ?? "") || a.label.localeCompare(b.label));
  const rest = m.metrics.filter((x) => x.last === null).sort((a, b) => a.label.localeCompare(b.label));
  return [...logged, ...rest];
}

/**
 * What the API's answer settles: your usual unit for this metric (the one
 * your readings of it use most, from reading_metrics; never simply the last
 * one used, click test P1-2), or its only unit, and "not recorded" for a
 * metric other than weight. Never the side, and never a weight's body state.
 */
export function settle(d: ReadingDraft, m: ReadingMetric | undefined): ReadingDraft {
  if (!m) return d;
  const usual = m.usual_unit && m.units.includes(m.usual_unit) ? m.usual_unit : null;
  return {
    ...d,
    unit: d.unit ?? usual ?? (m.units.length === 1 ? (m.units[0] ?? null) : null),
    bodyState: d.bodyState ?? (m.code === "weight" ? null : "not_recorded"),
  };
}

/** The value field's label, with the unit the value is in beside it: "Waist at navel, in cm". */
export function fieldLabel(m: ReadingMetric, unit: string | null): string {
  return unit ? `${m.label}, in ${unit}` : `${m.label} (choose the unit)`;
}

/** "Last: 77.6 kg on Sun 4 Oct." */
export function lastLine(m: ReadingMetric): string | null {
  const l = m.last;
  return l ? `Last: ${qty(l.value)} ${l.unit}${l.side ? `, ${l.side}` : ""} on ${day(l.date)}.` : null;
}

export function readingInput(member: string, date: string, d: ReadingDraft, m: ReadingMetric | undefined): { input: Record<string, unknown> } | { error: string } {
  if (!m) return { error: "Choose what you measured." };
  const value = typedNumber(d.value);
  if (d.value.trim() === "" || !Number.isFinite(value) || value <= 0) return { error: "Enter the reading as a number above 0." };
  if (!d.unit || !m.units.includes(d.unit)) return { error: "Choose the unit." };
  if (m.sides.length > 0 && !d.side) return { error: "Choose the side." };
  if (!d.bodyState) return { error: "Choose fasted, fed, after exercise or not recorded." };
  return { input: { member, date, metric: m.code, value, unit: d.unit, body_state: d.bodyState, ...(d.side ? { side: d.side } : {}) } };
}

/**
 * Whether the entry now on the form lets go of a failed Save held for
 * "Try again". Only a complete reading that differs from the held one does:
 * an edit that comes back to the held entry (a chip tapped again, a digit
 * typed and deleted) or one still incomplete keeps it, so a Save that
 * failed offline but landed is retried with its own keys, never written twice.
 */
export function releasesHeld(held: Record<string, unknown> | null, next: { input: Record<string, unknown> } | { error: string }): boolean {
  if (held === null || !("input" in next)) return false;
  const a = Object.keys(held).filter((k) => k !== "idempotency_key");
  const b = Object.keys(next.input).filter((k) => k !== "idempotency_key");
  return a.length !== b.length || b.some((k) => !Object.is(held[k], next.input[k]));
}

export function readingPlan(input: Record<string, unknown>): Plan {
  return { steps: [planStep("log_reading", input)], done: "Logged." };
}

const oneDecimal = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const twoDecimals = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** What log_reading returned, in words: the change since the previous reading, a weight's 7-day fasted average, the waist's waist to height. */
export function readingResult(r: LoggedReading): string[] {
  const lines: string[] = [];
  const change = r.computed.change;
  if (change) {
    const since = day(change.previous_on);
    lines.push(change.delta === 0 ? `Same as on ${since}.` : `${change.delta > 0 ? "Up" : "Down"} ${qty(Math.abs(change.delta))} ${r.reading.canonical_unit} since ${since}.`);
  }
  if (r.reading.metric === "weight") {
    const average = r.computed.seven_day_average_kg ?? null;
    lines.push(average === null ? "No 7-day fasted average yet: none of the last 7 days has a fasted weight." : `7-day fasted average: ${oneDecimal.format(average)} kg.`);
  }
  const ratio = r.computed.waist_to_height ?? null;
  if (ratio !== null) lines.push(`Waist to height: ${twoDecimals.format(ratio)}.`);
  return lines;
}
