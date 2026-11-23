/**
 * The catalogue's view logic (desktop spec §5): the lists, the food and
 * recipe records, "Used by", fields as typed (blank is never zero), edits
 * as only the changed fields, and every catalogue write as a plan: one key
 * per step, a reason every time (never filled in for the member), the
 * record re-read after it lands. A ref never shows (web decision 57); it
 * lives only in the URL and in the plans. Pure; every value is the API's.
 */
import { day, FOOD_STATES, foodLabel, list, loadText, n, plural, qty, sentenceCase, stateLabel } from "./format";
import { cataloguePath } from "./route";
import type { CatalogueHit, CatalogueListExercise, CatalogueListFood, CatalogueListGym, CatalogueListRecipe, Dependents, FoodRecord, Inventory, LastTrained, Learned, LoadAmount, MacroKey, MicroKey, NutrientTotal, RecipeRecord, WorkoutLineOut, WorkoutOut } from "./types";
import { planStep, type Plan, type WriteStatus } from "./writes";
import { typedNumber } from "./typed";

export const REASON_NEEDED = "Say why: the reason goes in its history.";

// ------------------------------------------------------------ lists

export interface ListRow {
  key: string;
  label: string;
  hint: string;
  href: string;
}

const per = (amount: number, unit: string) => (unit === "piece" ? (amount === 1 ? "per piece" : `per ${qty(amount)} pieces`) : `per ${qty(amount)} ${unit}`);
/** The list names a food's reference only when it isn't the default (100 g, 100 ml); a bare row reads "food". */
export function foodHint(amount: number, unit: string): string {
  return amount === 100 && (unit === "g" || unit === "ml") ? "food" : `food · ${per(amount, unit)}`;
}

const foodHref = (ref: string) => cataloguePath({ pane: "foods", record: { kind: "food", ref } });
const recipeHref = (ref: string) => cataloguePath({ pane: "foods", record: { kind: "recipe", ref } });

export function foodRows(items: readonly CatalogueListFood[]): ListRow[] {
  return items.map((f) => ({ key: `food:${f.id}`, label: foodLabel(f.name, f.state), hint: foodHint(f.reference_amount, f.reference_unit), href: foodHref(f.ref) }));
}

export function recipeRows(items: readonly CatalogueListRecipe[]): ListRow[] {
  return items.map((r) => ({ key: `recipe:${r.id}`, label: r.name, hint: r.kind === "idea" ? "recipe idea" : `recipe · ${plural(r.lines, "line", "lines")}`, href: recipeHref(r.ref) }));
}

/** Foods and recipes together for the All chip, by name without case. */
export function allRows(foods: readonly ListRow[], recipes: readonly ListRow[]): ListRow[] {
  return [...foods, ...recipes].sort((a, b) => a.label.localeCompare(b.label, "en", { sensitivity: "base" }) || a.key.localeCompare(b.key));
}

/** The next page after the rows shown: a row the household added meanwhile can shift a page; it is never listed twice. */
export function appendPage(rows: readonly ListRow[], page: readonly ListRow[]): ListRow[] {
  const seen = new Set(rows.map((r) => r.key));
  return [...rows, ...page.filter((r) => !seen.has(r.key))];
}

export type FoodsChip = "all" | "food" | "recipe";

export function searchKinds(chip: FoodsChip): ("food_source" | "recipe")[] {
  return chip === "food" ? ["food_source"] : chip === "recipe" ? ["recipe"] : ["food_source", "recipe"];
}

/** catalogue_search's hits (foods and recipes), best match first, worded as the list words them. */
export function searchRows(hits: readonly CatalogueHit[]): ListRow[] {
  return hits.flatMap((h): ListRow[] => {
    if (h.kind === "food_source") return [{ key: `food:${h.id}`, label: foodLabel(h.name, h.state), hint: "food", href: foodHref(h.ref) }];
    if (h.kind === "recipe") return [{ key: `recipe:${h.id}`, label: h.name, hint: "recipe", href: recipeHref(h.ref) }];
    return [];
  });
}

/** What the list remembers across the phone's list, record and back: the query, the chip and the pages shown. */
export interface ListMemory {
  query: string;
  chip: FoodsChip;
  pages: Readonly<Record<string, { rows: ListRow[]; next: number | null }>>;
}

export const EMPTY_LIST: ListMemory = { query: "", chip: "all", pages: {} };

/** The pages beyond the first of one kind; null forgets them. */
export function withPages(m: ListMemory, kind: string, page: { rows: ListRow[]; next: number | null } | null): ListMemory {
  const { [kind]: _drop, ...rest } = m.pages;
  return { ...m, pages: page ? { ...rest, [kind]: page } : rest };
}

/** A catalogue Save that landed: the lists re-read from their first page; the query and chip stay. */
export const afterSave = (m: ListMemory): ListMemory => ({ ...m, pages: {} });

/** The rows on screen: the search's hits while there is a query, else the chip's list. */
export function visibleRows(chip: FoodsChip, searching: boolean, foods: readonly ListRow[], recipes: readonly ListRow[], hits: readonly ListRow[]): ListRow[] {
  if (searching) return [...hits];
  return chip === "food" ? [...foods] : chip === "recipe" ? [...recipes] : allRows(foods, recipes);
}

/** What an empty list says. */
export function listEmpty(chip: FoodsChip, query: string, shown: number): string | null {
  if (shown > 0) return null;
  if (query.trim() !== "") return `Nothing matches "${query.trim()}".`;
  return chip === "food" ? "No foods yet." : chip === "recipe" ? "No recipes yet." : "Nothing in the catalogue yet.";
}

// ------------------------------------------------------------ the food record

export const MACRO_FIELDS: readonly { key: MacroKey; label: string; unit: string }[] = [
  { key: "kcal", label: "Energy", unit: "kcal" },
  { key: "protein_g", label: "Protein", unit: "g" },
  { key: "carbs_g", label: "Carbs", unit: "g" },
  { key: "fat_g", label: "Fat", unit: "g" },
];

export const MICRO_FIELDS: readonly { key: MicroKey; label: string; unit: string }[] = [
  { key: "fibre_g", label: "Fibre", unit: "g" },
  { key: "sat_fat_g", label: "Saturated fat", unit: "g" },
  { key: "total_sugars_g", label: "Sugars", unit: "g" },
  { key: "sodium_mg", label: "Sodium", unit: "mg" },
  { key: "potassium_mg", label: "Potassium", unit: "mg" },
  { key: "calcium_mg", label: "Calcium", unit: "mg" },
  { key: "iron_mg", label: "Iron", unit: "mg" },
  { key: "magnesium_mg", label: "Magnesium", unit: "mg" },
  { key: "b12_ug", label: "B12", unit: "µg" },
  { key: "vitamin_c_mg", label: "Vitamin C", unit: "mg" },
];

export interface FoodView {
  title: string;
  facts: string;
  per: string;
  macros: { key: string; label: string; value: string }[];
  micros: { key: string; label: string; value: string }[];
  measures: string[];
  yields: string[];
  price: string | null;
  category: string | null;
  tags: string | null;
  words: { id: number; word: string }[];
}

/** A value nobody measured is "unknown", never 0 (desktop spec §5). */
const amount = (value: number | null, unit: string) => (value === null ? "unknown" : `${qty(value)} ${unit}`);

export function foodView(f: FoodRecord, aliases: Learned["aliases"]): FoodView {
  const cost = f.cost_per_25g_protein_inr;
  return {
    title: foodLabel(f.name, f.state),
    facts: [sentenceCase(stateLabel(f.state)), f.last_checked_on ? `checked ${day(f.last_checked_on)}` : null, f.energy_override_reason ? `energy kept as given: ${f.energy_override_reason}` : null]
      .filter((x): x is string => x !== null)
      .join(" · "),
    per: f.reference_unit === "piece" ? `Per ${qty(f.reference_amount)} ${f.reference_amount === 1 ? "piece" : "pieces"}` : `Per ${qty(f.reference_amount)} ${f.reference_unit}`,
    macros: MACRO_FIELDS.map((m) => ({ key: m.key, label: m.label, value: amount(f[m.key], m.unit) })),
    micros: MICRO_FIELDS.map((m) => ({ key: m.key, label: m.label, value: amount(f[m.key], m.unit) })),
    measures: f.measures.map((m) => `1 ${m.name} = ${qty(m.amount)} ${f.reference_unit}`),
    yields: f.yields_from.map((y) => `From ${stateLabel(y.from_state)}: × ${qty(y.factor)}${y.discarded_fraction > 0 ? `, ${Math.round(y.discarded_fraction * 100)}% thrown away` : ""}`),
    price: cost === null ? null : n(cost.min) === n(cost.max) ? `₹${n(cost.min)} per 25 g protein` : `₹${n(cost.min)}–${n(cost.max)} per 25 g protein`,
    category: f.primary_category,
    tags: f.tags,
    words: wordsFor(aliases, "food_source", f.id),
  };
}

// ------------------------------------------------------------ "Used by"

export interface UsedBy {
  lines: string[];
  reach: string;
  empty: boolean;
}

/** What a change to a food or recipe reaches (catalogue_dependents), above the edit buttons. */
export function usedBy(d: Dependents): UsedBy {
  const lines: string[] = [];
  if (d.recipes.length > 0) lines.push(`${d.recipes.length === 1 ? "Recipe" : "Recipes"} ${list(d.recipes.map((r) => r.name))}`);
  if (d.intake_items > 0) {
    const dates = d.intake_dates;
    const when = !dates ? "" : dates.first === dates.last ? `, on ${day(dates.first)}` : `, ${day(dates.first)} to ${day(dates.last)}`;
    lines.push(`${plural(d.intake_items, "logged item", "logged items")}${when}`);
  }
  // "Since" is the earliest cook, whatever order the API lists them in (ISO dates sort as text).
  const since = d.cooks.reduce<string | null>((min, c) => (min === null || c.cooked_on < min ? c.cooked_on : min), null);
  if (since !== null) lines.push(`${plural(d.cooks.length, "cook", "cooks")}, since ${day(since)}`);
  if (d.yields.length > 0) lines.push(`Yields ${list(d.yields.map((y) => stateLabel(y.to_state)))}`);
  return { lines, empty: lines.length === 0, reach: lines.length === 0 ? "Nothing uses it yet." : "Logged days are worked out from the catalogue, not frozen: changing this changes them." };
}

// ------------------------------------------------------------ fields as typed

/**
 * name: required text. text: optional text (blank is null). number: a
 * required number, 0 or more. positive: a required number above 0.
 * optional: a number or blank (blank is null, "not known"). choice: one of
 * `options`.
 */
export type FieldKind = "name" | "text" | "number" | "positive" | "optional" | "choice";

export interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  unit?: string;
  group?: string;
  options?: readonly string[];
}

/** Digits with at most one decimal point: no sign, no comma, no exponent, no unit, and few enough to be a number (typed.ts). */
const isNumber = (s: string): boolean => Number.isFinite(typedNumber(s));

export function parseField(spec: FieldSpec, raw: string): { value: string | number | null } | { error: string } {
  const s = raw.trim();
  switch (spec.kind) {
    case "name":
      return s === "" ? { error: `${spec.label} can't be blank.` } : { value: s };
    case "text":
      return { value: s === "" ? null : s };
    case "choice":
      return spec.options?.includes(s) ? { value: s } : { error: `Choose a ${spec.label.toLowerCase()}.` };
    case "number":
    case "positive": {
      if (s === "") return { error: `${spec.label} can't be blank; enter 0 if there is none.` };
      if (!isNumber(s)) return { error: `${spec.label} must be a number, like 8.7.` };
      const v = Number(s);
      return spec.kind === "positive" && v <= 0 ? { error: `${spec.label} must be more than 0.` } : { value: v };
    }
    case "optional":
      // Blank is unknown, sent as null. Number("") is 0, so blank never reaches Number (desktop spec §5, review #10).
      if (s === "") return { value: null };
      return isNumber(s) ? { value: Number(s) } : { error: `${spec.label} must be a number, like 8.7, or blank if not known.` };
  }
}

const PRICE_GROUP = "Price and kind";

/** What Edit turns into inputs on a food (desktop spec §5): name, macros, micronutrients, price, category, tags. */
export const FOOD_FIELDS: readonly FieldSpec[] = [
  { key: "name", label: "Name", kind: "name", group: "Name" },
  ...MACRO_FIELDS.map((m) => ({ key: m.key, label: m.label, kind: "number" as const, unit: m.unit, group: "Macros" })),
  ...MICRO_FIELDS.map((m) => ({ key: m.key, label: m.label, kind: "optional" as const, unit: m.unit, group: "Micronutrients (blank if not known)" })),
  { key: "price_min_inr", label: "Lowest price", kind: "optional", unit: "₹", group: PRICE_GROUP },
  { key: "price_max_inr", label: "Highest price", kind: "optional", unit: "₹", group: PRICE_GROUP },
  { key: "primary_category", label: "Category", kind: "text", group: PRICE_GROUP },
  { key: "tags", label: "Tags", kind: "text", group: PRICE_GROUP },
];

/** A recipe's own fields (desktop spec §5). */
export const RECIPE_FIELDS: readonly FieldSpec[] = [
  { key: "name", label: "Name", kind: "name" },
  { key: "servings", label: "Servings", kind: "positive" },
  { key: "meal_type", label: "Meal type", kind: "text" },
  { key: "method", label: "Method", kind: "text" },
];

/** A new food (upsert_food_source): no ref, the API allocates it. */
export const NEW_FOOD_FIELDS: readonly FieldSpec[] = [
  { key: "name", label: "Name", kind: "name", group: "Name" },
  { key: "state", label: "State", kind: "choice", options: FOOD_STATES, group: "Name" },
  { key: "reference_amount", label: "Per how much", kind: "positive", group: "Name" },
  { key: "reference_unit", label: "Unit", kind: "choice", options: ["g", "ml", "piece"], group: "Name" },
  ...FOOD_FIELDS.filter((f) => f.key !== "name"),
];

/** The record's stored values as the inputs start: a number as stored, unknown as blank. */
export function startFields(specs: readonly FieldSpec[], record: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(specs.map((s) => [s.key, record[s.key] === null || record[s.key] === undefined ? "" : String(record[s.key])]));
}

/**
 * Only the fields the member changed (desktop spec §5, review #11): a field
 * whose text is as it started is neither checked nor sent; a changed one
 * is sent when its value differs ("8.70" for 8.7 is no change).
 */
export function changedFields(specs: readonly FieldSpec[], start: Record<string, string>, now: Record<string, string>): { changes: Record<string, string | number | null> } | { error: string; field: string } {
  const changes: Record<string, string | number | null> = {};
  for (const spec of specs) {
    const was = start[spec.key] ?? "";
    const is = now[spec.key] ?? "";
    if (is === was) continue;
    const after = parseField(spec, is);
    if ("error" in after) return { error: after.error, field: spec.key };
    const before = parseField(spec, was);
    if ("error" in before || before.value !== after.value) changes[spec.key] = after.value;
  }
  if (Object.keys(changes).length === 0) return { error: "Nothing changed.", field: specs[0]?.key ?? "" };
  return { changes };
}

const shown = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? "unknown" : typeof v === "number" ? qty(v) : v);

/** What a Save says once it landed: each changed field, before and after. */
export function savedText(specs: readonly FieldSpec[], start: Record<string, string>, changes: Record<string, string | number | null>): string {
  const parts = specs.filter((s) => s.key in changes).map((s) => {
    const before = parseField(s, start[s.key] ?? "");
    // A text field that was blank had nothing to be "unknown": "Tags: x", not "Tags unknown → x".
    if (s.kind === "text" && "value" in before && before.value === null) return `${s.label}: ${shown(changes[s.key])}`;
    const after = s.kind === "text" && changes[s.key] === null ? "none" : shown(changes[s.key]);
    return `${s.label} ${shown("error" in before ? start[s.key] : before.value)} → ${after}`;
  });
  return `Saved: ${parts.join("; ")}.`;
}

/** One amend of one record, with the member's own reason. */
export function amendPlan(record: { table: string; id: number }, changes: Record<string, string | number | null>, reason: string, done: string): Plan | { error: string } {
  const why = reason.trim();
  if (why === "") return { error: REASON_NEEDED };
  return { steps: [planStep("amend", { record, changes, reason: why })], done };
}

/** Macros that don't reconcile with kcal asked (energy_mismatch): keep them, with the member's reason. */
export function withOverride(changes: Record<string, string | number | null>, why: string): { changes: Record<string, string | number | null> } | { error: string } {
  const w = why.trim();
  if (w === "") return { error: "Say why to keep these values, for example: the label says so." };
  return { changes: { ...changes, energy_override_reason: w } };
}

/** A new food: upsert_food_source with the values given (blank optional values left out) and the member's reason. */
export function newFoodPlan(fields: Record<string, string>, reason: string, override: string | null): Plan | { error: string; field: string } {
  const input: Record<string, string | number> = {};
  for (const spec of NEW_FOOD_FIELDS) {
    const p = parseField(spec, fields[spec.key] ?? "");
    if ("error" in p) return { error: p.error, field: spec.key };
    if (p.value !== null) input[spec.key] = p.value;
  }
  if (override !== null) {
    const o = override.trim();
    if (o === "") return { error: "Say why to keep these values, for example: the label says so.", field: "override" };
    input.energy_override_reason = o;
  }
  const why = reason.trim();
  if (why === "") return { error: REASON_NEEDED, field: "reason" };
  return { steps: [planStep("upsert_food_source", { ...input, reason: why })], done: `Added ${foodLabel(String(input.name), String(input.state))}.` };
}

// ------------------------------------------------------------ recipes

export interface LineDraft {
  food: string;
  value: string;
  unit: string;
  /** The answer to an ambiguous food ("Is that oats cooked or dry?"); absent leaves it to the API to ask. */
  state?: string;
}

/** The new-recipe form's lines (fields "line-<i>-food", "-value", "-unit", "-state", `lines` rows), empty rows skipped. */
export function recipeLines(fields: Record<string, string>): LineDraft[] {
  const count = Number(fields.lines ?? "1");
  const out: LineDraft[] = [];
  for (let i = 0; i < (Number.isInteger(count) && count > 0 ? count : 1); i++) {
    const food = (fields[`line-${i}-food`] ?? "").trim();
    const value = (fields[`line-${i}-value`] ?? "").trim();
    if (food === "" && value === "") continue;
    const state = (fields[`line-${i}-state`] ?? "").trim();
    out.push({ food, value, unit: fields[`line-${i}-unit`] ?? "g", ...(state === "" ? {} : { state }) });
  }
  return out;
}

const UNITS = ["g", "ml", "piece"];
const lineIn = (l: LineDraft, at: string): { food: string; value: number; unit: string } | { error: string } => {
  if (l.food.trim() === "") return { error: `${at}which food?` };
  if (!isNumber(l.value.trim()) || Number(l.value) <= 0) return { error: `${at}the amount must be a number above 0.` };
  if (!UNITS.includes(l.unit)) return { error: `${at}choose g, ml or piece.` };
  return { food: l.food.trim(), value: Number(l.value), unit: l.unit };
};

/** A new recipe (upsert_recipe, a dish): its lines resolve like any amount; an ambiguous food asks. */
export function newRecipePlan(fields: Record<string, string>, reason: string): Plan | { error: string } {
  const own: Record<string, string | number> = {};
  for (const spec of RECIPE_FIELDS) {
    const p = parseField(spec, fields[spec.key] ?? (spec.key === "servings" ? "1" : ""));
    if ("error" in p) return { error: p.error };
    if (p.value !== null) own[spec.key] = p.value;
  }
  const drafts = recipeLines(fields);
  if (drafts.length === 0) return { error: "Add at least one line: a food and how much." };
  const lines = [];
  for (const [i, d] of drafts.entries()) {
    const l = lineIn(d, `Line ${i + 1}: `);
    if ("error" in l) return { error: l.error };
    lines.push(d.state ? { ...l, state: d.state } : l);
  }
  const why = reason.trim();
  if (why === "") return { error: REASON_NEEDED };
  return { steps: [planStep("upsert_recipe", { ...own, kind: "dish", lines, reason: why })], done: `Added ${String(own.name)}.` };
}

export interface RecipeView {
  title: string;
  facts: string;
  method: string | null;
  lines: { id: number; position: number; food: string; amount: string; value: number }[];
  perServing: string | null;
  manual: string | null;
}

const SERVING_PARTS: readonly { key: "kcal" | "protein" | "carbs" | "fat"; shown: (v: string) => string; unknown: string }[] = [
  { key: "kcal", shown: (v) => `${v} kcal`, unknown: "kcal unknown" },
  { key: "protein", shown: (v) => `${v} g protein`, unknown: "protein unknown" },
  { key: "carbs", shown: (v) => `${v} g carbs`, unknown: "carbs unknown" },
  { key: "fat", shown: (v) => `${v} g fat`, unknown: "fat unknown" },
];

/**
 * The server's per-serving totals as the server counted them: a total over
 * only some of the lines says how many ("Per serving (5 of 6 lines counted)"),
 * a nutrient nobody has says "protein unknown", never "unknown g protein".
 */
function perServingText(s: NonNullable<RecipeRecord["per_serving"]>, derived: boolean): string {
  // The server sends {value: 0, known: 0} for a nutrient no line has: that is unknown, never 0.
  const counted = (t: NutrientTotal | undefined): t is NutrientTotal => !!t && t.known > 0;
  const known = SERVING_PARTS.flatMap((p) => {
    const t = s[p.key];
    return counted(t) ? [t] : [];
  });
  const worst = derived ? known.reduce<NutrientTotal | null>((w, t) => (t.known < t.of && (w === null || t.known < w.known) ? t : w), null) : null;
  const head = worst ? `Per serving (${worst.known} of ${worst.of} lines counted)` : "Per serving";
  const parts = SERVING_PARTS.map((p) => {
    const t = s[p.key];
    if (!counted(t)) return p.unknown;
    const own = derived && t.known < t.of && worst && t.known !== worst.known ? ` (${t.known} of ${t.of})` : "";
    return `${p.shown(n(t.value))}${own}`;
  });
  return `${head}: ${parts.join(" · ")}`;
}

export function recipeView(r: RecipeRecord): RecipeView {
  const s = r.per_serving;
  return {
    title: r.name,
    facts: [`${qty(r.servings)} ${r.servings === 1 ? "serving" : "servings"}`, r.meal_type, r.prep_type].filter((x): x is string => !!x).join(" · "),
    method: r.method,
    lines: r.lines.map((l) => ({ id: l.id, position: l.position, food: foodLabel(l.name, l.state), amount: `${qty(l.amount_value)} ${l.amount_unit === "measure" ? (l.measure ?? "measure") : l.amount_unit}`, value: l.amount_value })),
    perServing: s ? perServingText(s, r.derived) : r.lines.length > 0 ? "Per serving: unknown" : null,
    manual: r.derived ? null : `Macros typed by hand${r.manual_macros_reason ? `: ${r.manual_macros_reason.trim().replace(/[.\s]+$/, "")}` : ""}.`,
  };
}

/** The food names a search offers for a recipe line's Food field: each name once (its states are the State field's), foods only. */
export function foodSuggestions(hits: readonly CatalogueHit[]): string[] {
  return [...new Set(hits.filter((h) => h.kind === "food_source").map((h) => h.name))];
}

/** Add a line (add_recipe_line): resolved like any amount; an ambiguous food asks. */
export function addLinePlan(recipeRef: string, fields: { food: string; value: string; unit: string; state?: string }, reason: string): Plan | { error: string } {
  if (fields.food.trim() === "") return { error: "Which food?" };
  const l = lineIn(fields, "");
  if ("error" in l) return { error: sentenceCase(l.error) };
  const why = reason.trim();
  if (why === "") return { error: REASON_NEEDED };
  // The state answers an ambiguous food ("Is that oats cooked or dry?"); blank leaves it to the API to ask.
  const state = (fields.state ?? "").trim();
  return { steps: [planStep("add_recipe_line", { recipe: recipeRef, line: state === "" ? l : { ...l, state }, reason: why })], done: `Added ${l.food}.` };
}

export function removeLinePlan(recipeRef: string, lineId: number, label: string, reason: string): Plan | { error: string } {
  const why = reason.trim();
  if (why === "") return { error: REASON_NEEDED };
  return { steps: [planStep("remove_recipe_line", { recipe: recipeRef, line_id: lineId, reason: why })], done: `Removed ${label}.` };
}

/** A line's amount (amend of the recipe line), sent only when it changed. */
export function lineAmountPlan(lineId: number, value: string, start: number, reason: string): Plan | { error: string } {
  const p = parseField({ key: "amount_value", label: "Amount", kind: "positive" }, value);
  if ("error" in p) return p;
  if (p.value === start) return { error: "Nothing changed." };
  return amendPlan({ table: "recipe_line", id: lineId }, { amount_value: p.value }, reason, `Amount changed to ${qty(p.value as number)}.`);
}

// ------------------------------------------------------------ measures, yields, words

export function addMeasurePlan(foodRef: string, fields: { name: string; amount: string }, reason: string): Plan | { error: string } {
  const name = fields.name.trim();
  if (name === "") return { error: "Name the measure, for example: katori." };
  const a = parseField({ key: "amount", label: "Amount", kind: "positive" }, fields.amount);
  if ("error" in a) return a;
  const why = reason.trim();
  if (why === "") return { error: REASON_NEEDED };
  return { steps: [planStep("add_measure", { food: foodRef, name, amount: a.value, reason: why })], done: `Added 1 ${name}.` };
}

/** A yield from another state of the same food: `from` is that state's ref (chosen from a list of states, never typed); thrown away as a percent. */
export function addYieldPlan(foodRef: string, fields: { from: string; factor: string; discarded: string }, reason: string): Plan | { error: string } {
  if (fields.from.trim() === "") return { error: "Which state does it come from?" };
  const f = parseField({ key: "factor", label: "How much it becomes", kind: "positive" }, fields.factor);
  if ("error" in f) return f;
  const d = parseField({ key: "discarded", label: "Thrown away", kind: "optional" }, fields.discarded);
  if ("error" in d || (d.value !== null && (d.value as number) >= 100)) return { error: "Thrown away must be a percent from 0 to 99." };
  const why = reason.trim();
  if (why === "") return { error: REASON_NEEDED };
  return {
    steps: [planStep("add_yield", { food: foodRef, from: fields.from.trim(), factor: f.value, ...(d.value === null ? {} : { discarded_fraction: (d.value as number) / 100 }), reason: why })],
    done: "Yield added.",
  };
}

/** Teach a word (learn_alias). A word that's taken asks; only the member's "Replace it" sends replace. */
export function teachWordPlan(kind: "food_source" | "recipe" | "exercise" | "workout", target: string | number, fields: { word: string }, reason: string, replace: boolean): Plan | { error: string } {
  const word = fields.word.trim();
  if (word === "") return { error: "Which word?" };
  const why = reason.trim();
  if (why === "") return { error: REASON_NEEDED };
  return { steps: [planStep("learn_alias", { alias: word, kind, target, reason: why, ...(replace ? { replace: true } : {}) })], done: `Learned "${word}".` };
}

/** Forget a word (forget_alias), with the member's reason: never "Forgotten in the app" (spec review #7). */
export function forgetWordPlan(id: number, word: string, reason: string): Plan | { error: string } {
  const why = reason.trim();
  if (why === "") return { error: REASON_NEEDED };
  return { steps: [planStep("forget_alias", { id, reason: why })], done: `Forgot "${word}".` };
}

/** Values typed as a list ("2.5, 5, 10"), each once. */
export function parseNumberList(text: string): { values: number[] } | { error: string } {
  const parts = text.split(/[\s,]+/).filter((p) => p !== "");
  if (parts.length === 0) return { error: "Give at least one value." };
  if (!parts.every(isNumber)) return { error: "Use numbers separated by commas, like 2.5, 5, 10." };
  return { values: [...new Set(parts.map(Number))] };
}

/** A yield's "from": the same food's other states (by name, without case), as the state in words; the ref goes only into the plan. */
export function otherStates(hits: readonly CatalogueHit[], food: { id: number; name: string }): { ref: string; label: string }[] {
  return hits.flatMap((h) => (h.kind === "food_source" && h.id !== food.id && h.name.toLowerCase() === food.name.toLowerCase() ? [{ ref: h.ref, label: stateLabel(h.state) }] : []));
}

/** learn_alias's question when a word already means something else: replace it, or keep the existing one (desktop spec §5). */
export const WORD_TAKEN = {
  reason: "alias_taken" as const,
  options: [
    { label: "Replace it", answer: "replace" },
    { label: "Keep the existing one", answer: null },
  ] as { label: string; answer: string | null }[],
};

// ------------------------------------------------------------ an edit's Save

/**
 * An edit's Save (desktop spec §5): only the changed fields, with the
 * override reason once the API asked about the energy, the member's own
 * reason, and "Saved: …" naming each change.
 */
export function editPlan(
  specs: readonly FieldSpec[],
  record: { table: string; id: number },
  draft: { start: Record<string, string>; fields: Record<string, string>; reason: string; override: string | null },
  asked: boolean,
): Plan | { error: string; field: string } {
  // Against the values the edit started from, never the record as re-read since (plan review #4).
  const start = draft.start;
  const diff = changedFields(specs, start, draft.fields);
  if ("error" in diff) return diff;
  let changes = diff.changes;
  if (asked) {
    const o = withOverride(changes, draft.override ?? "");
    if ("error" in o) return { error: o.error, field: "override" };
    changes = o.changes;
  }
  const plan = amendPlan(record, changes, draft.reason, savedText(specs, start, changes));
  return "error" in plan ? { error: plan.error, field: "reason" } : plan;
}

/** amend asked about macros that don't reconcile with kcal (energy_mismatch). */
export const energyAsked = (status: WriteStatus | null): boolean => status?.state === "question" && status.reason === "energy_mismatch";

/**
 * What a Save reaches, said near Save (desktop spec goal, mockup §4):
 * "Changes 31 logged items, 4 cooks and the Rajma curry recipe."
 */
export function reachText(d: Dependents): string {
  const parts: string[] = [];
  if (d.intake_items > 0) parts.push(plural(d.intake_items, "logged item", "logged items"));
  if (d.cooks.length > 0) parts.push(plural(d.cooks.length, "cook", "cooks"));
  if (d.recipes.length > 0) parts.push(`the ${list(d.recipes.map((r) => r.name))} ${d.recipes.length === 1 ? "recipe" : "recipes"}`);
  return parts.length === 0 ? "Nothing uses it yet." : `Changes ${list(parts)}.`;
}

/** Where an edit's status line sits: above the override field it asks for, else after the buttons (a held failure stays by Try again). */
export const statusAboveOverride = (status: WriteStatus | null): boolean => energyAsked(status);

/** The reach line as the dependents load: checking while loading, the reach once ready, and a plain warning only when the read failed. */
export function reachLine(state: { kind: string; data?: Dependents }): string {
  if (state.kind === "ready" && state.data) return reachText(state.data);
  if (state.kind === "loading") return "Checking what uses it…";
  return "What uses it didn't load; it may reach logged days.";
}

/** A new food's form starts with a state and a reference amount; never a reason. */
export const NEW_FOOD_START: Record<string, string> = { state: "as_sold", reference_amount: "100", reference_unit: "g" };

/** A new recipe's form starts with one serving and one empty line in grams. */
export const NEW_RECIPE_START: Record<string, string> = { servings: "1", lines: "1", "line-0-unit": "g" };

/** One more line row on the new-recipe form. */
export function addLineRow(fields: Record<string, string>): Record<string, string> {
  const count = Number(fields.lines ?? "1");
  const i = Number.isInteger(count) && count > 0 ? count : 1;
  return { ...fields, lines: String(i + 1), [`line-${i}-unit`]: "g" };
}

/** Where a new record opens once saved: by the ref the API allocated. */
export function createdHref(kind: "food" | "recipe", result: Record<string, unknown> | undefined): string | null {
  const rec = (kind === "food" ? result?.food_source : result?.recipe) as { ref?: unknown } | undefined;
  return typeof rec?.ref === "string" ? cataloguePath({ pane: "foods", record: { kind, ref: rec.ref } }) : null;
}

/** The words taught for one record (a food, recipe, exercise or workout), from `learned`. */
export function wordsFor(aliases: Learned["aliases"], kind: "food_source" | "recipe" | "exercise" | "workout", id: number): { id: number; word: string }[] {
  return aliases.filter((a) => a.kind === kind && a.target_id === id).map((a) => ({ id: a.id, word: a.alias }));
}

// ------------------------------------------------------------ workouts

export function workoutRows(items: readonly WorkoutOut[]): ListRow[] {
  return items.map((w) => ({
    key: `workout:${w.id}`,
    label: w.name,
    hint: `${plural(w.lines.length, "line", "lines")}${w.last_used ? ` · last ${day(w.last_used.slice(0, 10))}` : ""}`,
    href: cataloguePath({ pane: "workouts", id: w.id }),
  }));
}

const range = (low: number, high: number) => (low === high ? `${low}` : `${low}–${high}`);

/** A workout line in one sentence: "Goblet squat: 3 × 10–12, 16 kg, RIR 1–2, rest 90 s". */
export function workoutLineText(l: WorkoutLineOut): string {
  const target = l.target.kind === "reps" ? range(l.target.low, l.target.high) : l.target.kind === "duration" ? `${l.target.seconds} s` : `${qty(l.target.value)} ${l.target.unit}`;
  const load = l.load === null ? "" : l.load === "none" ? ", bodyweight" : `, ${loadText(l.load)}`;
  const rir = l.rir ? `, RIR ${range(l.rir.low, l.rir.high)}` : "";
  const rest = l.rest_s ? `, rest ${l.rest_s} s` : "";
  const kind = l.set_type === "working" ? "" : ` (${l.set_type.replace(/_/g, " ")})`;
  return `${l.exercise}: ${l.sets} × ${target}${load}${rir}${rest}${kind}`;
}

const WHOLE = /^\d+$/;

/** Add a line to a workout (add_workout_line): an exercise by name or learned word, whole sets, a rep range low to high. */
export function addWorkoutLinePlan(workoutId: number, fields: { exercise: string; sets: string; low: string; high: string }, reason: string): Plan | { error: string } {
  const exercise = fields.exercise.trim();
  if (exercise === "") return { error: "Which exercise?" };
  const sets = fields.sets.trim();
  if (!WHOLE.test(sets) || Number(sets) < 1 || Number(sets) > 20) return { error: "Sets is a whole number from 1 to 20." };
  const [low, high] = [fields.low.trim(), fields.high.trim()];
  if (!WHOLE.test(low) || !WHOLE.test(high) || Number(high) > 200) return { error: "Reps are whole numbers, like 8 to 10." };
  if (Number(low) > Number(high)) return { error: "Reps run low to high, like 8 to 10." };
  const why = reason.trim();
  if (why === "") return { error: REASON_NEEDED };
  return { steps: [planStep("add_workout_line", { workout: workoutId, line: { exercise, sets: Number(sets), reps: { low: Number(low), high: Number(high) } }, reason: why })], done: `Added ${exercise}.` };
}

export function removeWorkoutLinePlan(lineId: number, label: string, reason: string): Plan | { error: string } {
  const why = reason.trim();
  if (why === "") return { error: REASON_NEEDED };
  return { steps: [planStep("remove_workout_line", { line_id: lineId, reason: why })], done: `Removed ${label}.` };
}

// ------------------------------------------------------------ exercises (read-only)

const IMPLEMENT: Record<string, string> = {
  barbell: "barbell", dumbbell: "dumbbells", kettlebell: "kettlebell", machine: "machine", plate_loaded: "plate-loaded", cable: "cable",
  fixed_bar: "fixed bar", plates: "plates", bodyweight: "bodyweight", band: "band", cardio_machine: "cardio machine", other: "other",
};

/** An implement kind in words. */
export const implementWord = (kind: string): string => IMPLEMENT[kind] ?? kind.replace(/_/g, " ");

export function exerciseRows(items: readonly CatalogueListExercise[]): ListRow[] {
  return items.map((e) => ({ key: `exercise:${e.id}`, label: e.name, hint: `${implementWord(e.implement_kind)} · ${e.last_done ? `last ${day(e.last_done)}` : "not done yet"}`, href: cataloguePath({ pane: "exercises", id: e.id }) }));
}

/** last_trained in a sentence: its day and the API's days since. */
export function lastDoneText(t: LastTrained): string {
  if (t.last === null) return "Not done yet.";
  const ago = t.days_since === 0 ? "today" : t.days_since === null ? "" : `${plural(t.days_since, "day", "days")} ago`;
  return `Last done ${day(t.last)}${ago ? `, ${ago}` : ""}.`;
}

// ------------------------------------------------------------ gyms and equipment

export function gymRows(items: readonly CatalogueListGym[]): ListRow[] {
  return items.map((g) => ({ key: `gym:${g.id}`, label: g.name, hint: plural(g.equipment, "piece of equipment", "pieces of equipment"), href: cataloguePath({ pane: "gyms", id: g.id }) }));
}

/** Loads grouped by unit, in the API's order: "2.5, 5 kg; 10 lb". */
const byUnit = (loads: readonly LoadAmount[]) => {
  const units = [...new Set(loads.map((l) => l.unit))];
  return units.map((u) => `${loads.filter((l) => l.unit === u).map((l) => qty(l.value)).join(", ")} ${u}`).join("; ");
};

export function implementRows(inv: Inventory): { id: number; name: string; loads: string; note: string | null; bar: string | null; barred: boolean; unit: "kg" | "lb" }[] {
  return inv.implements.map((i) => {
    const notes = [i.absent.length > 0 ? `Not here: ${byUnit(i.absent)}.` : null, i.load_list_complete ? null : "The list may be missing some loads."].filter((x): x is string => x !== null);
    return {
      id: i.id,
      name: i.name,
      loads: i.loads === null ? "From the gym's plates" : i.loads.length === 0 ? "No loads listed" : byUnit(i.loads),
      note: notes.length > 0 ? notes.join(" ") : null,
      bar: i.bar ? `Bar ${qty(i.bar.value)} ${i.bar.unit}` : null,
      barred: i.loads === null,
      unit: i.unit,
    };
  });
}

/** The gym's plates per unit, as the API marks them. */
export function plateRows(inv: Inventory): string[] {
  return inv.plates.map((p) => {
    const seen = p.plates.filter((x) => x.status === "confirmed").map((x) => qty(x.value));
    const unchecked = p.plates.filter((x) => x.status === "inferred").map((x) => qty(x.value));
    const absent = p.plates.filter((x) => x.status === "absent").map((x) => qty(x.value));
    return `${p.unit}: ${seen.join(", ") || "none seen"}${unchecked.length > 0 ? ` (${unchecked.join(", ")} not checked)` : ""}${absent.length > 0 ? `; no ${absent.join(", ")}` : ""}. ${p.complete ? "That is all of them." : "May be missing some."}`;
  });
}

/** Add loads a piece has, or remove ones it doesn't, in its unit, with a reason. */
export function loadsPlan(tool: "add_implement_load" | "remove_implement_load", implementId: number, unit: "kg" | "lb", text: string, reason: string): Plan | { error: string } {
  const list = parseNumberList(text);
  if ("error" in list) return list;
  const why = reason.trim();
  if (why === "") return { error: REASON_NEEDED };
  return {
    steps: [planStep(tool, { implement_id: implementId, loads: list.values.map((value) => ({ value, unit })), reason: why })],
    done: `${tool === "add_implement_load" ? "Added" : "Removed"} ${list.values.map(qty).join(", ")} ${unit}.`,
  };
}

/** Record a gym's plates of one unit: those seen, those not there. */
export function recordPlatesPlan(gymId: number, unit: "kg" | "lb", available: string, absent: string, reason: string): Plan | { error: string } {
  const seen = available.trim() === "" ? { values: [] as number[] } : parseNumberList(available);
  if ("error" in seen) return seen;
  const gone = absent.trim() === "" ? { values: [] as number[] } : parseNumberList(absent);
  if ("error" in gone) return gone;
  if (seen.values.length === 0 && gone.values.length === 0) return { error: "Give the plates seen, or the ones not there." };
  const both = seen.values.filter((v) => gone.values.includes(v));
  if (both.length > 0) return { error: `${both.map(qty).join(", ")} can't be both there and not there.` };
  const why = reason.trim();
  if (why === "") return { error: REASON_NEEDED };
  return {
    steps: [planStep("record_plates", { gym: gymId, unit, ...(seen.values.length > 0 ? { available: seen.values } : {}), ...(gone.values.length > 0 ? { absent: gone.values } : {}), reason: why })],
    done: "Plates saved.",
  };
}

/** A bar's or sled's own weight (amend of the implement). */
export function barPlan(implementId: number, value: string, unit: "kg" | "lb", reason: string): Plan | { error: string } {
  const v = parseField({ key: "bar_value", label: "The bar's weight", kind: "positive" }, value);
  if ("error" in v) return v;
  return amendPlan({ table: "implement", id: implementId }, { bar_value: v.value, bar_unit: unit }, reason, `Bar set to ${qty(v.value as number)} ${unit}.`);
}
