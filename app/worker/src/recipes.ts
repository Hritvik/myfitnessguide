import { recipeIntake, type CookLine, type NutrientTotals, type RecipeSource } from "@myfitnessguide/domain";
import type { Catalogue } from "./catalogue";
import type { Ctx } from "./context";
import { all } from "./db";

export interface RecipeRow {
  id: number;
  ref: string;
  name: string;
  kind: "dish" | "idea";
  servings: number;
  manual_macros: number;
  manual_kcal: number | null;
  manual_protein_g: number | null;
  manual_carbs_g: number | null;
  manual_fat_g: number | null;
  manual_macros_reason: string | null;
  [key: string]: unknown;
}

export interface RecipeLineRow {
  id?: number;
  position: number;
  food_source_id: number;
  amount_value: number;
  amount_unit: string;
  measure_id: number | null;
  link_status: "confirmed" | "assumed" | null;
  note: string | null;
}

export interface RecipePrepStepRow {
  id?: number;
  position: number;
  action: string;
  lead: "same_meal" | "minutes_before" | "hours_before" | "evening_before" | "day_before";
  lead_min_h: number | null;
  lead_max_h: number | null;
  duration_min: number | null;
  who: "eater" | "cook" | "anyone";
  batchable: number;
  keeps_days: number | null;
  batch_group: string | null;
  batch_days: number | null;
  storage: "fridge" | "freezer" | "counter" | null;
  freezer_ok: number;
  food_source_id: number | null;
  amount_value: number | null;
  amount_unit: string | null;
  note: string | null;
}

/** A recipe by ref, name or alias, ignoring case: one statement, through the book. */
export async function findRecipe(ctx: Ctx, key: string, includeArchived = false): Promise<RecipeRow | null> {
  return (await RecipeBook.load(ctx, includeArchived)).find(key);
}

/** Every recipe of the household with its lines and aliases, in one statement (decision 96). */
export class RecipeBook {
  private constructor(
    readonly recipes: (RecipeRow & { aliases: string[] })[],
    private readonly byRecipe: Map<number, RecipeLineRow[]>,
    private readonly stepsByRecipe: Map<number, RecipePrepStepRow[]>,
  ) {}

  static async load(ctx: Ctx, includeArchived = false): Promise<RecipeBook> {
    const rows = await all<RecipeRow & { _lines: string; _steps: string; _aliases: string }>(
      ctx.db,
      `SELECT r.*,
         (SELECT json_group_array(json_object('id', l.id, 'position', l.position, 'food_source_id', l.food_source_id, 'amount_value', l.amount_value,
            'amount_unit', l.amount_unit, 'measure_id', l.measure_id, 'link_status', l.link_status, 'note', l.note)) FROM recipe_line l WHERE l.recipe_id = r.id) AS _lines,
         (SELECT json_group_array(json_object('id', s.id, 'position', s.position, 'action', s.action, 'lead', s.lead, 'lead_min_h', s.lead_min_h,
            'lead_max_h', s.lead_max_h, 'duration_min', s.duration_min, 'who', s.who, 'batchable', s.batchable, 'keeps_days', s.keeps_days,
            'batch_group', s.batch_group, 'batch_days', s.batch_days, 'storage', s.storage, 'freezer_ok', s.freezer_ok,
            'food_source_id', s.food_source_id, 'amount_value', s.amount_value, 'amount_unit', s.amount_unit, 'note', s.note))
          FROM recipe_prep_step s WHERE s.recipe_id = r.id) AS _steps,
         (SELECT json_group_array(a.alias) FROM alias a WHERE a.household_id = r.household_id AND a.kind = 'recipe' AND a.target_id = r.id) AS _aliases
       FROM recipe r WHERE r.household_id = ? AND (? OR r.archived_at IS NULL) ORDER BY r.id`,
      ctx.householdId,
      includeArchived ? 1 : 0,
    );
    const byRecipe = new Map<number, RecipeLineRow[]>();
    const stepsByRecipe = new Map<number, RecipePrepStepRow[]>();
    const recipes = rows.map(({ _lines, _steps, _aliases, ...r }) => {
      byRecipe.set(r.id, (JSON.parse(_lines) as RecipeLineRow[]).sort((a, b) => a.position - b.position));
      stepsByRecipe.set(r.id, (JSON.parse(_steps) as RecipePrepStepRow[]).sort((a, b) => a.position - b.position));
      return { ...(r as RecipeRow), aliases: JSON.parse(_aliases) as string[] };
    });
    return new RecipeBook(recipes, byRecipe, stepsByRecipe);
  }

  /** A book with no recipes, for a call that names none: no statement. */
  static empty(): RecipeBook {
    return new RecipeBook([], new Map(), new Map());
  }

  /** The book when any of the items is a recipe; otherwise the empty one, so a call naming no recipe costs nothing more. */
  static async forItems(ctx: Ctx, items: readonly { source: string }[]): Promise<RecipeBook> {
    return items.some((i) => i.source === "recipe") ? RecipeBook.load(ctx) : RecipeBook.empty();
  }

  /** A recipe by ref, name or alias, ignoring case. */
  find(key: string): RecipeRow | null {
    const k = key.trim().toLowerCase();
    return this.recipes.find((r) => r.ref.toLowerCase() === k || r.name.toLowerCase() === k || r.aliases.some((a) => a.toLowerCase() === k)) ?? null;
  }

  lines(id: number): RecipeLineRow[] {
    return this.byRecipe.get(id) ?? [];
  }

  steps(id: number): RecipePrepStepRow[] {
    return this.stepsByRecipe.get(id) ?? [];
  }
}

export async function loadRecipeLines(ctx: Ctx, recipeId: number): Promise<RecipeLineRow[]> {
  return all<RecipeLineRow>(ctx.db, "SELECT * FROM recipe_line WHERE recipe_id = ? ORDER BY position", recipeId);
}

export async function loadRecipeSteps(ctx: Ctx, recipeId: number): Promise<RecipePrepStepRow[]> {
  return all<RecipePrepStepRow>(ctx.db, "SELECT * FROM recipe_prep_step WHERE recipe_id = ? ORDER BY position", recipeId);
}

/** The recipe as the domain's intake source: its resolved lines, or manual per-serving macros. */
export function recipeSource(cat: Catalogue, recipe: RecipeRow, lines: readonly RecipeLineRow[]): RecipeSource {
  const source: RecipeSource = { servings: recipe.servings };
  if (recipe.manual_macros === 1) {
    source.manualPerServing = {
      kcal: recipe.manual_kcal,
      protein: recipe.manual_protein_g,
      carbs: recipe.manual_carbs_g,
      fat: recipe.manual_fat_g,
    };
  } else {
    source.lines = lines.map((l): CookLine => {
      const multiples = cat.storedMultiples(l);
      const s = cat.source(l.food_source_id);
      // A line whose amount cannot be converted counts as unknown, never as 0.
      return multiples === null ? { source: { ...s, nutrients: {} }, multiples: 0 } : { source: s, multiples };
    });
  }
  return source;
}

/** Nutrients for `servings` of a recipe, or null for a recipe with nothing to count. */
export function recipeNutrients(cat: Catalogue, recipe: RecipeRow, lines: readonly RecipeLineRow[], servings: number): NutrientTotals {
  return recipeIntake(recipeSource(cat, recipe, lines), servings);
}

export function describeRecipe(cat: Catalogue, recipe: RecipeRow, lines: readonly RecipeLineRow[], steps: readonly RecipePrepStepRow[] = []): Record<string, unknown> {
  const perServing = recipeNutrients(cat, recipe, lines, 1);
  return {
    id: recipe.id,
    ref: recipe.ref,
    name: recipe.name,
    kind: recipe.kind,
    servings: recipe.servings,
    meal_type: (recipe.meal_type as string | null | undefined) ?? null,
    prep_type: (recipe.prep_type as string | null | undefined) ?? null,
    method: (recipe.method as string | null | undefined) ?? null,
    derived: recipe.manual_macros !== 1,
    manual_macros_reason: recipe.manual_macros_reason,
    archived: recipe.archived_at !== null && recipe.archived_at !== undefined,
    archived_at: (recipe.archived_at as string | null | undefined) ?? null,
    archived_reason: (recipe.archived_reason as string | null | undefined) ?? null,
    per_serving: Object.keys(perServing).length > 0 ? perServing : null,
    lines: lines.map((l) => {
      const row = cat.row(l.food_source_id);
      return {
        id: l.id,
        position: l.position,
        ref: row.ref,
        name: row.name,
        state: row.state,
        amount_value: l.amount_value,
        amount_unit: l.amount_unit,
        measure: l.measure_id === null ? null : (cat.measures.find((m) => m.id === l.measure_id)?.name ?? null),
        link_status: l.link_status,
        note: l.note,
        nutrients: cat.storedNutrients(l),
      };
    }),
    prep_steps: steps.map((s) => {
      const food = s.food_source_id === null ? null : cat.row(s.food_source_id);
      return {
        id: s.id,
        position: s.position,
        action: s.action,
        lead: s.lead,
        lead_min_h: s.lead_min_h,
        lead_max_h: s.lead_max_h,
        duration_min: s.duration_min,
        who: s.who,
        batchable: s.batchable === 1,
        keeps_days: s.keeps_days,
        batch_group: s.batch_group,
        batch_days: s.batch_days,
        storage: s.storage,
        freezer_ok: s.freezer_ok === 1,
        food: food === null ? null : { ref: food.ref, name: food.name },
        amount_value: s.amount_value,
        amount_unit: s.amount_unit,
        note: s.note,
      };
    }),
  };
}
