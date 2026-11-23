import { addDays, buildPrepSchedule, sumNutrients, type NutrientTotals, type PrepOccurrence, type PrepStep, type ResolvedTarget } from "@myfitnessguide/domain";
import { z } from "zod";
import { Catalogue } from "../catalogue";
import type { Ctx, Member } from "../context";
import { all, first, type Row } from "../db";
import { ToolError } from "../errors";
import { dayViews, NutritionReader, viewOf } from "../nutrition";
import { loadPlanPrepTasks, preparedBatches, taskOf, type PrepTaskRow } from "../prep";
import { RecipeBook } from "../recipes";
import { readTool, writeTool, type Tool } from "../tool";
import { MEAL_FIELDS, previewMealInput, type MealInput } from "./nutrition";

const GROUP = "nutrition";
const date = z.iso.date();
const MAX_DAYS = 14;
const MAX_ENTRIES = 84;
const MAX_COMPONENTS_PER_ENTRY = 4;
const MAX_LINES_PER_COMPONENT = 30;
const MAX_LINES_PER_PLAN = 300;
const MAX_ALLOCATIONS_PER_PLAN = 300;
const MAX_PLAN_NOTE = 1_000;
const MAX_PLAN_PERSISTED_JSON_BYTES = 1_500_000;
const MACROS = ["kcal", "protein", "carbs", "fat"] as const;
type Macro = (typeof MACROS)[number];

function dates(from: string, to: string): string[] {
  if (to < from) throw new ToolError("invalid_period", "to must be on or after from");
  const out: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    out.push(day);
    if (out.length > MAX_DAYS) throw new ToolError("period_too_long", `meal planning covers at most ${MAX_DAYS} days`);
  }
  return out;
}

async function targetViews(ctx: Ctx, members: readonly Member[], from: string, to: string) {
  const cat = await Catalogue.load(ctx);
  const reader = new NutritionReader(ctx, cat);
  return { cat, ...(await dayViews(ctx, reader, members, from, to)) };
}

const planningContext = readTool({
  name: "household_planning_context",
  group: GROUP,
  description:
    "Household members, effective resolved nutrition targets, the current active saved plan for a 1–14 day planning period, and prepared_batches: confirmed cooks from the last week whose shares still have an unaccounted remainder. Excludes private target reasoning and notes.",
  input: { from: date, to: date },
  async run(ctx, input) {
    const period = dates(input.from, input.to);
    const members = (await ctx.members()).filter((member) => member.active === 1);
    const { views } = await targetViews(ctx, members, input.from, input.to);
    const activePlan = await first<PlanRow>(ctx.db,
      `SELECT * FROM meal_plan
        WHERE household_id = ? AND status = 'active' AND archived_at IS NULL AND superseded_at IS NULL
          AND effective_from <= ? AND effective_to >= ?
        ORDER BY effective_from, id LIMIT 1`,
      ctx.householdId, input.to, input.from,
    );
    return {
      from: input.from,
      to: input.to,
      members: members.map((member) => ({
        name: member.name,
        days: period.map((day) => {
          const view = viewOf(views, member.id, day);
          return {
            date: day,
            target_effective_from: view.target_effective_from,
            target: view.target,
            target_values: view.target_values,
          };
        }),
      })),
      active_plan: activePlan ? publicPlan(activePlan) : null,
      prepared_batches: await preparedBatches(ctx, ctx.today()),
    };
  },
});

const entry = z.object({ ...MEAL_FIELDS, note: z.string().max(MAX_PLAN_NOTE).optional(), cooks: MEAL_FIELDS.cooks.refine((cooks) => cooks.every((cook) => cook.portions !== undefined), {
  message: "every planned cook must provide portions, using [] when allocation is not known",
}) }).strict().superRefine((meal, issue) => {
  const components = meal.cooks.reduce((count, cook) => count + (cook.components?.length ?? 1), 0);
  if (components > MAX_COMPONENTS_PER_ENTRY) issue.addIssue({ code: "custom", message: `a planned meal supports at most ${MAX_COMPONENTS_PER_ENTRY} components`, path: ["cooks"] });
  for (const [cookIndex, cook] of meal.cooks.entries()) {
    for (const [componentIndex, component] of (cook.components ?? []).entries()) {
      if (component.lines.length > MAX_LINES_PER_COMPONENT) issue.addIssue({ code: "custom", message: `a planned component supports at most ${MAX_LINES_PER_COMPONENT} lines`, path: ["cooks", cookIndex, "components", componentIndex, "lines"] });
    }
    if ((cook.lines?.length ?? 0) > MAX_LINES_PER_COMPONENT) issue.addIssue({ code: "custom", message: `a planned component supports at most ${MAX_LINES_PER_COMPONENT} lines`, path: ["cooks", cookIndex, "lines"] });
  }
});

export const mealPlanEntries = z.array(entry).min(1).max(MAX_ENTRIES).superRefine((meals, issue) => {
  const lines = meals.reduce((total, meal) => total + meal.cooks.reduce((cookTotal, cook) => cookTotal + (cook.lines?.length ?? 0) + (cook.components?.reduce((componentTotal, component) => componentTotal + component.lines.length, 0) ?? 0), 0), 0);
  const allocations = meals.reduce((total, meal) => total + (meal.items?.length ?? 0) + meal.cooks.reduce((cookTotal, cook) => cookTotal + (cook.portions?.length ?? 0), 0), 0);
  if (lines > MAX_LINES_PER_PLAN) issue.addIssue({ code: "custom", message: `a meal plan supports at most ${MAX_LINES_PER_PLAN} ingredient lines` });
  if (allocations > MAX_ALLOCATIONS_PER_PLAN) issue.addIssue({ code: "custom", message: `a meal plan supports at most ${MAX_ALLOCATIONS_PER_PLAN} member allocations` });
});

function orderedEntries(entries: readonly MealInput[]): MealInput[] {
  return [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.meal_slot.localeCompare(b.meal_slot));
}

/** Sunday is 0, matching the domain's weekday helper. */
const BATCH_DAY = z.number().int().min(0).max(6).optional().describe("Optional weekly batch day: 0 Sunday … 6 Saturday. The schedule batches there when the shelf life allows.");

/** Every planned cook's recipe steps, resolved into the domain's plain occurrences. */
function prepOccurrences(ordered: readonly MealInput[], book: RecipeBook, cat: Catalogue): PrepOccurrence[] {
  const occurrences: PrepOccurrence[] = [];
  for (const meal of ordered) {
    for (const cook of meal.cooks) {
      if (cook.recipe === undefined) continue;
      const recipe = book.find(cook.recipe);
      if (!recipe) continue;
      const eaters = [...new Set((cook.portions ?? []).map((portion) => portion.member))];
      for (const row of book.steps(recipe.id)) {
        const food = row.food_source_id === null ? null : cat.row(row.food_source_id);
        const step: PrepStep = {
          action: row.action,
          lead: row.lead,
          lead_min_h: row.lead_min_h,
          lead_max_h: row.lead_max_h,
          duration_min: row.duration_min,
          who: row.who,
          batchable: row.batchable === 1,
          keeps_days: row.keeps_days,
          batch_group: row.batch_group,
          batch_days: row.batch_days,
          storage: row.storage,
          freezer_ok: row.freezer_ok === 1,
          food: food === null ? null : food.name,
          amount_value: row.amount_value,
          amount_unit: row.amount_unit,
          note: row.note,
        };
        occurrences.push({ date: meal.date, meal_slot: meal.meal_slot, meal: cook.name, recipe: recipe.ref, eaters, step });
      }
    }
  }
  return occurrences;
}

function coverage(totals: NutrientTotals): Record<Macro, { known: number; of: number }> {
  return Object.fromEntries(MACROS.map((macro) => [macro, { known: totals[macro]?.known ?? 0, of: totals[macro]?.of ?? 0 }])) as Record<Macro, { known: number; of: number }>;
}

function targetGoal(target: ResolvedTarget, macro: Macro): number {
  return macro === "kcal" ? target.kcal : target[macro].goal;
}

function comparison(totals: NutrientTotals, target: ResolvedTarget | null, planned = true) {
  if (!planned) return { delta: null, coverage: Object.fromEntries(MACROS.map((macro) => [macro, { known: 0, of: 0 }])) as Record<Macro, { known: number; of: number }>, incomplete: [...MACROS], assessment: "unplanned" };
  const incomplete = MACROS.filter((macro) => !totals[macro] || totals[macro].known < totals[macro].of);
  const delta = target === null
    ? null
    : Object.fromEntries(MACROS.map((macro) => {
        const total = totals[macro];
        return [macro, total && total.known === total.of ? targetGoal(target, macro) - total.value : null];
      }));
  const assessment = target === null ? "no_target" : incomplete.length > 0 ? "indeterminate" : "computed";
  return { delta, coverage: coverage(totals), incomplete, assessment };
}

export function honestTotals(totals: NutrientTotals) {
  return Object.fromEntries(Object.entries(totals).map(([nutrient, total]) => [
    nutrient,
    { ...total, value: total.known === 0 ? null : total.value },
  ]));
}

const previewMealPlan = readTool({
  name: "preview_meal_plan",
  group: GROUP,
  description:
    "Preview up to 14 days/84 meal occasions for the household without writing. Uses preview_meal's canonical food, recipe, portion and nutrition resolution. Every cook needs explicit portions; use [] when shares are not decided. Returns per-meal, member and day totals, target deltas, coverage, honest incomplete issues, and prep_schedule: the dated prep tasks the planned recipes' prep_steps derive (merged soaks, batched cooks split into fridge and freezer parts with a thaw, and who does each). batch_day (0 Sunday … 6 Saturday) is the optional weekly batch session.",
  input: { entries: mealPlanEntries, batch_day: BATCH_DAY },
  async run(ctx, input) {
    return previewMealPlanInput(ctx, input);
  },
});

export async function previewMealPlanInput(ctx: Ctx, input: { entries: MealInput[]; batch_day?: number }) {
    const ordered = orderedEntries(input.entries);
    const firstEntry = ordered[0] as MealInput;
    const lastEntry = ordered[ordered.length - 1] as MealInput;
    const period = dates(firstEntry.date, lastEntry.date);
    const seen = new Set<string>();
    for (const meal of ordered) {
      const key = `${meal.date}|${meal.meal_slot}`;
      if (seen.has(key)) throw new ToolError("duplicate_meal", `only one planned meal may use ${meal.date} ${meal.meal_slot}`);
      seen.add(key);
    }

    const household = (await ctx.members()).filter((member) => member.active === 1);
    const activeNames = new Set(household.map((member) => member.name));
    for (const meal of ordered) {
      for (const cook of meal.cooks) {
        const componentCount = cook.components?.length ?? 1;
        if ((cook.portions?.length ?? 0) > household.length * componentCount) {
          throw new ToolError("too_many_allocations", "a planned component may allocate at most one portion to each active household member");
        }
        const allocations = new Set<string>();
        for (const portion of cook.portions ?? []) {
          const key = `${portion.member.trim().toLowerCase()}|${portion.component?.trim().toLowerCase() ?? "_only"}`;
          if (allocations.has(key)) throw new ToolError("duplicate_allocation", `${portion.member} may have only one allocation for a planned component`);
          allocations.add(key);
        }
      }
    }
    const from = period[0] as string;
    const to = period[period.length - 1] as string;
    const { cat, views } = await targetViews(ctx, household, from, to);
    const usesRecipes = ordered.some((meal) => meal.cooks.some((cook) => cook.recipe !== undefined) || (meal.items ?? []).some((item) => item.source === "recipe"));
    const book = usesRecipes ? await RecipeBook.load(ctx) : RecipeBook.empty();
    const meals = [];
    const issues: Record<string, unknown>[] = [];
    const memberDays = new Map<string, NutrientTotals[]>();

    for (const meal of ordered) {
      const preview = await previewMealInput(ctx, cat, meal as MealInput, book);
      for (const member of Object.keys(preview.members)) {
        if (!activeNames.has(member)) throw new ToolError("inactive_member", `${member} is not an active household member`);
      }
      const allocated = Object.values(preview.members);
      meals.push({
        date: meal.date,
        meal_slot: meal.meal_slot,
        ...preview,
        members: Object.fromEntries(Object.entries(preview.members).map(([name, totals]) => [name, honestTotals(totals)])),
        totals: honestTotals(sumNutrients(allocated)),
      });
      for (const [member, nutrients] of Object.entries(preview.members)) {
        const key = `${member}|${meal.date}`;
        memberDays.set(key, [...(memberDays.get(key) ?? []), nutrients]);
      }
      for (const [cookIndex, cook] of preview.cooks.entries()) {
        for (const remainder of cook.remainder) {
          issues.push({ kind: "unallocated_remainder", date: meal.date, meal_slot: meal.meal_slot, cook_index: cookIndex, cook: cook.name, component: remainder.component });
        }
      }
    }

    const members = household.map((member) => {
      const rawTotals: NutrientTotals[] = [];
      const days = period.map((day) => {
        const parts = memberDays.get(`${member.name}|${day}`);
        const totals = sumNutrients(parts ?? []);
        if (parts) rawTotals.push(totals);
        const target = viewOf(views, member.id, day).target;
        const compared = comparison(totals, target, parts !== undefined);
        if (target === null) issues.push({ kind: "missing_target", member: member.name, date: day });
        if (parts !== undefined) for (const macro of compared.incomplete) issues.push({ kind: "incomplete_nutrition", member: member.name, date: day, nutrient: macro });
        return { date: day, totals: honestTotals(totals), target, ...compared };
      });
      return { member: member.name, totals: honestTotals(sumNutrients(rawTotals)), days };
    });

    const prepSchedule = buildPrepSchedule(prepOccurrences(ordered, book, cat), { batch_day: input.batch_day ?? null, from });

    return { from, to, meals, members, issues, prep_schedule: prepSchedule };
}

type PlanRow = Row & {
  id: number;
  household_id: number;
  name: string;
  status: "draft" | "active";
  revision: number;
  effective_from: string;
  effective_to: string;
  canonical_json: string;
  preview_json: string;
  supersedes_meal_plan_id: number | null;
  superseded_at: string | null;
  superseded_reason: string | null;
  archived_at: string | null;
  archived_reason: string | null;
  change_reason: string;
  created_at: string;
};

const planName = z.string().trim().min(1).max(200);
const changeReason = z.string().trim().min(1).max(MAX_PLAN_NOTE);

const encodedBytes = (value: string): number => new TextEncoder().encode(value).byteLength;

export function assertPersistedPlanPayload(canonicalJson: string, previewJson: string): void {
  const row = { canonical_json: canonicalJson, preview_json: previewJson };
  const rowJson = JSON.stringify(row);
  // WriteTx persists this row twice in the same atomic batch: createMany's
  // JSON parameter and record_version's nested JSON envelope. Bound the
  // larger encoded representation, not merely the two unescaped strings.
  const createBinding = JSON.stringify([row]);
  const versionBinding = JSON.stringify([JSON.stringify({ t: "meal_plan", id: 1, data: rowJson })]);
  if (Math.max(encodedBytes(createBinding), encodedBytes(versionBinding)) > MAX_PLAN_PERSISTED_JSON_BYTES) {
    throw new ToolError("meal_plan_too_large", "The canonical proposal and resolved preview are too large to save safely in one plan revision.");
  }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function publicPlan(row: PlanRow, supersededBy: number | null = null, currentId: number = row.id) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    revision: row.revision,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    supersedes_meal_plan_id: row.supersedes_meal_plan_id,
    superseded_at: row.superseded_at,
    superseded_by_meal_plan_id: supersededBy,
    current_meal_plan_id: currentId,
    archived: row.archived_at !== null,
    archived_at: row.archived_at,
    created_at: row.created_at,
  };
}

async function planLinks(ctx: Ctx, row: PlanRow): Promise<{ supersededBy: number | null; currentId: number }> {
  const linked = await first<{ superseded_by: number | null; current_id: number }>(ctx.db,
    `WITH RECURSIVE successors(id, revision) AS (
       SELECT id, revision FROM meal_plan WHERE id = ? AND household_id = ?
       UNION ALL
       SELECT next.id, next.revision FROM meal_plan next JOIN successors prior ON next.supersedes_meal_plan_id = prior.id
     )
     SELECT
       (SELECT id FROM meal_plan WHERE supersedes_meal_plan_id = ? AND household_id = ?) AS superseded_by,
       (SELECT id FROM successors ORDER BY revision DESC LIMIT 1) AS current_id`,
    row.id, ctx.householdId, row.id, ctx.householdId,
  );
  return { supersededBy: linked?.superseded_by ?? null, currentId: linked?.current_id ?? row.id };
}

async function planById(ctx: Ctx, id: number): Promise<PlanRow> {
  const row = await first<PlanRow>(ctx.db, "SELECT * FROM meal_plan WHERE id = ? AND household_id = ?", id, ctx.householdId);
  if (!row) throw new ToolError("meal_plan_not_found", `no meal plan ${id}`, 404);
  return row;
}

function assertCurrent(row: PlanRow, expectedRevision: number): void {
  if (row.revision !== expectedRevision || row.superseded_at !== null) {
    throw new ToolError("stale_meal_plan_revision", `Meal plan ${row.id} is no longer revision ${expectedRevision}; read the current plan before changing it.`, 409);
  }
}

async function assertNoActiveOverlap(ctx: Ctx, from: string, to: string, predecessorId: number | null): Promise<void> {
  const overlap = await first<{ id: number }>(ctx.db,
    `SELECT id FROM meal_plan
      WHERE household_id = ? AND status = 'active' AND archived_at IS NULL AND superseded_at IS NULL
        AND effective_from <= ? AND effective_to >= ? AND (? IS NULL OR id <> ?)
      LIMIT 1`,
    ctx.householdId, to, from, predecessorId, predecessorId,
  );
  if (overlap) throw new ToolError("meal_plan_overlap", `Active meal plan ${overlap.id} already covers part of ${from} to ${to}.`, 409);
}

async function stagePlanGraph(ctx: Ctx, args: {
  name: string;
  status: "draft" | "active";
  entries: MealInput[];
  preview: Awaited<ReturnType<typeof previewMealPlanInput>>;
  changeReason: string;
  predecessor: PlanRow | null;
  archivedAt?: string | null;
  archivedReason?: string | null;
}) {
  const tx = ctx.txOrThrow;
  await tx.reserve(["meal_plan", "meal_plan_entry", "meal_plan_component", "meal_plan_ingredient_snapshot", "meal_plan_allocation", "prep_task"]);
  if (args.predecessor) {
    const changes = { superseded_at: ctx.nowIso(), superseded_reason: args.changeReason };
    tx.update("meal_plan", args.predecessor.id, changes, { ...args.predecessor, ...changes });
  }
  const canonicalJson = json({ entries: args.entries });
  const previewJson = json(args.preview);
  assertPersistedPlanPayload(canonicalJson, previewJson);
  const [planId] = await tx.createMany("meal_plan", [{
    household_id: ctx.householdId,
    name: args.name.trim(),
    status: args.status,
    revision: (args.predecessor?.revision ?? 0) + 1,
    effective_from: args.preview.from,
    effective_to: args.preview.to,
    canonical_json: canonicalJson,
    preview_json: previewJson,
    supersedes_meal_plan_id: args.predecessor?.id ?? null,
    archived_at: args.archivedAt ?? null,
    archived_reason: args.archivedReason ?? null,
    change_reason: args.changeReason,
    created_at: ctx.nowIso(),
  }]);
  const entryIds = await tx.createMany("meal_plan_entry", args.entries.map((meal, index) => ({
    meal_plan_id: planId,
    position: index + 1,
    planned_on: meal.date,
    meal_slot: meal.meal_slot,
    note: meal.note ?? null,
    canonical_json: json(meal),
  })));
  const components = args.entries.flatMap((meal, entryIndex) => {
    const inEntry = meal.cooks.flatMap((cook, cookIndex) => {
      const parts = cook.components ?? [{ name: cook.name, lines: cook.lines ?? [] }];
      return parts.map((component) => ({ entryIndex, cookIndex, cook, component, single: cook.components === undefined }));
    });
    return inEntry.map((component, position) => ({ ...component, position: position + 1 }));
  });
  const componentIds = await tx.createMany("meal_plan_component", components.map(({ entryIndex, cook, component, position }) => ({
    meal_plan_entry_id: entryIds[entryIndex]!,
    position,
    name: component.name,
    canonical_json: json({ cook: cook.name, recipe: cook.recipe ?? null, component }),
  })));
  await tx.createMany("meal_plan_ingredient_snapshot", components.flatMap(({ entryIndex, cookIndex, component, single }, componentIndex) => {
    const resolvedCook = args.preview.meals[entryIndex]?.cooks[cookIndex];
    const resolvedLines = resolvedCook?.lines.filter((line) => single || line.component === component.name) ?? [];
    return resolvedLines.map((line, lineIndex) => ({
    meal_plan_component_id: componentIds[componentIndex]!,
    position: lineIndex + 1,
    canonical_json: json(line),
    }));
  }));
  const members = await ctx.members();
  const memberId = new Map(members.map((member) => [member.name.trim().toLowerCase(), member.id]));
  await tx.createMany("meal_plan_allocation", components.flatMap(({ cook, component }, componentIndex) => (cook.portions ?? [])
    .filter((portion) => portion.component === undefined || portion.component.trim().toLowerCase() === component.name.trim().toLowerCase())
    .map((portion, portionIndex) => ({
      meal_plan_component_id: componentIds[componentIndex]!,
      member_id: memberId.get(portion.member.trim().toLowerCase())!,
      position: portionIndex + 1,
      canonical_json: json({
        requested: portion,
        resolved: args.preview.meals[components[componentIndex]!.entryIndex]?.cooks[components[componentIndex]!.cookIndex]?.portions
          .find((resolved) => resolved.member.trim().toLowerCase() === portion.member.trim().toLowerCase() && resolved.component.trim().toLowerCase() === component.name.trim().toLowerCase()) ?? null,
      }),
    }))));
  // A revision keeps a done soak done: the task key is stable, so state
  // carries from the predecessor revision.
  const priorStates = args.predecessor === null
    ? []
    : await all<{ task_key: string; status: "pending" | "done" | "skipped"; settled_on: string | null; settled_by: number | null; settled_reason: string | null }>(
      ctx.db,
      "SELECT task_key, status, settled_on, settled_by, settled_reason FROM prep_task WHERE meal_plan_id = ?",
      args.predecessor.id,
    );
  const prior = new Map(priorStates.map((state) => [state.task_key, state]));
  await tx.createMany("prep_task", args.preview.prep_schedule.map((task) => {
    const state = prior.get(task.task_key);
    const status = state?.status ?? "pending";
    return {
      household_id: ctx.householdId,
      meal_plan_id: planId,
      task_key: task.task_key,
      action: task.action,
      who: task.who,
      status,
      due_on: task.due_by.slice(0, 10),
      window_start: task.window_start,
      window_end: task.window_end,
      settled_on: status === "pending" ? null : state?.settled_on ?? null,
      settled_by: status === "pending" ? null : state?.settled_by ?? null,
      settled_reason: status === "pending" ? null : state?.settled_reason ?? null,
      canonical_json: json(task),
      created_at: ctx.nowIso(),
    };
  }));
  return {
    id: planId!, household_id: ctx.householdId, name: args.name.trim(), status: args.status,
    revision: (args.predecessor?.revision ?? 0) + 1, effective_from: args.preview.from, effective_to: args.preview.to,
    canonical_json: canonicalJson, preview_json: previewJson, supersedes_meal_plan_id: args.predecessor?.id ?? null,
    superseded_at: null, superseded_reason: null, archived_at: args.archivedAt ?? null, archived_reason: args.archivedReason ?? null,
    change_reason: args.changeReason, created_at: ctx.nowIso(),
  } satisfies PlanRow;
}

type EntrySnapshot = Row & { id: number; position: number; planned_on: string; meal_slot: string; note: string | null; canonical_json: string };
type ComponentSnapshot = Row & { id: number; meal_plan_entry_id: number; position: number; name: string; canonical_json: string };
type IngredientSnapshot = Row & { meal_plan_component_id: number; position: number; canonical_json: string };
type AllocationSnapshot = Row & { meal_plan_component_id: number; member_id: number; position: number; canonical_json: string };

async function stagePlanClone(ctx: Ctx, args: {
  predecessor: PlanRow;
  changeReason: string;
  archivedAt: string | null;
  archivedReason: string | null;
}) {
  assertPersistedPlanPayload(args.predecessor.canonical_json, args.predecessor.preview_json);
  const entries = await all<EntrySnapshot>(ctx.db, "SELECT * FROM meal_plan_entry WHERE meal_plan_id = ? ORDER BY position", args.predecessor.id);
  const components = await all<ComponentSnapshot>(ctx.db,
    `SELECT c.* FROM meal_plan_component c JOIN meal_plan_entry e ON e.id = c.meal_plan_entry_id
      WHERE e.meal_plan_id = ? ORDER BY e.position, c.position`, args.predecessor.id,
  );
  const ingredients = await all<IngredientSnapshot>(ctx.db,
    `SELECT i.* FROM meal_plan_ingredient_snapshot i JOIN meal_plan_component c ON c.id = i.meal_plan_component_id
      JOIN meal_plan_entry e ON e.id = c.meal_plan_entry_id WHERE e.meal_plan_id = ? ORDER BY e.position, c.position, i.position`, args.predecessor.id,
  );
  const allocations = await all<AllocationSnapshot>(ctx.db,
    `SELECT a.* FROM meal_plan_allocation a JOIN meal_plan_component c ON c.id = a.meal_plan_component_id
      JOIN meal_plan_entry e ON e.id = c.meal_plan_entry_id WHERE e.meal_plan_id = ? ORDER BY e.position, c.position, a.position`, args.predecessor.id,
  );
  const tx = ctx.txOrThrow;
  await tx.reserve(["meal_plan", "meal_plan_entry", "meal_plan_component", "meal_plan_ingredient_snapshot", "meal_plan_allocation", "prep_task"]);
  const changes = { superseded_at: ctx.nowIso(), superseded_reason: args.changeReason };
  tx.update("meal_plan", args.predecessor.id, changes, { ...args.predecessor, ...changes });
  const [planId] = await tx.createMany("meal_plan", [{
    household_id: ctx.householdId,
    name: args.predecessor.name,
    status: args.predecessor.status,
    revision: args.predecessor.revision + 1,
    effective_from: args.predecessor.effective_from,
    effective_to: args.predecessor.effective_to,
    canonical_json: args.predecessor.canonical_json,
    preview_json: args.predecessor.preview_json,
    supersedes_meal_plan_id: args.predecessor.id,
    archived_at: args.archivedAt,
    archived_reason: args.archivedReason,
    change_reason: args.changeReason,
    created_at: ctx.nowIso(),
  }]);
  const entryIds = await tx.createMany("meal_plan_entry", entries.map((entry) => ({
    meal_plan_id: planId, position: entry.position, planned_on: entry.planned_on, meal_slot: entry.meal_slot,
    note: entry.note, canonical_json: entry.canonical_json,
  })));
  const entryId = new Map(entries.map((entry, index) => [entry.id, entryIds[index]!]));
  const componentIds = await tx.createMany("meal_plan_component", components.map((component) => ({
    meal_plan_entry_id: entryId.get(component.meal_plan_entry_id)!, position: component.position,
    name: component.name, canonical_json: component.canonical_json,
  })));
  const componentId = new Map(components.map((component, index) => [component.id, componentIds[index]!]));
  await tx.createMany("meal_plan_ingredient_snapshot", ingredients.map((ingredient) => ({
    meal_plan_component_id: componentId.get(ingredient.meal_plan_component_id)!, position: ingredient.position,
    canonical_json: ingredient.canonical_json,
  })));
  await tx.createMany("meal_plan_allocation", allocations.map((allocation) => ({
    meal_plan_component_id: componentId.get(allocation.meal_plan_component_id)!, member_id: allocation.member_id,
    position: allocation.position, canonical_json: allocation.canonical_json,
  })));
  // The schedule is part of the revision, and its state rides along.
  tx.exec(
    `INSERT INTO prep_task (household_id, meal_plan_id, task_key, action, who, status, due_on, window_start, window_end, settled_on, settled_by, settled_reason, canonical_json, created_at)
     SELECT household_id, ?1, task_key, action, who, status, due_on, window_start, window_end, settled_on, settled_by, settled_reason, canonical_json, created_at
     FROM prep_task WHERE meal_plan_id = ?2`,
    planId!, args.predecessor.id,
  );
  return {
    ...args.predecessor,
    id: planId!, revision: args.predecessor.revision + 1, supersedes_meal_plan_id: args.predecessor.id,
    superseded_at: null, superseded_reason: null, archived_at: args.archivedAt, archived_reason: args.archivedReason,
    change_reason: args.changeReason, created_at: ctx.nowIso(),
  } satisfies PlanRow;
}

const saveMealPlan = writeTool({
  name: "save_meal_plan",
  group: GROUP,
  description: "Save a validated household meal-plan draft or active plan without logging food, with its prep schedule stored as durable prep tasks (a successor keeps a settled task settled). Supplying plan_id creates an immutable successor and requires expected_revision.",
  input: {
    plan_id: z.number().int().positive().optional(),
    expected_revision: z.number().int().positive().optional(),
    name: planName,
    status: z.enum(["draft", "active"]),
    entries: mealPlanEntries,
    batch_day: BATCH_DAY,
    change_reason: changeReason,
  },
  async run(ctx, input) {
    if ((input.plan_id === undefined) !== (input.expected_revision === undefined)) {
      throw new ToolError("expected_revision_required", "plan_id and expected_revision must be supplied together");
    }
    const predecessor = input.plan_id === undefined ? null : await planById(ctx, input.plan_id);
    if (predecessor) assertCurrent(predecessor, input.expected_revision!);
    const normalizedEntries = orderedEntries(input.entries as MealInput[]);
    const preview = await previewMealPlanInput(ctx, { entries: normalizedEntries, batch_day: input.batch_day });
    if (input.status === "active") await assertNoActiveOverlap(ctx, preview.from, preview.to, predecessor?.id ?? null);
    const row = await stagePlanGraph(ctx, { name: input.name, status: input.status, entries: normalizedEntries, preview, changeReason: input.change_reason, predecessor });
    return { action: predecessor ? "revised" : "created", plan: publicPlan(row), preview };
  },
});

const mealPlan = readTool({
  name: "meal_plan",
  group: GROUP,
  description: "Read one household meal-plan revision, including its saved canonical proposal, the preview calculated when it was saved, and its prep_tasks with their done/skipped state.",
  input: { plan_id: z.number().int().positive() },
  async run(ctx, input) {
    const row = await planById(ctx, input.plan_id);
    const links = await planLinks(ctx, row);
    return {
      plan: publicPlan(row, links.supersededBy, links.currentId),
      proposal: JSON.parse(row.canonical_json),
      preview: JSON.parse(row.preview_json),
      prep_tasks: (await loadPlanPrepTasks(ctx, row.id)).map(taskOf),
    };
  },
});

const setMealPlanArchived = writeTool({
  name: "set_meal_plan_archived",
  group: GROUP,
  description: "Archive or restore a current meal plan by creating an immutable successor revision. Requires the revision just read and a change reason.",
  input: {
    plan_id: z.number().int().positive(),
    expected_revision: z.number().int().positive(),
    archived: z.boolean(),
    change_reason: changeReason,
  },
  async run(ctx, input) {
    const predecessor = await planById(ctx, input.plan_id);
    assertCurrent(predecessor, input.expected_revision);
    const currentlyArchived = predecessor.archived_at !== null;
    if (currentlyArchived === input.archived) {
      return { action: "unchanged", plan: publicPlan(predecessor, null, predecessor.id), preview: JSON.parse(predecessor.preview_json) };
    }
    if (!input.archived && predecessor.status === "active") {
      await assertNoActiveOverlap(ctx, predecessor.effective_from, predecessor.effective_to, predecessor.id);
    }
    const row = await stagePlanClone(ctx, {
      predecessor, changeReason: input.change_reason,
      archivedAt: input.archived ? ctx.nowIso() : null,
      archivedReason: input.archived ? input.change_reason : null,
    });
    return {
      action: input.archived ? "archived_as_successor" : "restored_as_successor",
      plan: publicPlan(row),
      preview: JSON.parse(row.preview_json),
    };
  },
});

const settlePrepTask = writeTool({
  name: "settle_prep_task",
  group: GROUP,
  description: "Mark a prep task done, skipped, or pending again, with a reason (required for a skip). A done or skipped task leaves today's prep list and the 'next prep' hint but stays in the plan's history.",
  input: {
    task_id: z.number().int().positive(),
    status: z.enum(["done", "skipped", "pending"]),
    reason: z.string().trim().min(1).max(MAX_PLAN_NOTE).optional(),
  },
  async run(ctx, input) {
    const row = await first<PrepTaskRow>(ctx.db, "SELECT * FROM prep_task WHERE id = ? AND household_id = ?", input.task_id, ctx.householdId);
    if (!row) throw new ToolError("not_found", `no prep task ${input.task_id}`, 404);
    const pending = input.status === "pending";
    const changes = {
      status: input.status,
      settled_on: pending ? null : ctx.today(),
      settled_by: pending ? null : ctx.caller.kind === "member" ? ctx.caller.memberId : null,
      settled_reason: pending ? null : input.reason ?? (input.status === "done" ? "Marked done." : "Marked skipped."),
    };
    ctx.txOrThrow.update("prep_task", row.id, changes, { ...row, ...changes });
    return { state: "confirmed", task: taskOf({ ...row, ...changes }) };
  },
});

export const MEAL_PLANNING_TOOLS: Tool[] = [planningContext, previewMealPlan, saveMealPlan, mealPlan, setMealPlanArchived, settlePrepTask];
