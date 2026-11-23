/**
 * Read-only tools for the app's screens. Each one shapes data the Today
 * screen needs and no other tool returns: who is signed in, the day's
 * meals with per-slot totals and the day's estimate, and the day's cooks
 * with every portion and the remainder. They write nothing; every number
 * is computed here (or in the domain), never in the app.
 */
import {
  addDays,
  energyAvailability,
  LOW_EA_KCAL_PER_KG_FFM,
  sumNutrients,
  weekStart,
  type NutrientTotals,
} from "@myfitnessguide/domain";
import { z } from "zod";
import { Catalogue } from "../catalogue";
import type { Ctx, Member } from "../context";
import { all, allIn, first } from "../db";
import { draftsAbout, householdDrafts, visibleDrafts, type DraftInfo } from "../drafts";
import { Clarify, ToolError } from "../errors";
import {
  computeCook,
  cookShares,
  dayViews,
  knownValue,
  nutritionDay,
  nutritionWeek,
  NutritionReader,
  partlyKnown,
  servingKey,
  unknownItems,
  viewOf,
  type IntakeRow,
  type ItemWithNutrients,
  type LoadedCook,
  type NutritionDay,
  type NutritionWeek,
} from "../nutrition";
import { readTool, type Tool } from "../tool";
import {
  derive,
  foldLifts,
  liftGroups,
  loadImplements,
  memberExerciseSets,
  noE1rmReason,
  weeklyVolume,
  type ExerciseRow,
  type PrescriptionState,
  type SessionRow,
  type SetRow,
} from "../training";
import { canonical } from "./health";
import { describeSet } from "../sets";
import { dueLines, loadRule, remainderCookIds, remaindersOf, waitingFor, yesterdayOpen, type DueLine } from "../waiting";

const GROUP = "screens";
/** The importer's reason for macros typed into Sheets with no catalogue ref (app/importer/src/load/nutrition.ts). */
const TYPED_MACROS_REASON = "Typed macros in Sheets";
/** A day whose known energy is at least this share typed macros says so (spec §8). */
const TYPED_MACROS_HIGH_SHARE = 0.5;

/** Whether a record's first version was written by the import. */
const IMPORTED = (table: string, alias: string) =>
  `(SELECT w.origin FROM record_version v JOIN write_log w ON w.id = v.write_id WHERE v.table_name = '${table}' AND v.record_id = ${alias}.id ORDER BY v.version LIMIT 1) = 'import'`;
const date = z.iso.date();

const whoami = readTool({
  name: "whoami",
  group: GROUP,
  description:
    "Who is calling: the signed-in member (null for the agent), the household's members with that member first, today's date and the time (HH:MM) in the household's time zone, and that time zone.",
  input: {},
  async run(ctx) {
    const members = (await ctx.members()).filter((m) => m.active === 1);
    const me = ctx.caller.kind === "member" ? ctx.caller.memberId : null;
    const ordered = [...members.filter((m) => m.id === me), ...members.filter((m) => m.id !== me)];
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: ctx.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ctx.clock());
    return { member: ctx.caller.kind === "member" ? ctx.caller.name : null, members: ordered.map((m) => m.name), today: ctx.today(), time, time_zone: ctx.timeZone };
  },
});

// ------------------------------------------------------------- day_meals

/** Meals in the order of a day. Workout meals lead because the household trains in the morning. */
const SLOT_ORDER = ["pre_workout", "post_workout", "breakfast", "lunch", "snack", "dinner"] as const;
/** Meals shown even when empty; the workout meals appear only when used. */
const CORE_SLOTS = new Set<string>(["breakfast", "lunch", "snack", "dinner"]);

/**
 * An agent's write names `speaker`, the member the agent was talking with
 * (null for an Inbox write without one, or a write made before the speaker
 * was stored), so the app says "logged by Asha" rather than "the agent".
 */
export type LoggedBy =
  | { kind: "member"; name: string }
  | { kind: "agent"; origin: string; speaker: string | null }
  | { kind: "system" }
  | null;

/** Who made the write that created a record: a member through the app, the agent (live chat or the Inbox) and whom it was talking with, or the system. */
export async function loggedBy(ctx: Ctx, table: string, id: number): Promise<LoggedBy> {
  return (await loggedByMany(ctx, table, [id])).get(id) ?? null;
}

/** `loggedBy` for many records of one table, in one statement per 100 records (decision 96). */
export async function loggedByMany(ctx: Ctx, table: string, ids: readonly number[]): Promise<Map<number, LoggedBy>> {
  return new Map([...(await authorshipMany(ctx, table, ids))].map(([id, a]) => [id, a.loggedBy]));
}

/** Who logged a record, and for one its member had confirmed and someone then edited (a re-draft, ticket 69), who edited it last. */
export interface Authorship {
  loggedBy: LoggedBy;
  everConfirmed: boolean;
  /** The latest version's writer, only when the record was ever confirmed; null otherwise. */
  editedBy: LoggedBy;
}

/** `loggedByMany` with each record's re-draft facts, from the same versions read: one statement per 100 records. */
export async function authorshipMany(ctx: Ctx, table: string, ids: readonly number[]): Promise<Map<number, Authorship>> {
  const rows = await allIn<{ record_id: number; resolver: string; origin: string; actor: string | null; speaker: string | null; st: string | null }>(
    ctx.db,
    (ph) =>
      `SELECT v.record_id, w.resolver, w.origin, m.name AS actor, s.name AS speaker, json_extract(v.data, '$.state') AS st FROM record_version v JOIN write_log w ON w.id = v.write_id
       LEFT JOIN member m ON m.id = w.actor_member_id
       LEFT JOIN member s ON s.id = w.speaker_member_id
       WHERE v.table_name = ? AND v.record_id IN (${ph}) ORDER BY v.record_id, v.version ASC`,
    ids,
    table,
  );
  const who = (w: (typeof rows)[number]): LoggedBy =>
    w.resolver === "member" && w.actor ? { kind: "member", name: w.actor } : w.resolver === "system" ? { kind: "system" } : { kind: "agent", origin: w.origin, speaker: w.speaker };
  const out = new Map<number, Authorship>();
  for (const w of rows) {
    // The first version is the write that created the record; the last one read is its latest edit.
    const seen = out.get(w.record_id);
    if (!seen) out.set(w.record_id, { loggedBy: who(w), everConfirmed: w.st === "confirmed", editedBy: null });
    else {
      seen.everConfirmed ||= w.st === "confirmed";
      seen.editedBy = who(w);
    }
  }
  for (const a of out.values()) if (!a.everConfirmed) a.editedBy = null;
  return out;
}

/** A meal's unknown items: kcal, protein, and `any` macro (each item once), for "N items unknown" (ticket 72). */
function slotUnknown(parts: readonly { nutrients: NutrientTotals }[]): Record<"kcal" | "protein" | "any", number> {
  const u = unknownItems(parts, ["kcal", "protein", "carbs", "fat"]);
  return { kcal: u.kcal, protein: u.protein, any: u.any };
}

/** A sum's value, null when nobody knows any part of it (review P2-2): never "P 0 g" for a protein never recorded. */
const valueOf = knownValue;

interface PortionInfo {
  cook: string;
  component: string;
  components: number;
  fraction: number | null;
  weighed_g: number | null;
  provenance: string;
  dominant_uncertainty: string | null;
  dominant_uncertainty_kcal: number | null;
}

/** Portions' cook, component and share, in one statement per 100 portions. */
async function portionInfos(ctx: Ctx, portionIds: readonly number[]): Promise<Map<number, PortionInfo>> {
  const rows = await allIn<PortionInfo & { portion_id: number }>(
    ctx.db,
    (ph) =>
      `SELECT p.id AS portion_id, k.name AS cook, c.name AS component, (SELECT count(*) FROM component c2 WHERE c2.cook_id = k.id) AS components,
              p.fraction, p.weighed_g, p.provenance, p.dominant_uncertainty, p.dominant_uncertainty_kcal
       FROM portion p JOIN component c ON c.id = p.component_id JOIN cook k ON k.id = c.cook_id WHERE p.id IN (${ph})`,
    portionIds,
  );
  return new Map(rows.map(({ portion_id, ...info }) => [portion_id, info]));
}

const dayMeals = readTool({
  name: "day_meals",
  group: GROUP,
  description:
    "A member's day as meals, in order: each meal is eaten (with its items and its kcal and protein, and unknown_items: how many items those sums leave out because nobody knows their value), skipped, nothing yet (an open day), or not recorded (a partial or complete day with nothing logged there). Each item carries its provenance, its dominant uncertainty in ± kcal, its state, its portion (a pot share) or leftover serving (a leftover helping), and for a draft who logged it. `estimate` sums the items' ± kcal and names the largest. honesty says whether the import wrote the day's items and how much of its energy was typed macros from Sheets (high from half).",
  input: { member: z.string().min(1), date },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    const cat = await Catalogue.load(ctx);
    const reader = new NutritionReader(ctx, cat);
    const rows = await reader.items(member.id, input.date);
    const status = (await first<{ status: string }>(ctx.db, "SELECT status FROM day_status WHERE member_id = ? AND day = ?", member.id, input.date))?.status ?? "open";
    const skipped = new Set(
      (await all<{ meal_slot: string }>(ctx.db, "SELECT meal_slot FROM skipped_meal WHERE member_id = ? AND day = ?", member.id, input.date)).map((s) => s.meal_slot),
    );
    const recipes = new Map(
      (await all<{ id: number; name: string }>(ctx.db, "SELECT id, name FROM recipe WHERE household_id = ?", ctx.householdId)).map((r) => [r.id, r.name]),
    );

    // Portions and who logged each draft, for every item at once (decision 96).
    const portions = await portionInfos(ctx, rows.filter((r) => r.row.source_kind === "portion").map((r) => r.row.portion_id as number));
    const loggers = await authorshipMany(ctx, "intake_item", rows.filter((r) => r.row.state === "draft").map((r) => r.row.id));
    const items = rows.map(({ row, nutrients }) => describe(cat, recipes, portions, loggers, row, nutrients));

    const slots = [];
    for (const slot of SLOT_ORDER) {
      const mine = items.filter((i) => i.meal_slot === slot);
      const isSkipped = skipped.has(slot);
      if (mine.length === 0 && !isSkipped && !CORE_SLOTS.has(slot)) continue;
      const parts = rows.filter((r) => r.row.meal_slot === slot);
      const totals = mine.length === 0 ? null : sumNutrients(parts.map((r) => r.nutrients));
      slots.push({
        slot,
        state: mine.length > 0 ? "eaten" : isSkipped ? "skipped" : status === "open" ? "nothing_yet" : "not_recorded",
        // The sum is of what is known; unknown_items says how many items it leaves out (ticket 72).
        totals: totals ? { kcal: valueOf(totals, "kcal"), protein: valueOf(totals, "protein"), unknown_items: slotUnknown(parts) } : null,
        items: mine.map(({ meal_slot: _slot, ...rest }) => rest),
      });
    }

    const sized = items.filter((i) => i.plus_minus_kcal !== null);
    const largest = sized.reduce<(typeof items)[number] | null>((a, i) => (a === null || (i.plus_minus_kcal ?? 0) > (a.plus_minus_kcal ?? 0) ? i : a), null);
    const estimate = {
      plus_minus_kcal: sized.length === 0 ? null : sized.reduce((a, i) => a + (i.plus_minus_kcal ?? 0), 0),
      method: "sum of each item's dominant uncertainty",
      estimated_items: items.filter((i) => i.provenance === "estimated").length,
      estimated_without_size: items.filter((i) => i.provenance === "estimated" && i.plus_minus_kcal === null).length,
      dominant: largest ? { name: largest.name, description: largest.uncertainty, kcal: largest.plus_minus_kcal } : null,
    };
    const imported = (await first<{ n: number }>(ctx.db, `SELECT count(*) AS n FROM intake_item i WHERE i.member_id = ? AND i.eaten_on = ? AND ${IMPORTED("intake_item", "i")}`, member.id, input.date))?.n ?? 0;
    const typed = rows.filter((r) => r.row.source_kind === "manual" && (r.row.manual_reason ?? "").startsWith(TYPED_MACROS_REASON));
    const typedKcal = typed.reduce((a, r) => a + (valueOf(r.nutrients, "kcal") ?? 0), 0);
    const knownKcal = rows.reduce((a, r) => a + (valueOf(r.nutrients, "kcal") ?? 0), 0);
    const share = knownKcal > 0 ? typedKcal / knownKcal : null;
    const honesty = { imported: imported > 0, typed_macros: { items: typed.length, kcal: typedKcal, share, high: share !== null && share >= TYPED_MACROS_HIGH_SHARE } };
    return { member: member.name, date: input.date, day_status: status, slots, estimate, honesty };
  },
});

function describe(
  cat: Catalogue,
  recipes: Map<number, string>,
  portions: Map<number, PortionInfo>,
  loggers: Map<number, Authorship>,
  row: IntakeRow,
  nutrients: NutrientTotals,
) {
  let name: string | null = null;
  let amount: Record<string, unknown> | null = null;
  let food: { ref: string; reference_unit: string; measures: { name: string; amount: number }[] } | null = null;
  let provenance = row.provenance;
  // A portion item's provenance and ± live on its portion.
  let uncertainty = { description: row.dominant_uncertainty, kcal: row.dominant_uncertainty_kcal };
  switch (row.source_kind) {
    case "food_source": {
      const source = cat.row(row.food_source_id as number);
      name = source.name;
      // The food's measures, for the row's Edit (click test P2-8).
      food = {
        ref: source.ref,
        reference_unit: source.reference_unit,
        measures: cat.measures.filter((m) => m.food_source_id === source.id).map((m) => ({ name: m.name, amount: m.amount })),
      };
      const measure = row.measure_id ? (cat.measures.find((m) => m.id === row.measure_id)?.name ?? null) : null;
      amount = { value: row.amount_value, unit: row.amount_unit, ...(measure ? { measure } : {}) };
      break;
    }
    case "recipe":
      name = recipes.get(row.recipe_id as number) ?? null;
      amount = { servings: row.recipe_servings };
      break;
    case "portion": {
      const p = portions.get(row.portion_id as number);
      if (p) {
        name = p.components > 1 ? `${p.cook}, ${p.component}` : p.cook;
        amount = p.weighed_g !== null ? { weighed_g: p.weighed_g } : { fraction: p.fraction };
        provenance = provenance ?? p.provenance;
        if (uncertainty.kcal === null) uncertainty = { description: p.dominant_uncertainty, kcal: p.dominant_uncertainty_kcal };
      }
      break;
    }
    case "manual":
      name = row.label ?? row.manual_reason;
      amount = null;
      break;
  }
  const kcal = valueOf(nutrients, "kcal");
  return {
    table: "intake_item" as const,
    id: row.id,
    meal_slot: row.meal_slot,
    source_kind: row.source_kind,
    name,
    label: row.label,
    amount,
    food,
    portion_id: row.portion_id,
    // A leftover helping's item is removed as its serving (retract_the_serving), so the app needs it.
    leftover_serving_id: row.leftover_serving_id ?? null,
    kcal,
    protein: valueOf(nutrients, "protein"),
    // Known for some of its parts only (a recipe with an unconvertible line): the row reads "450+ kcal" (ticket 72).
    partial: { kcal: partlyKnown(nutrients, "kcal"), protein: partlyKnown(nutrients, "protein") },
    provenance,
    plus_minus_kcal: uncertainty.kcal,
    uncertainty: uncertainty.description,
    state: row.state,
    logged_by: row.state === "draft" ? (loggers.get(row.id)?.loggedBy ?? null) : null,
    // A draft its member had confirmed is a re-draft (someone else's edit, ticket 69): the app asks about the edit, and names its editor.
    ever_confirmed: row.state === "draft" ? (loggers.get(row.id)?.everConfirmed ?? false) : true,
    edited_by: row.state === "draft" ? (loggers.get(row.id)?.editedBy ?? null) : null,
  };
}

// ------------------------------------------------------------- day_cooks

/** One cook as day_cooks returns it (the web's `DayCook`); household_overview's meals reuse it, always with `ask: null`. */
interface DayCookOut {
  cook_id: number;
  name: string;
  cooked_on: string;
  meal_slot: string;
  logged_by: LoggedBy;
  components: {
    component_id: number;
    name: string;
    shares: { portion_id: number; member: string; you: boolean; fraction: number | null; weighed_g: number | null; provenance: string; state: string }[];
    remainder: { fraction: number; status: string } | null;
    /** Leftover helpings eaten from it (click test P1-7): with the shares and the remainder, the whole pot. */
    leftovers: { serving_id: number; member: string; you: boolean; fraction: number | null; eaten_on: string }[];
  }[];
  absent: string[];
  ask: {
    portion_id: number;
    component_id: number;
    fraction: number | null;
    kcal: number | null;
    /** Never undefined from loadCooks (it selects the portion's ± columns); typed as PortionRow is. */
    plus_minus_kcal: number | null | undefined;
    uncertainty: string | null | undefined;
    provenance: string;
    logged_by: LoggedBy;
    ever_confirmed: boolean;
    edited_by: LoggedBy;
    records: { table: string; id: number }[];
  } | null;
}

/**
 * The given household meals' cooks, one entry per meal in order, seen by
 * `viewer.you` (their shares first and marked you; null for none), with
 * `ask` only for `viewer.askFor` (null for no ask). HEAD's day_cooks body:
 * every cook, its writer and the asked portions with their items in a
 * fixed number of statements (decision 96).
 */
async function cooksOn(ctx: Ctx, reader: NutritionReader, viewer: { you: number | null; askFor: Member | null }, meals: readonly { cook_id: number; meal_slot: string }[]): Promise<DayCookOut[]> {
  const members = (await ctx.members()).filter((m) => m.active === 1);
  const nameOf = (id: number) => members.find((m) => m.id === id)?.name ?? `member ${id}`;
  const you = viewer.you;
  const askFor = viewer.askFor;
  await reader.prefetchCooks(meals.map((m) => m.cook_id));
  const loadedCooks = new Map<number, LoadedCook>();
  for (const cookId of new Set(meals.map((m) => m.cook_id))) loadedCooks.set(cookId, await reader.cook(cookId));
  const draftOf = (cookId: number) => (askFor ? loadedCooks.get(cookId)?.portions.find((p) => p.member_id === askFor.id && p.state === "draft") : undefined);
  const draftIds = [...loadedCooks.keys()].map(draftOf).filter((p) => p !== undefined).map((p) => p.id);
  const cookLoggers = await loggedByMany(ctx, "cook", [...loadedCooks.keys()]);
  const portionLoggers = await authorshipMany(ctx, "portion", draftIds);
  const draftItems = new Map(
    (
      await allIn<{ portion_id: number; dominant_uncertainty: string | null; dominant_uncertainty_kcal: number | null }>(
        ctx.db,
        (ph) => `SELECT portion_id, dominant_uncertainty, dominant_uncertainty_kcal FROM intake_item WHERE portion_id IN (${ph})`,
        draftIds,
      )
    ).map((i) => [i.portion_id, i]),
  );

  return meals.map(({ cook_id, meal_slot }) => {
    const loaded = loadedCooks.get(cook_id) as LoadedCook;
    const fractionOf = (portionId: number) => loaded.result.portions.find((p) => p.member === `portion:${portionId}`);
    const components = loaded.components.map((c) => {
      const portions = loaded.portions
        .filter((p) => p.component_id === c.id)
        .sort((a, b) => Number(b.member_id === you) - Number(a.member_id === you) || a.member_id - b.member_id);
      const rem = loaded.result.remainder.find((r) => r.component === c.name);
      return {
        component_id: c.id,
        name: c.name,
        shares: portions.map((p) => ({
          portion_id: p.id, member: nameOf(p.member_id), you: p.member_id === you,
          fraction: fractionOf(p.id)?.fraction ?? null, weighed_g: p.weighed_g, provenance: p.provenance, state: p.state,
        })),
        remainder: rem ? { fraction: rem.fraction, status: rem.status } : null,
        leftovers: loaded.servings
          .filter((v) => v.component_id === c.id)
          .sort((a, b) => a.eaten_on.localeCompare(b.eaten_on) || a.id - b.id)
          .map((v) => ({
            serving_id: v.id, member: nameOf(v.member_id), you: v.member_id === you,
            fraction: loaded.result.portions.find((p) => p.member === servingKey(v.id))?.fraction ?? null, eaten_on: v.eaten_on,
          })),
      };
    });
    const present = new Set(loaded.portions.map((p) => p.member_id));
    const draft = draftOf(cook_id);
    let ask = null;
    if (draft) {
      const item = draftItems.get(draft.id);
      // The portion's ± (household_meal stores it there); an older item's own, if it has one.
      const sized = draft.dominant_uncertainty_kcal !== null && draft.dominant_uncertainty_kcal !== undefined;
      const computed = fractionOf(draft.id);
      ask = {
        portion_id: draft.id,
        component_id: draft.component_id,
        fraction: computed?.fraction ?? null,
        kcal: computed?.nutrients ? valueOf(computed.nutrients, "kcal") : null,
        plus_minus_kcal: sized ? draft.dominant_uncertainty_kcal : (item?.dominant_uncertainty_kcal ?? null),
        uncertainty: sized ? draft.dominant_uncertainty : (item?.dominant_uncertainty ?? null),
        provenance: draft.provenance,
        logged_by: portionLoggers.get(draft.id)?.loggedBy ?? null,
        // A share its member had confirmed and someone else then edited (ticket 69): asked as a re-draft.
        ever_confirmed: portionLoggers.get(draft.id)?.everConfirmed ?? false,
        edited_by: portionLoggers.get(draft.id)?.editedBy ?? null,
        // Confirming the portion confirms its intake item in the same write.
        records: [{ table: "portion", id: draft.id }],
      };
    }
    return {
      cook_id,
      name: loaded.cook.name,
      cooked_on: loaded.cook.cooked_on,
      meal_slot,
      logged_by: cookLoggers.get(cook_id) ?? null,
      components,
      absent: members.filter((m) => !present.has(m.id)).map((m) => m.name),
      ask,
    };
  });
}

const dayCooks = readTool({
  name: "day_cooks",
  group: GROUP,
  description:
    "The household's cooks eaten on a date, as seen by one member: per component, each present member's share (the signed-in member's first, marked `you`), the remainder and what happened to it, the leftover helpings eaten from it (who, what fraction, the day eaten), the members with no portion (they weren't there), and `ask`: that member's draft portion with its kcal and who logged it, for them to confirm, change or settle. `ask` is only given to that member (or the agent).",
  input: { member: z.string().min(1), date },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    const mayDecide = ctx.caller.kind === "agent" || ctx.caller.memberId === member.id;
    // "You" is the signed-in member; the agent sees through the member asked about.
    const you = ctx.caller.kind === "member" ? ctx.caller.memberId : member.id;
    const meals = await all<{ cook_id: number; meal_slot: string }>(
      ctx.db,
      `SELECT hc.cook_id, m.meal_slot FROM household_meal m JOIN household_meal_cook hc ON hc.household_meal_id = m.id
       WHERE m.household_id = ? AND m.eaten_on = ? ORDER BY m.id, hc.cook_id`,
      ctx.householdId,
      input.date,
    );
    const reader = new NutritionReader(ctx, await Catalogue.load(ctx));
    return { member: member.name, date: input.date, cooks: await cooksOn(ctx, reader, { you, askFor: mayDecide ? member : null }, meals) };
  },
});

// ------------------------------------------------------------- needs_you

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

type NeedsCard =
  | { rule: "drafts"; count: number; oldest: { table: string; id: number; deadline: string | null; waits: DraftInfo["waits"] }; message: string }
  | { rule: "remainder"; cook_id: number; cook: string; cooked_on: string; component_id: number; component: string | null; fraction: number; message: string }
  | { rule: "yesterday_open"; date: string; items: number; message: string }
  | { rule: "load"; session: string; date: string | null; prescriptions: { prescription_id: number; exercise: string; state: PrescriptionState }[]; message: string }
  | { rule: "flag"; flag_id: number; subject: string; due_on: string; more: number; message: string }
  | { rule: "measurement"; cadence: string; metric: string | null; body_state: string | null; last: string | null; message: string };

const needsYou = readTool({
  name: "needs_you",
  group: GROUP,
  description:
    "What needs a member's attention, ranked: drafts about them (the count and the oldest's auto-confirm deadline, or why it never auto-confirms), an unaccounted pot remainder (with the pot's date) in the last three days' pots they cooked or ate from, yesterday still open, loads to act on in the next session (ready, needing confirmation, or an unverified step to check at the gym), and, for the member themselves or the agent, a flag due within 7 days and the most overdue measurement. `cards` holds at most 3; `more` the rest.",
  input: { member: z.string().min(1), date: date.optional().describe("Today, by default.") },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    const today = input.date ?? ctx.today();
    const cards: NeedsCard[] = [];

    // 1. Drafts about the member that the caller may see, oldest first: one statement.
    const drafts = draftsAbout(visibleDrafts(ctx, await householdDrafts(ctx)), member.id);
    const oldest = drafts[0];
    if (oldest) {
      const when = oldest.deadline
        ? `confirms by itself at ${oldest.deadline}`
        : oldest.waits === "end_of_session" ? "waits for the end of the session" : oldest.waits === "rir_needed" ? "needs RIR" : "waits for them";
      cards.push({
        rule: "drafts", count: drafts.length,
        oldest: { table: oldest.table, id: oldest.id, deadline: oldest.deadline, waits: oldest.waits },
        message: `${plural(drafts.length, "draft", "drafts")} about ${member.name}; the oldest ${when}.`,
      });
    }

    // 2. Unaccounted remainders in the three days' pots the member cooked or ate from (the shared rule, spec §5).
    const cookIds = await remainderCookIds(ctx, member.id, today);
    if (cookIds.length > 0) {
      const reader = new NutritionReader(ctx, await Catalogue.load(ctx));
      for (const r of await remaindersOf(reader, cookIds)) {
        cards.push({
          rule: "remainder", cook_id: r.cook_id, cook: r.cook, cooked_on: r.cooked_on, component_id: r.component_id, component: r.component, fraction: r.fraction,
          message: `${Math.round(r.fraction * 100)}% of ${r.cook} (${r.cooked_on}) isn't accounted for yet.`,
        });
      }
    }

    // 3. Yesterday still open, with something logged on it.
    const y = await yesterdayOpen(ctx, member.id, today);
    if (y) cards.push({ rule: "yesterday_open", date: y.date, items: y.items, message: `${y.date} is still open (${plural(y.items, "item", "items")}): complete it, or mark a meal skipped.` });

    // 4. Loads to act on in the next session.
    const load = await loadRule(ctx, member, today);
    if (load) {
      cards.push({ rule: "load", session: load.session, date: load.date, prescriptions: load.prescriptions, message: `${plural(load.prescriptions.length, "load", "loads")} to act on in ${load.session}.` });
    }

    // 5 and 6 are owner-only, and the projection of the shared due lines (waiting.ts, R6).
    if (ctx.canSee(member.id)) {
      const due = await dueLines(ctx, member, today);
      const flags = due.filter((d): d is Extract<DueLine, { kind: "flag" }> => d.kind === "flag");
      const soonest = flags[0];
      if (soonest) cards.push({ rule: "flag", flag_id: soonest.flag_id, subject: soonest.subject, due_on: soonest.due_on, more: flags.length - 1, message: `${soonest.subject} is due on ${soonest.due_on}.` });
      const m = due.find((d): d is Exclude<DueLine, { kind: "flag" }> => d.kind !== "flag");
      // A computed metric (waist to height) isn't loggable, so its card names no metric and the app links to Progress.
      if (m) cards.push({ rule: "measurement", cadence: m.name, metric: m.kind === "reading" ? m.metric : null, body_state: m.kind === "reading" ? m.body_state : null, last: m.last, message: m.message });
    }

    return { member: member.name, date: today, cards: cards.slice(0, 3), more: cards.slice(3) };
  },
});

// ------------------------------------------------------------ week_summary

/** Provenance that counts as measured: weighed, counted, or from a label. */
const MEASURED = new Set(["weighed", "counted", "label"]);
const DAY_KIND: Record<string, "gym" | "dance" | "cardio"> = { strength: "gym", class: "dance", cardio: "cardio" };

/** An item's provenance; a portion item's lives on its portion (loaded with its cook by the reader). */
function provenanceOf(reader: NutritionReader, row: IntakeRow): string | null {
  if (row.provenance !== null || row.portion_id === null) return row.provenance;
  return reader.portion(row.portion_id)?.provenance ?? null;
}

interface DayShape {
  day_status: string;
  item_count: number;
  so_far: Partial<Record<"kcal" | "protein", { value: number }>>;
  unknown_items: Record<"kcal" | "protein" | "any", number>;
  left: Record<"kcal" | "protein", { goal: number }> | null;
}

const weekSummary = readTool({
  name: "week_summary",
  group: GROUP,
  description:
    "A member's week, Sunday to Saturday (the week holding `week`, this week by default): each day's kcal against target, protein (unknown_items: how many items each leaves out), day status and training (gym, dance class, cardio or rest); the share of the week's known energy that was measured (weighed, counted or label); and energy availability over the days with something logged and every item's energy known (partial_days_excluded: the days left out because an item's energy is unknown), from the latest BIA fat-free mass, flagged below 25 kcal/kg FFM (null with the reason when it can't be known). Owner-only, because energy availability uses fat-free mass.",
  input: { member: z.string().min(1), week: date.optional().describe("Any date in the week; this week by default.") },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    ctx.assertCanSee("reading", member.id);
    const start = weekStart(input.week ?? ctx.today());
    const end = addDays(start, 6);
    const dates = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const reader = new NutritionReader(ctx, await Catalogue.load(ctx));
    // Load-once: the seven days in one pass, and the week's sessions in one query.
    const { views, items } = await dayViews(ctx, reader, [member], start, end);
    const sessions = await all<{ performed_on: string; session_type: string; template: string | null; energy_kcal: number | null }>(
      ctx.db,
      `SELECT se.performed_on, se.session_type, t.name AS template, se.energy_kcal FROM session se LEFT JOIN session_template t ON t.id = se.template_id
       WHERE se.member_id = ? AND se.performed_on BETWEEN ? AND ? ORDER BY se.performed_on, se.id`,
      member.id,
      start,
      end,
    );
    let known = 0;
    let measured = 0;
    for (const { row, nutrients } of items) {
      const kcal = valueOf(nutrients, "kcal");
      if (kcal === null) continue;
      known += kcal;
      const prov = provenanceOf(reader, row);
      if (prov !== null && MEASURED.has(prov)) measured += kcal;
    }
    let intake = 0;
    let exercise = 0;
    let counted = 0;
    let withoutEnergy = 0;
    let partial = 0;
    const days = dates.map((d) => {
      const view = views.get(`${member.id}|${d}`) as unknown as DayShape;
      const today = sessions.filter((s) => s.performed_on === d);
      const kcal = view.so_far.kcal?.value ?? null;
      // A day with an item of unknown energy reads low by that item: left out of the average, never counted as 0 (ticket 74).
      if (view.item_count > 0 && view.unknown_items.kcal > 0) partial++;
      else if (view.item_count > 0 && kcal !== null) {
        counted++;
        intake += kcal;
        exercise += today.reduce((a, s) => a + (s.energy_kcal ?? 0), 0);
        withoutEnergy += today.filter((s) => s.session_type !== "strength" && s.energy_kcal === null).length;
      }
      const training = today.map((s) => ({ kind: DAY_KIND[s.session_type] ?? ("gym" as const), template: s.template, energy_kcal: s.energy_kcal }));
      return {
        date: d, day_status: view.day_status, item_count: view.item_count,
        kcal, kcal_target: view.left?.kcal.goal ?? null,
        protein: view.so_far.protein?.value ?? null, protein_target: view.left?.protein.goal ?? null,
        unknown_items: { kcal: view.unknown_items.kcal, protein: view.unknown_items.protein, any: view.unknown_items.any },
        training,
        kind: (["gym", "dance", "cardio"] as const).find((k) => training.some((t) => t.kind === k)) ?? "rest",
      };
    });
    const ffm = await first<{ value: number; unit: string; measured_on: string }>(
      ctx.db,
      "SELECT value, unit, measured_on FROM reading WHERE member_id = ? AND metric = 'bia_fat_free_mass' AND state = 'confirmed' AND measured_on <= ? ORDER BY measured_on DESC, id DESC LIMIT 1",
      member.id,
      end,
    );
    let ea = null;
    if (ffm && counted > 0) {
      // Through the canonical conversion every body reading uses (lb, kg, ...), never an inline factor.
      const ffmKg = canonical(ffm.value, ffm.unit);
      const r = energyAvailability({ intakeKcal: intake / counted, exerciseKcal: exercise / counted, ffmKg });
      ea = {
        value: r.value, low: r.low, threshold: LOW_EA_KCAL_PER_KG_FFM, ffm_kg: ffmKg, ffm_measured_on: ffm.measured_on, days_counted: counted,
        intake_kcal_per_day: intake / counted, exercise_kcal_per_day: exercise / counted, sessions_without_energy: withoutEnergy,
        partial_days_excluded: partial,
      };
    }
    return {
      member: member.name, week_start: start, week_end: end, days,
      measured: { kcal_measured: measured, kcal_known: known, share: known > 0 ? measured / known : null },
      energy_availability: ea,
      energy_availability_missing: ea ? null
        : !ffm ? "no fat-free mass reading"
        : partial > 0 ? "every day logged this week has an item of unknown energy"
        : "nothing logged this week",
    };
  },
});

// --------------------------------------------------------- nutrition_trends

/** A chart response includes at most four Sunday weeks; older weeks are replayable page descriptors. */
export const NUTRITION_PAGE_WEEKS = 4;
/** At four weeks per page, 26 pages is the most recent two years. */
export const NUTRITION_MAX_PAGES = 26;

export interface NutritionTrendsInput {
  member: string;
  from?: string | undefined;
  to?: string | undefined;
}

/**
 * Build one bounded, Sunday-aligned nutrition chart page. Nutrition is
 * household-visible; this projection deliberately contains no readings,
 * body composition or energy-availability data.
 */
export async function nutritionTrends(ctx: Ctx, input: NutritionTrendsInput, pageWeeks = NUTRITION_PAGE_WEEKS) {
  const member = await ctx.member(input.member);
  const today = ctx.today();
  const earliest = await first<{ items: string | null; totals: string | null }>(
    ctx.db,
    `SELECT (SELECT min(eaten_on) FROM intake_item WHERE member_id = ?) AS items,
            (SELECT min(day) FROM day_status WHERE member_id = ? AND manual_total_kcal IS NOT NULL) AS totals`,
    member.id,
    member.id,
  );
  const firstLogged = [earliest?.items, earliest?.totals]
    .filter((day): day is string => typeof day === "string")
    .sort()[0] ?? null;
  const empty = {
    member: member.name,
    from: null,
    to: null,
    today,
    pages: [] as { from: string; to: string }[],
    capped: false,
    first_logged_on: firstLogged,
    days: [] as NutritionDay[],
    weeks: [] as NutritionWeek[],
  };
  if (firstLogged === null) return empty;

  const currentWeekEnd = addDays(weekStart(today), 6);
  // Future ranges contain no additional facts. Clamp before date arithmetic
  // so even an extreme ISO date cannot amplify pagination work.
  const to = input.to !== undefined && input.to < currentWeekEnd ? addDays(weekStart(input.to), 6) : currentWeekEnd;
  const cap = addDays(currentWeekEnd, 1 - 7 * pageWeeks * NUTRITION_MAX_PAGES);
  const firstWeek = weekStart(firstLogged);
  const asked = weekStart(input.from ?? firstLogged);
  const floor = firstWeek < cap ? cap : firstWeek;
  const from = asked < floor ? floor : asked;
  const capped = asked < cap;
  if (from > to) return { ...empty, capped };

  const newestPageStart = addDays(to, 1 - 7 * pageWeeks);
  const answerFrom = newestPageStart > from ? newestPageStart : from;
  const pages: { from: string; to: string }[] = [];
  for (let end = addDays(answerFrom, -1); end >= from; end = addDays(end, -7 * pageWeeks)) {
    const pageStart = addDays(end, 1 - 7 * pageWeeks);
    pages.push({ from: pageStart < from ? from : pageStart, to: end });
  }

  const reader = new NutritionReader(ctx, await Catalogue.load(ctx));
  const { views, items } = await dayViews(ctx, reader, [member], answerFrom, to);
  const itemsByDate = new Map<string, ItemWithNutrients[]>();
  for (const item of items) {
    const sameDay = itemsByDate.get(item.row.eaten_on);
    if (sameDay) sameDay.push(item);
    else itemsByDate.set(item.row.eaten_on, [item]);
  }
  const days: NutritionDay[] = [];
  for (let day = answerFrom; day <= to; day = addDays(day, 1)) {
    days.push(nutritionDay(viewOf(views, member.id, day), itemsByDate.get(day) ?? [], today));
  }
  const weeks: NutritionWeek[] = [];
  for (let index = 0; index < days.length; index += 7) {
    weeks.push(nutritionWeek(days[index]!.date, days.slice(index, index + 7)));
  }
  return { member: member.name, from: answerFrom, to, today, pages, capped, first_logged_on: firstLogged, days, weeks };
}

const nutritionTrendsTool = readTool({
  name: "nutrition_trends",
  group: GROUP,
  description:
    "A member's nutrition over Sunday weeks for charts: truthful nutrient coverage, targets, macro split and cost coverage per day and week. `from` snaps to Sunday and `to` to Saturday. The newest four weeks are returned; older four-week ranges are replayable `pages`, capped at 26 pages/two years and clamped to the first item or legacy manual total. Household-visible and contains no readings, body composition or energy availability.",
  input: { member: z.string().min(1), from: date.optional(), to: date.optional() },
  async run(ctx, input) {
    return nutritionTrends(ctx, input);
  },
});

// ------------------------------------------------------- household_overview

interface DayLeft {
  day_status: string;
  left: Record<"kcal" | "protein", { left: number }> | null;
  unknown_items: Record<"kcal" | "protein" | "any", number>;
}

/** waiting_on_you lists at most this many, oldest first; `truncated` says there are more (they still confirm by themselves). */
const WAITING_CAP = 100;

const householdOverview = readTool({
  name: "household_overview",
  group: GROUP,
  description:
    "The household on a date (today by default), in one call: each member's kcal and protein left (unknown_items: how many items those leave out, so left is at most that), day status, drafts waiting on them (the oldest's deadline, or why it has none) and last session, with no health fields; the household's cooks on the date and the two days before (as day_cooks, never with an ask); leftovers with how much and since when; the drafts the signed-in member logged about others, still unconfirmed; and waiting_on_you, every draft about the signed-in member (oldest first, at most 100, with who logged it, when, its deadline or why it waits; truncated when there are more). Owner-only drafts count only for someone who may see them.",
  input: { date: date.optional() },
  async run(ctx, input) {
    const today = input.date ?? ctx.today();
    const dates = [today, addDays(today, -1), addDays(today, -2)];
    const me = ctx.caller.kind === "member" ? ctx.caller.memberId : null;
    const active = (await ctx.members()).filter((m) => m.active === 1);
    const ordered = [...active.filter((m) => m.id === me), ...active.filter((m) => m.id !== me)];
    const reader = new NutritionReader(ctx, await Catalogue.load(ctx));
    // Load-once: drafts, the three days' meals, the leftovers, then every member's day with every cook in one pass.
    const drafts = visibleDrafts(ctx, await householdDrafts(ctx));
    const meals = await all<{ cook_id: number; meal_slot: string; eaten_on: string }>(
      ctx.db,
      `SELECT hc.cook_id, m.meal_slot, m.eaten_on FROM household_meal m JOIN household_meal_cook hc ON hc.household_meal_id = m.id
       WHERE m.household_id = ? AND m.eaten_on IN (?, ?, ?) ORDER BY m.eaten_on DESC, m.id, hc.cook_id`,
      ctx.householdId,
      ...dates,
    );
    // What was in the fridge on the date: marked by then, not settled by then (a later discard still counts
    // for the days before). Bounded, so eaten-up history costs nothing.
    const leftoverRows = await all<{ cook_id: number; component_id: number; since: string }>(
      ctx.db,
      `SELECT c.cook_id, d.component_id, min(d.recorded_on) AS since FROM remainder_disposition d
       JOIN component c ON c.id = d.component_id JOIN cook k ON k.id = c.cook_id
       WHERE (d.disposition = 'leftover' OR (d.disposition = 'discarded' AND d.settled_on IS NOT NULL))
         AND (d.settled_on IS NULL OR d.settled_on > ?) AND d.recorded_on <= ? AND k.household_id = ?
       GROUP BY c.cook_id, d.component_id ORDER BY c.cook_id, d.component_id`,
      today,
      today,
      ctx.householdId,
    );
    const { views } = await dayViews(ctx, reader, ordered, today, today, { extraCookIds: [...meals.map((m) => m.cook_id), ...leftoverRows.map((l) => l.cook_id)] });
    const lastSessions = await all<{ member_id: number; performed_on: string; session_type: string; template: string | null }>(
      ctx.db,
      `SELECT member_id, performed_on, session_type, template FROM (
         SELECT se.member_id, se.performed_on, se.session_type, t.name AS template,
                row_number() OVER (PARTITION BY se.member_id ORDER BY se.performed_on DESC, se.id DESC) AS rn
         FROM session se JOIN member m ON m.id = se.member_id LEFT JOIN session_template t ON t.id = se.template_id
         WHERE m.household_id = ? AND se.performed_on <= ?
       ) WHERE rn = 1`,
      ctx.householdId,
      today,
    );

    const members = ordered.map((m) => {
      const view = views.get(`${m.id}|${today}`) as unknown as DayLeft;
      const mine = draftsAbout(drafts, m.id);
      const oldest = mine[0];
      const last = lastSessions.find((l) => l.member_id === m.id);
      return {
        member: m.name,
        you: m.id === me,
        day_status: view.day_status,
        kcal_left: view.left?.kcal.left ?? null,
        protein_left: view.left?.protein.left ?? null,
        unknown_items: { kcal: view.unknown_items.kcal, protein: view.unknown_items.protein, any: view.unknown_items.any },
        drafts: { count: mine.length, oldest: oldest ? { table: oldest.table, id: oldest.id, deadline: oldest.deadline, waits: oldest.waits } : null },
        last_session: last ? { date: last.performed_on, session_type: last.session_type, template: last.template } : null,
      };
    });

    const cooks = await cooksOn(ctx, reader, { you: me, askFor: null }, meals);
    const byDate = dates
      .map((d) => ({ date: d, cooks: cooks.filter((_, i) => meals[i]?.eaten_on === d) }))
      .filter((m) => m.cooks.length > 0);

    const leftovers = [];
    for (const l of leftoverRows) {
      const loaded = await reader.cook(l.cook_id);
      const component = loaded.components.find((c) => c.id === l.component_id);
      if (!component) continue;
      // The remainder as it stood on the date: no servings eaten after it, and this component still leftover.
      const asOf = computeCook(
        reader.cat,
        loaded.components,
        loaded.lines,
        cookShares({ portions: loaded.portions, servings: loaded.servings.filter((s) => s.eaten_on <= today) }),
        loaded.marks.map((m) => (m.component_id === component.id ? { ...m, disposition: "leftover" as const } : m)),
      );
      const r = asOf.remainder.find((x) => x.component === component.name && x.status === "leftover");
      if (!r) continue;
      leftovers.push({
        cook_id: l.cook_id, cook: loaded.cook.name, cooked_on: loaded.cook.cooked_on, component_id: component.id,
        component: loaded.components.length > 1 ? component.name : null, fraction: r.fraction, kcal: valueOf(r.nutrients, "kcal"), since: l.since,
      });
    }

    const waiting =
      me === null
        ? []
        : drafts
            .filter((d) => d.loggedBy === me && d.owner !== null && d.owner !== me)
            .map((d) => ({ table: d.table, id: d.id, about: active.find((m) => m.id === d.owner)?.name ?? "someone", summary: d.summary, deadline: d.deadline, waits: d.waits }));
    // Everything waiting on the signed-in member (spec 2026-10-07 §4): the same snapshot as the table's count, no new statement.
    const aboutMe = me === null ? [] : draftsAbout(drafts, me);
    const names = new Map((await ctx.members()).map((m) => [m.id, m.name]));
    const waitingOnYou = {
      drafts: aboutMe.slice(0, WAITING_CAP).map((d) => ({
        table: d.table, id: d.id, summary: d.summary,
        logged_by: d.loggedBy === null ? null : (names.get(d.loggedBy) ?? null),
        logged_at: d.createdAt, deadline: d.deadline, waits: d.waits,
      })),
      truncated: aboutMe.length > WAITING_CAP,
    };
    return { date: today, members, meals: byDate, leftovers, waiting, waiting_on_you: waitingOnYou };
  },
});

// --------------------------------------------------------------- sessions

const sessionsTool = readTool({
  name: "sessions",
  group: GROUP,
  description:
    "A member's sessions between two dates (default the 56 days to today), newest first: type, template, gym, state, working sets, volume (sets_without_volume counts working sets with none), records (an exercise whose best valid e1RM beats every earlier session's on the same implement), cardio blocks and time, energy, notes, and every set as log_set describes it. Training is household data.",
  input: { member: z.string().min(1), from: date.optional(), to: date.optional() },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    const to = input.to ?? ctx.today();
    const from = input.from ?? addDays(to, -55);
    const rows = await all<SessionRow & { template: string | null; gym: string | null; energy_kcal: number | null; imported: number }>(
      ctx.db,
      `SELECT se.*, t.name AS template, g.name AS gym, ${IMPORTED("session", "se")} AS imported FROM session se
       LEFT JOIN session_template t ON t.id = se.template_id LEFT JOIN gym g ON g.id = se.gym_id
       WHERE se.member_id = ? AND se.performed_on BETWEEN ? AND ? ORDER BY se.performed_on DESC, se.id DESC`,
      member.id,
      from,
      to,
    );
    if (rows.length === 0) return { member: member.name, from, to, sessions: [] };
    // Load-once, every multi-key read through allIn (decision 96): the sets, the exercises' working history,
    // the exercises, the implements, the cardio blocks.
    const ids = rows.map((r) => r.id);
    const sets = (await allIn<SetRow>(ctx.db, (ph) => `SELECT * FROM session_set WHERE session_id IN (${ph})`, ids)).sort(
      (a, b) => a.session_id - b.session_id || ((a.position as number | null) ?? a.set_number) - ((b.position as number | null) ?? b.set_number) || a.id - b.id,
    );
    const exerciseIds = [...new Set(sets.map((x) => x.exercise_id))];
    const history = await allIn<SetRow & { _on: string }>(
      ctx.db,
      (ph) =>
        `SELECT st.*, se.performed_on AS _on FROM session_set st JOIN session se ON se.id = st.session_id
         WHERE se.member_id = ? AND se.performed_on <= ? AND st.set_type <> 'warm_up' AND st.exercise_id IN (${ph})`,
      exerciseIds,
      member.id,
      to,
    );
    const exercises = await allIn<ExerciseRow>(ctx.db, (ph) => `SELECT id, name, implement_kind, bodyweight_dominant FROM exercise WHERE id IN (${ph})`, exerciseIds);
    const impls = await loadImplements(ctx, { ids: [...new Set([...sets, ...history].map((x) => x.load_implement_id).filter((x): x is number => x !== null))] });
    const cardio = await allIn<{ session_id: number; n: number; d: number | null; ids: string; notes: string }>(
      ctx.db,
      // The block ids, in order, so the app can fix a cardio session (decision 145);
      // the notes as a JSON array, so a note holding the id list's separator is safe.
      (ph) => `SELECT session_id, count(*) AS n, sum(duration_s) AS d, group_concat(id) AS ids, json_group_array(note) AS notes
               FROM (SELECT * FROM cardio_block WHERE session_id IN (${ph}) ORDER BY session_id, id) GROUP BY session_id`,
      ids,
    );
    const exerciseOf = (id: number) => exercises.find((e) => e.id === id) as ExerciseRow;
    const implOf = (id: number | null) => impls.find((i) => i.id === id) ?? null;
    const e1rmOf = (s: SetRow) => derive(s, implOf(s.load_implement_id), exerciseOf(s.exercise_id))?.e1rmKg ?? null;
    const keyOf = (s: SetRow) => `${s.exercise_id}|${s.load_implement_id ?? ""}`;

    // Records in one pass: history sorted by date and session, a running best per exercise and implement,
    // and for each session the running best as it stood before it.
    const ordered = [...history].sort((a, b) => a._on.localeCompare(b._on) || a.session_id - b.session_id);
    const running = new Map<string, number>();
    const bestBefore = new Map<number, Map<string, number>>();
    const bestIn = new Map<number, Map<string, number>>();
    let current: number | null = null;
    let pending = new Map<string, number>();
    const close = () => {
      if (current === null) return;
      for (const [k, v] of pending) running.set(k, Math.max(running.get(k) ?? -Infinity, v));
      pending = new Map();
    };
    for (const h of ordered) {
      if (h.session_id !== current) {
        close();
        current = h.session_id;
        bestBefore.set(h.session_id, new Map(running));
        bestIn.set(h.session_id, pending);
      }
      const e = e1rmOf(h);
      if (e === null) continue;
      const k = keyOf(h);
      pending.set(k, Math.max(pending.get(k) ?? -Infinity, e));
    }
    close();

    const out = rows.map((s) => {
      const own = sets.filter((x) => x.session_id === s.id);
      const described = own.map((x) => describeSet(x, exerciseOf(x.exercise_id), implOf(x.load_implement_id)));
      const working = own.filter((x) => x.set_type !== "warm_up");
      const before = bestBefore.get(s.id) ?? new Map<string, number>();
      const records = [...(bestIn.get(s.id) ?? new Map<string, number>())]
        .filter(([k, here]) => before.has(k) && here > (before.get(k) as number))
        .map(([k, here]) => ({ exercise: exerciseOf(Number(k.split("|")[0])).name, e1rm_kg: here, previous_best_kg: before.get(k) as number }));
      const blocks = cardio.find((c) => c.session_id === s.id);
      return {
        id: s.id, date: s.performed_on, session_type: s.session_type, template: s.template, gym: s.gym, state: s.state, imported: s.imported === 1,
        note: (s.note as string | null | undefined) ?? null,
        working_sets: working.length,
        volume_kg: described.filter((dd) => dd.set_type !== "warm_up").reduce((a, dd) => a + (dd.volume_kg ?? 0), 0),
        sets_without_volume: described.filter((dd) => dd.set_type !== "warm_up" && dd.volume_kg === null).length,
        records,
        cardio: blocks ? { blocks: blocks.n, duration_s: blocks.d, block_ids: blocks.ids.split(",").map(Number), notes: JSON.parse(blocks.notes) as (string | null)[] } : null,
        energy_kcal: s.energy_kcal,
        sets: described,
      };
    });
    return { member: member.name, from, to, sessions: out };
  },
});

// --------------------------------------------------------------- lift_trends

/** Cosmetic URL words for an exercise; the numeric id remains the key. */
export function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

type LiftExtra = {
  kind: "goal" | "method";
  exercise_id: number;
  on_date: string;
  tier: string | null;
  basis: string | null;
  value_low: number | null;
  value_high: number | null;
  unit: string | null;
  note: string | null;
};

/** A lift goal as stored; bodyweight multiples never disclose or infer bodyweight. */
const liftGoal = (goal: LiftExtra) =>
  goal.basis === "bodyweight_multiple"
    ? { week_of: goal.on_date, tier: goal.tier, multiple_low: goal.value_low, multiple_high: goal.value_high }
    : { week_of: goal.on_date, tier: goal.tier, low: goal.value_low, high: goal.value_high, unit: goal.unit };

const liftTrends = readTool({
  name: "lift_trends",
  group: GROUP,
  description:
    "A member's complete lift history for charts. Without exercise_id, returns every exercise with working sets, best RIR-adjusted e1RM (reps plus low RIR, capped at 12, comparable implements only), an honest reason when unavailable, next stored goal, and Sunday-week volume. With an exercise id from that list, returns the stable full session series oldest first, method segments, draft state, inferred-reps provenance, stored goals, method changes, and the described sets behind every point. Bodyweight-multiple goals remain multiples. Household data: any member may read any household member's lifts.",
  input: { member: z.string().min(1), exercise_id: z.number().int().positive().optional().describe("An exercise id from the list.") },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    const today = ctx.today();
    const exercises = await all<ExerciseRow>(ctx.db, "SELECT id, name, implement_kind, bodyweight_dominant FROM exercise WHERE household_id = ? ORDER BY id", ctx.householdId);
    const selected = input.exercise_id === undefined ? null : (exercises.find((exercise) => exercise.id === input.exercise_id) ?? null);
    if (input.exercise_id !== undefined && selected === null) throw new ToolError("not_found", `no exercise ${input.exercise_id}`, 404);

    const groups = await liftGroups(ctx, member.id, "session", selected ? { exerciseId: selected.id } : {});
    const filter = selected ? " AND exercise_id = ?" : "";
    const extras = await all<LiftExtra>(
      ctx.db,
      `SELECT 'goal' AS kind, exercise_id, week_of AS on_date, tier, basis, value_low, value_high, unit, NULL AS note
       FROM goal_point WHERE member_id = ? AND exercise_id IS NOT NULL${filter}
       UNION ALL
       SELECT 'method', exercise_id, changed_on, NULL, NULL, NULL, NULL, NULL, note
       FROM method_change WHERE member_id = ? AND exercise_id IS NOT NULL${filter}
       ORDER BY 3, 1`,
      ...(selected ? [member.id, selected.id, member.id, selected.id] : [member.id, member.id]),
    );
    const goals = extras.filter((extra) => extra.kind === "goal");
    const changes = extras
      .filter((extra) => extra.kind === "method")
      .map((extra) => ({ exercise_id: extra.exercise_id, date: extra.on_date, note: extra.note as string }));
    const series = foldLifts(groups, changes);

    if (selected) {
      const lift = series.get(selected.id);
      const loaded = await memberExerciseSets(ctx, member.id, [selected.id]);
      const implementsById = new Map(loaded.implements.map((implement) => [implement.id, implement]));
      const pointSessionIds = new Set((lift?.points ?? []).map((point) => point.session_id));
      const sessions = new Map<number, { session_id: number; date: string; sets: unknown[] }>();
      for (const set of loaded.sets) {
        // A session is supporting detail for a plotted working-set point.
        // Keep its warm-ups, but never surface an unrelated warm-up-only session.
        if (!pointSessionIds.has(set.session_id)) continue;
        const implement = set.load_implement_id === null ? null : (implementsById.get(set.load_implement_id) ?? null);
        const session = sessions.get(set.session_id) ?? { session_id: set.session_id, date: set.performed_on, sets: [] };
        session.sets.push({ ...describeSet(set, selected, implement), note: set.note ?? null });
        sessions.set(set.session_id, session);
      }
      return {
        member: member.name,
        exercise_id: selected.id,
        exercise: selected.name,
        slug: slugOf(selected.name),
        bodyweight_dominant: selected.bodyweight_dominant === 1,
        points: (lift?.points ?? []).map((point) => ({
          session_id: point.session_id,
          date: point.date,
          state: point.has_draft ? "draft" : "confirmed",
          segment: point.segment,
          e1rm: point.e1rm
            ? {
                kg: point.e1rm.kg,
                implement: point.e1rm.implement,
                set_id: point.e1rm.set_id,
                reps: point.e1rm.reps,
                rir_low: point.e1rm.rir_low,
                effective_reps: point.e1rm.reps + point.e1rm.rir_low,
                reps_assumed: point.e1rm.reps_assumed,
              }
            : null,
          top_set: point.top_set ? { set_id: point.top_set.set_id, total_kg: point.top_set.total_kg, reps: point.top_set.reps } : null,
          volume_kg: point.volume_kg,
          working_sets: point.working_sets,
          sets_without_volume: point.sets_without_volume,
        })),
        goals: goals.map(liftGoal),
        method_changes: changes.map((change) => ({ date: change.date, note: change.note })),
        sessions: [...sessions.values()],
      };
    }

    const exerciseById = new Map(exercises.map((exercise) => [exercise.id, exercise]));
    const thisWeek = weekStart(today);
    const lifts = [...series.values()]
      .sort((a, b) => b.last_done.localeCompare(a.last_done) || a.exercise_id - b.exercise_id)
      .map((lift) => {
        const exercise = exerciseById.get(lift.exercise_id) as ExerciseRow;
        const nextGoal = goals
          .filter((goal) => goal.exercise_id === exercise.id && goal.on_date >= thisWeek)
          .sort((a, b) => a.on_date.localeCompare(b.on_date) || Number(b.tier === "planned") - Number(a.tier === "planned"))[0];
        return {
          exercise_id: exercise.id,
          exercise: exercise.name,
          slug: slugOf(exercise.name),
          implement_kind: exercise.implement_kind,
          bodyweight_dominant: exercise.bodyweight_dominant === 1,
          last_done: lift.last_done,
          sessions: lift.points.length,
          best_e1rm: lift.best_e1rm,
          no_e1rm: noE1rmReason(lift, exercise),
          best_top_set: lift.best_top_set,
          next_goal: nextGoal ? liftGoal(nextGoal) : null,
        };
      });
    return { member: member.name, lifts, weekly_volume: weeklyVolume(groups, today) };
  },
});

// ---------------------------------------------------------------- waiting

const waitingTool = readTool({
  name: "waiting",
  group: GROUP,
  description:
    "Everything waiting on a member, for Waiting on you (a signed-in member names only themselves; the agent anyone): asks (durable open questions with the member's own quoted text); handoffs (drafts about them, grouped: one logger's food for one date and meal, or one reading, blood draw or session with its sets; one logger's food over several dates logged within 2 hours as one batch with a row per day; items with kcal and protein, null when unknown, and totals with unknown_items; at most 100 drafts, cut between hand-offs, truncated when more); settle (unaccounted remainders in the last three days' pots they cooked or ate from, and yesterday still open); on_others (their own drafts about others, grouped the same way); sent (their website texts sent for review, awaiting processing); due (owner-only: raised measurement cadences, a loggable reading's metric and body state, and open flags due within 7 days); and count, the badge: open questions, hand-offs (a batch counts its days) and settle rows, over everything (never due). Training prescriptions and equipment gaps stay in next_prescription and inventory_gaps.",
  input: { member: z.string().min(1).optional(), date: date.optional().describe("Today, by default.") },
  async run(ctx, input) {
    const member = input.member !== undefined ? await ctx.member(input.member) : ctx.caller.kind === "member" ? await ctx.memberById(ctx.caller.memberId) : null;
    if (!member) throw new Clarify("member_needed", "Whose Waiting on you?", (await ctx.members()).map((m) => m.name), ["member"]);
    if (ctx.caller.kind === "member" && ctx.caller.memberId !== member.id) throw new ToolError("not_visible", "Waiting on you is visible only to its member", 403);
    return { ...(await waitingFor(ctx, member, input.date ?? ctx.today())) };
  },
});

export const SCREEN_TOOLS: Tool[] = [whoami, dayMeals, dayCooks, needsYou, weekSummary, nutritionTrendsTool, householdOverview, sessionsTool, liftTrends, waitingTool];
