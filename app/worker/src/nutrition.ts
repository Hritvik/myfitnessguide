import {
  addDays,
  dayTotals,
  KCAL_PER_G,
  leftToday,
  recomputeCook,
  resolveTarget,
  sumNutrients,
  totalsFrom,
  type Cook,
  type CookResult,
  type DayTotals,
  type LeftToday,
  type MacroTarget,
  type NutrientTotal,
  type NutrientTotals,
  type Portion,
  type RemainderMark,
  type ResolvedTarget,
  type Target,
} from "@myfitnessguide/domain";
import { z } from "zod";
import { AMOUNT, MICROS, PROTEIN_BANDS, PROVENANCE, type Catalogue } from "./catalogue";
import type { Ctx, Member } from "./context";
import { all, allIn, first, type Row } from "./db";
import { Clarify, ToolError } from "./errors";
import { bestScore, fuzzyRank } from "./fuzzy";
import { loadRecipeLines, recipeNutrients, type RecipeBook, type RecipeLineRow, type RecipeRow } from "./recipes";

// ------------------------------------------------------------ input shapes

const ITEM_COMMON = {
  provenance: z.enum(PROVENANCE),
  confidence: z.enum(["high", "medium", "low"]),
  dominant_uncertainty: z
    .object({ description: z.string().min(1), kcal: z.number().min(0).describe("Its size in ± kcal.") })
    .strict()
    .optional(),
  label: z.string().optional().describe("The item as the member said it, e.g. '2 medium'."),
  note: z.string().optional(),
};

function itemUnion<E extends z.ZodRawShape>(extra: E) {
  return z.discriminatedUnion("source", [
    z.object({ source: z.literal("food"), ...AMOUNT, ...ITEM_COMMON, ...extra }).strict(),
    z
      .object({ source: z.literal("recipe"), recipe: z.string().min(1).describe("Recipe ref or name."), servings: z.number().positive(), ...ITEM_COMMON, ...extra })
      .strict(),
    z
      .object({
        source: z.literal("manual"),
        kcal: z.number().min(0),
        protein_g: z.number().min(0),
        carbs_g: z.number().min(0),
        fat_g: z.number().min(0),
        reason: z.string().min(1).describe("Why the macros are manual."),
        name: z
          .string()
          .min(1)
          .optional()
          .describe("What was eaten, as the member said it. The API resolves it against the catalogue and refuses a strong match unless override_reason is given."),
        override_reason: z
          .string()
          .min(1)
          .optional()
          .describe("Why a catalogue match is deliberately not used (label differs, catalogue stale, custom preparation, catalogue outage). Recorded on the item."),
        ...ITEM_COMMON,
        ...extra,
      })
      .strict(),
  ]);
}

export const ITEM = itemUnion({});
/** An item with the member who ate it (household_meal's direct items). */
export const MEMBER_ITEM = itemUnion({ member: z.string().min(1) });
export type ItemIn = z.infer<typeof ITEM>;

export const PORTION = z
  .object({
    member: z.string().min(1),
    component: z.string().optional().describe("Defaults to the cook's only component."),
    fraction: z.number().min(0).max(1).optional(),
    weighed_g: z.number().min(0).optional(),
    provenance: z.enum(PROVENANCE),
    confidence: z.enum(["high", "medium", "low"]).optional().describe("Of the resulting intake item; default medium."),
    dominant_uncertainty: ITEM_COMMON.dominant_uncertainty.describe("The biggest uncertainty in this member's share, with its size in ± kcal."),
  })
  .strict();
export type PortionIn = z.infer<typeof PORTION>;

// --------------------------------------------------------------- intake items

export interface IntakeRow {
  id: number;
  member_id: number;
  eaten_on: string;
  meal_slot: string;
  household_meal_id: number | null;
  source_kind: "food_source" | "portion" | "recipe" | "manual";
  food_source_id: number | null;
  amount_value: number | null;
  amount_unit: string | null;
  measure_id: number | null;
  portion_id: number | null;
  recipe_id: number | null;
  recipe_servings: number | null;
  manual_kcal: number | null;
  manual_protein_g: number | null;
  manual_carbs_g: number | null;
  manual_fat_g: number | null;
  manual_reason: string | null;
  provenance: string | null;
  confidence: string;
  dominant_uncertainty: string | null;
  dominant_uncertainty_kcal: number | null;
  label: string | null;
  note: string | null;
  state: string;
  confirmed_at: string | null;
  /** The leftover serving this item belongs to (migration 0029); its nutrients come from the serving's cook. */
  leftover_serving_id: number | null;
}

export interface ItemWithNutrients {
  row: IntakeRow;
  nutrients: NutrientTotals;
}

/** Resolve one item as entered into intake_item columns and its nutrients, asking on any ambiguity. */
export async function resolveItem(
  ctx: Ctx,
  cat: Catalogue,
  item: ItemIn,
  path: (string | number)[],
  book: RecipeBook,
): Promise<{ columns: Row; nutrients: NutrientTotals; display: { ref: string | null; name: string | null } }> {
  const common: Row = {
    provenance: item.provenance,
    confidence: item.confidence,
    dominant_uncertainty: item.dominant_uncertainty?.description ?? null,
    dominant_uncertainty_kcal: item.dominant_uncertainty?.kcal ?? null,
    label: item.label ?? null,
    note: item.note ?? null,
  };
  if (item.source === "food") {
    const r = cat.resolve(item, path);
    const yieldNote = r.yieldApplied
      ? `entered as ${item.value} ${item.unit ?? ""} ${r.row.name} ${r.yieldApplied.fromState}; converted by yield x${r.yieldApplied.factor}`.replace(/\s+/g, " ")
      : null;
    return {
      columns: {
        ...common,
        source_kind: "food_source",
        food_source_id: r.row.id,
        ...r.stored,
        note: [item.note, yieldNote].filter(Boolean).join("; ") || null,
      },
      nutrients: r.nutrients,
      display: { ref: r.row.ref, name: r.row.name },
    };
  }
  if (item.source === "recipe") {
    const recipe = book.find(item.recipe);
    if (!recipe) {
      const dishes = book.recipes.filter((r) => r.kind === "dish");
      const options = fuzzyRank(item.recipe, dishes.map((r) => ({ item: `${r.name} (${r.ref})`, names: [r.name, r.ref, ...r.aliases] }))).slice(0, 5);
      throw new Clarify("unknown_recipe", `There is no recipe ${item.recipe}. Which one?`, options, [...path, "recipe"]);
    }
    if (recipe.kind === "idea") {
      throw new Clarify("recipe_is_idea", `${recipe.name} is a meal idea, which is never eaten. What was actually eaten?`, [], [...path, "recipe"]);
    }
    const lines = book.lines(recipe.id);
    return {
      columns: { ...common, source_kind: "recipe", recipe_id: recipe.id, recipe_servings: item.servings },
      nutrients: recipeNutrients(cat, recipe, lines, item.servings),
      display: { ref: recipe.ref, name: recipe.name },
    };
  }
  // Manual entries: enforce catalogue-first policy (INV-002, INV-003, INV-008).
  // A manual item may carry a `name` describing what was eaten; a strong
  // catalogue match must be confirmed or explicitly overridden.
  const manualItem = item;
  const description = (manualItem.name ?? manualItem.label ?? "").trim();
  const override = manualItem.override_reason;
  if (description !== "" && override === undefined) {
    const candidates = cat.rows
      .map((r) => ({ row: r, score: bestScore(description, [r.name, r.ref, ...cat.aliasesOf(r.id)]) }))
      .filter((c) => c.score >= 60)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    const top = candidates[0];
    if (top !== undefined && top.score >= 80) {
      throw new ToolError(
        "CATALOG_MATCH_REQUIRES_CONFIRMATION",
        `"${description}" matches ${top.row.name} (${top.row.ref}) in the catalogue. Log it by amount as a food source so the server computes its nutrients, or give override_reason if this is genuinely a different food.`,
        409,
        {
          candidates: candidates.map((c) => ({ ref: c.row.ref, name: c.row.name, state: c.row.state, score: c.score })),
          suggested_next_action: `log_intake with source "food", food "${top.row.ref}", and the amount eaten`,
        },
      );
    }
    if (top !== undefined && (candidates[1] !== undefined || top.score < 80)) {
      throw new Clarify(
        "AMBIGUOUS_FOOD_VARIANT",
        `"${description}" may be one of these catalogue foods. Which one, or is it a manual entry?`,
        candidates.map((c) => `${c.row.name} (${c.row.ref})`),
        path,
        { candidates: candidates.map((c) => ({ ref: c.row.ref, name: c.row.name, state: c.row.state, score: c.score })) },
      );
    }
  }
  return {
    columns: {
      ...common,
      source_kind: "manual",
      manual_kcal: manualItem.kcal,
      manual_protein_g: manualItem.protein_g,
      manual_carbs_g: manualItem.carbs_g,
      manual_fat_g: manualItem.fat_g,
      manual_reason: override === undefined ? manualItem.reason : `${manualItem.reason} [override: ${override}]`,
    },
    nutrients: totalsFrom({ kcal: manualItem.kcal, protein: manualItem.protein_g, carbs: manualItem.carbs_g, fat: manualItem.fat_g }),
    display: { ref: null, name: null },
  };
}

/**
 * Caches recipes and cooks while computing many items. `items` and
 * `prefetchCooks` load what a whole day needs in a fixed number of
 * statements, however many items, recipes or cooks it has (decision 96).
 */
export class NutritionReader {
  private readonly recipes = new Map<number, { recipe: RecipeRow; lines: RecipeLineRow[] }>();
  private readonly cooks = new Map<number, LoadedCook>();
  /** A portion's cook, for portion items. */
  private readonly portionCooks = new Map<number, number | null>();
  /** A leftover serving's cook, for serving items. */
  private readonly servingCooks = new Map<number, number | null>();

  constructor(
    readonly ctx: Ctx,
    readonly cat: Catalogue,
  ) {}

  async cook(cookId: number): Promise<LoadedCook> {
    let c = this.cooks.get(cookId);
    if (!c) {
      c = await loadCook(this.ctx, this.cat, cookId);
      this.cooks.set(cookId, c);
    }
    return c;
  }

  /** Load these cooks together, ahead of `cook` (a missing one is left for `cook` to report). */
  async prefetchCooks(cookIds: readonly number[]): Promise<void> {
    const missing = cookIds.filter((id) => !this.cooks.has(id));
    if (missing.length === 0) return;
    for (const [id, c] of await loadCooks(this.ctx, this.cat, missing)) this.cooks.set(id, c);
  }

  /**
   * Load every recipe, portion's cook and cook these items read, plus any
   * extra cooks the caller will show, in a fixed number of statements
   * (decision 96): the extra cooks share the portions' loadCooks pass.
   */
  async prefetch(rows: readonly IntakeRow[], extraCookIds: readonly number[] = []): Promise<void> {
    const recipeIds = [...new Set(rows.filter((r) => r.source_kind === "recipe").map((r) => r.recipe_id as number))].filter((id) => !this.recipes.has(id));
    if (recipeIds.length > 0) {
      const recipes = await allIn<RecipeRow>(this.ctx.db, (ph) => `SELECT * FROM recipe WHERE id IN (${ph})`, recipeIds);
      const lines = await allIn<RecipeLineRow & { recipe_id: number }>(
        this.ctx.db,
        (ph) => `SELECT * FROM recipe_line WHERE recipe_id IN (${ph}) ORDER BY recipe_id, position`,
        recipeIds,
      );
      for (const recipe of recipes) this.recipes.set(recipe.id, { recipe, lines: lines.filter((l) => l.recipe_id === recipe.id) });
    }
    const portionIds = [...new Set(rows.filter((r) => r.source_kind === "portion").map((r) => r.portion_id as number))].filter((id) => !this.portionCooks.has(id));
    const cookIds = [...extraCookIds];
    if (portionIds.length > 0) {
      const found = await allIn<{ portion_id: number; cook_id: number }>(
        this.ctx.db,
        (ph) => `SELECT p.id AS portion_id, c.cook_id FROM portion p JOIN component c ON c.id = p.component_id WHERE p.id IN (${ph})`,
        portionIds,
      );
      for (const id of portionIds) this.portionCooks.set(id, found.find((f) => f.portion_id === id)?.cook_id ?? null);
      cookIds.push(...found.map((f) => f.cook_id));
    }
    const servingIds = [...new Set(rows.map((r) => r.leftover_serving_id).filter((x): x is number => x !== null && x !== undefined))].filter((id) => !this.servingCooks.has(id));
    if (servingIds.length > 0) {
      const found = await allIn<{ serving_id: number; cook_id: number }>(
        this.ctx.db,
        (ph) => `SELECT s.id AS serving_id, c.cook_id FROM leftover_serving s JOIN component c ON c.id = s.component_id WHERE s.id IN (${ph})`,
        servingIds,
      );
      for (const id of servingIds) this.servingCooks.set(id, found.find((f) => f.serving_id === id)?.cook_id ?? null);
      cookIds.push(...found.map((f) => f.cook_id));
    }
    // One loadCooks pass for the portions' and servings' cooks and the caller's extra cooks.
    await this.prefetchCooks([...new Set(cookIds)]);
  }

  /** A portion row from the cooks loaded so far (no query). */
  portion(id: number): PortionRow | undefined {
    for (const c of this.cooks.values()) {
      const p = c.portions.find((x) => x.id === id);
      if (p) return p;
    }
    return undefined;
  }

  /** A leftover serving row from the cooks loaded so far (no query). */
  serving(id: number): ServingRow | undefined {
    for (const c of this.cooks.values()) {
      const s = c.servings.find((x) => x.id === id);
      if (s) return s;
    }
    return undefined;
  }

  async itemNutrients(row: IntakeRow): Promise<NutrientTotals> {
    switch (row.source_kind) {
      case "manual": {
        const servingId = row.leftover_serving_id ?? null;
        if (servingId !== null) {
          // A leftover serving's item: its share of the cook, never the macros stored with it.
          let cookId = this.servingCooks.get(servingId);
          if (cookId === undefined) {
            cookId = (await first<{ cook_id: number }>(this.ctx.db, "SELECT c.cook_id FROM leftover_serving s JOIN component c ON c.id = s.component_id WHERE s.id = ?", servingId))?.cook_id ?? null;
            this.servingCooks.set(servingId, cookId);
          }
          if (cookId === null) return {};
          const cook = await this.cook(cookId);
          return cook.result.portions.find((x) => x.member === servingKey(servingId))?.nutrients ?? {};
        }
        return totalsFrom({ kcal: row.manual_kcal, protein: row.manual_protein_g, carbs: row.manual_carbs_g, fat: row.manual_fat_g });
      }
      case "food_source":
        return (
          this.cat.storedNutrients({
            food_source_id: row.food_source_id as number,
            amount_value: row.amount_value as number,
            amount_unit: row.amount_unit as string,
            measure_id: row.measure_id,
          }) ?? {}
        );
      case "recipe": {
        const id = row.recipe_id as number;
        let r = this.recipes.get(id);
        if (!r) {
          const recipe = (await first<RecipeRow>(this.ctx.db, "SELECT * FROM recipe WHERE id = ?", id)) as RecipeRow;
          r = { recipe, lines: await loadRecipeLines(this.ctx, id) };
          this.recipes.set(id, r);
        }
        return recipeNutrients(this.cat, r.recipe, r.lines, row.recipe_servings as number);
      }
      case "portion": {
        const portionId = row.portion_id as number;
        let cookId = this.portionCooks.get(portionId);
        if (cookId === undefined) {
          cookId =
            (
              await first<{ cook_id: number }>(
                this.ctx.db,
                "SELECT c.cook_id FROM portion p JOIN component c ON c.id = p.component_id WHERE p.id = ?",
                portionId,
              )
            )?.cook_id ?? null;
          this.portionCooks.set(portionId, cookId);
        }
        if (cookId === null) return {};
        const cook = await this.cook(cookId);
        return cook.result.portions.find((x) => x.member === portionKey(portionId))?.nutrients ?? {};
      }
    }
  }

  /** A member's items on a day, with nutrients; `exclude` drops items a write in progress removes, before anything is loaded for them. */
  async items(memberId: number, date: string, exclude: ReadonlySet<number> = new Set()): Promise<ItemWithNutrients[]> {
    const rows = (await all<IntakeRow>(this.ctx.db, "SELECT * FROM intake_item WHERE member_id = ? AND eaten_on = ? ORDER BY id", memberId, date)).filter(
      (r) => !exclude.has(r.id),
    );
    await this.prefetch(rows);
    const out: ItemWithNutrients[] = [];
    for (const row of rows) out.push({ row, nutrients: await this.itemNutrients(row) });
    return out;
  }
}

export function describeItem(cat: Catalogue, row: Partial<IntakeRow> & Row, nutrients: NutrientTotals, member: string): Record<string, unknown> {
  let ref: string | null = null;
  let name: string | null = null;
  let foodState: string | null = null;
  if (row.food_source_id) {
    const s = cat.row(row.food_source_id as number);
    ref = s.ref;
    name = s.name;
    foodState = s.state;
  }
  return {
    id: row.id,
    member,
    date: row.eaten_on,
    meal_slot: row.meal_slot,
    household_meal_id: row.household_meal_id ?? null,
    state: row.state,
    source_kind: row.source_kind,
    ref: ref ?? (row.recipe_ref as string | undefined) ?? null,
    name: name ?? (row.recipe_name as string | undefined) ?? null,
    food_state: foodState,
    amount_value: row.amount_value ?? null,
    amount_unit: row.amount_unit ?? null,
    measure: row.measure_id ? (cat.measures.find((m) => m.id === row.measure_id)?.name ?? null) : null,
    recipe_servings: row.recipe_servings ?? null,
    portion_id: row.portion_id ?? null,
    manual_reason: row.manual_reason ?? null,
    provenance: row.provenance ?? null,
    confidence: row.confidence,
    dominant_uncertainty: row.dominant_uncertainty ?? null,
    dominant_uncertainty_kcal: row.dominant_uncertainty_kcal ?? null,
    label: row.label ?? null,
    note: row.note ?? null,
    nutrients,
  };
}

// --------------------------------------------------------------------- cooks

export const portionKey = (id: number): string => `portion:${id}`;
export const servingKey = (id: number): string => `serving:${id}`;

/** A later helping of a cook's leftover, dated the day it was eaten (migration 0029). */
export interface ServingRow {
  id: number;
  component_id: number;
  member_id: number;
  kind: "fraction" | "weighed";
  fraction: number | null;
  weighed_g: number | null;
  eaten_on: string;
  provenance: string;
  state: string;
  confirmed_at: string | null;
}

/** A loaded cook's shares for computeCook: its portions and its leftover servings (the remainder is what neither accounts for). */
export function cookShares(loaded: Pick<LoadedCook, "portions" | "servings">) {
  return [
    ...loaded.portions.map((p) => ({ key: portionKey(p.id), component_id: p.component_id, fraction: p.fraction, weighed_g: p.weighed_g })),
    ...loaded.servings.map((s) => ({ key: servingKey(s.id), component_id: s.component_id, fraction: s.fraction, weighed_g: s.weighed_g })),
  ];
}

export interface ComponentRow {
  id: number;
  cook_id: number;
  position: number;
  name: string;
  cooked_weight_g: number | null;
  cooked_weight_provenance: string | null;
}

export interface CookLineRow {
  id: number;
  component_id: number;
  position: number;
  food_source_id: number;
  amount_value: number;
  amount_unit: string;
  measure_id: number | null;
  provenance: string;
}

export interface PortionRow {
  id: number;
  component_id: number;
  member_id: number;
  kind: "fraction" | "weighed";
  fraction: number | null;
  weighed_g: number | null;
  provenance: string;
  /** The share's ± (migration 0026); null when no size was given. */
  dominant_uncertainty?: string | null;
  dominant_uncertainty_kcal?: number | null;
  state: string;
}

export interface LoadedCook {
  cook: Row & { id: number; name: string; cooked_on: string; recipe_id: number | null; state: string };
  components: ComponentRow[];
  lines: CookLineRow[];
  portions: PortionRow[];
  /** Leftover servings of its components (portions and servings together are the eaten shares). */
  servings: ServingRow[];
  marks: { component_id: number; disposition: "leftover" | "discarded" }[];
  result: CookResult;
}

/** The domain's view of a cook from its rows. Portions are keyed by `key`. */
export function computeCook(
  cat: Catalogue,
  components: readonly Pick<ComponentRow, "id" | "name" | "cooked_weight_g">[],
  lines: readonly Pick<CookLineRow, "component_id" | "food_source_id" | "amount_value" | "amount_unit" | "measure_id">[],
  portions: readonly { key: string; component_id: number; fraction: number | null; weighed_g: number | null }[],
  marks: readonly { component_id: number; disposition: "leftover" | "discarded" | "eaten" }[] = [],
): CookResult {
  const nameOf = (id: number) => components.find((c) => c.id === id)?.name ?? `component ${id}`;
  const cook: Cook = {
    lines: lines.map((l) => {
      const multiples = cat.storedMultiples(l);
      const source = cat.source(l.food_source_id);
      return multiples === null
        ? { component: nameOf(l.component_id), source: { ...source, nutrients: {} }, multiples: 0 }
        : { component: nameOf(l.component_id), source, multiples };
    }),
    components: components.map((c) => (c.cooked_weight_g === null ? { name: c.name } : { name: c.name, cookedWeightG: c.cooked_weight_g })),
  };
  const domainPortions: Portion[] = portions.map((p) => ({
    member: p.key,
    component: nameOf(p.component_id),
    share: p.fraction !== null ? { fraction: p.fraction } : { weighedG: p.weighed_g as number },
  }));
  const domainMarks: RemainderMark[] = marks.map((m) => ({ component: nameOf(m.component_id), disposition: m.disposition }));
  return recomputeCook(cook, domainPortions, domainMarks);
}

export async function loadCook(ctx: Ctx, cat: Catalogue, cookId: number): Promise<LoadedCook> {
  const loaded = (await loadCooks(ctx, cat, [cookId])).get(cookId);
  if (!loaded) throw new ToolError("not_found", `no cook ${cookId}`, 404);
  return loaded;
}

/**
 * The household's cooks among these ids, each with its components, lines,
 * portions, leftover servings and remainder marks: five statements (per 100 cooks), however
 * many cooks (decision 96). A cook not in the household is left out.
 */
export async function loadCooks(ctx: Ctx, cat: Catalogue, cookIds: readonly number[]): Promise<Map<number, LoadedCook>> {
  const out = new Map<number, LoadedCook>();
  const cooks = await allIn<LoadedCook["cook"]>(ctx.db, (ph) => `SELECT * FROM cook WHERE household_id = ? AND id IN (${ph})`, cookIds, ctx.householdId);
  if (cooks.length === 0) return out;
  const ids = cooks.map((c) => c.id);
  const components = await allIn<ComponentRow>(ctx.db, (ph) => `SELECT * FROM component WHERE cook_id IN (${ph}) ORDER BY cook_id, position`, ids);
  const lines = await allIn<CookLineRow>(
    ctx.db,
    (ph) => `SELECT l.* FROM cook_line l JOIN component c ON c.id = l.component_id WHERE c.cook_id IN (${ph}) ORDER BY c.cook_id, c.position, l.position`,
    ids,
  );
  // Portions and leftover servings in one statement (per 100 cooks), so the cook stays five statements.
  type ShareRow = PortionRow & { share: "portion" | "leftover_serving"; confirmed_at: string | null; eaten_on: string | null };
  const shares = await allIn<ShareRow>(
    ctx.db,
    (ph) =>
      `SELECT x.* FROM (
         SELECT 'portion' AS share, p.id, p.component_id, p.member_id, p.kind, p.fraction, p.weighed_g, p.provenance, p.state, p.confirmed_at,
                p.dominant_uncertainty, p.dominant_uncertainty_kcal, NULL AS eaten_on FROM portion p
         UNION ALL
         SELECT 'leftover_serving', s.id, s.component_id, s.member_id, s.kind, s.fraction, s.weighed_g, s.provenance, s.state, s.confirmed_at,
                NULL, NULL, s.eaten_on FROM leftover_serving s
       ) x JOIN component c ON c.id = x.component_id WHERE c.cook_id IN (${ph}) ORDER BY x.share, x.id`,
    ids,
  );
  const marks = await allIn<{ component_id: number; disposition: "leftover" | "discarded" }>(
    ctx.db,
    (ph) => `SELECT d.component_id, d.disposition FROM remainder_disposition d JOIN component c ON c.id = d.component_id WHERE c.cook_id IN (${ph}) ORDER BY d.id`,
    ids,
  );
  const cookOf = new Map<number, number>();
  const componentsByCook = new Map<number, ComponentRow[]>();
  const linesByCook = new Map<number, CookLineRow[]>();
  const portionsByCook = new Map<number, PortionRow[]>();
  const servingsByCook = new Map<number, ServingRow[]>();
  const marksByCook = new Map<number, { component_id: number; disposition: "leftover" | "discarded" }[]>();
  const append = <T>(buckets: Map<number, T[]>, cookId: number | undefined, row: T): void => {
    if (cookId === undefined) return;
    const bucket = buckets.get(cookId);
    if (bucket) bucket.push(row);
    else buckets.set(cookId, [row]);
  };
  for (const component of components) {
    cookOf.set(component.id, component.cook_id);
    append(componentsByCook, component.cook_id, component);
  }
  for (const line of lines) append(linesByCook, cookOf.get(line.component_id), line);
  for (const share of shares) {
    const cookId = cookOf.get(share.component_id);
    if (share.share === "portion") {
      const { share: _share, eaten_on: _eatenOn, ...portion } = share;
      append(portionsByCook, cookId, portion as PortionRow);
    } else {
      const { share: _share, dominant_uncertainty: _uncertainty, dominant_uncertainty_kcal: _uncertaintyKcal, ...serving } = share;
      append(servingsByCook, cookId, serving as unknown as ServingRow);
    }
  }
  for (const mark of marks) append(marksByCook, cookOf.get(mark.component_id), mark);
  for (const cook of cooks) {
    const cs = componentsByCook.get(cook.id) ?? [];
    const ls = linesByCook.get(cook.id) ?? [];
    const ps = portionsByCook.get(cook.id) ?? [];
    const ss = servingsByCook.get(cook.id) ?? [];
    const ms = marksByCook.get(cook.id) ?? [];
    const result = computeCook(cat, cs, ls, cookShares({ portions: ps, servings: ss }), ms);
    out.set(cook.id, { cook, components: cs, lines: ls, portions: ps, servings: ss, marks: ms, result });
  }
  return out;
}

/** Hands out ids for the rows a plan creates: the write's WriteTx, or a preview's counter. */
export interface IdSource {
  allocate(table: string): Promise<number>;
}

/** Ids for a preview: negative, never stored, unique within the call. */
export function previewIds(): IdSource {
  let next = 0;
  return { allocate: async () => --next };
}

/**
 * A member's portion of a cook's component, eaten after the meal was
 * logged (mark_remainder's "eaten" on an unaccounted remainder, a routed
 * share of today's pot, and commit_route's), with its intake item. Asks
 * when the member already has a portion of it, when its rest is not
 * unaccounted (a leftover, discarded or eaten), or when the shares (the
 * pot's portions and leftover servings, cookShares) would pass the whole.
 * Takes the portion's id from `ids` (the write's WriteTx, or previewIds()),
 * adds the portion to `loaded.portions` so a second piece sees it, and
 * stages nothing. `where.meal_slot` is null only in a preview.
 */
export async function planEatenPortion(
  ctx: Ctx,
  cat: Catalogue,
  loaded: LoadedCook,
  component: { id: number; name: string },
  member: Member,
  amount: { fraction: number | null; weighed_g: number | null },
  where: { eaten_on: string; meal_slot: string | null; household_meal_id: number | null },
  provenance: string,
  path: (string | number)[],
  ids: IdSource,
): Promise<{
  portion: Row & { id: number; state: string; component_id: number; fraction: number | null; weighed_g: number | null };
  item: Row;
  nutrients: NutrientTotals | null;
  remainder: CookResult["remainder"];
}> {
  if (loaded.portions.some((p) => p.component_id === component.id && p.member_id === member.id)) {
    throw new Clarify("duplicate_portion", `${member.name} already has a portion of ${component.name}; amend it instead.`, [], [...path, "member"]);
  }
  // Only an unaccounted remainder takes a new portion: a leftover is eaten as a leftover serving
  // (mark_remainder), and a discarded or eaten rest is gone.
  const rest = loaded.result.remainder.find((r) => r.component === component.name);
  if (rest && rest.status !== "unaccounted") {
    throw new Clarify("not_unaccounted", `The rest of ${component.name} is marked ${rest.status}, so it can't take a new portion; a helping of a leftover is recorded with mark_remainder.`, [], [...path, "component_id"]);
  }
  // A weighed share of a component with no cooked weight can't be worked out: asked in the member's words.
  if (amount.weighed_g !== null && !loaded.components.find((c) => c.id === component.id)?.cooked_weight_g) {
    noCookedWeight(loaded.cook.name, component.name, loaded.components.length, amount.weighed_g, [...path, "weighed_g"]);
  }
  const stamp = ctx.stamp(ctx.stateFor(member.id));
  const id = await ids.allocate("portion");
  const portion = {
    id, component_id: component.id, member_id: member.id, kind: amount.fraction === null ? ("weighed" as const) : ("fraction" as const),
    fraction: amount.fraction, weighed_g: amount.weighed_g, provenance, ...stamp,
  };
  const shares = [...cookShares(loaded), { key: portionKey(id), component_id: component.id, fraction: amount.fraction, weighed_g: amount.weighed_g }];
  const result = computeCook(cat, loaded.components, loaded.lines, shares, loaded.marks);
  if (result.problems.length > 0) {
    // The domain names shares by key ("portion:3"): the member asked sees whose share it is instead.
    const who = await shareNames(ctx, loaded);
    who.set(portionKey(id), member.name);
    cookProblemsToClarify(result.problems, [...path, "fraction"], who);
  }
  loaded.portions.push(portion);
  const item = {
    member_id: member.id, eaten_on: where.eaten_on, meal_slot: where.meal_slot, household_meal_id: where.household_meal_id,
    source_kind: "portion", portion_id: id, confidence: "medium", ...stamp,
  };
  return { portion, item, nutrients: result.portions.find((p) => p.member === portionKey(id))?.nutrients ?? null, remainder: result.remainder };
}

/**
 * A weighed share of a component with no cooked weight can't be worked out: asked in the member's
 * words (the cook, or the part of a cook with several), at the share's weighed_g.
 */
export function noCookedWeight(cookName: string, componentName: string, componentCount: number, grams: number, path: (string | number)[]): never {
  const what = componentCount > 1 ? `The ${componentName} of ${cookName}` : `The ${cookName}`;
  throw new Clarify(
    "cooked_weight_needed",
    `${what} has no cooked weight yet, so ${grams} g of it can't be worked out. Give the share as a fraction (say, half), or weigh the whole pot first.`,
    [],
    path,
  );
}

/** Whose each of a loaded cook's shares is, by its domain key ("portion:3" → the member's name). One members read (cached). */
export async function shareNames(ctx: Ctx, loaded: Pick<LoadedCook, "portions" | "servings">): Promise<Map<string, string>> {
  const names = new Map((await ctx.members()).map((m) => [m.id, m.name]));
  return new Map<string, string>([
    ...loaded.portions.map((p): [string, string] => [portionKey(p.id), names.get(p.member_id) ?? "someone"]),
    ...loaded.servings.map((v): [string, string] => [servingKey(v.id), names.get(v.member_id) ?? "someone"]),
  ]);
}

/**
 * Turn the domain's cook problems into questions, keyed by what went wrong. The domain names a share
 * by its key ("portion:3", "serving:-1"); `who` maps each key to its member, and a key it doesn't know
 * reads "someone", so no question a member sees carries an internal id.
 */
export function cookProblemsToClarify(problems: readonly string[], path: (string | number)[], who: ReadonlyMap<string, string> = new Map()): void {
  if (problems.length === 0) return;
  // A leftover helping in a list of shares is said as one ("leftover eaten by Hritvik 30%"), so a member sees why the pot is full.
  const worded = problems.map((t) =>
    t
      .replace(/\bserving:-?\d+(?= \d+(?:\.\d+)?%)/g, (k) => `leftover eaten by ${who.get(k) ?? "someone"}`)
      .replace(/\b(?:portion|serving):-?\d+/g, (k) => who.get(k) ?? "someone"),
  );
  const problem = worded[0] as string;
  let reason = "cook_problem";
  if (/more than the whole/.test(problem)) reason = "portions_exceed_whole";
  else if (/cooked weight/.test(problem)) reason = "cooked_weight_needed";
  else if (/does not have/.test(problem)) reason = "unknown_component";
  throw new Clarify(reason, `${problem}. What is right?`, [], path, { problems: worded });
}

// ---------------------------------------------------------------------- days

export interface TargetRow {
  id: number;
  member_id: number;
  effective_from: string;
  provenance: string;
  reasoning: string;
}

export interface TargetValueRow {
  nutrient: string;
  kind: "target" | "floor" | "ceiling" | "remainder" | "reference_intake";
  value: number | null;
}

export async function loadTarget(ctx: Ctx, memberId: number, date: string): Promise<{ row: TargetRow; values: TargetValueRow[] } | null> {
  const row = await first<TargetRow>(
    ctx.db,
    "SELECT * FROM target WHERE member_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1",
    memberId,
    date,
  );
  if (!row) return null;
  const values = await all<TargetValueRow>(ctx.db, "SELECT nutrient, kind, value FROM target_value WHERE target_id = ? ORDER BY nutrient, kind", row.id);
  return { row, values };
}

/** The domain Target from stored values, or null when kcal or a macro has neither a goal nor a remainder. */
export function domainTarget(values: readonly TargetValueRow[]): Target | null {
  const find = (n: string, k: TargetValueRow["kind"]) => values.find((v) => v.nutrient === n && v.kind === k);
  const kcal = find("kcal", "target")?.value;
  if (kcal === undefined || kcal === null) return null;
  const macro = (n: string): MacroTarget | null => {
    const floor = find(n, "floor")?.value ?? undefined;
    const withFloor = floor === undefined ? {} : { floor };
    const goal = find(n, "target")?.value;
    if (goal !== undefined && goal !== null) return { goal, ...withFloor };
    if (find(n, "remainder")) return { remainder: true, ...withFloor };
    return null;
  };
  const protein = macro("protein_g");
  const fat = macro("fat_g");
  const carbs = macro("carbs_g");
  if (!protein || !fat || !carbs) return null;
  return { kcal, protein, fat, carbs };
}

const pick = (totals: NutrientTotals, keys: readonly string[], rename: (k: string) => string = (k) => k) =>
  Object.fromEntries(keys.filter((k) => totals[k] !== undefined).map((k) => [rename(k), totals[k]]));

/** Whether an item's (or a sum's) value for this nutrient is not wholly known: absent, or known for fewer parts than it has. */
const notWhole = (t: NutrientTotals, key: string): boolean => {
  const v = t[key];
  return !v || v.known < v.of;
};

/**
 * How many of these items each nutrient's sum leaves out (ticket 72), and `any`: the items with any of these
 * nutrients not wholly known, each counted once (the app's "N items unknown"). A sum with a count above 0 is
 * partial, and says so; blank is never zero.
 */
export function unknownItems<K extends string>(items: readonly { nutrients: NutrientTotals }[], keys: readonly K[]): Record<K | "any", number> {
  const out = {} as Record<K | "any", number>;
  for (const key of keys) out[key] = items.filter((i) => notWhole(i.nutrients, key)).length;
  out.any = items.filter((i) => keys.some((key) => notWhole(i.nutrients, key))).length;
  return out;
}

/** A sum's value, or null when nobody knows any part of it (absent, or known for none): never a 0 that was never measured. */
export function knownValue(t: NutrientTotals, key: string): number | null {
  const v = t[key];
  return v && v.known > 0 ? v.value : null;
}

/** A value known for some of its parts but not all (a recipe with one unconvertible line): it reads "450+ kcal". */
export function partlyKnown(t: NutrientTotals, key: string): boolean {
  const v = t[key];
  return v !== undefined && v.known > 0 && v.known < v.of;
}

export type TrendMacro = "kcal" | "protein" | "carbs" | "fat";
export const TREND_MACROS: readonly TrendMacro[] = ["kcal", "protein", "carbs", "fat"];

/** The stable day shape shared by direct reads and trend folds. */
export interface DayView extends Record<string, unknown> {
  member: string;
  date: string;
  day_status: string;
  skipped_meals: string[];
  source: DayTotals["source"];
  conflict: boolean;
  item_count: number;
  draft_items: number;
  so_far: Partial<Record<TrendMacro, NutrientTotal>>;
  unknown_items: Record<TrendMacro | "any", number>;
  target: ResolvedTarget | null;
  target_effective_from: string | null;
  target_values: TargetValueRow[];
  left: LeftToday | null;
  micros: Partial<Record<string, NutrientTotal>>;
  protein_bands: Partial<Record<string, NutrientTotal>>;
  cost_inr: { min: NutrientTotal | null; max: NutrientTotal | null } | null;
}

export interface DayInputs {
  items: ItemWithNutrients[];
  status: (Row & { status: string; manual_total_kcal: number | null }) | null;
  skipped: string[];
  target: { row: TargetRow; values: TargetValueRow[] } | null;
}

/** A member's day from loaded inputs: no queries. */
export function dayViewFrom(
  member: Member,
  date: string,
  inputs: DayInputs,
  extra: readonly { nutrients: NutrientTotals; state: string }[] = [],
  exclude: ReadonlySet<number> = new Set(),
): DayView {
  const stored = inputs.items.filter((s) => !exclude.has(s.row.id));
  const status = inputs.status;
  const manual =
    status && status.manual_total_kcal !== null
      ? {
          kcal: status.manual_total_kcal,
          protein: status.manual_total_protein_g as number,
          carbs: status.manual_total_carbs_g as number,
          fat: status.manual_total_fat_g as number,
        }
      : undefined;
  const items = [...stored.map((s) => ({ nutrients: s.nutrients, state: s.row.state })), ...extra];
  const day = dayTotals(items, manual);
  const target = inputs.target;
  const domain = target ? domainTarget(target.values) : null;
  let resolved: ResolvedTarget | null = null;
  let left: LeftToday | null = null;
  if (domain) {
    try {
      resolved = resolveTarget(domain);
      left = leftToday(domain, day.totals);
    } catch (error) {
      throw new ToolError("invalid_target", (error as Error).message, 422);
    }
  }
  const t = day.totals;
  return {
    member: member.name,
    date,
    day_status: status?.status ?? "open",
    skipped_meals: [...inputs.skipped].sort(),
    source: day.source,
    conflict: day.conflict,
    item_count: items.length,
    draft_items: items.filter((i) => i.state === "draft").length,
    so_far: pick(t, TREND_MACROS) as DayView["so_far"],
    unknown_items: unknownItems(items, ["kcal", "protein", "carbs", "fat"]),
    target: resolved,
    target_effective_from: target?.row.effective_from ?? null,
    target_values: target?.values ?? [],
    left,
    micros: pick(t, MICROS),
    protein_bands: pick(t, PROTEIN_BANDS.map((b) => `protein_${b}`), (k) => k.replace("protein_", "")),
    cost_inr: t.cost_min_inr || t.cost_max_inr ? { min: t.cost_min_inr ?? null, max: t.cost_max_inr ?? null } : null,
  };
}

/**
 * A member's day: so far (macros), target, left, micros with coverage,
 * protein bands and cost, all from the domain's dayTotals and leftToday.
 * `extra` adds items not yet stored (a write in progress, or what_if);
 * `exclude` drops stored items a write in progress removes (retract).
 */
export async function dayView(
  ctx: Ctx,
  reader: NutritionReader,
  member: Member,
  date: string,
  extra: readonly { nutrients: NutrientTotals; state: string }[] = [],
  exclude: ReadonlySet<number> = new Set(),
): Promise<DayView> {
  const items = await reader.items(member.id, date, exclude);
  const status = await first<Row & { status: string; manual_total_kcal: number | null }>(ctx.db, "SELECT * FROM day_status WHERE member_id = ? AND day = ?", member.id, date);
  const skipped = (await all<{ meal_slot: string }>(ctx.db, "SELECT meal_slot FROM skipped_meal WHERE member_id = ? AND day = ? ORDER BY meal_slot", member.id, date)).map((s) => s.meal_slot);
  const target = await loadTarget(ctx, member.id, date);
  return dayViewFrom(member, date, { items, status, skipped, target }, extra, exclude);
}

/**
 * Day views for members over a date range, load-once (decision 96): the
 * items, the reader's priming (portions' cooks, recipes, any extra cooks),
 * the statuses, the skipped meals, the targets and their values, each one
 * statement per 100 members through allIn. Keyed `${memberId}|${date}`;
 * `items` are every loaded item with its nutrients.
 */
export async function dayViews(
  ctx: Ctx,
  reader: NutritionReader,
  members: readonly Member[],
  from: string,
  to: string,
  options: { extraCookIds?: readonly number[] } = {},
): Promise<{ views: Map<string, DayView>; items: ItemWithNutrients[] }> {
  const views = new Map<string, DayView>();
  const ids = members.map((m) => m.id);
  const rows = (
    await allIn<IntakeRow>(ctx.db, (ph) => `SELECT * FROM intake_item WHERE eaten_on BETWEEN ? AND ? AND member_id IN (${ph})`, ids, from, to)
  ).sort((a, b) => a.id - b.id);
  await reader.prefetch(rows, options.extraCookIds ?? []);
  const items: ItemWithNutrients[] = [];
  for (const row of rows) items.push({ row, nutrients: await reader.itemNutrients(row) });
  const statuses = await allIn<Row & { member_id: number; day: string; status: string; manual_total_kcal: number | null }>(
    ctx.db, (ph) => `SELECT * FROM day_status WHERE day BETWEEN ? AND ? AND member_id IN (${ph})`, ids, from, to,
  );
  const skipped = await allIn<{ member_id: number; day: string; meal_slot: string }>(
    ctx.db, (ph) => `SELECT member_id, day, meal_slot FROM skipped_meal WHERE day BETWEEN ? AND ? AND member_id IN (${ph})`, ids, from, to,
  );
  const everTarget = (await allIn<TargetRow>(ctx.db, (ph) => `SELECT * FROM target WHERE effective_from <= ? AND member_id IN (${ph})`, ids, to)).sort(
    (a, b) => b.effective_from.localeCompare(a.effective_from),
  );
  // Only the targets the range uses (each member's one in force on `from` and any set inside the range),
  // so the values' statement does not grow with a member's target history.
  const targets = everTarget.filter(
    (t) => t.effective_from > from || t === everTarget.find((x) => x.member_id === t.member_id && x.effective_from <= from),
  );
  const values = await allIn<TargetValueRow & { target_id: number }>(
    ctx.db, (ph) => `SELECT target_id, nutrient, kind, value FROM target_value WHERE target_id IN (${ph}) ORDER BY nutrient, kind`, targets.map((t) => t.id),
  );
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  for (const member of members) {
    for (const date of dates) {
      const t = targets.find((x) => x.member_id === member.id && x.effective_from <= date);
      views.set(
        `${member.id}|${date}`,
        dayViewFrom(member, date, {
          items: items.filter((i) => i.row.member_id === member.id && i.row.eaten_on === date),
          status: statuses.find((x) => x.member_id === member.id && x.day === date) ?? null,
          skipped: skipped.filter((x) => x.member_id === member.id && x.day === date).map((x) => x.meal_slot),
          target: t ? { row: t, values: values.filter((v) => v.target_id === t.id).map(({ target_id: _t, ...v }) => v as TargetValueRow) } : null,
        }),
      );
    }
  }
  return { views, items };
}

/** Retrieve a day that dayViews guarantees it built for every member/date pair. */
export function viewOf(views: ReadonlyMap<string, DayView>, memberId: number, date: string): DayView {
  const view = views.get(`${memberId}|${date}`);
  if (!view) throw new Error(`no day view for member ${memberId} on ${date}`);
  return view;
}

// ------------------------------------------------------- nutrition over time

export type NotCounted = "unlogged" | "partial" | "today_open" | "future";
export interface NutrientDay {
  value: number;
  known: number;
  of: number;
  complete: boolean;
}

export interface NutritionDay {
  date: string;
  status: "complete" | "open" | "partial" | "future";
  logged: boolean;
  source: DayView["source"];
  counted: boolean;
  not_counted: NotCounted | null;
  item_count: number;
  draft_items: number;
  kcal: NutrientDay | null;
  protein: NutrientDay | null;
  carbs: NutrientDay | null;
  fat: NutrientDay | null;
  target: Record<TrendMacro, number> | null;
  macro_kcal: { protein: number; carbs: number; fat: number } | null;
  cost: { min: number; max: number; priced_items: number; items: number; complete: boolean } | null;
  cost_per_25g_protein: { min: number; max: number; priced_protein_g: number } | null;
  cost_missing: "nothing_priced" | "no_protein_in_priced_items" | "manual_day_total" | null;
}

export interface NutritionWeek {
  week_start: string;
  week_end: string;
  days: { in_range: number; counted: number; logged: number; complete: number; partial: number; unlogged: number; today_open: number; open_counted: number };
  average: Record<TrendMacro, { value: number; days: number } | null>;
  target_average: Record<TrendMacro, number | null>;
  macro_split: { protein: number; carbs: number; fat: number } | null;
  cost: { min: number; max: number; days: number } | null;
  cost_per_25g_protein: { min: number; max: number } | null;
  cost_items: { priced: number; of: number } | null;
}

/** Chart averages count logged, non-partial days, excluding an open today and future days. */
export function countedDay(view: Pick<DayView, "date" | "day_status" | "source">, today: string): boolean {
  if (view.date > today || view.source === "empty" || view.day_status === "partial") return false;
  return !(view.date === today && view.day_status === "open");
}

const whole = (total: NutrientTotal | null | undefined): total is NutrientTotal =>
  total !== null && total !== undefined && total.of > 0 && total.known === total.of;

function pricedItems(items: readonly ItemWithNutrients[]): { min: number; max: number; protein: number } {
  return items.reduce(
    (sum, { nutrients }) => {
      const low = nutrients.cost_min_inr;
      const high = nutrients.cost_max_inr;
      const protein = nutrients.protein;
      return whole(low) && whole(high) && whole(protein)
        ? { min: sum.min + low.value, max: sum.max + high.value, protein: sum.protein + protein.value }
        : sum;
    },
    { min: 0, max: 0, protein: 0 },
  );
}

const FUTURE_DAY = {
  status: "future", logged: false, source: "empty", counted: false, not_counted: "future", item_count: 0, draft_items: 0,
  kcal: null, protein: null, carbs: null, fat: null, target: null, macro_kcal: null, cost: null, cost_per_25g_protein: null, cost_missing: null,
} as const;

/** Convert one loaded day into the chart contract without querying. */
export function nutritionDay(view: DayView, items: readonly ItemWithNutrients[], today: string): NutritionDay {
  if (view.date > today) return { date: view.date, ...FUTURE_DAY };
  const logged = view.source !== "empty";
  const counted = countedDay(view, today);
  const status = view.day_status === "complete" || view.day_status === "partial" ? view.day_status : "open";
  const not_counted: NotCounted | null = counted ? null : !logged ? "unlogged" : status === "partial" ? "partial" : "today_open";
  const nutrient = (key: TrendMacro): NutrientDay | null => {
    const total = view.so_far[key];
    return total ? { ...total, complete: total.known === total.of } : null;
  };
  const [kcal, protein, carbs, fat] = TREND_MACROS.map(nutrient) as [NutrientDay | null, NutrientDay | null, NutrientDay | null, NutrientDay | null];
  const target = view.target
    ? { kcal: view.target.kcal, protein: view.target.protein.goal, carbs: view.target.carbs.goal, fat: view.target.fat.goal }
    : null;
  const macro_kcal = protein?.complete && carbs?.complete && fat?.complete
    ? { protein: protein.value * KCAL_PER_G.protein, carbs: carbs.value * KCAL_PER_G.carbs, fat: fat.value * KCAL_PER_G.fat }
    : null;
  const price = view.cost_inr;
  const cost = price?.min && price.max
    ? { min: price.min.value, max: price.max.value, priced_items: price.min.known, items: price.min.of, complete: whole(price.min) && whole(price.max) }
    : null;
  const priced = pricedItems(items);
  const cost_per_25g_protein = priced.protein > 0
    ? { min: (priced.min / priced.protein) * 25, max: (priced.max / priced.protein) * 25, priced_protein_g: priced.protein }
    : null;
  const cost_missing = !logged
    ? null
    : view.source === "manual_day_total"
      ? "manual_day_total"
      : cost === null || cost.priced_items === 0
        ? "nothing_priced"
        : cost_per_25g_protein === null
          ? "no_protein_in_priced_items"
          : null;
  return { date: view.date, status, logged, source: view.source, counted, not_counted, item_count: view.item_count, draft_items: view.draft_items, kcal, protein, carbs, fat, target, macro_kcal, cost, cost_per_25g_protein, cost_missing };
}

const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Fold chart days into one Sunday week without querying. */
export function nutritionWeek(weekStart: string, days: readonly NutritionDay[]): NutritionWeek {
  const counted = days.filter((day) => day.counted);
  const average = {} as NutritionWeek["average"];
  const target_average = {} as NutritionWeek["target_average"];
  for (const key of TREND_MACROS) {
    const used = counted.filter((day) => day[key]?.complete);
    average[key] = used.length === 0 ? null : { value: mean(used.map((day) => (day[key] as NutrientDay).value)), days: used.length };
    const goals = used.flatMap((day) => (day.target ? [day.target[key]] : []));
    target_average[key] = goals.length === 0 ? null : mean(goals);
  }
  const protein = average.protein;
  const carbs = average.carbs;
  const fat = average.fat;
  const macroTotal = protein && carbs && fat
    ? protein.value * KCAL_PER_G.protein + carbs.value * KCAL_PER_G.carbs + fat.value * KCAL_PER_G.fat
    : 0;
  const macro_split = protein && carbs && fat && macroTotal > 0
    ? { protein: protein.value * KCAL_PER_G.protein / macroTotal, carbs: carbs.value * KCAL_PER_G.carbs / macroTotal, fat: fat.value * KCAL_PER_G.fat / macroTotal }
    : null;
  const costed = counted.filter((day) => day.cost?.complete);
  const cost = costed.length === 0 ? null : { min: mean(costed.map((day) => day.cost!.min)), max: mean(costed.map((day) => day.cost!.max)), days: costed.length };
  const perProtein = counted.flatMap((day) => (day.cost_per_25g_protein ? [day.cost_per_25g_protein] : []));
  const pricedProtein = perProtein.reduce((sum, value) => sum + value.priced_protein_g, 0);
  const cost_per_25g_protein = pricedProtein > 0
    ? { min: perProtein.reduce((sum, value) => sum + value.min * value.priced_protein_g, 0) / pricedProtein, max: perProtein.reduce((sum, value) => sum + value.max * value.priced_protein_g, 0) / pricedProtein }
    : null;
  const withCost = days.flatMap((day) => (day.cost ? [day.cost] : []));
  const cost_items = withCost.length === 0 ? null : { priced: withCost.reduce((sum, value) => sum + value.priced_items, 0), of: withCost.reduce((sum, value) => sum + value.items, 0) };
  const count = (predicate: (day: NutritionDay) => boolean) => days.filter(predicate).length;
  return {
    week_start: weekStart,
    week_end: addDays(weekStart, 6),
    days: { in_range: count((day) => day.status !== "future"), counted: counted.length, logged: count((day) => day.logged), complete: count((day) => day.status === "complete"), partial: count((day) => day.status === "partial"), unlogged: count((day) => day.not_counted === "unlogged"), today_open: count((day) => day.not_counted === "today_open"), open_counted: counted.filter((day) => day.status === "open").length },
    average,
    target_average,
    macro_split,
    cost,
    cost_per_25g_protein,
    cost_items,
  };
}

export function sumMemberNutrients(parts: readonly NutrientTotals[]): NutrientTotals {
  return sumNutrients(parts);
}
