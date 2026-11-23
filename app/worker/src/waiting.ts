/**
 * What waits on a member, one set of rules (redesign-a spec §5): the drafts
 * snapshot is drafts.ts's; this file holds the rest. Pots with an
 * unaccounted remainder (the date and the two days before, pots the member
 * cooked or ate from), yesterday still open, and loads to act on in the next
 * session. needs_you, household_overview and waiting call these, so a list
 * and a count come from the same rules (Adversarial Review #6).
 */
import { addDays, stalenessTop, sumNutrients, type NutrientTotals } from "@myfitnessguide/domain";
import { Catalogue } from "./catalogue";
import type { Ctx, Member } from "./context";
import { all, first } from "./db";
import { draftsAbout, householdDrafts, visibleDrafts, type DraftInfo } from "./drafts";
import { capHandoffs, groupHandoffs, unitDrafts, waitingCount, type Handoff, type HandoffType, type Logger, type Unit, type Waits } from "./handoffs";
import { knownValue, NutritionReader, partlyKnown, unknownItems, type IntakeRow } from "./nutrition";
import { localHoursFromNow, NEXT_PREP_HORIZON_H } from "./prep";
import { openQuestions } from "./questions";
import { firstWriteSql, LOGGED_BY } from "./records";
import { cadenceStatus, nextSessionPlan, progressionsOf, type PrescriptionState } from "./training";
import { COMPUTED_METRICS } from "./tools/health";

/** The date and the two days before (spec §2, To settle). */
export const SETTLE_DAYS = 3;

export interface Remainder {
  cook_id: number;
  cook: string;
  cooked_on: string;
  component_id: number;
  /** The component's name when the pot has more than one. */
  component: string | null;
  fraction: number;
}

/** Pots eaten in the window that the member cooked (first wrote) or has a portion of: one statement. */
export async function remainderCookIds(ctx: Ctx, memberId: number, today: string): Promise<number[]> {
  const rows = await all<{ cook_id: number }>(
    ctx.db,
    `SELECT DISTINCT hc.cook_id FROM household_meal m JOIN household_meal_cook hc ON hc.household_meal_id = m.id JOIN cook k ON k.id = hc.cook_id
     WHERE m.household_id = ?1 AND m.eaten_on BETWEEN ?2 AND ?3
       AND (EXISTS (SELECT 1 FROM component c JOIN portion p ON p.component_id = c.id WHERE c.cook_id = hc.cook_id AND p.member_id = ?4)
            OR ${firstWriteSql(LOGGED_BY, "'cook'", "k.id")} = ?4)
     ORDER BY hc.cook_id`,
    ctx.householdId,
    addDays(today, 1 - SETTLE_DAYS),
    today,
    memberId,
  );
  return rows.map((r) => r.cook_id);
}

/** Each unaccounted remainder of these pots, through the reader (one loadCooks for any not loaded yet). */
export async function remaindersOf(reader: NutritionReader, cookIds: readonly number[]): Promise<Remainder[]> {
  if (cookIds.length === 0) return [];
  await reader.prefetchCooks(cookIds);
  const out: Remainder[] = [];
  for (const id of cookIds) {
    const loaded = await reader.cook(id);
    for (const r of loaded.result.remainder.filter((x) => x.status === "unaccounted")) {
      const component = loaded.components.find((c) => c.name === r.component);
      if (!component) continue;
      out.push({
        cook_id: loaded.cook.id, cook: loaded.cook.name, cooked_on: loaded.cook.cooked_on, component_id: component.id,
        component: loaded.components.length > 1 ? component.name : null, fraction: r.fraction,
      });
    }
  }
  return out;
}

export interface YesterdayOpen {
  date: string;
  items: number;
}

/** Yesterday still open with something logged on it: one statement. */
export async function yesterdayOpen(ctx: Ctx, memberId: number, today: string): Promise<YesterdayOpen | null> {
  const yesterday = addDays(today, -1);
  const y = await first<{ status: string | null; items: number }>(
    ctx.db,
    "SELECT (SELECT status FROM day_status WHERE member_id = ?1 AND day = ?2) AS status, (SELECT count(*) FROM intake_item WHERE member_id = ?1 AND eaten_on = ?2) AS items",
    memberId,
    yesterday,
  );
  const items = y?.items ?? 0;
  return (y?.status ?? "open") === "open" && items > 0 ? { date: yesterday, items } : null;
}

/** Load states the member can act on before or at the next session. */
const ACTIONABLE = new Set<PrescriptionState["kind"]>(["ready", "needs_confirmation", "check_at_gym"]);

export interface LoadRule {
  session: string;
  date: string | null;
  prescriptions: { prescription_id: number; exercise: string; state: PrescriptionState }[];
}

/** The next session's actionable loads: the plan next_prescription uses, every prescription checked at once. */
export async function loadRule(ctx: Ctx, member: Member, today: string): Promise<LoadRule | null> {
  if (member.programming_mode !== "prescribed") return null;
  const plan = await nextSessionPlan(ctx, member.id, today);
  if (!plan?.next) return null;
  const next = plan.prescriptions.filter((x) => x.template_id === plan.templateId);
  const states = await progressionsOf(ctx, next);
  const prescriptions = next
    .map((p) => ({ prescription_id: p.id, exercise: p.exercise_name, state: (states.get(p.id) as { state: PrescriptionState }).state }))
    .filter((p) => ACTIONABLE.has(p.state.kind));
  return prescriptions.length > 0 ? { session: plan.next.session, date: plan.next.date, prescriptions } : null;
}

// ---------------------------------------------------------------- due lines (R6)

/** Open flags due within this many days are due lines (needs_you's rule 5, moved here). */
export const FLAG_WINDOW_DAYS = 7;
/** How many raised cadences are due lines (staleness' own default). */
export const DUE_LIMIT = 2;

export type DueLine =
  | { kind: "reading"; cadence_id: number; name: string; message: string; metric: string; body_state: string | null; last: string | null; due_since: string | null }
  | { kind: "cadence"; cadence_id: number; name: string; message: string; last: string | null; due_since: string | null }
  | { kind: "prep"; task_id: number; action: string; who: string; due_on: string; window_start: string; window_end: string; message: string }
  | { kind: "flag"; flag_id: number; subject: string; due_on: string; window_days: number };

/**
 * What a member is due to measure or follow up (owner-only data; the caller checks): the raised cadences,
 * ranked by the domain's stalenessTop with each cadence's id standing in for its message (so two cadences with
 * one message never bind to each other), a reading cadence whose metric isn't computed carrying its metric and
 * body state, then open flags due within 7 days. needs_you's flag and measurement cards are its projection.
 */
export async function dueLines(ctx: Ctx, member: Member, today: string): Promise<DueLine[]> {
  const statuses = await cadenceStatus(ctx, member.id, today);
  const ranked = stalenessTop(statuses.map(({ cadence: c, last }) => ({ name: c.name, last, everyDays: c.every_days, message: String(c.id) })), today, DUE_LIMIT);
  const lines: DueLine[] = ranked.flatMap((id): DueLine[] => {
    const st = statuses.find((x) => String(x.cadence.id) === id);
    if (!st) return [];
    const c = st.cadence;
    const base = { cadence_id: c.id, name: c.name, message: c.message, last: st.last, due_since: st.last ? addDays(st.last, c.every_days) : null };
    return c.source === "reading" && c.metric !== null && !COMPUTED_METRICS.includes(c.metric)
      ? [{ kind: "reading", ...base, metric: c.metric, body_state: c.body_state ?? null }]
      : [{ kind: "cadence", ...base }];
  });
  const flags = await all<{ id: number; subject: string; due_on: string }>(
    ctx.db,
    "SELECT id, subject, due_on FROM flag WHERE member_id = ? AND status = 'open' AND due_on IS NOT NULL AND due_on <= ? ORDER BY due_on, id",
    member.id,
    addDays(today, FLAG_WINDOW_DAYS),
  );
  // Prep whose window is open now (or opens within the horizon), one statement.
  const horizon = localHoursFromNow(ctx, NEXT_PREP_HORIZON_H);
  const floor = localHoursFromNow(ctx, -24);
  const prepRows = await all<{ id: number; action: string; who: string; due_on: string; window_start: string; window_end: string; canonical_json: string }>(
    ctx.db,
    `SELECT t.id, t.action, t.who, t.due_on, t.window_start, t.window_end, t.canonical_json
       FROM prep_task t JOIN meal_plan p ON p.id = t.meal_plan_id
      WHERE t.household_id = ?1 AND p.status = 'active' AND p.archived_at IS NULL AND p.superseded_at IS NULL
        AND t.status = 'pending' AND t.window_start <= ?2 AND t.window_end >= ?3
      ORDER BY t.window_start, t.id`,
    ctx.householdId, horizon, floor,
  );
  const name = member.name.trim().toLowerCase();
  const prep: DueLine[] = [];
  for (const row of prepRows) {
    if (row.who === "cook") continue;
    const assignees = (JSON.parse(row.canonical_json) as { assignees?: string[] }).assignees ?? [];
    if (row.who === "eater" && !assignees.some((assignee) => assignee.trim().toLowerCase() === name)) continue;
    prep.push({ kind: "prep", task_id: row.id, action: row.action, who: row.who, due_on: row.due_on, window_start: row.window_start, window_end: row.window_end, message: row.action });
  }
  return [...prep.slice(0, 6), ...lines, ...flags.map((f): DueLine => ({ kind: "flag", flag_id: f.id, subject: f.subject, due_on: f.due_on, window_days: FLAG_WINDOW_DAYS }))];
}

// ---------------------------------------------------------------- the read

export type Amount = { value: number; unit: string } | { fraction: number } | { grams: number } | { servings: number };

export interface WaitingItem {
  table: string;
  id: number;
  summary: string;
  amount: Amount | null;
  /** Null when nobody knows it (never 0 for unknown); `partial` when known for some of its parts. */
  kcal: number | null;
  protein: number | null;
  partial: { kcal: boolean; protein: boolean };
  ever_confirmed: boolean;
  edited_by: string | null;
}

export interface Totals {
  kcal: number | null;
  protein: number | null;
  unknown_items: { kcal: number; protein: number; any: number };
}

export interface WaitingHandoff {
  kind: "handoff";
  key: string;
  type: HandoffType;
  logger: { member: string | null; origin: string | null };
  logged_at: string;
  deadline: string | null;
  waits: Waits;
  question_ids: number[];
  date: string | null;
  slot: string | null;
  items: WaitingItem[];
  totals: Totals | null;
}

export interface WaitingBatch {
  kind: "batch";
  key: string;
  logger: WaitingHandoff["logger"];
  logged_at: string;
  deadline: string | null;
  days: { date: string; items: number; totals: Totals; handoffs: WaitingHandoff[] }[];
}

export type WaitingAsk = { kind: "question"; id: number; text: string; choices: string[]; asked_at: string; quote: { text: string; sent_at: string } | null; holds: { table: string; id: number }[] };

export type SettleRow = ({ kind: "remainder" } & Remainder) | { kind: "yesterday"; date: string; items: number };

export interface OnOthersRow {
  member: string;
  key: string;
  kind: "handoff" | "batch";
  type: HandoffType;
  from: string | null;
  to: string | null;
  slot: string | null;
  logged_at: string;
  deadline: string | null;
  waits: Waits;
  items: number;
  summary: string;
  records: { table: string; id: number }[];
  can_take_back: boolean;
}

export interface SentRow {
  id: number;
  date: string;
  meal_slot: string | null;
  text: string;
  created_at: string;
}

export interface WaitingOut {
  member: string;
  date: string;
  asks: WaitingAsk[];
  handoffs: (WaitingHandoff | WaitingBatch)[];
  settle: SettleRow[];
  on_others: OnOthersRow[];
  sent: SentRow[];
  due: DueLine[];
  count: number;
  truncated: boolean;
}

const FOOD = new Set(["intake_item", "portion", "leftover_serving"]);
const MACROS = ["kcal", "protein", "carbs", "fat"] as const;
const ids = (ds: readonly DraftInfo[], table: string) => JSON.stringify(ds.filter((d) => d.table === table).map((d) => d.id));

function totalsOf(parts: readonly NutrientTotals[]): Totals {
  const sum = sumNutrients([...parts]);
  const u = unknownItems(parts.map((nutrients) => ({ nutrients })), MACROS);
  return { kcal: knownValue(sum, "kcal"), protein: knownValue(sum, "protein"), unknown_items: { kcal: u.kcal, protein: u.protein, any: u.any } };
}

/** Everything waiting on a member (spec §2, §5): one drafts snapshot, one food read, one cook load, the shared rules. */
export async function waitingFor(ctx: Ctx, member: Member, today: string): Promise<WaitingOut> {
  const members = await ctx.members();
  const nameOf = (id: number | null) => (id === null ? null : (members.find((m) => m.id === id)?.name ?? null));
  const loggerOut = (l: Logger) => ({ member: nameOf(l.member), origin: l.origin });

  // The drafts snapshot (visibility first: another member's owner-only kinds are never listed, spec §2).
  const drafts = visibleDrafts(ctx, await householdDrafts(ctx));
  const units = groupHandoffs(draftsAbout(drafts, member.id));
  const { kept, truncated } = capHandoffs(units);
  const shown = kept.flatMap(unitDrafts);

  // The shown food drafts' intake rows, then one prefetch for their recipes and pots and the settle pots (one loadCooks).
  const food = shown.filter((d) => FOOD.has(d.table));
  const rows = food.length === 0 ? [] : await all<IntakeRow>(
    ctx.db,
    `SELECT * FROM intake_item WHERE id IN (SELECT value FROM json_each(?1)) OR portion_id IN (SELECT value FROM json_each(?2)) OR leftover_serving_id IN (SELECT value FROM json_each(?3))`,
    ids(food, "intake_item"), ids(food, "portion"), ids(food, "leftover_serving"),
  );
  const cookIds = await remainderCookIds(ctx, member.id, today);
  const reader = rows.length > 0 || cookIds.length > 0 ? new NutritionReader(ctx, await Catalogue.load(ctx)) : null;
  if (reader) await reader.prefetch(rows, cookIds);
  const keyOf = (r: IntakeRow) => (r.portion_id !== null ? `portion:${r.portion_id}` : r.leftover_serving_id != null ? `leftover_serving:${r.leftover_serving_id}` : `intake_item:${r.id}`);
  const rowOf = new Map(rows.map((r) => [keyOf(r), r]));
  const nutrients = new Map<string, NutrientTotals>();
  if (reader) for (const r of rows) nutrients.set(keyOf(r), await reader.itemNutrients(r));
  const readingIds = shown.filter((d) => d.table === "reading").map((d) => d.id);
  const readings = readingIds.length === 0 ? [] : await all<{ id: number; value: number; unit: string }>(ctx.db, "SELECT id, value, unit FROM reading WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(readingIds));

  const amountOf = (d: DraftInfo): Amount | null => {
    if (d.table === "reading") {
      const r = readings.find((x) => x.id === d.id);
      return r ? { value: r.value, unit: r.unit } : null;
    }
    if (d.table === "portion" || d.table === "leftover_serving") {
      const p = d.table === "portion" ? reader?.portion(d.id) : reader?.serving(d.id);
      return p ? (p.fraction !== null ? { fraction: p.fraction } : p.weighed_g !== null ? { grams: p.weighed_g } : null) : null;
    }
    const r = rowOf.get(`${d.table}:${d.id}`);
    if (!r || d.table !== "intake_item") return null;
    if (r.recipe_servings !== null) return { servings: r.recipe_servings };
    if (r.amount_value === null || r.amount_unit === null) return null;
    if (r.amount_unit === "measure") return { value: r.amount_value, unit: reader?.cat.measures.find((m) => m.id === r.measure_id)?.name ?? "measure" };
    return { value: r.amount_value, unit: r.amount_unit };
  };
  const itemOf = (d: DraftInfo): WaitingItem => {
    const n = nutrients.get(`${d.table}:${d.id}`);
    return {
      table: d.table, id: d.id, summary: d.summary, amount: amountOf(d),
      kcal: n ? knownValue(n, "kcal") : null, protein: n ? knownValue(n, "protein") : null,
      partial: { kcal: n ? partlyKnown(n, "kcal") : false, protein: n ? partlyKnown(n, "protein") : false },
      ever_confirmed: d.everConfirmed, edited_by: nameOf(d.editedBy),
    };
  };
  const handoffOut = (h: Handoff): WaitingHandoff => ({
    kind: "handoff", key: h.key, type: h.type, logger: loggerOut(h.logger), logged_at: h.loggedAt, deadline: h.deadline, waits: h.waits,
    question_ids: [...new Set(h.drafts.flatMap((d) => d.questionIds))], date: h.on, slot: h.slot, items: h.drafts.map(itemOf),
    totals: h.type === "food" ? totalsOf(h.drafts.map((d) => nutrients.get(`${d.table}:${d.id}`) ?? {})) : null,
  });
  const handoffs = kept.map((u): WaitingHandoff | WaitingBatch =>
    u.kind === "handoff"
      ? handoffOut(u)
      : {
          kind: "batch", key: u.key, logger: loggerOut(u.logger), logged_at: u.loggedAt, deadline: u.deadline,
          days: u.days.map((d) => {
            const hs = d.handoffs.map(handoffOut);
            const parts = d.handoffs.flatMap((h) => h.drafts.map((x) => nutrients.get(`${x.table}:${x.id}`) ?? {}));
            return { date: d.on, items: hs.reduce((n, h) => n + h.items.length, 0), totals: totalsOf(parts), handoffs: hs };
          }),
        },
  );

  // Durable questions only (ChatGPT reconciliation decision 6): training checks stay in next_prescription.
  const questions = await openQuestions(ctx, member.id);
  const asks: WaitingAsk[] = questions.map((q) => ({ kind: "question", id: q.id, text: q.text, choices: q.choices, asked_at: q.asked_at, quote: q.quote, holds: q.blocks }));

  // To settle: the shared remainder rule (the same reader, so no second cook load) and yesterday.
  const y = await yesterdayOpen(ctx, member.id, today);
  const settle: SettleRow[] = [...(reader ? await remaindersOf(reader, cookIds) : []).map((r) => ({ kind: "remainder" as const, ...r })), ...(y ? [{ kind: "yesterday" as const, ...y }] : [])];

  // You're waiting on others: your own drafts about others (a re-draft you made counts as yours), grouped the same way.
  const mineAboutOthers = drafts.filter((d) => d.owner !== null && d.owner !== member.id && (d.everConfirmed ? d.editedBy === member.id : d.loggedBy === member.id));
  const on_others: OnOthersRow[] = [];
  for (const owner of [...new Set(mineAboutOthers.map((d) => d.owner as number))]) {
    for (const u of groupHandoffs(mineAboutOthers.filter((d) => d.owner === owner))) {
      const ds = unitDrafts(u);
      const dates = ds.map((d) => d.on).filter((x): x is string => x !== null).sort();
      on_others.push({
        member: nameOf(owner) ?? "someone", key: u.key, kind: u.kind, type: u.kind === "batch" ? "food" : u.type,
        from: dates[0] ?? null, to: dates[dates.length - 1] ?? null, slot: u.kind === "handoff" ? u.slot : null,
        logged_at: u.loggedAt, deadline: u.deadline, waits: u.kind === "handoff" ? u.waits : null, items: ds.length,
        summary: [...new Set(ds.map((d) => d.summary))].slice(0, 3).join(", "), records: ds.map((d) => ({ table: d.table, id: d.id })),
        can_take_back: ds.every((d) => !d.everConfirmed),
      });
    }
  }

  // Sent for review, awaiting processing: the texts the member sent (Worker decision 157).
  const sent = await all<SentRow>(
    ctx.db,
    "SELECT id, entry_on AS date, meal_slot, text, created_at FROM inbox_entry WHERE created_by = ? AND status = 'pending' ORDER BY created_at, id LIMIT 100",
    member.id,
  );

  // Due lines are the Worker's, shown in Progress, and do not count in the badge (ruling 4).
  const due = await dueLines(ctx, member, today);

  return {
    member: member.name, date: today, asks, handoffs, settle, on_others, sent, due,
    count: waitingCount({ asks: asks.length, units: units as Unit[], settle: settle.length }), truncated,
  };
}
