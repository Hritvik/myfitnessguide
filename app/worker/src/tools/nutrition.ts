import { sumNutrients, type NutrientTotals } from "@myfitnessguide/domain";
import { z } from "zod";
import { AMOUNT, Catalogue, MEAL_SLOTS, PROVENANCE, type ResolvedAmount } from "../catalogue";
import type { Ctx, Member } from "../context";
import { all, first, type Row } from "../db";
import { Clarify, ToolError } from "../errors";
import {
  computeCook,
  cookProblemsToClarify,
  cookShares,
  dayView,
  describeItem,
  ITEM,
  loadCook,
  MEMBER_ITEM,
  NutritionReader,
  noCookedWeight,
  planEatenPortion,
  PORTION,
  portionKey,
  previewIds,
  resolveItem,
  servingKey,
  shareNames,
  type IdSource,
  type IntakeRow,
} from "../nutrition";
import { RecipeBook } from "../recipes";
import { reopenLeftovers } from "./records";
import { readTool, writeTool, type Tool } from "../tool";

const GROUP = "nutrition";
const date = z.iso.date();
const mealSlot = z.enum(MEAL_SLOTS);

const logIntake = writeTool({
  name: "log_intake",
  group: GROUP,
  description:
    "Log standalone foods or existing recipe servings: a food source by amount (unit or measure, and state when ambiguous), a saved recipe by servings, or manual macros with a reason. Do not flatten named composed dishes such as sandwiches, salads, smoothies, curries, or omelettes into separate intake items; record each as a named cook with household_meal, even when only one person eats it. Returns each item's nutrients and the day so far.",
  input: {
    member: z.string().min(1),
    date,
    meal_slot: mealSlot,
    items: z.array(ITEM).min(1),
  },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    ctx.onBehalfOf(member.id);
    const cat = await Catalogue.load(ctx);
    const book = await RecipeBook.forItems(ctx, input.items);
    const resolved = [];
    for (const [i, item] of input.items.entries()) resolved.push(await resolveItem(ctx, cat, item, ["items", i], book));
    const stamp = ctx.stamp(ctx.stateFor(member.id));
    const items = [];
    for (const r of resolved) {
      const row = { member_id: member.id, eaten_on: input.date, meal_slot: input.meal_slot, ...r.columns, ...stamp };
      const id = await ctx.txOrThrow.create("intake_item", row);
      items.push(describeItem(cat, { id, ...row, recipe_ref: r.display.ref, recipe_name: r.display.name }, r.nutrients, member.name));
    }
    const day = await dayView(ctx, new NutritionReader(ctx, cat), member, input.date, resolved.map((r) => ({ nutrients: r.nutrients, state: stamp.state })));
    return { items, day };
  },
});

const dayItems = readTool({
  name: "day_items",
  group: GROUP,
  description: "A member's intake items for one day, each with its computed nutrients and state.",
  input: { member: z.string().min(1), date },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    const cat = await Catalogue.load(ctx);
    const reader = new NutritionReader(ctx, cat);
    const items = await reader.items(member.id, input.date);
    const recipes = new Map(
      (await all<{ id: number; ref: string; name: string }>(ctx.db, "SELECT id, ref, name FROM recipe WHERE household_id = ?", ctx.householdId)).map((r) => [r.id, r]),
    );
    return {
      member: member.name,
      date: input.date,
      items: items.map((i) => {
        const recipe = i.row.recipe_id ? recipes.get(i.row.recipe_id) : undefined;
        return describeItem(cat, { ...i.row, recipe_ref: recipe?.ref, recipe_name: recipe?.name } as IntakeRow & Row, i.nutrients, member.name);
      }),
    };
  },
});

const dayTotalsTool = readTool({
  name: "day_totals",
  group: GROUP,
  description:
    "A member's day: so far, target, left (with floors), unknown_items (per macro, how many items so far and left leave out because nobody knows their value: a count above 0 makes them partial; `any` counts items with any macro unknown, each once), micronutrients with coverage, protein by band, cost, day status and skipped meals. Drafts count, and draft_items says how many.",
  input: { member: z.string().min(1), date },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    const cat = await Catalogue.load(ctx);
    return dayView(ctx, new NutritionReader(ctx, cat), member, input.date);
  },
});

const setDayStatus = writeTool({
  name: "set_day_status",
  group: GROUP,
  description:
    "Mark a member's day open, complete or partial, with its skipped meals (replacing the list) and optionally a legacy manual day total. A member sets only their own day; the agent any member's.",
  input: {
    member: z.string().min(1),
    date,
    status: z.enum(["open", "complete", "partial"]),
    skipped_meals: z.array(mealSlot).optional(),
    manual_total: z
      .object({ kcal: z.number().min(0), protein_g: z.number().min(0), carbs_g: z.number().min(0), fat_g: z.number().min(0), reason: z.string().min(1) })
      .strict()
      .optional(),
  },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    // Closing a day is the member's own call, or the agent's (Hritvik, 7 Oct 2026): never another member's.
    if (!ctx.canSee(member.id)) throw new ToolError("not_visible", "a day's status is set only by its member, or the agent", 403);
    ctx.onBehalfOf(member.id);
    const tx = ctx.txOrThrow;
    const m = input.manual_total;
    tx.exec(
      `INSERT INTO day_status (member_id, day, status, manual_total_kcal, manual_total_protein_g, manual_total_carbs_g, manual_total_fat_g, manual_total_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (member_id, day) DO UPDATE SET status = excluded.status,
         manual_total_kcal = coalesce(excluded.manual_total_kcal, manual_total_kcal),
         manual_total_protein_g = coalesce(excluded.manual_total_protein_g, manual_total_protein_g),
         manual_total_carbs_g = coalesce(excluded.manual_total_carbs_g, manual_total_carbs_g),
         manual_total_fat_g = coalesce(excluded.manual_total_fat_g, manual_total_fat_g),
         manual_total_reason = coalesce(excluded.manual_total_reason, manual_total_reason)`,
      member.id, input.date, input.status, m?.kcal ?? null, m?.protein_g ?? null, m?.carbs_g ?? null, m?.fat_g ?? null, m?.reason ?? null,
    );
    if (input.skipped_meals) {
      tx.exec("DELETE FROM skipped_meal WHERE member_id = ? AND day = ?", member.id, input.date);
      for (const slot of new Set(input.skipped_meals)) {
        tx.exec("INSERT INTO skipped_meal (member_id, day, meal_slot) VALUES (?, ?, ?)", member.id, input.date, slot);
      }
    }
    return { member: member.name, date: input.date, status_set: input.status, skipped_meals: [...new Set(input.skipped_meals ?? [])] };
  },
});

const whatIf = readTool({
  name: "what_if",
  group: GROUP,
  description: "The member's day as if these items were eaten too: each item's nutrients and the resulting totals and left. Writes nothing.",
  input: { member: z.string().min(1), date, items: z.array(ITEM).min(1) },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    const cat = await Catalogue.load(ctx);
    const book = await RecipeBook.forItems(ctx, input.items);
    const resolved = [];
    for (const [i, item] of input.items.entries()) resolved.push(await resolveItem(ctx, cat, item, ["items", i], book));
    const day = await dayView(ctx, new NutritionReader(ctx, cat), member, input.date, resolved.map((r) => ({ nutrients: r.nutrients, state: "what_if" })));
    return {
      items: resolved.map((r) => describeItem(cat, { ...r.columns, eaten_on: input.date, state: "what_if", recipe_ref: r.display.ref, recipe_name: r.display.name }, r.nutrients, member.name)),
      day,
    };
  },
});

// ------------------------------------------------------------ household meal

const SHORT_TEXT = 200;
const NOTE_TEXT = 2_000;
const MAX_COOKS = 12;
const MAX_COMPONENTS = 12;
const MAX_LINES = 40;
const MAX_PORTIONS = 20;
const MAX_DIRECT_ITEMS = 20;

const boundedPortion = PORTION.superRefine((portion, issue) => {
  if (portion.member.length > SHORT_TEXT || (portion.component?.length ?? 0) > SHORT_TEXT || (portion.dominant_uncertainty?.description.length ?? 0) > NOTE_TEXT) {
    issue.addIssue({ code: "custom", message: "portion text is too long" });
  }
});

const COOK_LINE = z.object({
  ...AMOUNT,
  food: z.string().min(1).max(SHORT_TEXT),
  measure: z.string().max(SHORT_TEXT).optional(),
  provenance: z.enum(PROVENANCE),
  note: z.string().max(NOTE_TEXT).optional(),
}).strict();
type CookLineIn = z.infer<typeof COOK_LINE>;

const COMPONENT = z
  .object({
    name: z.string().min(1).max(SHORT_TEXT),
    cooked_weight_g: z.number().positive().optional(),
    cooked_weight_provenance: z.enum(PROVENANCE).optional(),
    lines: z.array(COOK_LINE).min(1).max(MAX_LINES),
  })
  .strict();

const COOK = z
  .object({
    name: z.string().min(1).max(SHORT_TEXT),
    recipe: z.string().max(SHORT_TEXT).optional().describe("Start from this recipe's lines when no lines are given."),
    cooked_on: date.optional().describe("Defaults to the meal's date."),
    note: z.string().max(NOTE_TEXT).optional(),
    lines: z.array(COOK_LINE).max(MAX_LINES).optional().describe("Lines of a single-component cook."),
    cooked_weight_g: z.number().positive().optional(),
    cooked_weight_provenance: z.enum(PROVENANCE).optional(),
    components: z.array(COMPONENT).max(MAX_COMPONENTS).optional().describe("Separately shared parts (salad, dressing)."),
    portions: z.array(boundedPortion).max(MAX_PORTIONS).optional().describe("Known shares for present members. Use [] when the dish or pot is prepared now but its shares are not known; the whole remains unaccounted and can be allocated later with mark_remainder. A member who was not there gets no entry."),
  })
  .strict();


interface PlannedComponent {
  id: number;
  name: string;
  cooked_weight_g: number | null;
  cooked_weight_provenance: string | null;
  lines: { resolved: ResolvedAmount; provenance: string; note: string | null }[];
}

async function lastSplit(ctx: Ctx, recipeId: number): Promise<{ member: string; component: string; fraction: number | null; weighed_g: number | null }[]> {
  const cook = await first<{ id: number }>(
    ctx.db,
    `SELECT k.id FROM cook k WHERE k.recipe_id = ? AND EXISTS (
       SELECT 1 FROM portion p JOIN component c ON c.id = p.component_id WHERE c.cook_id = k.id)
     ORDER BY k.cooked_on DESC, k.id DESC LIMIT 1`,
    recipeId,
  );
  if (!cook) return [];
  return all(
    ctx.db,
    `SELECT m.name AS member, c.name AS component, p.fraction, p.weighed_g FROM portion p
     JOIN component c ON c.id = p.component_id JOIN member m ON m.id = p.member_id
     WHERE c.cook_id = ? ORDER BY p.id`,
    cook.id,
  );
}

const boundedMemberItem = MEMBER_ITEM.superRefine((item, issue) => {
  const references = [item.member, item.source === "food" ? item.food : item.source === "recipe" ? item.recipe : undefined];
  const prose = [item.note, item.label, item.source === "manual" ? item.reason : undefined, item.dominant_uncertainty?.description];
  if (references.some((value) => value !== undefined && value.length > SHORT_TEXT) || prose.some((value) => value !== undefined && value.length > NOTE_TEXT)) {
    issue.addIssue({ code: "custom", message: "meal item text is too long" });
  }
});

export const MEAL_FIELDS = {
  date,
  meal_slot: mealSlot,
  note: z.string().max(NOTE_TEXT).optional(),
  cooks: z.array(COOK).max(MAX_COOKS),
  items: z.array(boundedMemberItem).max(MAX_DIRECT_ITEMS).optional().describe("Direct items, such as a shared bowl of curd, each with its member."),
};
export type MealInput = z.infer<z.ZodObject<typeof MEAL_FIELDS>>;

/**
 * household_meal's step 1, shared with preview_meal so the two can never
 * disagree (spec §4): resolve and check every cook, line, portion and
 * direct item, asking on any ambiguity, and compute each cook's split.
 * Writes nothing; the component and portion ids come from `ids` (the
 * write's WriteTx, or previewIds()).
 */
export async function planMeal(ctx: Ctx, cat: Catalogue, input: MealInput, ids: IdSource, prefetchedBook?: RecipeBook) {
  if (input.cooks.length === 0 && (input.items ?? []).length === 0) {
    throw new Clarify("empty_meal", "What was eaten? Give at least one cook or item.", [], ["cooks"]);
  }
  // Every recipe a cook or a direct item names, in one statement (none when nothing names one).
  const book = prefetchedBook ?? (input.cooks.some((c) => c.recipe !== undefined) || (input.items ?? []).some((i) => i.source === "recipe") ? await RecipeBook.load(ctx) : RecipeBook.empty());
  const plans = [];
  for (const [i, cook] of input.cooks.entries()) {
    const base = ["cooks", i];
    let recipeId: number | null = null;
    let recipeLines: CookLineIn[] | null = null;
    if (cook.recipe !== undefined) {
      const recipe = book.find(cook.recipe);
      if (!recipe) throw new Clarify("unknown_recipe", `There is no recipe ${cook.recipe}.`, [], [...base, "recipe"]);
      if (recipe.kind === "idea") throw new Clarify("recipe_is_idea", `${recipe.name} is a meal idea, never cooked as such. What was cooked?`, [], [...base, "recipe"]);
      recipeId = recipe.id;
      if (!cook.lines && !cook.components) {
        // A cook may start from its recipe; the copied quantities are inferred, not weighed.
        recipeLines = book.lines(recipe.id).map((l) => {
          const row = cat.row(l.food_source_id);
          const measure = l.measure_id === null ? undefined : cat.measures.find((m) => m.id === l.measure_id)?.name;
          return measure !== undefined
            ? { food: row.ref, value: l.amount_value, measure, provenance: "inferred" as const }
            : { food: row.ref, value: l.amount_value, unit: row.reference_unit, provenance: "inferred" as const };
        });
      }
    }
    if (cook.lines && cook.components) throw new ToolError("invalid", "give a cook's lines, or its components, not both");
    const specs = cook.components
      ? cook.components.map((c, j) => ({ ...c, path: [...base, "components", j, "lines"] }))
      : [{
          name: "whole",
          cooked_weight_g: cook.cooked_weight_g,
          cooked_weight_provenance: cook.cooked_weight_provenance,
          lines: cook.lines ?? recipeLines ?? [],
          path: [...base, "lines"],
        }];
    const components: PlannedComponent[] = [];
    for (const spec of specs) {
      if (spec.lines.length === 0) throw new Clarify("no_lines", `What went into ${cook.name}?`, [], spec.path);
      if ((spec.cooked_weight_g === undefined) !== (spec.cooked_weight_provenance === undefined)) {
        throw new Clarify("cooked_weight_provenance", `Was the ${spec.name} cooked weight weighed or estimated?`, [...PROVENANCE], spec.path.slice(0, -1));
      }
      components.push({
        id: await ids.allocate("component"),
        name: spec.name,
        cooked_weight_g: spec.cooked_weight_g ?? null,
        cooked_weight_provenance: spec.cooked_weight_provenance ?? null,
        lines: spec.lines.map((l, k) => ({ resolved: cat.resolve(l, [...spec.path, k]), provenance: l.provenance, note: l.note ?? null })),
      });
    }

    if (cook.portions === undefined) {
      const suggestion = recipeId === null ? [] : await lastSplit(ctx, recipeId);
      throw new Clarify(
        "split_needed",
        suggestion.length > 0
          ? `How was ${cook.name} shared? Last time it was ${suggestion.map((s) => `${s.member} ${s.fraction ?? `${s.weighed_g} g`}`).join(", ")}.`
          : `How was ${cook.name} shared between the members who were there?`,
        [],
        [...base, "portions"],
        { suggestion },
      );
    }
    const portions: { member: Member; component: PlannedComponent; p: z.infer<typeof PORTION>; id: number }[] = [];
    for (const [k, p] of cook.portions.entries()) {
      const path = [...base, "portions", k];
      const member = await ctx.member(p.member, [...path, "member"]);
      let component: PlannedComponent | undefined;
      if (p.component === undefined) {
        if (components.length > 1) throw new Clarify("component_needed", `Which part of ${cook.name} is ${member.name}'s portion of?`, components.map((c) => c.name), [...path, "component"]);
        component = components[0];
      } else {
        component = components.find((c) => c.name.toLowerCase() === p.component?.toLowerCase());
        if (!component) throw new Clarify("unknown_component", `${cook.name} has no part called ${p.component}.`, components.map((c) => c.name), [...path, "component"]);
      }
      if ((p.fraction === undefined) === (p.weighed_g === undefined)) {
        throw new Clarify("share_needed", `Give ${member.name}'s share as a fraction or a weighed amount.`, [], path);
      }
      if (portions.some((q) => q.member.id === member.id && q.component === component)) {
        throw new Clarify("duplicate_portion", `${member.name} already has a portion of ${component?.name}; a second helping is an amendment.`, [], path);
      }
      if (p.weighed_g !== undefined && !component?.cooked_weight_g) {
        noCookedWeight(cook.name, component?.name ?? "", components.length, p.weighed_g, [...path, "weighed_g"]);
      }
      portions.push({ member, component: component as PlannedComponent, p, id: await ids.allocate("portion") });
    }

    const result = computeCook(
      cat,
      components,
      components.flatMap((c) => c.lines.map((l) => ({ component_id: c.id, food_source_id: l.resolved.row.id, ...l.resolved.stored }))),
      portions.map((q) => ({ key: portionKey(q.id), component_id: q.component.id, fraction: q.p.fraction ?? null, weighed_g: q.p.weighed_g ?? null })),
    );
    // The domain names each share by its key; the question names its member (as planEatenPortion's does).
    cookProblemsToClarify(result.problems, [...base, "portions"], new Map(portions.map((q) => [portionKey(q.id), q.member.name])));
    plans.push({ cook, recipeId, components, portions, result });
  }

  const directs = [];
  for (const [i, item] of (input.items ?? []).entries()) {
    const member = await ctx.member(item.member, ["items", i, "member"]);
    directs.push({ member, r: await resolveItem(ctx, cat, item, ["items", i], book) });
  }
  return { plans, directs };
}

const householdMeal = writeTool({
  name: "household_meal",
  group: GROUP,
  description:
    "Record one meal occasion with named preparations made from ingredients as cooks, plus any direct items. Use a named cook for sandwiches, salads, smoothies, curries, omelettes, and other composed dishes even when only one person eats them; give that member a 100% portion. Use portions: [] when a dish or pot is prepared before its shares are known, then allocate the unaccounted remainder later with mark_remainder. Portions about members other than the speaker are drafts. Returns each portion's nutrients, the remainder, and each member's total.",
  input: MEAL_FIELDS,
  async run(ctx, input) {
    const tx = ctx.txOrThrow;
    const cat = await Catalogue.load(ctx);
    // Every table's next id in one statement (decision 97), so planning and writing allocate without reading.
    await tx.reserve(["household_meal", "cook", "component", "cook_line", "portion", "intake_item"]);
    // 1. Resolve and check everything before writing anything.
    const { plans, directs } = await planMeal(ctx, cat, input, tx);

    // 2. Write: the meal, each cook with its components, lines and portions, and an intake item per portion.
    // Rows are collected per table and inserted with createMany, so the write is a constant number of
    // statements however many cooks, lines, portions and items (decision 103); same rows, same versions.
    const mealStamp = ctx.stamp(ctx.stateFor(null));
    const mealId = await tx.allocate("household_meal");
    const rows = { cook: [] as Row[], component: [] as Row[], cook_line: [] as Row[], portion: [] as Row[], intake_item: [] as Row[] };
    const joins: { household_meal_id: number; cook_id: number }[] = [];
    const perMember = new Map<string, NutrientTotals[]>();
    const add = (name: string, n: NutrientTotals) => perMember.set(name, [...(perMember.get(name) ?? []), n]);
    const cooks = [];
    for (const plan of plans) {
      const cookStamp = ctx.stamp(ctx.stateFor(null));
      const cookId = await tx.allocate("cook");
      rows.cook.push({
        id: cookId, household_id: ctx.householdId, cooked_on: plan.cook.cooked_on ?? input.date, recipe_id: plan.recipeId, name: plan.cook.name,
        note: plan.cook.note ?? null, ...cookStamp,
      });
      joins.push({ household_meal_id: mealId, cook_id: cookId });
      const lines = [];
      for (const [j, c] of plan.components.entries()) {
        rows.component.push({ id: c.id, cook_id: cookId, position: j + 1, name: c.name, cooked_weight_g: c.cooked_weight_g, cooked_weight_provenance: c.cooked_weight_provenance });
        for (const [k, l] of c.lines.entries()) {
          const id = await tx.allocate("cook_line");
          rows.cook_line.push({
            id, component_id: c.id, position: k + 1, food_source_id: l.resolved.row.id, ...l.resolved.stored, provenance: l.provenance, note: l.note,
          });
          lines.push({ id, component: c.name, ref: l.resolved.row.ref, name: l.resolved.row.name, state: l.resolved.row.state, ...l.resolved.stored, provenance: l.provenance, nutrients: l.resolved.nutrients });
        }
      }
      const portions = [];
      for (const q of plan.portions) {
        const stamp = ctx.stamp(ctx.stateFor(q.member.id));
        const data = {
          id: q.id, component_id: q.component.id, member_id: q.member.id, kind: q.p.fraction !== undefined ? "fraction" : "weighed",
          fraction: q.p.fraction ?? null, weighed_g: q.p.weighed_g ?? null, provenance: q.p.provenance,
          dominant_uncertainty: q.p.dominant_uncertainty?.description ?? null, dominant_uncertainty_kcal: q.p.dominant_uncertainty?.kcal ?? null, ...stamp,
        };
        rows.portion.push(data);
        const itemId = await tx.allocate("intake_item");
        rows.intake_item.push({
          id: itemId, member_id: q.member.id, eaten_on: input.date, meal_slot: input.meal_slot, household_meal_id: mealId, source_kind: "portion",
          portion_id: q.id, confidence: q.p.confidence ?? "medium", ...stamp,
        });
        const computed = plan.result.portions.find((x) => x.member === portionKey(q.id));
        if (computed?.nutrients) add(q.member.name, computed.nutrients);
        portions.push({
          id: q.id, member: q.member.name, component: q.component.name, kind: data.kind, fraction: computed?.fraction ?? null,
          weighed_g: data.weighed_g, provenance: q.p.provenance, dominant_uncertainty: q.p.dominant_uncertainty ?? null,
          state: stamp.state, nutrients: computed?.nutrients ?? null, intake_item_id: itemId,
        });
      }
      cooks.push({
        id: cookId, name: plan.cook.name, state: cookStamp.state, recipe_id: plan.recipeId,
        components: plan.components.map((c) => ({
          id: c.id, name: c.name, cooked_weight_g: c.cooked_weight_g,
          nutrients: plan.result.components.find((x) => x.name === c.name)?.totals ?? null,
        })),
        lines, totals: plan.result.totals, portions, remainder: plan.result.remainder,
      });
    }
    const items = [];
    for (const d of directs) {
      const stamp = ctx.stamp(ctx.stateFor(d.member.id));
      const id = await tx.allocate("intake_item");
      const row = { id, member_id: d.member.id, eaten_on: input.date, meal_slot: input.meal_slot, household_meal_id: mealId, ...d.r.columns, ...stamp };
      rows.intake_item.push(row);
      add(d.member.name, d.r.nutrients);
      items.push(describeItem(cat, { ...row, recipe_ref: d.r.display.ref, recipe_name: d.r.display.name }, d.r.nutrients, d.member.name));
    }
    // Parents before children, for the foreign keys.
    await tx.createMany("household_meal", [{ id: mealId, household_id: ctx.householdId, eaten_on: input.date, meal_slot: input.meal_slot, note: input.note ?? null, ...mealStamp }]);
    await tx.createMany("cook", rows.cook);
    if (joins.length > 0) {
      tx.exec(
        "INSERT INTO household_meal_cook (household_meal_id, cook_id) SELECT json_extract(value, '$.household_meal_id'), json_extract(value, '$.cook_id') FROM json_each(?)",
        JSON.stringify(joins),
      );
    }
    await tx.createMany("component", rows.component);
    await tx.createMany("cook_line", rows.cook_line);
    await tx.createMany("portion", rows.portion);
    await tx.createMany("intake_item", rows.intake_item);
    return {
      household_meal: { id: mealId, date: input.date, meal_slot: input.meal_slot, state: mealStamp.state },
      cooks,
      items,
      members: Object.fromEntries([...perMember].map(([name, parts]) => [name, sumNutrients(parts)])),
    };
  },
});

/** Canonical read-only rendering shared by preview_meal and multi-day plan previews. */
export async function previewMealInput(ctx: Ctx, cat: Catalogue, input: MealInput, prefetchedBook?: RecipeBook) {
  const { plans, directs } = await planMeal(ctx, cat, input, previewIds(), prefetchedBook);
  const perMember = new Map<string, NutrientTotals[]>();
  const add = (name: string, n: NutrientTotals) => perMember.set(name, [...(perMember.get(name) ?? []), n]);
  const cooks = plans.map((plan) => ({
    name: plan.cook.name,
    recipe_id: plan.recipeId,
    components: plan.components.map((c) => ({ name: c.name, cooked_weight_g: c.cooked_weight_g, nutrients: plan.result.components.find((x) => x.name === c.name)?.totals ?? null })),
    lines: plan.components.flatMap((c) =>
      c.lines.map((l) => ({ component: c.name, ref: l.resolved.row.ref, name: l.resolved.row.name, state: l.resolved.row.state, ...l.resolved.stored, provenance: l.provenance, nutrients: l.resolved.nutrients })),
    ),
    totals: plan.result.totals,
    portions: plan.portions.map((q) => {
      const computed = plan.result.portions.find((x) => x.member === portionKey(q.id));
      if (computed?.nutrients) add(q.member.name, computed.nutrients);
      return {
        member: q.member.name, component: q.component.name, kind: q.p.fraction !== undefined ? "fraction" : "weighed",
        fraction: computed?.fraction ?? null, weighed_g: q.p.weighed_g ?? null, nutrients: computed?.nutrients ?? null,
      };
    }),
    remainder: plan.result.remainder,
  }));
  const items = directs.map((d) => {
    add(d.member.name, d.r.nutrients);
    return describeItem(cat, { ...d.r.columns, eaten_on: input.date, meal_slot: input.meal_slot, state: "preview", recipe_ref: d.r.display.ref, recipe_name: d.r.display.name }, d.r.nutrients, d.member.name);
  });
  return { cooks, items, members: Object.fromEntries([...perMember].map(([name, parts]) => [name, sumNutrients(parts)])) };
}

const previewMeal = readTool({
  name: "preview_meal",
  group: GROUP,
  description:
    "Preview what household_meal would compute without writing: named cooks and their ingredient lines, totals, known portions, remainders, direct items, and each member's total. A one-person composed dish is still a named cook with a 100% portion; portions: [] previews a dish or pot whose shares will be allocated later. Same input and clarification rules as household_meal.",
  input: MEAL_FIELDS,
  async run(ctx, input) {
    const cat = await Catalogue.load(ctx);
    return previewMealInput(ctx, cat, input);
  },
});

const markRemainder = writeTool({
  name: "mark_remainder",
  group: GROUP,
  description:
    "Allocate shares after a dish or pot was logged with portions: [], or say what happened to any other remainder. In a later conversation, call day_cooks for the cooked date to recover the component_id. An unaccounted remainder can become a partial or complete portion eaten by a member on the cooked meal's day, or be marked leftover or discarded. A leftover can be eaten by any member at a later meal (meal_slot required) or discarded whole.",
  input: {
    component_id: z.number().int().positive(),
    disposition: z.enum(["leftover", "discarded", "eaten"]),
    member: z.string().optional().describe("Who ate it, for eaten."),
    fraction: z.number().gt(0).max(1).optional().describe("Default: all that is unaccounted (or left over)."),
    weighed_g: z.number().positive().optional(),
    provenance: z.enum(PROVENANCE),
    date: date.optional().describe("For eaten: when; defaults to the meal's date (a leftover: today). For the others: when recorded; defaults to today."),
    meal_slot: mealSlot.optional().describe("For eaten; defaults to the meal's slot (a leftover: required)."),
    note: z.string().optional(),
  },
  async run(ctx, input) {
    const tx = ctx.txOrThrow;
    const component = await first<{ id: number; cook_id: number; name: string }>(ctx.db, "SELECT id, cook_id, name FROM component WHERE id = ?", input.component_id);
    if (!component) throw new ToolError("not_found", `no component ${input.component_id}`, 404);
    const cat = await Catalogue.load(ctx);
    const loaded = await loadCook(ctx, cat, component.cook_id);
    const left = loaded.result.remainder.find((r) => r.component === component.name && (r.status === "unaccounted" || r.status === "leftover"));
    if (!left) throw new Clarify("nothing_unaccounted", `Nothing of ${component.name} is unaccounted or left over.`, [], ["component_id"]);
    const fromLeftover = left.status === "leftover";
    if (fromLeftover && input.disposition === "leftover") {
      throw new Clarify("already_leftover", `The rest of ${component.name} is already marked leftover.`, [], ["disposition"]);
    }

    const shares = cookShares(loaded);
    if (fromLeftover) {
      const today = input.date ?? ctx.today();
      // Every leftover mark of the component (the computed remainder said it is leftover; settled_on is only the read's bound).
      const open = await all<Row & { id: number; note: string | null }>(
        ctx.db,
        "SELECT * FROM remainder_disposition WHERE component_id = ? AND disposition = 'leftover' ORDER BY id",
        component.id,
      );
      if (input.disposition === "discarded") {
        if (input.fraction !== undefined || input.weighed_g !== undefined) {
          throw new Clarify("discard_all", "A leftover is discarded whole; mark any part that was eaten first.", [], ["fraction"]);
        }
        for (const r of open) {
          // recorded_on stays: it is when the leftover went into the fridge, which a past day's Household still shows.
          const changes = { disposition: "discarded", settled_on: today, provenance: input.provenance, note: input.note ?? r.note };
          tx.update("remainder_disposition", r.id, changes, { ...r, ...changes });
        }
        const discarded = loaded.marks.map((m) => (m.component_id === component.id ? { ...m, disposition: "discarded" as const } : m));
        return { cook_id: component.cook_id, remainder: computeCook(cat, loaded.components, loaded.lines, shares, discarded).remainder, portion: null, serving: null };
      }
      // eaten: a leftover serving, by any member (a portion of the pot doesn't stop a later helping), dated the day it was eaten.
      if (input.member === undefined) throw new Clarify("member_needed", `Who ate the ${component.name} leftover?`, (await ctx.members()).map((m) => m.name), ["member"]);
      if (input.meal_slot === undefined) throw new Clarify("meal_slot_needed", "Which meal was the leftover eaten at?", [...MEAL_SLOTS], ["meal_slot"]);
      const member = await ctx.member(input.member);
      ctx.onBehalfOf(member.id);
      if (input.weighed_g !== undefined && !loaded.components.find((c) => c.id === component.id)?.cooked_weight_g) {
        noCookedWeight(loaded.cook.name, component.name, loaded.components.length, input.weighed_g, ["weighed_g"]);
      }
      const fraction = input.weighed_g === undefined ? (input.fraction ?? left.fraction) : null;
      const stamp = ctx.stamp(ctx.stateFor(member.id));
      const servingId = await tx.allocate("leftover_serving");
      const serving = {
        id: servingId, component_id: component.id, member_id: member.id, kind: fraction === null ? "weighed" : "fraction", fraction,
        weighed_g: input.weighed_g ?? null, eaten_on: today, provenance: input.provenance, ...stamp,
      };
      const after = computeCook(cat, loaded.components, loaded.lines, [...shares, { key: servingKey(servingId), component_id: component.id, fraction, weighed_g: serving.weighed_g }], loaded.marks);
      const who = await shareNames(ctx, loaded);
      who.set(servingKey(servingId), member.name);
      cookProblemsToClarify(after.problems, ["fraction"], who);
      const nutrients = after.portions.find((p) => p.member === servingKey(servingId))?.nutrients ?? {};
      tx.raw("leftover_serving", serving);
      tx.version("leftover_serving", servingId, "create", serving);
      const v = (key: string) => nutrients[key]?.value ?? 0;
      const itemId = await tx.create("intake_item", {
        member_id: member.id, eaten_on: today, meal_slot: input.meal_slot, household_meal_id: null, source_kind: "manual",
        // Required by the item's checks; readers compute a serving's item from its cook, never from these.
        manual_kcal: v("kcal"), manual_protein_g: v("protein"), manual_carbs_g: v("carbs"), manual_fat_g: v("fat"),
        manual_reason: `Leftover serving of ${loaded.cook.name}`, label: `${loaded.cook.name}, leftover`,
        provenance: input.provenance, confidence: "medium", leftover_serving_id: servingId, ...stamp,
      });
      // Eaten up: settle the leftover so the household's open-leftover read skips it.
      if (!after.remainder.some((r) => r.component === component.name)) {
        for (const r of open) tx.update("remainder_disposition", r.id, { settled_on: today }, { ...r, settled_on: today });
      }
      return {
        cook_id: component.cook_id, remainder: after.remainder, portion: null,
        serving: { id: servingId, member: member.name, component: component.name, fraction, weighed_g: serving.weighed_g, eaten_on: today, state: stamp.state, intake_item_id: itemId, nutrients },
      };
    }

    const marks: { component_id: number; disposition: "leftover" | "discarded" | "eaten" }[] = [...loaded.marks];
    if (input.disposition === "eaten") {
      if (input.member === undefined) throw new Clarify("member_needed", `Who ate the rest of ${component.name}?`, (await ctx.members()).map((m) => m.name), ["member"]);
      const member = await ctx.member(input.member);
      const meal = await first<{ id: number; eaten_on: string; meal_slot: string }>(
        ctx.db,
        "SELECT m.id, m.eaten_on, m.meal_slot FROM household_meal_cook hc JOIN household_meal m ON m.id = hc.household_meal_id WHERE hc.cook_id = ? ORDER BY m.eaten_on DESC LIMIT 1",
        component.cook_id,
      );
      const slot = input.meal_slot ?? meal?.meal_slot;
      if (!slot) throw new Clarify("meal_slot_needed", "Which meal was it eaten at?", [...MEAL_SLOTS], ["meal_slot"]);
      const fraction = input.weighed_g === undefined ? (input.fraction ?? left.fraction) : null;
      ctx.onBehalfOf(member.id);
      await tx.reserve(["portion", "intake_item"]);
      const planned = await planEatenPortion(
        ctx, cat, loaded, component, member, { fraction, weighed_g: input.weighed_g ?? null },
        { eaten_on: input.date ?? meal?.eaten_on ?? ctx.today(), meal_slot: slot, household_meal_id: meal?.id ?? null },
        input.provenance, [], tx,
      );
      await tx.createMany("portion", [planned.portion]);
      const [itemId] = await tx.createMany("intake_item", [planned.item]);
      return {
        cook_id: component.cook_id,
        remainder: planned.remainder,
        portion: { id: planned.portion.id, member: member.name, component: component.name, fraction, weighed_g: input.weighed_g ?? null, state: planned.portion.state, intake_item_id: itemId, nutrients: planned.nutrients },
        serving: null,
      };
    }
    const kind = input.fraction !== undefined ? "fraction" : input.weighed_g !== undefined ? "weighed" : "rest";
    await tx.create("remainder_disposition", {
      component_id: component.id, disposition: input.disposition, amount_kind: kind, fraction: input.fraction ?? null,
      weighed_g: input.weighed_g ?? null, recorded_on: input.date ?? ctx.today(), provenance: input.provenance, note: input.note ?? null,
    });
    marks.push({ component_id: component.id, disposition: input.disposition });
    const result = computeCook(cat, loaded.components, loaded.lines, shares, marks);
    cookProblemsToClarify(result.problems, ["fraction"], await shareNames(ctx, loaded));
    return { cook_id: component.cook_id, remainder: result.remainder, portion: null, serving: null };
  },
});

/**
 * A cook's component, for a tool that changes its lines after the cook was written.
 * Its cook comes back too: every recompute is of the whole cook, never one component.
 */
async function componentById(ctx: Ctx, componentId: number): Promise<{ id: number; cook_id: number; name: string }> {
  const component = await first<{ id: number; cook_id: number; name: string }>(ctx.db, "SELECT id, cook_id, name FROM component WHERE id = ?", componentId);
  if (!component) throw new ToolError("not_found", `no component ${componentId}`, 404);
  return component;
}

/** The reason is the record of why a written cook changed, so it is required, as it is on a recipe's lines. */
function reasonNeeded(reason: string | undefined, question: string): void {
  if (!reason) throw new Clarify("reason_needed", question, [], ["reason"]);
}

/**
 * Recompute a cook from a changed set of lines and report it, clearing any leftover the
 * change brings back. Adding food to a pot can re-open a leftover a weighed serving had
 * eaten up, exactly as amending a line's amount can.
 */
async function recomputeCook(
  ctx: Ctx,
  cat: Catalogue,
  loaded: Awaited<ReturnType<typeof loadCook>>,
  lines: typeof loaded.lines,
  at: (string | number)[],
) {
  const result = computeCook(cat, loaded.components, lines, cookShares(loaded), loaded.marks);
  // computeCook keys a share by its row, not by a person. Name them, or the caller reads an id as a member.
  const nameOf = await shareNames(ctx, loaded);
  cookProblemsToClarify(result.problems, at, nameOf);
  const back = loaded.components.filter((c) => result.remainder.some((r) => r.component === c.name && r.status === "leftover")).map((c) => c.id);
  if (back.length > 0) reopenLeftovers(ctx, back);
  return { ...result, portions: result.portions.map((p) => ({ ...p, member: nameOf.get(p.member) ?? p.member })) };
}

const addCookLine = writeTool({
  name: "add_cook_line",
  group: GROUP,
  description:
    "Add one ingredient to a component of a cook that is already written - the oil, the ghee, the cheese that gets reported after the meal went in (resolved like any amount; ambiguity asks), at the end or at a position (later lines move down), with the reason (required; it goes to the write log). Every portion, every leftover serving and the remainder recompute from it, so the ingredient reaches the leftovers too. Confirmed on write.",
  input: {
    component_id: z.number().int().positive(),
    line: COOK_LINE,
    position: z.number().int().min(1).optional().describe("Default: after the last line."),
  },
  async run(ctx, input) {
    reasonNeeded(input.reason, "Why does the cook gain this line (for example, it went in the pan and was not reported)?");
    const tx = ctx.txOrThrow;
    const component = await componentById(ctx, input.component_id);
    const cat = await Catalogue.load(ctx);
    const loaded = await loadCook(ctx, cat, component.cook_id);
    const r = cat.resolve(input.line, ["line"]);
    const mine = loaded.lines.filter((l) => l.component_id === component.id);
    const end = Math.max(0, ...mine.map((l) => l.position));
    const position = Math.min(input.position ?? end + 1, end + 1);
    // Highest first, so positions stay unique while they move.
    for (const l of [...mine].filter((x) => x.position >= position).sort((a, b) => b.position - a.position)) {
      tx.update("cook_line", l.id, { position: l.position + 1 }, { ...l, position: l.position + 1 });
      l.position += 1;
    }
    const data = { component_id: component.id, position, food_source_id: r.row.id, ...r.stored, provenance: input.line.provenance, note: input.line.note ?? null };
    const id = await tx.create("cook_line", data);
    const lines = [...loaded.lines, { id, ...data } as (typeof loaded.lines)[number]];
    const result = await recomputeCook(ctx, cat, loaded, lines, ["line"]);
    return {
      state: "confirmed",
      cook_id: component.cook_id,
      line: { id, component: component.name, position, ref: r.row.ref, name: r.row.name, ...r.stored, nutrients: r.nutrients },
      totals: result.totals,
      portions: result.portions,
      remainder: result.remainder,
    };
  },
});

const removeCookLine = writeTool({
  name: "remove_cook_line",
  group: GROUP,
  description:
    "Remove one ingredient line from a component of a written cook, with the reason (required; it goes to the write log and the line's history). A component keeps at least one line. Every portion, every leftover serving and the remainder recompute. Confirmed on write.",
  input: { component_id: z.number().int().positive(), line_id: z.number().int().positive() },
  async run(ctx, input) {
    reasonNeeded(input.reason, "Why is the line coming out of the cook (for example, it never went in)?");
    const component = await componentById(ctx, input.component_id);
    const cat = await Catalogue.load(ctx);
    const loaded = await loadCook(ctx, cat, component.cook_id);
    const line = loaded.lines.find((l) => l.id === input.line_id && l.component_id === component.id);
    if (!line) throw new ToolError("not_found", `${component.name} has no line ${input.line_id}`, 404);
    if (loaded.lines.filter((l) => l.component_id === component.id).length === 1) {
      throw new Clarify("no_lines", `That is ${component.name}'s only line. What went into it instead?`, [], ["line_id"]);
    }
    ctx.txOrThrow.remove("cook_line", line.id, line as unknown as Row, "delete");
    const lines = loaded.lines.filter((l) => l.id !== line.id);
    const result = await recomputeCook(ctx, cat, loaded, lines, ["line_id"]);
    return {
      state: "confirmed",
      cook_id: component.cook_id,
      removed: { id: line.id, component: component.name, position: line.position },
      totals: result.totals,
      portions: result.portions,
      remainder: result.remainder,
    };
  },
});

/** The intake item's source and nutrient columns: replaced together, so no stale value survives. */
const SOURCE_COLUMNS = [
  "source_kind",
  "food_source_id",
  "amount_value",
  "amount_unit",
  "measure_id",
  "recipe_id",
  "recipe_servings",
  "manual_kcal",
  "manual_protein_g",
  "manual_carbs_g",
  "manual_fat_g",
  "manual_reason",
  "provenance",
  "confidence",
  "dominant_uncertainty",
  "dominant_uncertainty_kcal",
  "label",
  "note",
] as const;

const correctIntake = writeTool({
  name: "correct_intake",
  group: GROUP,
  description:
    "Replace what a logged intake item was, atomically: give the item's id and the corrected item exactly as log_intake takes one (a food by amount, a recipe by servings, or manual macros with a reason). The server resolves the replacement against the catalogue and recomputes every nutrient, replacing the source columns in one versioned write, so no old macro or old food reference survives. Use when the wrong food, amount or unit was logged; for a share of a cooked meal correct the portion instead. Returns the corrected item, the old source and nutrients, and the day as it now stands.",
  input: {
    item_id: z.number().int().positive(),
    replacement: ITEM,
    date: date.optional().describe("Move the corrected item to another day, when the date was wrong too."),
    meal_slot: mealSlot.optional().describe("Move the corrected item to another meal slot."),
    expected_version: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("The item's current record version (1 after logging). A different one is refused, so a stale correction never overwrites a newer one."),
  },
  async run(ctx, input) {
    if (input.reason === undefined || input.reason.trim() === "") {
      throw new Clarify("reason_needed", "Why is this item being corrected? The old source and nutrients stay in the record's history.", [], ["reason"]);
    }
    const item = await first<IntakeRow>(ctx.db, "SELECT * FROM intake_item WHERE id = ?", input.item_id);
    if (!item) throw new ToolError("not_found", `no intake_item ${input.item_id}`, 404);
    const member = await ctx.memberById(item.member_id);
    ctx.onBehalfOf(member.id);
    if (item.portion_id !== null) {
      throw new ToolError("correct_the_portion", `intake_item ${item.id} is a share of a cooked meal; correct portion ${String(item.portion_id)} instead.`, 400, {
        portion_id: item.portion_id,
      });
    }
    if (item.leftover_serving_id != null) {
      throw new ToolError(
        "correct_the_serving",
        `intake_item ${item.id} is a leftover serving; correct leftover_serving ${String(item.leftover_serving_id)} instead.`,
        400,
        { leftover_serving_id: item.leftover_serving_id },
      );
    }
    if (input.expected_version !== undefined) {
      const current = await first<{ version: number }>(
        ctx.db,
        "SELECT coalesce(max(version), 0) AS version FROM record_version WHERE table_name = 'intake_item' AND record_id = ?",
        item.id,
      );
      const version = current?.version ?? 0;
      if (version !== input.expected_version) {
        throw new ToolError("intake_version_conflict", `intake_item ${item.id} is at version ${version}, not ${input.expected_version}. Read it again before correcting it.`, 409, {
          current_version: version,
        });
      }
    }
    const cat = await Catalogue.load(ctx);
    const book = await RecipeBook.forItems(ctx, [input.replacement]);
    const resolved = await resolveItem(ctx, cat, input.replacement, ["replacement"], book);
    const stamp = ctx.stamp(ctx.stateFor(member.id));
    const patch: Row = {};
    for (const column of SOURCE_COLUMNS) patch[column] = resolved.columns[column] ?? null;
    if (input.date !== undefined) patch.eaten_on = input.date;
    if (input.meal_slot !== undefined) patch.meal_slot = input.meal_slot;
    patch.state = stamp.state;
    patch.confirmed_at = stamp.confirmed_at;
    const after = { ...item, ...patch };
    ctx.txOrThrow.update("intake_item", item.id, patch, after, "amend");
    const reader = new NutritionReader(ctx, cat);
    const beforeNutrients = await reader.itemNutrients(item);
    const day = await dayView(ctx, reader, member, after.eaten_on as string, [{ nutrients: resolved.nutrients, state: stamp.state }], new Set([item.id]));
    return {
      item: describeItem(
        cat,
        { ...after, recipe_ref: resolved.display.ref, recipe_name: resolved.display.name } as IntakeRow & Row,
        resolved.nutrients,
        member.name,
      ),
      previous: { source_kind: item.source_kind, nutrients: beforeNutrients },
      changed_fields: Object.keys(patch),
      day,
    };
  },
});

export const NUTRITION_TOOLS: Tool[] = [householdMeal, previewMeal, logIntake, correctIntake, dayTotalsTool, dayItems, setDayStatus, whatIf, markRemainder, addCookLine, removeCookLine];
