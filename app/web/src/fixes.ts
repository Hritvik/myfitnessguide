/**
 * Fixing or removing what a member logged (ticket 61): a confirmed food on
 * Today, a confirmed set on Train. Remove is one `retract` of the record the
 * API takes (a pot share's portion, a leftover helping's serving, else the
 * intake item); Edit is an `amend` of only the fields that changed, one step
 * per record. Both reasons are fixed: the member types nothing.
 */
import { amountChips, switchMeasure, type AmountDraft } from "./food";
import { day, qty, slotLabel } from "./format";
import { parseRir } from "./setEntry";
import type { DescribedSet, MealItem, ReadingMetrics, RecordRef } from "./types";
import { planStep, type Plan } from "./writes";
import { typedNumber } from "./typed";

export const REMOVED_REASON = "Removed in the app";
export const CORRECTED_REASON = "Corrected in the app";

/** Where an item's amount is amended, and its value as the form shows it (a pot share's fraction as a percent). */
export interface ItemAmount {
  table: "intake_item" | "portion";
  id: number;
  field: "amount_value" | "recipe_servings" | "fraction" | "weighed_g";
  value: string;
  unit: string;
  /**
   * A food item's measures, then its own unit (click test P2-8), and the one
   * it is stored in; absent for any other amount, or a food whose measure
   * the list doesn't hold.
   */
  options?: AmountOption[];
  current?: number;
  /** The food's unit and measures, to convert an amount between them. */
  food?: NonNullable<MealItem["food"]>;
}

/** A measure the Edit offers: "egg (50 g)" or the food's own unit. */
export interface AmountOption {
  label: string;
  measure?: string;
  unit?: string;
}

export interface ItemEdit {
  itemId: number;
  /** Whose item: the member a new amount is checked for (what_if, their usual amount). */
  member?: string;
  slot: string;
  date: string;
  /** Null for a typed item, which has no amount to change here. */
  amount: ItemAmount | null;
}

export interface ItemFix {
  /** The record `retract` takes. */
  remove: RecordRef;
  /** "Remove 2 pc Whole egg from Breakfast?" */
  ask: string;
  /** A leftover helping's amount is its serving's, which amend can't change: remove it and log it again. */
  edit: ItemEdit | "leftover";
}

export interface ItemEditDraft {
  amount: string;
  slot: string;
  date: string;
  /** The chosen measure's index in the amount's options. */
  option?: number;
}

/** A value as a field holds it: at most two decimals, no grouping (so it reads back as a number). */
const num = (v: number): string => String(Math.round(v * 100) / 100);

const UNIT_WORDS: Record<string, string> = { piece: "pc" };

function itemAmount(i: MealItem): ItemAmount | null {
  const a = i.amount;
  if (!a) return null;
  if (i.source_kind === "portion" && i.portion_id !== null) {
    if (a.weighed_g !== undefined) return { table: "portion", id: i.portion_id, field: "weighed_g", value: num(a.weighed_g), unit: "g" };
    if (a.fraction !== undefined && a.fraction !== null) return { table: "portion", id: i.portion_id, field: "fraction", value: num(a.fraction * 100), unit: "% of the pot" };
    return null;
  }
  if (i.source_kind === "recipe" && a.servings !== undefined) return { table: "intake_item", id: i.id, field: "recipe_servings", value: num(a.servings), unit: "servings" };
  if (i.source_kind === "food_source" && a.value !== undefined && a.unit) {
    const unit = a.unit === "measure" ? (a.measure ?? "measure") : (UNIT_WORDS[a.unit] ?? a.unit);
    const amount: ItemAmount = { table: "intake_item", id: i.id, field: "amount_value", value: num(a.value), unit };
    const food = i.food;
    if (!food) return amount;
    const options = amountChips(food);
    const current = options.findIndex((o) => (a.unit === "measure" ? o.measure === a.measure : o.unit === a.unit));
    return current < 0 ? amount : { ...amount, options, current, food };
  }
  return null;
}

/** The unit words an option's amount is counted in: "egg", "g", "pc". */
export const optionUnit = (o: AmountOption): string => o.measure ?? UNIT_WORDS[o.unit ?? ""] ?? o.unit ?? "";

/**
 * Choosing another measure in a food's Edit: the amount is converted so it
 * still means the same food (as the Food tab's chips do, click test P1-1).
 */
export function switchItemMeasure(a: ItemAmount, d: ItemEditDraft, option: number): ItemEditDraft {
  const to = a.options?.[option];
  const from = a.options?.[d.option ?? a.current ?? -1];
  if (!to || !from || !a.food) return { ...d, option };
  const next = switchMeasure(
    { value: d.amount, unit: from.unit ?? null, measure: from.measure ?? null, provenance: "estimated", uncertainty: "", uncertaintyKcal: "" },
    a.food,
    to.measure ? { measure: to.measure } : { unit: to.unit },
  );
  return { ...d, amount: next.value, option };
}

/** An own, confirmed item's Edit and Remove; `amountText` is the row's own words for the amount. */
export function itemFix(i: MealItem, slot: string, date: string, amountText: string | null = null, member: string | null = null): ItemFix {
  const leftover = i.leftover_serving_id ?? null;
  const remove: RecordRef =
    i.portion_id !== null ? { table: "portion", id: i.portion_id } : leftover !== null ? { table: "leftover_serving", id: leftover } : { table: "intake_item", id: i.id };
  const shown = amountText ?? defaultAmount(i);
  const ask = `Remove ${shown ? `${shown} ` : ""}${i.name ?? "this item"} from ${slotLabel(slot)}?`;
  return { remove, ask, edit: leftover !== null ? "leftover" : { itemId: i.id, ...(member ? { member } : {}), slot, date, amount: itemAmount(i) } };
}

function defaultAmount(i: MealItem): string | null {
  const a = itemAmount(i);
  if (!a) return null;
  return a.field === "fraction" ? `${a.value}% of the pot` : `${a.value} ${a.unit}`;
}

export function removeItemPlan(record: RecordRef): Plan {
  return { steps: [planStep("retract", { records: [record], reason: REMOVED_REASON })], done: "Removed." };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A food item's new amount, to check before Save as the Food tab checks a new
 * one (click test P1-1, review P2): what_if's item for its kcal, and the
 * draft foodCheck compares with the member's usual amount. Null when the
 * amount and measure are as they were, or the item isn't a food.
 */
export function editAmountCheck(e: ItemEdit, d: ItemEditDraft): { item: Record<string, unknown>; draft: AmountDraft; ref: string } | null {
  const a = e.amount;
  if (!a || a.field !== "amount_value" || !a.food || !a.options) return null;
  const option = a.options[d.option ?? a.current ?? -1];
  const value = typedNumber(d.amount);
  if (!option || !d.amount.trim() || !Number.isFinite(value) || value <= 0) return null;
  if (d.amount.trim() === a.value && (d.option ?? a.current) === a.current) return null;
  const unit = option.measure ? null : (option.unit ?? null);
  return {
    item: { source: "food", food: a.food.ref, value, ...(option.measure ? { measure: option.measure } : { unit }), provenance: "estimated", confidence: "low" },
    draft: { value: d.amount.trim(), unit, measure: option.measure ?? null, provenance: "estimated", uncertainty: "", uncertaintyKcal: "" },
    ref: a.food.ref,
  };
}

/** One amend per record with changes: the item's meal and day, and its amount where it lives. */
export function editItemPlan(e: ItemEdit, d: ItemEditDraft, today: string): Plan | { error: string } {
  if (!DAY.test(d.date) || d.date > today) return { error: "Choose a day up to today." };
  const item: Record<string, unknown> = {};
  if (d.slot !== e.slot) item.meal_slot = d.slot;
  if (d.date !== e.date) item.eaten_on = d.date;
  const amount: Record<string, unknown> = {};
  if (e.amount && d.amount.trim() !== e.amount.value) {
    const v = typedNumber(d.amount);
    if (d.amount.trim() === "" || !Number.isFinite(v) || v <= 0) return { error: "Enter the amount as a number above 0." };
    if (e.amount.field === "fraction") {
      if (v < 1 || v > 100) return { error: "Enter your share as a percent from 1 to 100." };
      amount.fraction = v / 100;
    } else if (v !== Number(e.amount.value)) amount[e.amount.field] = v;
  }
  // Another measure sends the amount with it, as log_intake takes one (click test P2-8).
  const chosen = e.amount?.options && d.option !== undefined && d.option !== e.amount.current ? e.amount.options[d.option] : undefined;
  if (chosen) {
    const v = typedNumber(d.amount);
    if (d.amount.trim() === "" || !Number.isFinite(v) || v <= 0) return { error: "Enter the amount as a number above 0." };
    amount.amount_value = v;
    if (chosen.measure) amount.measure = chosen.measure;
    else amount.unit = chosen.unit;
  }
  const steps = [];
  // A pot share's amount goes first: the share is the step that can ask (more than the pot) or be refused,
  // and a first step that asks writes nothing, so the meal and day never move without it.
  if (e.amount?.table === "portion" && Object.keys(amount).length > 0) {
    steps.push(planStep("amend", { record: { table: "portion", id: e.amount.id }, changes: amount, reason: CORRECTED_REASON }));
  }
  const onItem = e.amount?.table === "intake_item" ? { ...item, ...amount } : item;
  if (Object.keys(onItem).length > 0) steps.push(planStep("amend", { record: { table: "intake_item", id: e.itemId }, changes: onItem, reason: CORRECTED_REASON }));
  if (steps.length === 0) return { error: "Nothing has changed." };
  return { steps, done: "Changed." };
}

// ---------------------------------------------------------------- sets

/**
 * A set's Edit changes reps and RIR only. A load is changed by removing the
 * set and logging it again: log_set checks a load against the gym's
 * inventory, and amend doesn't.
 */
export interface SetEdit {
  id: number;
  setType: string;
  reps: string;
  /** "2" or "1-2"; empty for a blank or not-recorded RIR. */
  rir: string;
  /** A set not counted in reps (ticket 68): a hold's seconds, or a carry's distance (changed by logging it again). */
  counted?: "seconds" | "distance";
  /** A hold's seconds. */
  secs?: string;
}

export const SET_LOAD_NOTE = "To change the load, remove the set and log it again.";

export interface SetFix {
  ask: string;
  edit: SetEdit;
}

export interface SetEditDraft {
  reps: string;
  rir: string;
  /** A hold's seconds. */
  secs?: string;
}

const rirText = (r: DescribedSet["rir"]): string => (r === null || r === "not_recorded" ? "" : r.low === r.high ? num(r.low) : `${num(r.low)}-${num(r.high)}`);

export function setFix(s: DescribedSet): SetFix {
  const edit: SetEdit = { id: s.id, setType: s.set_type, reps: s.reps === null ? "" : String(s.reps), rir: rirText(s.rir) };
  // A set with no reps is counted by its seconds or its distance (Worker decision 144).
  if (s.reps === null && s.duration_s != null) Object.assign(edit, { counted: "seconds", secs: String(s.duration_s) });
  else if (s.reps === null && s.distance) edit.counted = "distance";
  return { ask: `Remove set ${s.set_number} of ${s.exercise}?`, edit };
}

export function removeSetPlan(id: number): Plan {
  return { steps: [planStep("retract", { records: [{ table: "session_set", id }], reason: REMOVED_REASON })], done: "Removed." };
}

/** The changed fields, checked as the Set form checks a new set (setInput). */
export function editSetPlan(e: SetEdit, d: SetEditDraft, mode: "prescribed" | "record_only"): Plan | { error: string } {
  const changes: Record<string, unknown> = {};
  if (e.counted === "seconds") {
    // A hold is counted in seconds; reps in reserve belongs to counted reps, so it is never asked (Worker decision 144).
    const secs = typedNumber(d.secs ?? "");
    if (!(d.secs ?? "").trim() || !Number.isInteger(secs) || secs <= 0) return { error: "Enter the seconds." };
    if (String(secs) !== e.secs) changes.duration_s = secs;
  } else if (e.counted === undefined) {
    const reps = typedNumber(d.reps);
    if (!d.reps.trim() || !Number.isInteger(reps) || reps < 0 || reps > 200) return { error: "Enter the reps." };
    if (String(reps) !== e.reps) changes.reps = reps;
  }
  const rir = parseRir(d.rir);
  if (rir === "bad") return { error: "Enter the reps in reserve as a number, or a range like 1-2." };
  if (rir === null && mode === "prescribed" && e.setType === "working" && e.counted === undefined) return { error: "Enter the reps in reserve." };
  const was = parseRir(e.rir);
  const same = rir === null ? was === null : was !== null && was !== "bad" && was.low === rir.low && was.high === rir.high;
  if (!same) {
    if (rir) Object.assign(changes, { rir_status: "recorded", rir_low: rir.low, rir_high: rir.high });
    else Object.assign(changes, { rir_status: "not_recorded", rir_low: null, rir_high: null });
  }
  if (Object.keys(changes).length === 0) return { error: "Nothing has changed." };
  return { steps: [planStep("amend", { record: { table: "session_set", id: e.id }, changes, reason: CORRECTED_REASON })], done: "Set changed." };
}

// ---------------------------------------------------------------- readings

/**
 * Your own confirmed reading's Edit and Remove (click test P1-3), on
 * Progress: Remove is one `retract` of the reading; Edit amends the value,
 * the unit and the day, only what changed. The Worker asks before an
 * implausible value or unit goes in, as log_reading does.
 */
export interface ReadingEdit {
  id: number;
  value: string;
  unit: string;
  units: string[];
  date: string;
}

export interface ReadingFix {
  id: number;
  text: string;
  ask: string;
  edit: ReadingEdit;
}

export interface ReadingEditDraft {
  value: string;
  unit: string;
  date: string;
}

const BODY_WORDS: Record<string, string> = { fasted: "fasted", fed: "fed", post_exercise: "after exercise" };

/** The recent readings as rows to fix; one of a metric reading_metrics doesn't offer (a computed one) is left out. */
export function readingFixes(m: ReadingMetrics): ReadingFix[] {
  return (m.recent ?? []).flatMap((r) => {
    const metric = m.metrics.find((x) => x.code === r.metric);
    if (!metric) return [];
    const state = BODY_WORDS[r.body_state];
    const what = `${metric.label}${r.side ? `, ${r.side}` : ""}`;
    return [{
      id: r.id,
      text: `${what}: ${qty(r.value)} ${r.unit}${state ? `, ${state}` : ""}, ${day(r.date)}`,
      ask: `Remove ${what} ${qty(r.value)} ${r.unit} of ${day(r.date)}?`,
      edit: { id: r.id, value: num(r.value), unit: r.unit, units: metric.units, date: r.date },
    }];
  });
}

export function removeReadingPlan(id: number): Plan {
  return { steps: [planStep("retract", { records: [{ table: "reading", id }], reason: REMOVED_REASON })], done: "Removed." };
}

export function editReadingPlan(e: ReadingEdit, d: ReadingEditDraft, today: string): Plan | { error: string } {
  const value = typedNumber(d.value);
  if (d.value.trim() === "" || !Number.isFinite(value) || value <= 0) return { error: "Enter the reading as a number above 0." };
  if (!e.units.includes(d.unit)) return { error: "Choose the unit." };
  if (!DAY.test(d.date) || d.date > today) return { error: "Choose a day up to today." };
  const changes: Record<string, unknown> = {};
  if (value !== Number(e.value)) changes.value = value;
  if (d.unit !== e.unit) changes.unit = d.unit;
  if (d.date !== e.date) changes.measured_on = d.date;
  if (Object.keys(changes).length === 0) return { error: "Nothing has changed." };
  return { steps: [planStep("amend", { record: { table: "reading", id: e.id }, changes, reason: CORRECTED_REASON })], done: "Changed." };
}
