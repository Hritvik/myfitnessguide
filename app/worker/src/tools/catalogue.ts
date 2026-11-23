import { z } from "zod";
import { assertNotAnAlias } from "../aliases";
import { AMOUNT, Catalogue, checkLabelEnergy, MICROS, PROTEIN_BANDS, STATES, type SourceRow } from "../catalogue";
import type { Ctx } from "../context";
import { all, first, type Row } from "../db";
import { Clarify, ToolError } from "../errors";
import { bestScore, EVERY_WORD, nameDistance, NEAR_SPELLING, prepareQuery } from "../fuzzy";
import { describeRecipe, findRecipe, loadRecipeLines, loadRecipeSteps, RecipeBook, type RecipeLineRow, type RecipePrepStepRow, type RecipeRow } from "../recipes";
import { readTool, writeTool, type Tool } from "../tool";
import { ExerciseIndex } from "../training";
import { loadWorkouts } from "../workouts";
import { RECIPE_LIFECYCLE_TOOLS } from "./template-lifecycle";

const GROUP = "catalogue";
const MAX_RECIPE_LINES = 100;
const nullableNumber = z.number().min(0).nullable().optional();

const microFields = Object.fromEntries(MICROS.map((m) => [m, nullableNumber])) as Record<(typeof MICROS)[number], typeof nullableNumber>;

const FOOD_SOURCE_FIELDS = [
  "ref", "name", "state", "reference_amount", "reference_unit", "kcal", "protein_g", "carbs_g", "fat_g", ...MICROS,
  "protein_band", "protein_quality", "price_min_inr", "price_max_inr", "primary_category", "tags", "last_checked_on",
  "assumptions", "energy_override_reason",
] as const;

function costPer25gProtein(row: { protein_g: number; price_min_inr: number | null; price_max_inr: number | null }) {
  if (row.price_min_inr === null || row.price_max_inr === null || !(row.protein_g > 0)) return null;
  return { min: (row.price_min_inr / row.protein_g) * 25, max: (row.price_max_inr / row.protein_g) * 25 };
}

async function sourceByRef(ctx: Ctx, ref: string): Promise<SourceRow | null> {
  return first<SourceRow>(ctx.db, "SELECT * FROM food_source WHERE household_id = ? AND ref = ? COLLATE NOCASE", ctx.householdId, ref.trim());
}

/** A food source as catalogue_lookup shows it: its row, measures, the yields into it and cost per 25 g protein. */
function describeSource(cat: Catalogue, row: SourceRow, yields: readonly (Row & { to_id: number })[]): Record<string, unknown> {
  const measures = cat.measures.filter((m) => m.food_source_id === row.id).sort((a, b) => a.id - b.id).map((m) => ({ name: m.name, amount: m.amount }));
  const yieldsFrom = yields.filter((y) => y.to_id === row.id).map(({ to_id: _t, ...y }) => y);
  return { ...row, measures, yields_from: yieldsFrom, cost_per_25g_protein_inr: costPer25gProtein(row) };
}

const REF_FIELD = z
  .string()
  .min(1)
  .optional()
  .describe("Leave out: the API allocates the next free ref. An existing ref is refused (change it with amend).");

const REF_PREFIX = { food_source: "FS", recipe: "R" } as const;

/** The next free ref: the prefix and one more than the highest number in use, at least 3 digits. */
async function nextRef(ctx: Ctx, table: "food_source" | "recipe"): Promise<string> {
  const prefix = REF_PREFIX[table];
  const refs = await all<{ ref: string }>(ctx.db, `SELECT ref FROM ${table} WHERE ref GLOB ?`, `${prefix}[0-9]*`);
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  const highest = refs.reduce((max, r) => Math.max(max, Number(pattern.exec(r.ref)?.[1] ?? 0)), 0);
  return `${prefix}${String(highest + 1).padStart(3, "0")}`;
}

/**
 * The ref a new record gets. Left out, the API allocates it. An existing
 * ref is refused (an edit is an amend, never a whole replacement). A new
 * ref chosen by the caller is accepted only from the importer, which
 * carries the Sheets refs over.
 */
async function refFor(ctx: Ctx, table: "food_source" | "recipe", ref: string | undefined): Promise<string> {
  if (ref === undefined) return nextRef(ctx, table);
  const existing = await first<{ id: number; ref: string }>(ctx.db, `SELECT id, ref FROM ${table} WHERE ref = ? COLLATE NOCASE`, ref.trim());
  if (existing) {
    throw new ToolError("ref_exists", `${existing.ref} already exists; change it with amend (a ${table === "food_source" ? "food source" : "recipe"} is never replaced whole)`, 409, {
      record: { table, id: existing.id },
      use: "amend",
    });
  }
  if (ctx.writeInfo.origin !== "import") {
    throw new ToolError("ref_not_allocated", `refs are allocated by the API; leave ref out to create a new ${table === "food_source" ? "food source" : "recipe"}`, 400);
  }
  return ref.trim();
}

const upsertFoodSource = writeTool({
  name: "upsert_food_source",
  group: GROUP,
  description:
    "Create a food source; the API allocates its ref (FS + the next free number). Nutrients per reference amount (micros null = unknown, 0 = measured zero), measures, price and yields from another state of the same food. An existing ref is refused, so a source is never replaced whole: change it with amend, add a measure with add_measure. Macros that don't reconcile with kcal (4/4/9, within max(10%, 15 kcal)) ask (energy_mismatch) unless energy_override_reason is given. Confirmed on write.",
  input: {
    ref: REF_FIELD,
    name: z.string().min(1),
    state: z.enum(STATES),
    reference_amount: z.number().positive(),
    reference_unit: z.enum(["g", "ml", "piece"]),
    kcal: z.number().min(0),
    protein_g: z.number().min(0),
    carbs_g: z.number().min(0),
    fat_g: z.number().min(0),
    ...microFields,
    protein_band: z.enum(PROTEIN_BANDS).nullable().optional(),
    protein_quality: z.string().nullable().optional(),
    price_min_inr: nullableNumber,
    price_max_inr: nullableNumber,
    primary_category: z.string().nullable().optional(),
    tags: z.string().nullable().optional(),
    last_checked_on: z.iso.date().nullable().optional(),
    assumptions: z.string().nullable().optional(),
    energy_override_reason: z
      .string()
      .min(1)
      .optional()
      .describe("Why to keep macros that don't reconcile with kcal by 4/4/9 (beyond max(10%, 15 kcal)), e.g. the label really says so. Without it, a mismatch asks."),
    measures: z.array(z.object({ name: z.string().min(1), amount: z.number().positive() }).strict()).optional(),
    yields_from: z
      .array(
        z.object({
          from: z.string().min(1).describe("Ref of the source in the other state."),
          factor: z.number().positive(),
          discarded_fraction: z.number().min(0).lt(1).optional(),
          note: z.string().optional(),
        }).strict(),
      )
      .optional(),
  },
  async run(ctx, input) {
    await assertNotAnAlias(ctx, input.name, ["name"]);
    const tx = ctx.txOrThrow;
    const ref = await refFor(ctx, "food_source", input.ref);
    const clash = await first<{ ref: string }>(
      ctx.db,
      "SELECT ref FROM food_source WHERE household_id = ? AND name = ? COLLATE NOCASE AND state = ?",
      ctx.householdId,
      input.name,
      input.state,
    );
    if (clash) {
      throw new Clarify("duplicate_food_source", `${input.name} (${input.state}) already exists as ${clash.ref}. Use that one, or amend it?`, [clash.ref], ["name"]);
    }
    const energyCheck = checkLabelEnergy(input, ["kcal"]);

    const row: Row = { household_id: ctx.householdId };
    for (const f of FOOD_SOURCE_FIELDS) row[f] = (input as Record<string, unknown>)[f] ?? null;
    row.ref = ref;
    await tx.reserve(["food_source", "measure"]);
    const id = await tx.create("food_source", row);

    const measureList: { name: string; amount: number }[] = [];
    for (const [i, m] of (input.measures ?? []).entries()) {
      if (measureList.some((x) => x.name.toLowerCase() === m.name.toLowerCase())) {
        throw new Clarify("duplicate_measure", `Two measures are called ${m.name}; which amount is it?`, [], ["measures", i, "name"]);
      }
      measureList.push({ name: m.name, amount: m.amount });
    }
    // Every measure in one insert (decision 103), so a label with many measures stays a constant cost.
    await tx.createMany("measure", measureList.map((m) => ({ food_source_id: id, name: m.name, amount: m.amount })));

    const yieldsFrom: Record<string, unknown>[] = [];
    for (const [i, y] of (input.yields_from ?? []).entries()) {
      const from = await sourceByRef(ctx, y.from);
      if (!from) throw new Clarify("unknown_food", `There is no food source ${y.from}.`, [], ["yields_from", i, "from"]);
      if (from.name.toLowerCase() !== input.name.toLowerCase()) {
        throw new ToolError("yield_across_foods", `a yield links two states of one food; ${from.name} is not ${input.name}`);
      }
      await tx.create("yield", { from_food_source_id: from.id, to_food_source_id: id, factor: y.factor, discarded_fraction: y.discarded_fraction ?? 0, note: y.note ?? null });
      yieldsFrom.push({ from_ref: from.ref, from_state: from.state, factor: y.factor, discarded_fraction: y.discarded_fraction ?? 0 });
    }

    const saved = { id, ...row } as unknown as SourceRow;
    return {
      action: "created",
      state: "confirmed",
      food_source: { ...saved, measures: measureList, yields_from: yieldsFrom },
      energy_check: energyCheck,
      computed: { cost_per_25g_protein_inr: costPer25gProtein(saved) },
    };
  },
});

const addMeasure = writeTool({
  name: "add_measure",
  group: GROUP,
  description:
    "Add a named measure (1 scoop, 1 tsp, 1 egg) to an existing food source, as an amount of its reference unit. An existing measure's amount changes with amend. Confirmed on write.",
  input: {
    food: z.string().min(1).describe("The food source's ref."),
    name: z.string().min(1),
    amount: z.number().positive().describe("In the source's reference unit (g, ml or piece)."),
  },
  async run(ctx, input) {
    const source = await sourceByRef(ctx, input.food);
    if (!source) throw new Clarify("unknown_food", `There is no food source ${input.food}.`, [], ["food"]);
    const prior = await first<{ id: number; amount: number }>(ctx.db, "SELECT id, amount FROM measure WHERE food_source_id = ? AND name = ? COLLATE NOCASE", source.id, input.name.trim());
    if (prior) {
      throw new ToolError("measure_exists", `${source.ref} already has a ${input.name} of ${prior.amount} ${source.reference_unit}; change it with amend`, 409, {
        record: { table: "measure", id: prior.id },
        use: "amend",
      });
    }
    const id = await ctx.txOrThrow.create("measure", { food_source_id: source.id, name: input.name.trim(), amount: input.amount });
    const measures = await all<{ name: string; amount: number }>(ctx.db, "SELECT name, amount FROM measure WHERE food_source_id = ? ORDER BY id", source.id);
    return { state: "confirmed", measure: { id, food: source.ref, name: input.name.trim(), amount: input.amount, unit: source.reference_unit }, measures: [...measures, { name: input.name.trim(), amount: input.amount }] };
  },
});

const recipeLine = z.object({
  ...AMOUNT,
  link_status: z.enum(["confirmed", "assumed"]).optional(),
  note: z.string().optional(),
}).strict();

/** One ordered prep operation on a recipe: the soak, the batch, the evening assembly. */
const prepStep = z.object({
  action: z.string().min(1).max(200).describe("The operation, as an imperative: \"Soak\", \"Pressure-cook\", \"Assemble overnight oats\"."),
  lead: z.enum(["same_meal", "minutes_before", "hours_before", "evening_before", "day_before"]),
  lead_min_h: z.number().min(0).optional().describe("The nearest the step may be done before the meal, in hours."),
  lead_max_h: z.number().min(0).optional().describe("The furthest ahead the step may start, in hours (12 for an 8-12 hour soak)."),
  duration_min: z.number().int().positive().optional(),
  who: z.enum(["eater", "cook", "anyone"]).optional().describe("Who does it; defaults to anyone."),
  batchable: z.boolean().optional().describe("Whether several meals can share one batch."),
  keeps_days: z.number().min(0).optional().describe("Fridge life of the prepared thing, in days."),
  batch_group: z.string().min(1).max(100).optional().describe("Steps prepared together share a group, so two separate nights' soaks do not merge."),
  batch_days: z.number().min(0).optional().describe("How many days of consumers one batch may cover; defaults to keeps_days."),
  storage: z.enum(["fridge", "freezer", "counter"]).optional(),
  freezer_ok: z.boolean().optional().describe("A batch beyond its fridge life can be frozen and thawed instead of split."),
  food: z.string().min(1).optional().describe("The food the operation acts on, as a ref, name or alias."),
  amount_value: z.number().positive().optional(),
  amount_unit: z.enum(["g", "ml", "piece"]).optional(),
  note: z.string().max(1000).optional(),
}).strict().superRefine((step, issue) => {
  if ((step.amount_value === undefined) !== (step.amount_unit === undefined)) {
    issue.addIssue({ code: "custom", message: "amount_value and amount_unit go together", path: ["amount_value"] });
  }
  if (step.amount_value !== undefined && step.food === undefined) {
    issue.addIssue({ code: "custom", message: "an amount needs the food it measures", path: ["food"] });
  }
  if (step.lead_min_h !== undefined && step.lead_max_h !== undefined && step.lead_max_h < step.lead_min_h) {
    issue.addIssue({ code: "custom", message: "lead_max_h must be at least lead_min_h", path: ["lead_max_h"] });
  }
});

/** The food source a prep step acts on: resolved like an amount when it has one, else by ref, name or alias. */
function prepFood(cat: Catalogue, step: PrepStepIn, path: (string | number)[]): number {
  if (step.food === undefined) throw new Error("prepFood needs a food");
  if (step.amount_value !== undefined && step.amount_unit !== undefined) {
    return cat.resolve({ food: step.food, value: step.amount_value, unit: step.amount_unit }, [...path, "food"]).row.id;
  }
  const k = step.food.trim().toLowerCase();
  const row = cat.rows.find((r) => r.ref.toLowerCase() === k || r.name.toLowerCase() === k || cat.aliasesOf(r.id).some((a) => a.toLowerCase() === k));
  if (!row) throw new Clarify("unknown_food", `There is no food called ${step.food}.`, [], [...path, "food"]);
  return row.id;
}

type PrepStepIn = z.infer<typeof prepStep>;

function prepStepRow(recipeId: number, position: number, step: PrepStepIn, cat: Catalogue, path: (string | number)[]): Row {
  return {
    recipe_id: recipeId,
    position,
    action: step.action.trim(),
    lead: step.lead,
    lead_min_h: step.lead_min_h ?? null,
    lead_max_h: step.lead_max_h ?? null,
    duration_min: step.duration_min ?? null,
    who: step.who ?? "anyone",
    batchable: step.batchable === true ? 1 : 0,
    keeps_days: step.keeps_days ?? null,
    batch_group: step.batch_group?.trim() ?? null,
    batch_days: step.batch_days ?? null,
    storage: step.storage ?? null,
    freezer_ok: step.freezer_ok === true ? 1 : 0,
    food_source_id: step.food === undefined ? null : prepFood(cat, step, path),
    amount_value: step.amount_value ?? null,
    amount_unit: step.amount_unit ?? null,
    note: step.note ?? null,
  };
}

const upsertRecipe = writeTool({
  name: "upsert_recipe",
  group: GROUP,
  description:
    "Create a reusable recipe template when the dish is likely to recur or the member asks to save it; log a one-off composed dish as a named cook with household_meal instead. The API allocates its ref (R + the next free number). Supply ingredient lines (resolved like any amount; ambiguity asks), or manual per-serving macros with a reason, and optional prep_steps: the ordered soak, batch, cook and assembly operations a meal plan schedules. Names are unique per household. An existing ref is refused, so a recipe is never replaced whole: change its fields or a line's amount with amend. Returns per-serving nutrients. Confirmed on write.",
  input: {
    ref: REF_FIELD,
    name: z.string().min(1),
    kind: z.enum(["dish", "idea"]),
    servings: z.number().positive(),
    meal_type: z.string().optional(),
    prep_type: z.string().optional(),
    method: z.string().optional(),
    source_assumptions: z.string().optional(),
    lines: z.array(recipeLine).max(MAX_RECIPE_LINES).optional(),
    prep_steps: z.array(prepStep).max(20).optional().describe("Ordered prep operations the plan can schedule (soak, batch, assemble the night before)."),
    manual_macros: z
      .object({ kcal: z.number().min(0), protein_g: z.number().min(0), carbs_g: z.number().min(0), fat_g: z.number().min(0), reason: z.string().min(1) })
      .strict()
      .optional(),
  },
  async run(ctx, input) {
    await assertNotAnAlias(ctx, input.name, ["name"]);
    const tx = ctx.txOrThrow;
    const ref = await refFor(ctx, "recipe", input.ref);
    const twin = await first<{ ref: string }>(
      ctx.db,
      "SELECT ref FROM recipe WHERE household_id = ? AND name = ? COLLATE NOCASE",
      ctx.householdId,
      input.name,
    );
    if (twin) {
      throw new Clarify("duplicate_recipe", `A recipe called ${input.name} already exists as ${twin.ref}. Use it, or amend it?`, [twin.ref], ["name"]);
    }
    const lines = input.lines ?? [];
    if (input.kind === "dish" && !input.manual_macros && lines.length === 0) {
      throw new Clarify("no_lines", `What goes into ${input.name}? Give its ingredient lines, or manual macros per serving with a reason.`, [], ["lines"]);
    }
    const cat = await Catalogue.load(ctx);
    const resolved = lines.map((l, i) => ({ line: l, r: cat.resolve(l, ["lines", i]) }));
    const prepRows = (input.prep_steps ?? []).map((s, i) => prepStepRow(0, i + 1, s, cat, ["prep_steps", i]));

    const m = input.manual_macros;
    const row: Row = {
      household_id: ctx.householdId,
      ref,
      name: input.name,
      kind: input.kind,
      servings: input.servings,
      meal_type: input.meal_type ?? null,
      prep_type: input.prep_type ?? null,
      method: input.method ?? null,
      source_assumptions: input.source_assumptions ?? null,
      manual_macros: m ? 1 : 0,
      manual_kcal: m?.kcal ?? null,
      manual_protein_g: m?.protein_g ?? null,
      manual_carbs_g: m?.carbs_g ?? null,
      manual_fat_g: m?.fat_g ?? null,
      manual_macros_reason: m?.reason ?? null,
    };
    // The recipe's and its lines' next ids in one statement, and the lines in one insert (decision 97, 103):
    // a constant number of statements however many lines; their first versions go in finish()'s one statement.
    await tx.reserve(["recipe", "recipe_line", "recipe_prep_step"]);
    const id = await tx.create("recipe", row);
    const lineData = resolved.map(({ line, r }, i) => ({
      recipe_id: id,
      position: i + 1,
      food_source_id: r.row.id,
      ...r.stored,
      link_status: line.link_status ?? null,
      note: line.note ?? null,
    }));
    const lineIds = await tx.createMany("recipe_line", lineData);
    const lineRows: RecipeLineRow[] = lineData.map((data, i) => ({ id: lineIds[i] as number, ...data }));
    const stepRows: RecipePrepStepRow[] = prepRows.map((data, i) => ({ ...(data as unknown as RecipePrepStepRow), recipe_id: id, id: 0 }));
    const stepIds = prepRows.length === 0 ? [] : await tx.createMany("recipe_prep_step", prepRows.map((r) => ({ ...r, recipe_id: id })));
    stepRows.forEach((s, i) => { s.id = stepIds[i]; });
    return {
      action: "created",
      state: "confirmed",
      recipe: describeRecipe(cat, { id, ...row } as unknown as RecipeRow, lineRows, stepRows),
    };
  },
});

function reasonNeeded(reason: string | undefined, question: string): void {
  if (!reason) throw new Clarify("reason_needed", question, [], ["reason"]);
}

async function recipeByRef(ctx: Ctx, ref: string): Promise<RecipeRow> {
  const recipe = await first<RecipeRow>(ctx.db, "SELECT * FROM recipe WHERE household_id = ? AND ref = ? COLLATE NOCASE", ctx.householdId, ref.trim());
  if (!recipe) throw new Clarify("unknown_recipe", `There is no recipe ${ref}.`, [], ["recipe"]);
  return recipe;
}

const addRecipeLine = writeTool({
  name: "add_recipe_line",
  group: GROUP,
  description:
    "Add one ingredient line to an existing recipe (resolved like any amount; ambiguity asks), at the end or at a position (later lines move down), with the reason (required; it goes to the write log). Returns the recipe with per-serving nutrients recomputed. Confirmed on write.",
  input: {
    recipe: z.string().min(1).describe("The recipe's ref."),
    line: recipeLine,
    position: z.number().int().min(1).optional().describe("Default: after the last line."),
  },
  async run(ctx, input) {
    reasonNeeded(input.reason, "Why does the recipe gain this line (for example, the dish always has it)?");
    const tx = ctx.txOrThrow;
    const recipe = await recipeByRef(ctx, input.recipe);
    const cat = await Catalogue.load(ctx);
    const r = cat.resolve(input.line, ["line"]);
    const lines = await loadRecipeLines(ctx, recipe.id);
    const end = Math.max(0, ...lines.map((l) => l.position));
    const position = Math.min(input.position ?? end + 1, end + 1);
    // Highest first, so positions stay unique while they move.
    for (const l of [...lines].filter((x) => x.position >= position).sort((a, b) => b.position - a.position)) {
      tx.update("recipe_line", l.id as number, { position: l.position + 1 }, { ...l, position: l.position + 1 });
      l.position += 1;
    }
    const data = { recipe_id: recipe.id, position, food_source_id: r.row.id, ...r.stored, link_status: input.line.link_status ?? null, note: input.line.note ?? null };
    const id = await tx.create("recipe_line", data);
    const after = [...lines, { id, ...data } as RecipeLineRow].sort((a, b) => a.position - b.position);
    return { state: "confirmed", line: { id, position, food: r.row.ref }, recipe: describeRecipe(cat, recipe, after, await loadRecipeSteps(ctx, recipe.id)) };
  },
});

const removeRecipeLine = writeTool({
  name: "remove_recipe_line",
  group: GROUP,
  description:
    "Remove one ingredient line from a recipe, with the reason (required; it goes to the write log and the line's history). A dish keeps at least one line unless it has manual macros. Returns the recipe recomputed. Confirmed on write.",
  input: { recipe: z.string().min(1).describe("The recipe's ref."), line_id: z.number().int().positive() },
  async run(ctx, input) {
    reasonNeeded(input.reason, "Why is the line coming out of the recipe?");
    const recipe = await recipeByRef(ctx, input.recipe);
    const lines = await loadRecipeLines(ctx, recipe.id);
    const line = lines.find((l) => l.id === input.line_id);
    if (!line) throw new ToolError("not_found", `${recipe.ref} has no line ${input.line_id}`, 404);
    const left = lines.filter((l) => l.id !== line.id);
    if (left.length === 0 && recipe.kind === "dish" && recipe.manual_macros !== 1) {
      throw new Clarify("no_lines", `That is ${recipe.name}'s only line. What goes into it instead, or what are its manual macros?`, [], ["line_id"]);
    }
    ctx.txOrThrow.remove("recipe_line", line.id as number, line as unknown as Row, "delete");
    const cat = await Catalogue.load(ctx);
    return { state: "confirmed", removed: { id: line.id, position: line.position }, recipe: describeRecipe(cat, recipe, left, await loadRecipeSteps(ctx, recipe.id)) };
  },
});

const recipePatch = z.object({
  name: z.string().min(1).optional(),
  kind: z.enum(["dish", "idea"]).optional(),
  servings: z.number().positive().optional(),
  meal_type: z.string().nullable().optional(),
  prep_type: z.string().nullable().optional(),
  method: z.string().nullable().optional(),
  source_assumptions: z.string().nullable().optional(),
  manual_macros: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("derived") }).strict(),
    z.object({
      mode: z.literal("manual"),
      kcal: z.number().min(0),
      protein_g: z.number().min(0),
      carbs_g: z.number().min(0),
      fat_g: z.number().min(0),
      reason: z.string().min(1),
    }).strict(),
  ]).optional(),
  prep_steps: z.array(prepStep).max(20).nullable().optional().describe("Replace the recipe's ordered prep steps; null clears them."),
}).strict();

const recipeOperation = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), line: recipeLine, position: z.number().int().min(1).optional() }).strict(),
  z.object({ action: z.literal("replace"), line_id: z.number().int().positive(), line: recipeLine }).strict(),
  z.object({ action: z.literal("move"), line_id: z.number().int().positive(), position: z.number().int().min(1) }).strict(),
  z.object({ action: z.literal("remove"), line_id: z.number().int().positive() }).strict(),
]);

type PlannedRecipeLine = Omit<RecipeLineRow, "id"> & {
  id: number | null;
  recipe_id: number;
  link_status: "confirmed" | "assumed" | null;
  note: string | null;
};

function positioned(lines: readonly PlannedRecipeLine[]): PlannedRecipeLine[] {
  return lines.map((line, index) => ({ ...line, position: index + 1 }));
}

const updateRecipe = writeTool({
  name: "update_recipe",
  group: GROUP,
  description:
    "Update one reusable recipe from a discussion in one atomic call, selected by ref, exact name or alias. Patch its name, kind, servings, preparation metadata, explicit derived/manual macro mode or prep_steps (a replace-all list; null clears), and add, replace, move or remove ingredient lines using the same public amount shapes as recipe creation. Operations run in order; the final recipe is validated before it is saved. Needs a reason and returns the complete recipe with per-serving nutrients recomputed. Under mutable history, corrected recipe nutrition becomes the current best understanding of prior recipe servings; record versions preserve the previous belief. Confirmed on write.",
  input: {
    recipe: z.string().min(1).describe("The recipe's ref."),
    change_reason: z.string().min(1).optional().describe("Why the member wants this recipe changed; public MCP clients should provide it so the audit history keeps their rationale."),
    patch: recipePatch.optional(),
    operations: z.array(recipeOperation).max(MAX_RECIPE_LINES).optional(),
  },
  async run(ctx, input) {
    reasonNeeded(input.change_reason ?? input.reason, "Why is this saved recipe changing?");
    if (!input.patch && (input.operations?.length ?? 0) === 0) {
      throw new Clarify("no_changes", "What should change in the recipe?", [], ["patch", "operations"]);
    }

    const recipe = await findRecipe(ctx, input.recipe);
    if (!recipe) throw new Clarify("unknown_recipe", `There is no recipe ${input.recipe}.`, [], ["recipe"]);
    if (input.patch?.name !== undefined) {
      await assertNotAnAlias(ctx, input.patch.name, ["patch", "name"]);
      const twin = await first<{ ref: string }>(
        ctx.db,
        "SELECT ref FROM recipe WHERE household_id = ? AND name = ? COLLATE NOCASE AND id <> ?",
        ctx.householdId,
        input.patch.name,
        recipe.id,
      );
      if (twin) throw new Clarify("duplicate_recipe", `${input.patch.name} already exists as ${twin.ref}.`, [twin.ref], ["patch", "name"]);
    }

    const cat = await Catalogue.load(ctx);
    const original = await loadRecipeLines(ctx, recipe.id);
    const plannedSteps = input.patch?.prep_steps === undefined
      ? null
      : (input.patch.prep_steps ?? []).map((s, i) => prepStepRow(recipe.id, i + 1, s, cat, ["patch", "prep_steps", i]));
    let planned: PlannedRecipeLine[] = original.map((line) => ({
      ...line,
      id: line.id as number,
      recipe_id: recipe.id,
      link_status: ((line as unknown as Row).link_status as "confirmed" | "assumed" | null | undefined) ?? null,
      note: ((line as unknown as Row).note as string | null | undefined) ?? null,
    }));

    const findLine = (lineId: number, operationIndex: number): number => {
      const index = planned.findIndex((line) => line.id === lineId);
      if (index < 0) throw new ToolError("not_found", `${recipe.ref} has no current line ${lineId}`, 404, { path: ["operations", operationIndex, "line_id"] });
      return index;
    };

    for (const [operationIndex, operation] of (input.operations ?? []).entries()) {
      if (operation.action === "add") {
        const resolved = cat.resolve(operation.line, ["operations", operationIndex, "line"]);
        const at = Math.min(operation.position ?? planned.length + 1, planned.length + 1) - 1;
        const added: PlannedRecipeLine = {
          id: null,
          recipe_id: recipe.id,
          position: at + 1,
          food_source_id: resolved.row.id,
          ...resolved.stored,
          link_status: operation.line.link_status ?? null,
          note: operation.line.note ?? null,
        };
        planned = positioned([...planned.slice(0, at), added, ...planned.slice(at)]);
        continue;
      }

      const index = findLine(operation.line_id, operationIndex);
      if (operation.action === "remove") {
        planned = positioned(planned.filter((_, lineIndex) => lineIndex !== index));
      } else if (operation.action === "move") {
        const line = planned[index] as PlannedRecipeLine;
        const without = planned.filter((_, lineIndex) => lineIndex !== index);
        const at = Math.min(operation.position, without.length + 1) - 1;
        planned = positioned([...without.slice(0, at), line, ...without.slice(at)]);
      } else {
        const resolved = cat.resolve(operation.line, ["operations", operationIndex, "line"]);
        const prior = planned[index] as PlannedRecipeLine;
        const replacement: PlannedRecipeLine = {
          ...prior,
          food_source_id: resolved.row.id,
          ...resolved.stored,
          link_status: operation.line.link_status ?? null,
          note: operation.line.note ?? null,
        };
        planned = planned.map((line, lineIndex) => (lineIndex === index ? replacement : line));
      }
    }

    const { manual_macros: macroPatch, prep_steps: _stepsPatch, ...metadataPatch } = input.patch ?? {};
    const macroChanges: Row = macroPatch?.mode === "manual"
      ? {
          manual_macros: 1,
          manual_kcal: macroPatch.kcal,
          manual_protein_g: macroPatch.protein_g,
          manual_carbs_g: macroPatch.carbs_g,
          manual_fat_g: macroPatch.fat_g,
          manual_macros_reason: macroPatch.reason,
        }
      : macroPatch?.mode === "derived"
        ? {
            manual_macros: 0,
            manual_kcal: null,
            manual_protein_g: null,
            manual_carbs_g: null,
            manual_fat_g: null,
            manual_macros_reason: null,
          }
        : {};
    const parentChanges: Row = { ...metadataPatch, ...macroChanges };
    // RecipeBook decorates rows with aliases for lookup. They are not recipe
    // columns and must never leak into a version snapshot.
    const { aliases: _aliases, ...storedRecipe } = recipe as RecipeRow & { aliases?: string[] };
    const afterRecipe = { ...storedRecipe, ...parentChanges } as RecipeRow;
    if (planned.length > MAX_RECIPE_LINES) {
      throw new Clarify("too_many_lines", `A recipe can have at most ${MAX_RECIPE_LINES} ingredient lines.`, [], ["operations"]);
    }
    if (afterRecipe.kind === "dish" && afterRecipe.manual_macros !== 1 && planned.length === 0) {
      throw new Clarify("no_lines", `What goes into ${afterRecipe.name}? A dish without manual macros needs at least one ingredient line.`, [], ["operations"]);
    }

    const tx = ctx.txOrThrow;
    await tx.reserve(["recipe_prep_step"]);
    if (Object.keys(parentChanges).length > 0) tx.update("recipe", recipe.id, parentChanges, afterRecipe as unknown as Row);

    let finalLines = planned;
    if ((input.operations?.length ?? 0) > 0) {
      // Move existing positions out of the unique-key range first. Each retained
      // line then gets exactly one amend version containing its final content.
      tx.exec("UPDATE recipe_line SET position = position + 1000000 WHERE recipe_id = ?", recipe.id);
      const retained = planned.filter((line): line is PlannedRecipeLine & { id: number } => line.id !== null);
      const retainedIds = new Set(retained.map((line) => line.id));
      const removed = original.filter((line) => !retainedIds.has(line.id as number));
      if (removed.length > 0) {
        tx.versions("recipe_line", "delete", removed.map((line) => ({ id: line.id as number, data: line as unknown as Row })));
        tx.exec("DELETE FROM recipe_line WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(removed.map((line) => line.id)));
      }
      if (retained.length > 0) {
        const json = JSON.stringify(retained);
        const columns = ["recipe_id", "position", "food_source_id", "amount_value", "amount_unit", "measure_id", "link_status", "note"];
        const set = columns.map((column) => `${column} = (SELECT json_extract(j.value, '$.${column}') FROM json_each(?1) j WHERE json_extract(j.value, '$.id') = recipe_line.id)`).join(", ");
        tx.exec(`UPDATE recipe_line SET ${set} WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))`, json);
        tx.versions("recipe_line", "amend", retained.map((line) => ({ id: line.id, data: line as unknown as Row })));
      }
      const added = planned.filter((line) => line.id === null);
      const addedIds = await tx.createMany("recipe_line", added.map(({ id: _id, ...data }) => data as unknown as Row));
      let addedIndex = 0;
      finalLines = planned.map((line) => line.id === null ? { ...line, id: addedIds[addedIndex++] as number } : line);
    }

    const originalIds = new Set(original.map((line) => line.id as number));
    const finalIds = new Set(finalLines.flatMap((line) => (line.id === null ? [] : [line.id])));
    let finalSteps = await loadRecipeSteps(ctx, recipe.id);
    if (plannedSteps !== null) {
      // Retain each position's row and amend it, so a change is a version of
      // the same step (stable id) rather than a delete and a new row.
      const before = finalSteps;
      const retained = Math.min(before.length, plannedSteps.length);
      const after: RecipePrepStepRow[] = [];
      for (let i = 0; i < retained; i++) {
        const prior = before[i]!;
        const row = { ...prior, ...plannedSteps[i], id: prior.id, recipe_id: recipe.id, position: i + 1 } as RecipePrepStepRow;
        const { id: _id, ...changes } = row;
        tx.update("recipe_prep_step", prior.id as number, changes as unknown as Row, row as unknown as Row);
        after.push(row);
      }
      const added = plannedSteps.slice(retained);
      const addedIds = added.length === 0 ? [] : await tx.createMany("recipe_prep_step", added);
      added.forEach((row, i) => after.push({ ...(row as unknown as RecipePrepStepRow), id: addedIds[i] as number }));
      const removed = before.slice(retained);
      if (removed.length > 0) {
        tx.versions("recipe_prep_step", "delete", removed.map((step) => ({ id: step.id as number, data: step as unknown as Row })));
        tx.exec("DELETE FROM recipe_prep_step WHERE recipe_id = ? AND position > ?", recipe.id, retained);
      }
      finalSteps = after;
    }
    return {
      action: "updated",
      state: "confirmed",
      affected: {
        recipe_id: recipe.id,
        created_line_ids: [...finalIds].filter((id) => !originalIds.has(id)),
        updated_line_ids: [...finalIds].filter((id) => originalIds.has(id) && (input.operations?.length ?? 0) > 0),
        removed_line_ids: [...originalIds].filter((id) => !finalIds.has(id)),
      },
      recipe: { ...describeRecipe(cat, afterRecipe, finalLines as RecipeLineRow[], finalSteps), source_assumptions: afterRecipe.source_assumptions ?? null },
    };
  },
});

const addYield = writeTool({
  name: "add_yield",
  group: GROUP,
  description:
    "Add a yield to an existing food source: how much of it one unit of another state of the same food becomes (dry rice to cooked x3), with a discarded fraction for what is thrown away (yolks). Needs the reason (it goes to the write log). A yield between the same two sources is changed with amend. Confirmed on write.",
  input: {
    food: z.string().min(1).describe("Ref of the source the yield leads to (cooked rice)."),
    from: z.string().min(1).describe("Ref of the source in the other state (dry rice)."),
    factor: z.number().positive(),
    discarded_fraction: z.number().min(0).lt(1).optional(),
    note: z.string().optional(),
  },
  async run(ctx, input) {
    reasonNeeded(input.reason, "How is the yield known (weighed, label, a standard ratio)?");
    const to = await sourceByRef(ctx, input.food);
    if (!to) throw new Clarify("unknown_food", `There is no food source ${input.food}.`, [], ["food"]);
    const from = await sourceByRef(ctx, input.from);
    if (!from) throw new Clarify("unknown_food", `There is no food source ${input.from}.`, [], ["from"]);
    if (from.id === to.id) throw new ToolError("yield_to_itself", "a yield links two different states");
    if (from.name.toLowerCase() !== to.name.toLowerCase()) throw new ToolError("yield_across_foods", `a yield links two states of one food; ${from.name} is not ${to.name}`);
    const prior = await first<{ id: number }>(ctx.db, "SELECT id FROM yield WHERE from_food_source_id = ? AND to_food_source_id = ?", from.id, to.id);
    if (prior) throw new ToolError("yield_exists", `${to.ref} already has a yield from ${from.ref}; change it with amend`, 409, { record: { table: "yield", id: prior.id }, use: "amend" });
    const row = { from_food_source_id: from.id, to_food_source_id: to.id, factor: input.factor, discarded_fraction: input.discarded_fraction ?? 0, note: input.note ?? null };
    const id = await ctx.txOrThrow.create("yield", row);
    return { state: "confirmed", yield: { id, from: from.ref, from_state: from.state, to: to.ref, to_state: to.state, factor: row.factor, discarded_fraction: row.discarded_fraction, note: row.note } };
  },
});

const KINDS = ["food_source", "recipe", "exercise", "workout"] as const;

/** Near-spelling hits kept below better ones when another kind matched better: enough to show a typo's food, never a list of them. */
const NEAR_BELOW_OTHERS = 2;

/**
 * A near-spelling is a fallback for a typo, judged per kind (decision 143),
 * and ranked by closeness (decision 150): hits come sorted best first, near-
 * spellings closest first. A kind with only near-spellings keeps them all
 * when nothing of any kind matched better, else its first two at the bottom,
 * so a recipe matching "peer" never hides the pear a typo meant. A kind with
 * a better hit (name, prefix, substring, word) keeps only its closest near-
 * spelling, so "beat" still finds Beet beside Beaten egg; and none when the
 * query is spelled out, every word whole, in a better hit's name, so "rice"
 * (Rice is a food) doesn't offer a whey's "Rich".
 */
function nearSpellingsKept<H extends { score: number; item: Record<string, unknown> }>(query: string, hits: H[]): H[] {
  const better = (h: H) => h.score > NEAR_SPELLING;
  const anyBetter = hits.some(better);
  const kindOf = (h: H) => String(h.item.kind);
  const kindsWithBetter = new Set(hits.filter(better).map(kindOf));
  const queryWords = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const wordsOf = (h: H) => [h.item.name, ...((h.item.aliases as string[] | undefined) ?? [])].flatMap((n) => String(n).toLowerCase().split(/[^a-z0-9]+/));
  const spelledOut = queryWords.length > 0 && hits.filter(better).some((h) => queryWords.every((w) => wordsOf(h).includes(w)));
  const nearKept = new Map<string, number>();
  return hits.filter((h) => {
    if (better(h)) return true;
    const kind = kindOf(h);
    const n = nearKept.get(kind) ?? 0;
    nearKept.set(kind, n + 1);
    if (kindsWithBetter.has(kind)) return !spelledOut && n === 0;
    if (!anyBetter) return true;
    return n < NEAR_BELOW_OTHERS;
  });
}

const catalogueSearch = readTool({
  name: "catalogue_search",
  group: GROUP,
  description:
    "Fuzzy search over food sources, recipes, exercises and workouts, by name, ref and every learned alias. Best match first. Each result's score says how it matched: 100 the name, 80 its start, 60 the query at a word start, 50 with spacing ignored, 40 every query word in the name in any order; 22-39 a partial hit (some query words found, at most one missing, others near-spelt); 21 the query only inside a word; 1-20 a near-spelling (typo). A partial hit is never the thing asked for: read it as \"not in the catalogue, closest names shown\" and never log against it; ask, or create the food.",
  input: {
    query: z.string().min(1),
    kinds: z.array(z.enum(KINDS)).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  },
  async run(ctx, input) {
    const kinds = new Set(input.kinds ?? KINDS);
    const hits: { score: number; order: number; item: Record<string, unknown> }[] = [];
    let order = 0;
    if (kinds.has("food_source")) {
      const cat = await Catalogue.load(ctx);
      for (const r of cat.rows) {
        const aliases = cat.aliasesOf(r.id);
        const score = bestScore(input.query, [r.name, r.ref, `${r.name} ${r.state}`, ...aliases]);
        if (score > 0) hits.push({ score, order: order++, item: { kind: "food_source", id: r.id, ref: r.ref, name: r.name, state: r.state, aliases } });
      }
    }
    if (kinds.has("recipe")) {
      for (const r of (await RecipeBook.load(ctx)).recipes) {
        const score = bestScore(input.query, [r.name, r.ref, ...r.aliases]);
        if (score > 0) hits.push({ score, order: order++, item: { kind: "recipe", id: r.id, ref: r.ref, name: r.name, recipe_kind: r.kind, aliases: r.aliases } });
      }
    }
    if (kinds.has("exercise")) {
      for (const e of (await ExerciseIndex.load(ctx)).entries) {
        const score = bestScore(input.query, [e.name, ...e.aliases]);
        if (score > 0) hits.push({ score, order: order++, item: { kind: "exercise", id: e.id, name: e.name, implement_kind: e.implement_kind, aliases: e.aliases } });
      }
    }
    if (kinds.has("workout")) {
      for (const w of await loadWorkouts(ctx, null)) {
        const score = bestScore(input.query, [w.name, ...w.aliases]);
        if (score > 0) hits.push({ score, order: order++, item: { kind: "workout", id: w.id, name: w.name, aliases: w.aliases } });
      }
    }
    // Near-spellings, partial word matches and matches inside a word, equally scored: the name closer to the whole query first.
    const pq = prepareQuery(input.query);
    const away = new Map(hits.filter((h) => h.score < EVERY_WORD).map((h) => [h, nameDistance(pq, [String(h.item.name), ...((h.item.aliases as string[]) ?? [])])]));
    hits.sort((a, b) => b.score - a.score || (away.get(a) ?? 0) - (away.get(b) ?? 0) || a.order - b.order);
    const kept = nearSpellingsKept(input.query, hits);
    return { results: kept.slice(0, input.limit ?? 10).map((h) => ({ ...h.item, score: h.score })) };
  },
});

const LIST_KINDS = ["food_source", "recipe", "exercise", "gym"] as const;
/** catalogue_list's page: 200 rows, and one more read to say whether there are more. */
const LIST_PAGE = 200;

/**
 * Each kind's list in one statement, its hint computed in the same
 * statement through an indexed correlated subquery (measured at 500
 * foods, 200 recipes, 150 exercises over 10,000 sets: at most 2 ms).
 * Each binds the household, the limit and the offset; the exercise list
 * also the caller member (null for the agent), after the household, and
 * today last (a confirmed set in a confirmed session, on or before today).
 */
const LIST_SQL: Record<(typeof LIST_KINDS)[number], { sql: string; byMember: boolean }> = {
  food_source: {
    sql: `SELECT f.id, f.ref, f.name, f.state, f.reference_amount, f.reference_unit FROM food_source f
      WHERE f.household_id = ? ORDER BY f.name COLLATE NOCASE, f.state, f.id LIMIT ? OFFSET ?`,
    byMember: false,
  },
  recipe: {
    sql: `SELECT r.id, r.ref, r.name, r.kind, r.servings, (SELECT count(*) FROM recipe_line l WHERE l.recipe_id = r.id) AS lines FROM recipe r
      WHERE r.household_id = ? AND r.archived_at IS NULL ORDER BY r.name COLLATE NOCASE, r.id LIMIT ? OFFSET ?`,
    byMember: false,
  },
  exercise: {
    sql: `SELECT e.id, e.name, e.implement_kind,
        (SELECT max(se.performed_on) FROM session_set s JOIN session se ON se.id = s.session_id WHERE s.exercise_id = e.id AND s.state = 'confirmed' AND se.state = 'confirmed' AND se.performed_on <= ?5 AND (?2 IS NULL OR se.member_id = ?2)) AS last_done
      FROM exercise e WHERE e.household_id = ?1 ORDER BY e.name COLLATE NOCASE, e.id LIMIT ?3 OFFSET ?4`,
    byMember: true,
  },
  gym: {
    sql: `SELECT g.id, g.name, (SELECT count(*) FROM implement i WHERE i.gym_id = g.id) AS equipment FROM gym g
      WHERE g.household_id = ? ORDER BY g.name COLLATE NOCASE, g.id LIMIT ? OFFSET ?`,
    byMember: false,
  },
};

const catalogueList = readTool({
  name: "catalogue_list",
  group: GROUP,
  description:
    "Every food source, recipe, exercise or gym of the household, by name, 200 a page (offset for the next; truncated says there are more, next_offset where they start). Each row has one hint: a food's state and reference amount, a recipe's line count, an exercise's implement kind and the day the signed-in member last did it, confirmed sets only and not after today (the household's last, for the agent), a gym's equipment count. Workouts: use workouts.",
  input: { kind: z.enum(LIST_KINDS), offset: z.number().int().min(0).optional() },
  async run(ctx, input) {
    const offset = input.offset ?? 0;
    const me = ctx.caller.kind === "member" ? ctx.caller.memberId : null;
    const { sql, byMember } = LIST_SQL[input.kind];
    const rows = byMember
      ? await all<Row>(ctx.db, sql, ctx.householdId, me, LIST_PAGE + 1, offset, ctx.today())
      : await all<Row>(ctx.db, sql, ctx.householdId, LIST_PAGE + 1, offset);
    const truncated = rows.length > LIST_PAGE;
    return { kind: input.kind, offset, items: rows.slice(0, LIST_PAGE), truncated, next_offset: truncated ? offset + LIST_PAGE : null };
  },
});

const catalogueLookup = readTool({
  name: "catalogue_lookup",
  group: GROUP,
  description: "Look up many food sources and recipes by ref, learned word (or a recipe's exact name) in one call. Unknown refs come back in `missing`.",
  input: { refs: z.array(z.string().min(1)).min(1).max(100) },
  async run(ctx, input) {
    // A constant number of statements however many refs (decision 96): the
    // catalogue, then, only when needed, every yield and every recipe.
    const cat = await Catalogue.load(ctx);
    const foodSources: unknown[] = [];
    const recipes: unknown[] = [];
    const missing: string[] = [];
    let yields: (Row & { to_id: number })[] | null = null;
    let book: RecipeBook | null = null;
    for (const ref of input.refs) {
      const source = cat.pinned(ref);
      if (source) {
        yields ??= await all<Row & { to_id: number }>(
          ctx.db,
          `SELECT y.to_food_source_id AS to_id, f.ref AS from_ref, f.state AS from_state, y.factor, y.discarded_fraction
           FROM yield y JOIN food_source f ON f.id = y.from_food_source_id WHERE f.household_id = ? ORDER BY y.id`,
          ctx.householdId,
        );
        foodSources.push(describeSource(cat, source, yields));
        continue;
      }
      book ??= await RecipeBook.load(ctx, true);
      const recipe = book.find(ref);
      if (recipe) {
        recipes.push(describeRecipe(cat, recipe, book.lines(recipe.id), book.steps(recipe.id)));
        continue;
      }
      missing.push(ref);
    }
    return { food_sources: foodSources, recipes, missing };
  },
});

/** The first and last day of the logged items counted, or null when none: from the counting statement itself. */
const datesOf = (r: { n: number; first_on: string | null; last_on: string | null } | null) =>
  r && r.n > 0 && r.first_on !== null && r.last_on !== null ? { first: r.first_on, last: r.last_on } : null;

const catalogueDependents = readTool({
  name: "catalogue_dependents",
  group: GROUP,
  description: "What depends on a food source or recipe: recipes, cooks (with their dates), intake items (how many, and the first and last day they were eaten) and yields, so an edit's reach is known first.",
  input: { ref: z.string().min(1) },
  async run(ctx, input) {
    const source = await sourceByRef(ctx, input.ref);
    if (source) {
      const recipes = await all(
        ctx.db,
        "SELECT DISTINCT r.ref, r.name FROM recipe_line l JOIN recipe r ON r.id = l.recipe_id WHERE l.food_source_id = ? ORDER BY r.ref",
        source.id,
      );
      const cooks = await all(
        ctx.db,
        `SELECT DISTINCT k.id, k.name, k.cooked_on FROM cook_line l JOIN component c ON c.id = l.component_id
         JOIN cook k ON k.id = c.cook_id WHERE l.food_source_id = ? ORDER BY k.cooked_on, k.id`,
        source.id,
      );
      const intake = await first<{ n: number; first_on: string | null; last_on: string | null }>(
        ctx.db,
        "SELECT count(*) AS n, min(eaten_on) AS first_on, max(eaten_on) AS last_on FROM intake_item WHERE food_source_id = ?",
        source.id,
      );
      const yields = await all(
        ctx.db,
        `SELECT f.ref AS to_ref, f.state AS to_state, y.factor FROM yield y JOIN food_source f ON f.id = y.to_food_source_id
         WHERE y.from_food_source_id = ? ORDER BY f.ref`,
        source.id,
      );
      return { kind: "food_source", ref: source.ref, recipes, cooks, intake_items: intake?.n ?? 0, intake_dates: datesOf(intake), yields };
    }
    const recipe = await findRecipe(ctx, input.ref, true);
    if (recipe) {
      const cooks = await all(ctx.db, "SELECT id, name, cooked_on FROM cook WHERE recipe_id = ? ORDER BY cooked_on, id", recipe.id);
      const intake = await first<{ n: number; first_on: string | null; last_on: string | null }>(
        ctx.db,
        "SELECT count(*) AS n, min(eaten_on) AS first_on, max(eaten_on) AS last_on FROM intake_item WHERE recipe_id = ?",
        recipe.id,
      );
      return { kind: "recipe", ref: recipe.ref, recipes: [], cooks, intake_items: intake?.n ?? 0, intake_dates: datesOf(intake), yields: [] };
    }
    throw new ToolError("not_found", `no food source or recipe ${input.ref}`, 404);
  },
});

export const CATALOGUE_TOOLS: Tool[] = [catalogueSearch, catalogueList, catalogueLookup, upsertFoodSource, addMeasure, addYield, upsertRecipe, updateRecipe, ...RECIPE_LIFECYCLE_TOOLS, addRecipeLine, removeRecipeLine, catalogueDependents];
