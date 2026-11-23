import {
  labelEnergyCheck,
  resolveAmount,
  scaleNutrients,
  type AmountInput,
  type AmountUnit,
  type FoodSource,
  type Nutrients,
  type NutrientTotals,
  type Yield,
} from "@myfitnessguide/domain";
import { z } from "zod";
import type { Ctx } from "./context";
import { all } from "./db";
import { Clarify } from "./errors";
import { fuzzyRank } from "./fuzzy";

export const STATES = ["as_sold", "raw", "dry", "cooked", "soaked", "drained", "shelled", "in_shell"] as const;
export const PROVENANCE = ["weighed", "counted", "label", "estimated", "inferred", "reconstructed"] as const;
export const MEAL_SLOTS = ["breakfast", "lunch", "dinner", "snack", "pre_workout", "post_workout"] as const;
export const MICROS = [
  "sodium_mg",
  "fibre_g",
  "iron_mg",
  "b12_ug",
  "calcium_mg",
  "magnesium_mg",
  "potassium_mg",
  "sat_fat_g",
  "total_sugars_g",
  "vitamin_c_mg",
] as const;
export const PROTEIN_BANDS = ["complete", "partial", "incomplete", "negligible"] as const;

/** An amount as the agent parsed it. The API validates; it never guesses a state or a unit. */
export const AMOUNT = {
  food: z.string().min(1).describe("Food source name or ref (FS001). A ref pins the state."),
  value: z.number().positive(),
  unit: z.enum(["mg", "g", "kg", "ml", "l", "piece"]).optional().describe("Give a unit or a measure."),
  measure: z.string().optional().describe("A named measure of the source, e.g. tsp or egg."),
  state: z.enum(STATES).optional().describe("Required when the food exists in more than one state."),
};
export const AmountSchema = z.object(AMOUNT).strict();
export type AmountIn = z.infer<typeof AmountSchema>;

export interface SourceRow {
  id: number;
  ref: string;
  name: string;
  state: string;
  reference_amount: number;
  reference_unit: "g" | "ml" | "piece";
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  protein_band: string | null;
  price_min_inr: number | null;
  price_max_inr: number | null;
  [key: string]: unknown;
}

export interface MeasureRow {
  id: number;
  food_source_id: number;
  name: string;
  amount: number;
}

const toDomainUnit = (u: string): AmountUnit => (u === "piece" ? "each" : (u as AmountUnit));

/**
 * Nutrients per reference amount, in the domain's keys (kcal, protein,
 * carbs, fat) plus the micros by column name. Price and protein band ride
 * along as nutrients, so the domain's totals carry cost and bands with
 * coverage like any other value.
 */
export function nutrientsOf(row: SourceRow): Nutrients {
  const n: Record<string, number | null> = {
    kcal: row.kcal,
    protein: row.protein_g,
    carbs: row.carbs_g,
    fat: row.fat_g,
  };
  for (const m of MICROS) n[m] = (row[m] as number | null) ?? null;
  n.cost_min_inr = row.price_min_inr;
  n.cost_max_inr = row.price_max_inr;
  for (const b of PROTEIN_BANDS) n[`protein_${b}`] = row.protein_band === null ? null : row.protein_band === b ? row.protein_g : 0;
  return n;
}

export function toFoodSource(row: SourceRow, measures: readonly MeasureRow[]): FoodSource {
  return {
    id: String(row.id),
    food: row.name.toLowerCase(),
    state: row.state,
    referenceAmount: { value: row.reference_amount, unit: toDomainUnit(row.reference_unit) },
    measures: measures.filter((m) => m.food_source_id === row.id).map((m) => ({ name: m.name.toLowerCase(), amount: m.amount })),
    nutrients: nutrientsOf(row),
  };
}

/** The household catalogue, loaded once per call. */
export class Catalogue {
  private constructor(
    readonly rows: SourceRow[],
    readonly measures: MeasureRow[],
    readonly sources: FoodSource[],
    readonly yields: Yield[],
    /** Each learned word, keyed without case, with its source and its stored spelling. */
    private readonly aliases: Map<string, { id: number; word: string }>,
  ) {}

  static async load(ctx: Ctx): Promise<Catalogue> {
    // Every food source with its measures, the yields from it and its aliases, in one statement (decision 96).
    const raw = await all<SourceRow & { _measures: string; _yields: string; _aliases: string }>(
      ctx.db,
      `SELECT f.*,
         (SELECT json_group_array(json_object('id', m.id, 'food_source_id', m.food_source_id, 'name', m.name, 'amount', m.amount))
            FROM measure m WHERE m.food_source_id = f.id) AS _measures,
         (SELECT json_group_array(json_object('to_id', y.to_food_source_id, 'factor', y.factor, 'discarded_fraction', y.discarded_fraction))
            FROM yield y WHERE y.from_food_source_id = f.id) AS _yields,
         (SELECT json_group_array(a.alias) FROM alias a WHERE a.household_id = f.household_id AND a.kind = 'food_source' AND a.target_id = f.id) AS _aliases
       FROM food_source f WHERE f.household_id = ? ORDER BY f.id`,
      ctx.householdId,
    );
    const rows = raw.map(({ _measures: _m, _yields: _y, _aliases: _a, ...r }) => r as SourceRow);
    const aliases = new Map(raw.flatMap((r) => (JSON.parse(r._aliases) as string[]).map((w) => [w.toLowerCase(), { id: r.id, word: w }] as const)));
    const measures = raw.flatMap((r) => JSON.parse(r._measures) as MeasureRow[]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const yields: Yield[] = [];
    for (const from of raw) {
      for (const y of JSON.parse(from._yields) as { to_id: number; factor: number; discarded_fraction: number }[]) {
        const to = byId.get(y.to_id);
        if (to && from.name.toLowerCase() === to.name.toLowerCase()) {
          yields.push({ food: from.name.toLowerCase(), fromState: from.state, toState: to.state, factor: y.factor, discardedFraction: y.discarded_fraction });
        }
      }
    }
    return new Catalogue(rows, measures, rows.map((r) => toFoodSource(r, measures)), yields, aliases);
  }

  private aliasesById: Map<number, string[]> | null = null;

  /** The household's words for one food source (indexed by source once per catalogue). */
  aliasesOf(id: number): string[] {
    if (!this.aliasesById) {
      this.aliasesById = new Map();
      for (const a of this.aliases.values()) {
        const list = this.aliasesById.get(a.id);
        if (list) list.push(a.word);
        else this.aliasesById.set(a.id, [a.word]);
      }
    }
    return this.aliasesById.get(id) ?? [];
  }

  /** The one source a ref or a learned word names, ignoring case; undefined when neither. */
  pinned(key: string): SourceRow | undefined {
    const k = key.trim().toLowerCase();
    const alias = this.aliases.get(k);
    return this.rows.find((r) => r.ref.toLowerCase() === k) ?? (alias ? this.rows.find((r) => r.id === alias.id) : undefined);
  }

  row(id: number): SourceRow {
    const r = this.rows.find((x) => x.id === id);
    if (!r) throw new Error(`food source ${id} not loaded`);
    return r;
  }

  source(id: number): FoodSource {
    return this.sources.find((s) => s.id === String(id)) as FoodSource;
  }

  /**
   * Resolve an amount as entered to one food source, through the domain.
   * Every ambiguity comes back as a Clarify at `path`.
   */
  resolve(input: AmountIn, path: (string | number)[]): ResolvedAmount {
    let food = input.food.trim().toLowerCase();
    let state: string | undefined = input.state;
    // A ref or a learned word names one source, so it pins the state.
    const pinned = this.pinned(food);
    if (pinned) {
      food = pinned.name.toLowerCase();
      state = pinned.state;
    }
    const domainInput: AmountInput = { food, value: input.value };
    if (input.unit !== undefined) domainInput.unit = toDomainUnit(input.unit);
    if (input.measure !== undefined) domainInput.measure = input.measure.toLowerCase();
    if (state !== undefined) domainInput.state = state;
    const result = resolveAmount(domainInput, this.sources, this.yields);
    if (result.kind === "clarify") {
      let options: unknown[] = result.options;
      if (result.reason === "unknown_food") {
        options = fuzzyRank(input.food, this.rows.map((r) => ({ item: `${r.name} (${r.state}, ${r.ref})`, names: [r.name, r.ref, ...this.aliasesOf(r.id)] }))).slice(0, 5);
      }
      throw new Clarify(result.reason, result.question, options, path);
    }
    const row = this.row(Number(result.sourceId));
    const measure =
      input.measure !== undefined && result.yieldApplied === null
        ? this.measures.find((m) => m.food_source_id === row.id && m.name.toLowerCase() === input.measure?.toLowerCase())
        : undefined;
    return {
      row,
      multiples: result.multiples,
      // Stored as entered when it was a measure of this source; otherwise in
      // the source's reference unit (converted from kg, mg, l, or through a yield).
      stored: measure
        ? { amount_value: input.value, amount_unit: "measure", measure_id: measure.id }
        : { amount_value: result.amount, amount_unit: row.reference_unit, measure_id: null },
      yieldApplied: result.yieldApplied,
      nutrients: scaleNutrients(this.source(row.id).nutrients, result.multiples),
    };
  }

  /** Multiples of the reference amount for a stored line, through the domain's resolveAmount. */
  storedMultiples(line: { food_source_id: number; amount_value: number; amount_unit: string; measure_id: number | null }): number | null {
    const row = this.row(line.food_source_id);
    const input: AmountInput = { food: row.name.toLowerCase(), state: row.state, value: line.amount_value };
    if (line.amount_unit === "measure") {
      const m = this.measures.find((x) => x.id === line.measure_id);
      if (!m) return null;
      input.measure = m.name.toLowerCase();
    } else {
      input.unit = toDomainUnit(line.amount_unit);
    }
    const result = resolveAmount(input, [this.source(row.id)]);
    return result.kind === "resolved" ? result.multiples : null;
  }

  storedNutrients(line: { food_source_id: number; amount_value: number; amount_unit: string; measure_id: number | null }): NutrientTotals | null {
    const multiples = this.storedMultiples(line);
    return multiples === null ? null : scaleNutrients(this.source(line.food_source_id).nutrients, multiples);
  }
}

export interface ResolvedAmount {
  row: SourceRow;
  multiples: number;
  stored: { amount_value: number; amount_unit: string; measure_id: number | null };
  yieldApplied: { fromState: string; toState: string; factor: number; discardedFraction: number } | null;
  nutrients: NutrientTotals;
}

/**
 * The label energy check (domain labelEnergyCheck) on a food source's
 * values: asks when the macros don't reconcile with the stated energy,
 * unless the source carries an override reason. Returns what it found.
 */
export function checkLabelEnergy(
  row: { kcal: number; protein_g: number; carbs_g: number; fat_g: number; energy_override_reason?: string | null },
  path: (string | number)[],
) {
  const c = labelEnergyCheck({ kcal: row.kcal, protein: row.protein_g, carbs: row.carbs_g, fat: row.fat_g });
  const check = {
    reconciles: c.reconciles,
    atwater_kcal: c.atwaterKcal,
    difference_kcal: c.differenceKcal,
    tolerance_kcal: c.toleranceKcal,
    override_reason: row.energy_override_reason ?? null,
  };
  if (!c.reconciles && !row.energy_override_reason) {
    const round = (n: number) => Math.round(n * 10) / 10;
    throw new Clarify(
      "energy_mismatch",
      `The macros give ${round(c.atwaterKcal)} kcal (4/4/9), ${round(Math.abs(c.differenceKcal))} kcal ${c.differenceKcal < 0 ? "under" : "over"} the stated ${row.kcal}. Is a macro missing or misread, or the reference amount wrong? If the label really says this, give energy_override_reason.`,
      [],
      path,
      { energy_check: check },
    );
  }
  return check;
}
