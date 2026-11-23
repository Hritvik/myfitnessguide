/**
 * The Food tab (spec §3): today's pots, recents and search; the amount
 * row; a preview from what_if; one write per Save. Every number shown
 * comes from the API; this file only formats and builds requests.
 */
import { atLeast, atMostWord, foodLabel, n, pct, qty, slotLabel, unknownCount, unknownTail } from "./format";
import type { CatalogueHit, DayCooks, FoodSourceDetail, LeftLine, RecentItems, WhatIf } from "./types";
import { planStep, type Plan } from "./writes";
import { typedNumber } from "./typed";

export type Pick =
  | { kind: "food"; ref: string; name: string; state: string; usual: { value: number; unit?: string; measure?: string } | null }
  | { kind: "recipe"; ref: string; name: string; usual: number | null }
  | { kind: "pot"; componentId: number; name: string };

export interface PickerRow {
  key: string;
  group: "Today's pots" | "Recent" | "Search results";
  label: string;
  detail: string | null;
  pick: Pick;
}

const num = (v: number) => String(Math.round(v * 100) / 100);
/** A usual amount as a member would weigh it: grams and ml whole, a measure or a piece to two decimals. */
const usualNum = (u: { value: number; unit?: string; measure?: string }) => (!u.measure && (u.unit === "g" || u.unit === "ml") ? String(Math.round(u.value)) : num(u.value));
export const amountText = (u: { value: number; unit?: string; measure?: string }) => `${usualNum(u)} ${u.measure ?? u.unit ?? ""}`.trim();
const servingsText = (s: number) => `${num(s)} serving${s === 1 ? "" : "s"}`;

/**
 * Today's pots (a remainder not yet accounted for, that the member has no
 * share of), then recents; while typing, the search results instead.
 * Offline, `offlineQuery` filters what is already loaded.
 */
export function buildPicker(recents: RecentItems | null, cooks: DayCooks | null, hits: CatalogueHit[] | null, forMember: string, offlineQuery?: string): PickerRow[] {
  const rows: PickerRow[] = [];
  if (hits === null) {
    for (const c of cooks?.cooks ?? []) {
      for (const comp of c.components) {
        if (comp.remainder?.status !== "unaccounted" || comp.shares.some((s) => s.member === forMember)) continue;
        rows.push({
          key: `pot:${comp.component_id}`, group: "Today's pots", label: comp.name === "whole" ? c.name : `${c.name}, ${comp.name}`,
          detail: `${pct(comp.remainder.fraction)} not eaten yet`, pick: { kind: "pot", componentId: comp.component_id, name: c.name },
        });
      }
    }
    for (const i of recents?.items ?? []) {
      rows.push(
        i.kind === "food_source"
          ? { key: `recent:${i.ref}`, group: "Recent", label: foodLabel(i.name, i.state), detail: `usually ${amountText(i.usual)}`, pick: { kind: "food", ref: i.ref, name: i.name, state: i.state, usual: i.usual } }
          : { key: `recent:${i.ref}`, group: "Recent", label: i.name, detail: `usually ${servingsText(i.usual.servings)}`, pick: { kind: "recipe", ref: i.ref, name: i.name, usual: i.usual.servings } },
      );
    }
    const q = offlineQuery?.trim().toLowerCase();
    return q ? rows.filter((r) => r.label.toLowerCase().includes(q)) : rows;
  }
  for (const h of hits) {
    const also = (h.aliases?.length ?? 0) > 0 ? `also "${h.aliases.join('", "')}"` : null;
    if (h.kind === "food_source") {
      const usual = recents?.items.find((i) => i.kind === "food_source" && i.usual.food === h.ref);
      rows.push({ key: `hit:${h.ref}`, group: "Search results", label: foodLabel(h.name, h.state), detail: also, pick: { kind: "food", ref: h.ref, name: h.name, state: h.state, usual: usual && usual.kind === "food_source" ? usual.usual : null } });
    } else if (h.kind === "recipe" && h.recipe_kind === "dish") {
      const usual = recents?.items.find((i) => i.kind === "recipe" && i.ref === h.ref);
      rows.push({ key: `hit:${h.ref}`, group: "Search results", label: h.name, detail: also, pick: { kind: "recipe", ref: h.ref, name: h.name, usual: usual && usual.kind === "recipe" ? usual.usual.servings : null } });
    }
  }
  return rows;
}

const NO_MATCH_NEXT = "Add it as a new food below, or teach the word to a food in the Catalogue's Words.";

/** What a search that found nothing to log says, once its answer is in (null while there is something, or no answer yet). */
export function noMatchLine(query: string, rows: PickerRow[], hits: CatalogueHit[] | null): string | null {
  if (hits === null || rows.length > 0 || !query.trim()) return null;
  const idea = hits.find((h) => h.kind === "recipe" && h.recipe_kind !== "dish");
  if (idea) return `Nothing matches "${query.trim()}" that can be logged here: "${idea.name}" is a recipe idea, not a dish. ${NO_MATCH_NEXT}`;
  return `Nothing matches "${query.trim()}". ${NO_MATCH_NEXT}`;
}

export type Provenance = "estimated" | "weighed" | "counted" | "label";
export const PROVENANCES: Provenance[] = ["estimated", "weighed", "counted", "label"];
const CONFIDENCE: Record<Provenance, "high" | "medium" | "low"> = { estimated: "low", weighed: "high", counted: "medium", label: "high" };

export interface AmountDraft {
  value: string;
  unit: string | null;
  measure: string | null;
  provenance: Provenance;
  uncertainty: string;
  uncertaintyKcal: string;
}

export function draftFor(pick: Pick): AmountDraft {
  const base = { provenance: "estimated" as const, uncertainty: "", uncertaintyKcal: "" };
  if (pick.kind === "food" && pick.usual) return { ...base, value: usualNum(pick.usual), unit: pick.usual.unit ?? null, measure: pick.usual.measure ?? null };
  if (pick.kind === "recipe" && pick.usual !== null) return { ...base, value: num(pick.usual), unit: null, measure: null };
  return { ...base, value: "", unit: null, measure: null };
}

/** Switching to another state of the same food: a fresh draft (the amount and measure belonged to the other state), keeping how it was measured. */
export function switchState(current: Extract<Pick, { kind: "food" }>, draft: AmountDraft, ref: string, state: string): { pick: Extract<Pick, { kind: "food" }>; draft: AmountDraft } {
  const pick = { ...current, ref, state, usual: null };
  return { pick, draft: { ...draftFor(pick), provenance: draft.provenance } };
}

/** What converting between a food's measures needs: its unit and its measures. */
export type MeasuredFood = { reference_unit: FoodSourceDetail["reference_unit"]; measures: FoodSourceDetail["measures"] };

/** The measure chips, each with its size as the catalogue gives it, then the reference unit. */
export function amountChips(source: MeasuredFood): { label: string; unit?: string; measure?: string }[] {
  const unit = source.reference_unit === "piece" ? "g" : source.reference_unit;
  return [
    ...source.measures.map((m) => ({ label: `${m.name} (${num(m.amount)} ${unit})`, measure: m.name })),
    source.reference_unit === "piece" ? { label: "pieces", unit: "piece" } : { label: source.reference_unit, unit: source.reference_unit },
  ];
}

/**
 * Picking another measure chip (click test P1-1): the amount is converted so
 * it still means the same food, never kept as a count of the new measure
 * (118 g picked as "medium (118 g)" is 1 medium, not 118). A measure's size
 * is in the food's reference unit, so g/ml and measures convert; a piece
 * food's measures have no size in pieces, so a measure (or pieces) starts at
 * 1. Nothing typed starts a measure at 1 and a unit empty.
 */
export function switchMeasure(d: AmountDraft, source: MeasuredFood, next: { measure?: string; unit?: string }): AmountDraft {
  const to = { measure: next.measure ?? null, unit: next.measure ? null : (next.unit ?? null) };
  const startAt = to.measure ? "1" : "";
  const typed = typedNumber(d.value);
  const sizeOf = (measure: string | null, unit: string | null): number | null => {
    if (measure) return source.reference_unit === "piece" ? null : (source.measures.find((m) => m.name === measure)?.amount ?? null);
    return unit === source.reference_unit && unit !== "piece" ? 1 : null;
  };
  const from = sizeOf(d.measure, d.unit);
  const size = sizeOf(to.measure, to.unit);
  let value: string;
  if (!d.value.trim() || !Number.isFinite(typed) || typed <= 0) value = startAt;
  else if (from !== null && size !== null) value = num((typed * from) / size);
  else value = "1";
  return { ...d, ...to, value };
}

/** The plausibility question, only while the form holds the item it was asked about: "Save anyway" never sends an older amount. */
export function askedFor(asking: { key: string; text: string } | null, itemKey: string): string | null {
  return asking && asking.key === itemKey ? asking.text : null;
}

/**
 * A Save whose check awaits the API (what_if) runs once at a time (review
 * round): a second tap while the first is checking is ignored, so one tap
 * makes one plan and one key. `running` disables the button meanwhile.
 */
export function oneAtATime(work: () => Promise<void>): { run(): Promise<void>; running(): boolean } {
  let busy = false;
  return {
    async run() {
      if (busy) return;
      busy = true;
      try {
        await work();
      } finally {
        busy = false;
      }
    },
    running: () => busy,
  };
}

/** One item over this many kcal asks before it is saved. */
export const FOOD_KCAL_ASK = 1500;
/** An amount this many times the member's usual one (same measure or unit) asks before it is saved. */
export const USUAL_RATIO_ASK = 4;

/**
 * Whether a food's amount is implausible enough to ask before saving (click
 * test P1-1). The kcal is what_if's for the item (null offline or before it
 * answers); the usual is the member's usual amount of this food from
 * recent_items. A question, never a refusal: the member can save it anyway.
 */
export function foodCheck(kcal: number | null, d: AmountDraft, usual: { value: number; unit?: string; measure?: string } | null): string | null {
  if (kcal !== null && kcal > FOOD_KCAL_ASK) return `That is ${n(kcal)} kcal for one item. Is the amount right?`;
  const value = typedNumber(d.value);
  if (!usual || usual.value <= 0 || !Number.isFinite(value)) return null;
  const same = d.measure !== null ? usual.measure === d.measure : usual.measure === undefined && usual.unit === d.unit;
  if (!same) return null;
  const ratio = value / usual.value;
  return ratio >= USUAL_RATIO_ASK ? `That is ${qty(ratio)} times your usual ${amountText(usual)}. Is the amount right?` : null;
}

/** The chip for the food's own unit (grams, ml or pieces), last of amountChips: where an amount starts unless a measure is picked. */
export const referenceChip = (source: FoodSourceDetail): number => amountChips(source).length - 1;

export function foodItem(pick: Exclude<Pick, { kind: "pot" }>, d: AmountDraft): { item: Record<string, unknown> } | { error: string } {
  const value = typedNumber(d.value);
  if (!d.value.trim() || !Number.isFinite(value) || value <= 0) return { error: "Enter how much." };
  if (pick.kind === "food" && d.unit === null && d.measure === null) return { error: "Choose a measure, or grams." };
  let uncertainty: Record<string, unknown> = {};
  if (d.uncertainty.trim() || d.uncertaintyKcal.trim()) {
    const kcal = typedNumber(d.uncertaintyKcal);
    if (!d.uncertaintyKcal.trim() || !Number.isFinite(kcal) || kcal < 0) return { error: "Enter the ± as a number of kcal." };
    uncertainty = { dominant_uncertainty: { description: d.uncertainty.trim() || "amount", kcal } };
  }
  const common = { provenance: d.provenance, confidence: CONFIDENCE[d.provenance], ...uncertainty };
  if (pick.kind === "recipe") return { item: { source: "recipe", recipe: pick.ref, servings: value, ...common } };
  return { item: { source: "food", food: pick.ref, value, ...(d.measure ? { measure: d.measure } : { unit: d.unit }), ...common } };
}

/** What is left of one macro; when the day's sum leaves out `unknown` items, at most (or over by at least) what it reads (ticket 72). */
const leftText = (l: LeftLine, unit: string, noun: string, unknown = 0) =>
  l.left < 0 ? `over by ${atLeast(-l.left, unknown)}${unit} ${noun}` : `${atMostWord(unknown)}${n(l.left)}${unit} ${noun}`;

/** The preview, in words, from what_if's numbers: the item, and what's left today after it. */
export function previewLine(w: WhatIf): string | null {
  const nutrients = w.items[0]?.nutrients;
  const kcal = nutrients?.kcal?.value;
  if (kcal === undefined) return null;
  const protein = nutrients?.protein?.value;
  const item = `This: ${n(kcal)} kcal and ${protein === undefined ? "protein not known" : `${n(protein)} g protein`}.`;
  const left = w.day.left;
  if (!left) return item;
  const k = left.kcal;
  const p = left.protein;
  const uk = w.day.unknown_items?.kcal ?? 0;
  const up = w.day.unknown_items?.protein ?? 0;
  const tail = unknownTail(unknownCount(w.day.unknown_items));
  if (k.left < 0) return `${item} Left today after it: ${leftText(k, "", "kcal", uk)}, and ${p.left < 0 ? leftText(p, " g", "protein", up) : `${leftText(p, " g", "protein", up)} left`}${tail}.`;
  return `${item} Left today after it: ${leftText(k, "", "kcal", uk)} and ${leftText(p, " g", "protein", up)}${tail}.`;
}

/** What a Save logged, in words, and for whom: `me` is the signed-in member, so another member's item reads as their draft. */
export interface Logged {
  what: string;
  me: string;
}

const loggedDone = (member: string, slot: string, logged?: Logged): string => {
  if (!logged) return "Logged.";
  if (member === logged.me) return `Logged ${logged.what} to ${slotLabel(slot)}.`;
  return `Logged ${logged.what} to ${member}'s ${slotLabel(slot)}, as a draft for ${member} to confirm.`;
};

export function foodPlan(member: string, date: string, slot: string, item: Record<string, unknown>, logged?: Logged): Plan {
  return { steps: [planStep("log_intake", { member, date, meal_slot: slot, items: [item] })], done: loggedDone(member, slot, logged) };
}

export function potShare(mode: "percent" | "grams", value: string): { fraction: number } | { weighed_g: number } | { error: string } {
  const v = typedNumber(value, { percent: mode === "percent" });
  if (mode === "percent") return value.trim() && Number.isFinite(v) && v >= 1 && v <= 100 ? { fraction: v / 100 } : { error: "Enter a share from 1 to 100%." };
  return value.trim() && Number.isFinite(v) && v > 0 ? { weighed_g: v } : { error: "Enter the grams." };
}

export function potPlan(componentId: number, member: string, date: string, slot: string, share: { fraction: number } | { weighed_g: number }, provenance: Provenance, logged?: Logged): Plan {
  return { steps: [planStep("mark_remainder", { component_id: componentId, disposition: "eaten", member, ...share, provenance, date, meal_slot: slot })], done: logged ? loggedDone(member, slot, logged) : "Logged the share." };
}

export interface NewFoodDraft {
  name: string;
  state: string;
  per: "g" | "ml";
  kcal: string;
  protein: string;
  carbs: string;
  fat: string;
  measureName: string;
  measureAmount: string;
}

/** A new food per 100 g or ml. The API checks the label's energy; when it asks, the member's word goes back as the override reason. */
export function newFoodPlan(f: NewFoodDraft, overrideReason?: string): Plan | { error: string } {
  const nums = [f.kcal, f.protein, f.carbs, f.fat].map((v) => typedNumber(v));
  if (!f.name.trim()) return { error: "Enter the food's name." };
  if (nums.some((v) => !Number.isFinite(v) || v < 0)) return { error: `Enter kcal, protein, carbs and fat per 100 ${f.per}.` };
  const [kcal, protein_g, carbs_g, fat_g] = nums as [number, number, number, number];
  // A measure half typed (a name without what it holds, or a size that isn't one) is asked about, never dropped (ticket 67).
  const measureName = f.measureName.trim();
  const holds = typedNumber(f.measureAmount);
  if ((measureName || f.measureAmount.trim()) && !(measureName && Number.isFinite(holds) && holds > 0)) return { error: `Name the measure and how many ${f.per} it holds, or leave both empty.` };
  const measure = measureName ? { measures: [{ name: measureName, amount: holds }] } : {};
  const input = {
    name: f.name.trim(), state: f.state, reference_amount: 100, reference_unit: f.per, kcal, protein_g, carbs_g, fat_g, ...measure,
    ...(overrideReason ? { energy_override_reason: overrideReason } : {}),
  };
  return { steps: [planStep("upsert_food_source", input)], done: `Added ${f.name.trim()}.` };
}
