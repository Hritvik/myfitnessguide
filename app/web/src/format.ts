import type { LoadAmount, PrescribedLoad } from "./types";

/**
 * Display formatting only: rounding for reading, dates, plural words. No
 * nutrition is computed here; every number arrives from the API.
 */

const whole = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/** A whole number with grouping: 1194.4 -> "1,194". Estimates never show a decimal. */
export function n(value: number): string {
  const s = whole.format(Math.round(value));
  return s === "-0" ? "0" : s;
}

const quantity = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

/** An amount as entered, to at most two decimals: 0.3333 -> "0.33". */
export function qty(value: number): string {
  return quantity.format(value);
}

/** A share of a whole, as a whole percent: 0.38 -> "38%". */
export function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** ICU versions disagree on September in en-GB ("Sep" or "Sept"); print "Sep" everywhere so screens and tests are stable. */
const stableMonths = (s: string) => s.replace(/\bSept\b/, "Sep");

const dayFormat = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** "2026-10-06" -> "Tue 6 Oct". */
export function day(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return stableMonths(dayFormat.format(new Date(Date.UTC(y, m - 1, d))));
}

const longFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "2027-03-28" -> "28 Mar 2027", for dates that may be in another year. */
export function longDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return stableMonths(longFormat.format(new Date(Date.UTC(y, m - 1, d))));
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c". */
export function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Every food state, in the API's order (catalogue.ts STATES): the new-food picker and the label reader share it. */
export const FOOD_STATES = ["as_sold", "raw", "dry", "cooked", "soaked", "drained", "shelled", "in_shell"] as const;

/** A food state in words: "as_sold" -> "as sold", "in_shell" -> "in shell". */
export function stateLabel(state: string): string {
  return state.replace(/_/g, " ");
}

/** A food source as the member reads it: "Greek yogurt (as sold)". */
export function foodLabel(name: string, state: string): string {
  return saysState(name, state) ? name : `${name} (${stateLabel(state)})`;
}

/** Whether a food's name already ends on its state in words ("White rice, cooked"), so the label needn't repeat it. */
function saysState(name: string, state: string): boolean {
  return new RegExp(`(^|[\\s,(-])${stateLabel(state)}\\)?$`, "i").test(name.trim());
}

const STATE_IN_LABEL = new RegExp(`\\((${FOOD_STATES.join("|")})(?:, [A-Z]{1,4}\\d+)?\\)`, "g");

/**
 * A catalogue label from the API in the member's words: the state code
 * loses its underscore and the ref goes ("Greek yogurt (as_sold, FS007)"
 * -> "Greek yogurt (as sold)"). The agent reads the codes; the app doesn't.
 */
export function plainFood(label: string): string {
  return label.replace(STATE_IN_LABEL, (_m, state: string, offset: number) =>
    saysState(label.slice(0, offset), state) ? "\u0000" : `(${stateLabel(state)})`,
  ).replace(/\s?\u0000/g, "");
}

const REF = /\b[A-Z]{1,4}\d+\b/;
const SHORT_WORDS = 40;

/**
 * An uncertainty an agent described, as a few words for a sentence: its
 * first sentence, a capital lowered unless it starts an acronym, the end
 * stop dropped. Null when that is still a note (longer than 40 characters,
 * or naming a ref), so the caller names the item instead.
 */
export function shortUncertainty(text: string | null | undefined): string | null {
  const first = (text ?? "").trim().split(/(?<=[.;!?])\s/)[0]!.replace(/[.;!?,\s]+$/, "");
  if (!first || first.length > SHORT_WORDS || REF.test(first)) return null;
  return /^[A-Z][a-z]/.test(first) ? first.charAt(0).toLowerCase() + first.slice(1) : first;
}

/** A reason the API wrote for the agent, without its own trailing aside in brackets ("… by hand (manual rule)"), so the app's brackets never nest. */
export function plainReason(reason: string): string {
  return reason.replace(/\s*\([^()]*\)\s*$/, "").trim() || reason;
}

export function sentenceCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const SLOT_LABELS: Record<string, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  snack: "Snack",
  dinner: "Dinner",
  pre_workout: "Pre-workout",
  post_workout: "Post-workout",
};

export function slotLabel(slot: string): string {
  return SLOT_LABELS[slot] ?? sentenceCase(slot.replace(/_/g, " "));
}

const loadAmountText = (a: LoadAmount) => `${qty(a.value)} ${a.unit}`;
const PER: Record<string, string> = { per_side: " a side", per_hand: " a hand", per_leg: " a leg" };

/** A prescribed load as it goes on the bar: "20 kg bar + 10 kg + 5 lb a side", "2 × 20 kg a side", "16 kg". */
export function loadText(load: PrescribedLoad): string {
  const per = PER[load.basis ?? ""] ?? "";
  if (!load.plates && load.value < 0) return `${qty(-load.value)} ${load.unit} assistance${per}`;
  const side = load.plates ? load.plates.map((p) => `${p.count > 1 ? `${p.count} × ` : ""}${loadAmountText(p)}`).join(" + ") : loadAmountText(load);
  return `${load.bar ? `${loadAmountText(load.bar)} bar + ` : ""}${side}${per}`;
}

// ---- partial sums (ticket 72, web decision 118) ---------------------------------------------

/** A sum that leaves out `unknown` items is at least what it reads: "1,315+". */
export function atLeast(value: number, unknown = 0): string {
  return `${n(value)}${unknown > 0 ? "+" : ""}`;
}

/** What is left, when the sum it subtracts leaves out items, is at most what it reads: "at most " (else nothing). */
export function atMostWord(unknown = 0): string {
  return unknown > 0 ? "at most " : "";
}

/** How many items a set of sums leaves out: the Worker's `any` (each item once), else the larger of kcal's and protein's. */
export function unknownCount(u: { kcal?: number; protein?: number; any?: number } | undefined): number {
  return u?.any ?? Math.max(u?.kcal ?? 0, u?.protein ?? 0);
}

/** The count a partial sum carries: " · 1 item unknown", or nothing when the sum is whole. */
export function unknownTail(count = 0): string {
  return count > 0 ? ` · ${plural(count, "item", "items")} unknown` : "";
}
