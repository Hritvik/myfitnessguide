/**
 * A household meal (spec §4): adjust the recipe's lines, say who ate how
 * much (unselected means absent, never 0), preview it with preview_meal,
 * save with household_meal; if the recipe's lines changed, ask once
 * whether to keep the changes. That is the one multi-step plan: the meal
 * first, then the recipe update, each step with its own key.
 */
import { amountChips } from "./food";
import { foodLabel, n, pct, slotLabel } from "./format";
import type { FoodSourceDetail, PreviewMeal, RecipeDetail } from "./types";
import { planStep, type Plan } from "./writes";
import { typedNumber } from "./typed";

export interface LineDraft {
  key: string;
  lineId: number | null;
  ref: string;
  label: string;
  value: string;
  unit: string | null;
  measure: string | null;
  edited: boolean;
}
export type Share = { mode: "percent" | "grams"; value: string };
export interface MealDraft {
  name: string;
  recipe: RecipeDetail | null;
  lines: LineDraft[];
  eaters: Record<string, Share | undefined>;
  /** The whole pot's cooked weight in grams, weighed: asked for (and sent) only when a share is in grams. */
  cookedWeight: string;
}
export type KeepChoice = "once" | "update" | "new";

/** A share in grams is a part of the whole pot's cooked weight, so the panel asks for that weight once any share is in grams. */
export const needsCookedWeight = (d: MealDraft): boolean => Object.values(d.eaters).some((s) => s?.mode === "grams");

const num = (v: number) => String(Math.round(v * 1000) / 1000);

export function fromRecipe(recipe: RecipeDetail): MealDraft {
  return {
    name: recipe.name,
    recipe,
    eaters: {},
    cookedWeight: "",
    lines: recipe.lines.map((l) => ({
      key: `line-${l.id}`, lineId: l.id, ref: l.ref, label: foodLabel(l.name, l.state), value: num(l.amount_value),
      unit: l.amount_unit === "measure" ? null : l.amount_unit, measure: l.measure, edited: false,
    })),
  };
}

export function blankMeal(): MealDraft {
  return { name: "", recipe: null, lines: [], eaters: {}, cookedWeight: "" };
}

const amount = (l: LineDraft) => (l.measure ? { measure: l.measure } : { unit: l.unit });
const lineValue = (l: LineDraft) => typedNumber(l.value);
const lineOk = (l: LineDraft) => l.value.trim() !== "" && Number.isFinite(lineValue(l)) && lineValue(l) > 0;

function changed(d: MealDraft): boolean {
  if (!d.recipe) return true;
  if (d.lines.length !== d.recipe.lines.length) return true;
  return d.lines.some((l) => l.edited || l.lineId === null);
}

export function mealInput(d: MealDraft, date: string, slot: string): { input: Record<string, unknown> } | { error: string } {
  if (!d.name.trim()) return { error: "Name the dish." };
  if (!d.recipe && d.lines.length === 0) return { error: "Add what went into it." };
  const bad = d.lines.find((l) => !lineOk(l));
  if (bad) return { error: `Enter how much ${bad.label}.` };
  const portions: Record<string, unknown>[] = [];
  for (const [member, share] of Object.entries(d.eaters)) {
    if (!share) continue;
    const v = typedNumber(share.value);
    if (!share.value.trim() || !Number.isFinite(v) || v <= 0 || (share.mode === "percent" && v > 100)) return { error: `Enter ${member}'s share.` };
    portions.push(share.mode === "percent" ? { member, fraction: v / 100, provenance: "estimated" } : { member, weighed_g: v, provenance: "estimated" });
  }
  if (portions.length === 0) return { error: "Choose who ate, and how much." };
  const cook: Record<string, unknown> = { name: d.name.trim(), ...(d.recipe ? { recipe: d.recipe.ref } : {}) };
  // Without the pot's weight a grams share is sent as it is, and the API asks for the weight (cooked_weight_needed).
  if (needsCookedWeight(d) && d.cookedWeight.trim() !== "") {
    const g = typedNumber(d.cookedWeight);
    if (!Number.isFinite(g) || g <= 0) return { error: "Enter the whole pot's weight in grams." };
    cook.cooked_weight_g = g;
    cook.cooked_weight_provenance = "weighed";
  }
  // Unchanged recipe lines are copied by the API (as inferred); any change sends them all.
  if (changed(d)) cook.lines = d.lines.map((l) => ({ food: l.ref, value: lineValue(l), ...amount(l), provenance: l.edited || l.lineId === null ? "estimated" : "inferred" }));
  cook.portions = portions;
  return { input: { date, meal_slot: slot, cooks: [cook] } };
}

export interface RecipeChanges {
  removed: number[];
  added: LineDraft[];
  amended: { lineId: number; value: number }[];
}

/** What changed against the recipe; null when there is no recipe or nothing changed. A changed unit or measure is a remove and an add. */
export function recipeChanges(d: MealDraft): RecipeChanges | null {
  if (!d.recipe || !changed(d)) return null;
  const out: RecipeChanges = { removed: [], added: [], amended: [] };
  for (const r of d.recipe.lines) {
    const kept = d.lines.find((l) => l.lineId === r.id);
    const sameUnit = kept && (kept.measure ?? null) === (r.measure ?? null) && (kept.measure !== null || kept.unit === r.amount_unit);
    if (!kept || !sameUnit) {
      out.removed.push(r.id);
      if (kept) out.added.push(kept);
    } else if (lineValue(kept) !== r.amount_value) out.amended.push({ lineId: r.id, value: lineValue(kept) });
  }
  out.added.push(...d.lines.filter((l) => l.lineId === null));
  return out.removed.length + out.added.length + out.amended.length > 0 ? out : null;
}

export function mealPlan(d: MealDraft, date: string, slot: string, keep: KeepChoice, newName?: string): Plan | { error: string } {
  const built = mealInput(d, date, slot);
  if ("error" in built) return built;
  const meal = planStep("household_meal", built.input);
  const changes = recipeChanges(d);
  if (keep === "once" || !changes || !d.recipe) return { steps: [meal], done: `Logged ${d.name.trim() || "the dish"} to ${slotLabel(slot)}.` };
  const reason = `Changed when cooking on ${date} (${slot})`;
  if (keep === "new") {
    if (!newName?.trim()) return { error: "Name the new recipe." };
    const lines = d.lines.map((l) => ({ food: l.ref, value: lineValue(l), ...amount(l) }));
    return { steps: [meal, planStep("upsert_recipe", { name: newName.trim(), kind: "dish", servings: d.recipe.servings, lines, reason })], done: `Logged, and saved as ${newName.trim()}.` };
  }
  const steps = [
    meal,
    ...changes.removed.map((id) => planStep("remove_recipe_line", { recipe: d.recipe?.ref, line_id: id, reason })),
    ...changes.added.map((l) => planStep("add_recipe_line", { recipe: d.recipe?.ref, line: { food: l.ref, value: lineValue(l), ...amount(l) }, reason })),
    ...changes.amended.map((a) => planStep("amend", { record: { table: "recipe_line", id: a.lineId }, changes: { amount_value: a.value }, reason })),
  ];
  return { steps, done: `Logged, and ${d.recipe.name} is updated for everyone.` };
}

/** The preview in words: each portion's share with its kcal and protein, and what isn't eaten yet, all from preview_meal. */
export function previewLines(p: PreviewMeal): string[] {
  return p.cooks.flatMap((c) => [
    ...c.portions.map((q) => {
      const share = q.kind === "fraction" && q.fraction !== null ? pct(q.fraction) : `${n(q.weighed_g ?? 0)} g`;
      const kcal = q.nutrients?.kcal?.value;
      const protein = q.nutrients?.protein?.value;
      return `${q.member}: ${share}, ${kcal === undefined ? "kcal not known" : `${n(kcal)} kcal`} and ${protein === undefined ? "protein not known" : `${n(protein)} g protein`}.`;
    }),
    ...c.remainder.filter((r) => r.status === "unaccounted" && r.fraction > 0).map((r) => `${pct(r.fraction)} of ${r.component === "whole" ? c.name : `${c.name}, ${r.component}`} not eaten yet.`),
  ]);
}

/** An added ingredient line, in the unit or measure chosen from the food's own chips (the Food tab's helper), never assumed grams. */
export function newLine(source: FoodSourceDetail, chip: number, value: string, key: string): LineDraft | { error: string } {
  const c = amountChips(source)[chip];
  if (!c) return { error: "Choose a measure, or a unit." };
  const v = typedNumber(value);
  if (!value.trim() || !Number.isFinite(v) || v <= 0) return { error: `Enter how much ${source.name}.` };
  return { key, lineId: null, ref: source.ref, label: foodLabel(source.name, source.state), value: value.trim(), unit: c.measure ? null : (c.unit ?? null), measure: c.measure ?? null, edited: true };
}

/**
 * What a Save may do next. Once the meal step has landed (a step's answer is back) and the plan did not finish,
 * the plan is kept: re-planning would mint a new household_meal key and write the meal twice. Only Try again
 * (same keys) or Back remain. A question from the meal step itself (nothing landed) may be answered and re-planned.
 */
export function afterSave(outcome: { status: { state: string }; results: unknown[] }): { hold: boolean; replan: boolean } {
  const hold = outcome.status.state !== "saved" && outcome.results.length > 0;
  return { hold, replan: !hold };
}
