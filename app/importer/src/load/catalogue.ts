/**
 * base Food Sources and Recipes (+ Recipe Ingredients) -> the household
 * catalogue, through upsert_food_source and upsert_recipe.
 *
 * Sheets gives nutrients per *serving* (free text such as "1 scoop (33 g)").
 * The app wants them per typed reference amount, so each serving is read as:
 * a leading weight or volume ("100 g dry", "250 mL"); else a weight in
 * parentheses ("1 scoop (33 g)", also kept as the measure "scoop"); else one
 * piece. Either way the nutrients per serving are unchanged, and a quantity
 * in servings converts exactly (qty x reference amount).
 */
import { labelEnergyCheck } from "@myfitnessguide/domain";
import type { Row } from "../grid";
import { ParseError } from "../parse";
import { Loader, RowReader } from "./context";

export interface Serving {
  amount: number;
  unit: "g" | "ml" | "piece";
  measure: { name: string; amount: number } | null;
}

export function parseServing(text: string): Serving {
  const t = text.trim();
  let m = /^(\d+(?:\.\d+)?)\s*(g|ml)\b/i.exec(t);
  if (m) return { amount: Number(m[1]), unit: (m[2] as string).toLowerCase() as "g" | "ml", measure: null };
  m = /\(~?\s*(\d+(?:\.\d+)?)\s*(g|ml)\)/i.exec(t);
  if (m) {
    const amount = Number(m[1]);
    const unit = (m[2] as string).toLowerCase() as "g" | "ml";
    const name = /^1\s+([a-z][a-z ]*?)\s*\(/i.exec(t)?.[1]?.trim().toLowerCase() ?? null;
    return { amount, unit, measure: name && name.length <= 30 ? { name, amount } : null };
  }
  return { amount: 1, unit: "piece", measure: null };
}

export type State = "as_sold" | "raw" | "dry" | "cooked" | "shelled";

/** The state a source's name or serving states outright, or null when it states none. */
export function statedState(name: string, serving: string): State | null {
  const t = `${name} ${serving}`.toLowerCase();
  if (/\bdry\b/.test(t) && !/dry[- ]roasted/.test(t)) return "dry";
  if (/\b(cooked|boiled)\b/.test(t)) return "cooked";
  if (/\braw\b/.test(t)) return "raw";
  if (/\begg( white)?\b/.test(name.toLowerCase()) && /\begg\b/.test(serving.toLowerCase())) return "shelled";
  return null;
}

/** Whole-food staples whose weight changes with cooking: their state is worth a ruling when the sheet doesn't say. */
const STAPLE = /\b(rice|oats|atta|flour|dal|daal|chana|rajma|chickpeas?|lentils?|quinoa|pasta|penne|millet|soya|makhana|murmura|poha)\b/i;
const PREPARED = /^(mixed meal|restaurant dish|snack|protein bar|dessert|beverage)$/i;

const MICROS: [string, string][] = [
  ["X", "sodium_mg"], ["Y", "fibre_g"], ["Z", "iron_mg"], ["AA", "b12_ug"], ["AB", "calcium_mg"], ["AC", "magnesium_mg"], ["AD", "potassium_mg"],
  ["AF", "sat_fat_g"], ["AG", "total_sugars_g"], ["AH", "vitamin_c_mg"],
];
const BANDS = ["complete", "partial", "incomplete", "negligible"];

export interface SourceFact {
  id: number;
  reference_amount: number;
  reference_unit: "g" | "ml" | "piece";
}

export const sourceFact = (ld: Loader, ref: string) => ld.facts.get(`fs:${ref.trim().toUpperCase()}`) as SourceFact | undefined;

export async function loadFoodSources(ld: Loader): Promise<void> {
  for (const row of ld.sheet("base", "Food Sources")?.rows() ?? []) await loadFoodSource(ld, row);
}

async function loadFoodSource(ld: Loader, row: Row): Promise<void> {
  const origin = ld.origin(row);
  const ref = row.text("U").toUpperCase();
  const name = row.text("A");
  const servingText = row.text("B");
  if (!ref || !name) {
    ld.book.raise({ origin, code: "missing_key", kind: "semantic", problem: "A food source row has no Food ID or no name.", proposed_fix: "Give it a ref and a name, or leave it out.", proposal: null, row: row.cells(["A", "B", "U"]) });
    return;
  }
  const rd = new RowReader(ld, row);
  const input: Record<string, unknown> = { ref, name };
  try {
    const kcal = rd.num("F");
    const protein = rd.num("G");
    const carbs = rd.num("H");
    const fat = rd.num("I");
    Object.assign(input, { kcal, protein_g: protein, carbs_g: carbs, fat_g: fat });
    for (const [col, key] of MICROS) {
      const v = rd.num(col);
      if (v !== null) input[key] = v;
    }
    const pmin = rd.num("J");
    const pmax = rd.num("K");
    if (pmin !== null || pmax !== null) {
      input.price_min_inr = pmin ?? pmax;
      input.price_max_inr = pmax ?? pmin;
    }
    const checked = rd.date("V");
    if (checked) input.last_checked_on = checked;
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    ld.book.raise({ origin, code: "unreadable_value", kind: "semantic", problem: error.message, proposed_fix: "Correct the cell, or leave the source out.", proposal: null, row: row.cells(["F", "G", "H", "I", "J", "K", "V"]) });
    return;
  }
  rd.flush();
  const band = row.text("AE").toLowerCase();
  if (band && BANDS.includes(band)) input.protein_band = band;
  else if (band) {
    ld.book.raise({ origin, code: "unknown_protein_band", kind: "semantic", problem: `protein_band "${band}" is not one of ${BANDS.join(", ")}`, proposed_fix: "Leave the band unknown.", proposal: true, row: row.cells(["AE"]) });
  }
  const serving = parseServing(servingText);
  Object.assign(input, { reference_amount: serving.amount, reference_unit: serving.unit });
  if (serving.measure) input.measures = [serving.measure];
  for (const [col, key] of [["R", "protein_quality"], ["S", "primary_category"], ["T", "tags"]] as const) if (row.text(col)) input[key] = row.text(col);
  const assumptions = [row.text("W"), `Serving in Sheets: ${servingText || "(blank)"}`].filter(Boolean).join("\n");
  input.assumptions = assumptions;

  let state: State | null = statedState(name, servingText);
  if (state === null) {
    state = "as_sold";
    if (STAPLE.test(name) && !PREPARED.test(row.text("S"))) {
      const r = ld.book.raise<State>({
        origin, code: "unclear_food_state", kind: "semantic",
        problem: `"${name}" (${servingText}) does not say whether it is dry, raw or cooked, and its weight depends on it.`,
        proposed_fix: "Treat it as sold (as_sold), or give the state as override (dry, raw, cooked, soaked, drained).",
        proposal: "as_sold", row: row.cells(["A", "B", "S"]),
      });
      if (!r.apply) return;
      state = r.value;
    }
  }
  input.state = state;
  if (!energyReconciles(ld, row, input)) return;
  const res = await ld.write("upsert_food_source", input, origin, { evidence: row });
  if (!res) return;
  const id = (res.food_source as { id: number }).id;
  ld.record(origin, { table: "food_source", id, tool: "upsert_food_source" });
  ld.facts.set(`fs:${ref}`, { id, reference_amount: serving.amount, reference_unit: serving.unit } satisfies SourceFact);
}

export async function loadRecipes(ld: Loader): Promise<void> {
  const lines = ld.sheet("base", "Recipe Ingredients")?.rows() ?? [];
  const byRecipe = new Map<string, Row[]>();
  for (const l of lines) {
    const ref = l.text("N").toUpperCase();
    if (!ref) {
      ld.book.raise({ origin: ld.origin(l), code: "orphan_line", kind: "semantic", problem: "An ingredient line has no Recipe ID.", proposed_fix: "Give it its recipe's ref, or leave it out.", proposal: null, row: l.cells(["A", "B", "D", "N"]) });
      continue;
    }
    byRecipe.set(ref, [...(byRecipe.get(ref) ?? []), l]);
  }
  const known = new Set<string>();
  for (const row of ld.sheet("base", "Recipes")?.rows() ?? []) {
    const ref = row.text("Y").toUpperCase();
    known.add(ref);
    await loadRecipe(ld, row, byRecipe.get(ref) ?? []);
  }
  for (const [ref, ls] of byRecipe) {
    if (known.has(ref)) continue;
    for (const l of ls) {
      ld.book.raise({ origin: ld.origin(l), code: "unknown_recipe", kind: "semantic", problem: `The line's recipe ${ref} is not in Recipes.`, proposed_fix: "Correct the Recipe ID, or leave the line out.", proposal: null, row: l.cells(["A", "B", "D", "N"]) });
    }
  }
}

async function loadRecipe(ld: Loader, row: Row, lineRows: Row[]): Promise<void> {
  const origin = ld.origin(row);
  const ref = row.text("Y").toUpperCase();
  const name = row.text("A");
  if (!ref || !name) {
    ld.book.raise({ origin, code: "missing_key", kind: "semantic", problem: "A recipe row has no Recipe ID or no dish name.", proposed_fix: "Give it both, or leave it out.", proposal: null, row: row.cells(["A", "Y"]) });
    return;
  }
  const lines: Record<string, unknown>[] = [];
  for (const l of lineRows) {
    const lrd = new RowReader(ld, l);
    const fsRef = l.text("B").toUpperCase();
    const fact = sourceFact(ld, fsRef);
    let qty: number | null;
    try {
      qty = lrd.num("D");
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      qty = null;
    }
    if (!fact || qty === null || !(qty > 0)) {
      ld.book.raise({
        origin: ld.origin(l), code: fact ? "bad_quantity" : "unknown_food", kind: "semantic",
        problem: fact ? `Quantity "${l.text("D")}" is not a positive number of servings.` : `Food ${fsRef || "(blank)"} is not a loaded food source.`,
        proposed_fix: "Correct the line, or leave it out of the recipe.", proposal: null, row: l.cells(["A", "B", "D", "N"]),
      });
      continue;
    }
    lrd.flush();
    const link = l.text("L").toLowerCase();
    const note = [l.text("E"), l.text("M")].filter(Boolean).join("; ");
    lines.push({
      food: fsRef, value: round9(qty * fact.reference_amount), unit: fact.reference_unit,
      ...(link === "confirmed" || link === "assumed" ? { link_status: link } : {}),
      ...(note ? { note } : {}),
    });
  }
  const derived = row.text("Z").toLowerCase() === "derived";
  const input: Record<string, unknown> = {
    ref, name, kind: row.text("AK").toLowerCase() === "meal plan" ? "idea" : "dish", servings: 1, lines,
  };
  for (const [col, key] of [["B", "meal_type"], ["C", "prep_type"], ["J", "method"]] as const) if (row.text(col)) input[key] = row.text(col);
  const assumptions = [row.text("K"), row.text("I") ? `Ingredients: ${row.text("I")}` : ""].filter(Boolean).join("\n");
  if (assumptions) input.source_assumptions = assumptions;
  if (!derived) {
    const rd = new RowReader(ld, row);
    try {
      const [kcal, protein, carbs, fat] = ["E", "F", "G", "H"].map((c) => rd.num(c));
      if ([kcal, protein, carbs, fat].some((v) => v === null)) throw new ParseError("a stored recipe is missing one of its typed macros (E-H)");
      input.manual_macros = { kcal, protein_g: protein, carbs_g: carbs, fat_g: fat, reason: "Stored estimate in Sheets (Derivation: stored); its ingredient lines are partial or absent." };
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      ld.book.raise({ origin, code: "unreadable_value", kind: "semantic", problem: error.message, proposed_fix: "Correct the macros, or leave the recipe out.", proposal: null, row: row.cells(["E", "F", "G", "H", "Z"]) });
      return;
    }
    rd.flush();
  }
  const res = await ld.write("upsert_recipe", input, origin, { evidence: row });
  if (!res) return;
  const id = (res.recipe as { id: number }).id;
  ld.record(origin, { table: "recipe", id, tool: "upsert_recipe" });
  ld.facts.set(`recipe:${ref}`, { id, derived });
}

export const round9 = (x: number) => Math.round(x * 1e9) / 1e9;

/**
 * The API's label energy check, ruled on before the write: a source whose
 * macros don't reconcile with its stated kcal is a semantic ruling, and
 * while pending (or accepted) it is imported as typed, with the override
 * reason the API needs. False when the ruling leaves the row out.
 */
function energyReconciles(ld: Loader, row: Row, input: Record<string, unknown>): boolean {
  const [kcal, protein, carbs, fat] = [input.kcal, input.protein_g, input.carbs_g, input.fat_g];
  if (typeof kcal !== "number" || typeof protein !== "number" || typeof carbs !== "number" || typeof fat !== "number") return true;
  const check = labelEnergyCheck({ kcal, protein, carbs, fat });
  if (check.reconciles) return true;
  const round = (n: number) => Math.round(n * 10) / 10;
  const r = ld.book.raise<string>({
    origin: ld.origin(row),
    code: "label_energy_mismatch",
    kind: "semantic",
    problem: `The macros give ${round(check.atwaterKcal)} kcal by 4/4/9, ${round(Math.abs(check.differenceKcal))} kcal ${check.differenceKcal < 0 ? "under" : "over"} the stated ${kcal} (tolerance ${round(check.toleranceKcal)}).`,
    proposed_fix: "Import it as typed with the reason given here (or an override reason), or reject it and correct the source after cutover.",
    proposal: "Imported as typed from the Sheets catalogue; its macros were never reconciled with its energy.",
    row: row.cells(["A", "B", "F", "G", "H", "I"]),
  });
  if (!r.apply) return false;
  input.energy_override_reason = r.value;
  return true;
}
