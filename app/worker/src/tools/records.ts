import { z } from "zod";
import { ALIAS_KINDS, assertNotAnAlias } from "../aliases";
import { AMOUNT, Catalogue, checkLabelEnergy, type AmountIn } from "../catalogue";
import type { Ctx } from "../context";
import { all, first, MAX_BOUND_PARAMS, type Row } from "../db";
import { Clarify, ToolError } from "../errors";
import { computeCook, cookProblemsToClarify, cookShares, dayView, loadCook, loadCooks, NutritionReader, portionKey, shareNames, type IntakeRow } from "../nutrition";
import { AMENDABLE, OWNER_ONLY, OWNER_TEXT, RETRACTABLE } from "../owner-only";
import { authorsOf, householdsOf, lastConfirmedOf, ownersOf, STATE_TABLES } from "../records";
import { readTool, writeTool, type Tool } from "../tool";
import { derive, deriveRirAdjusted, loadImplements, type SetRow } from "../training";
import { compositionAmount } from "@myfitnessguide/domain";
import { RULE } from "./import";
import { PLATE, platesOf } from "../sets";
import { MEASURERS, readingQuestion } from "./health";
import { dropSettled } from "../questions";

const GROUP = "records";

export { OWNER_ONLY, OWNER_TEXT };

/** A row as the caller may see it: OWNER_TEXT fields null unless they may see the owner's, or wrote them (`keep`). */
export function withoutOwnerText(ctx: Ctx, table: string, owner: number | null, row: Row, keep: readonly string[] = []): Row {
  const fields = Object.hasOwn(OWNER_TEXT, table) ? (OWNER_TEXT[table] as readonly string[]) : [];
  if (fields.length === 0 || ctx.canSee(owner)) return row;
  const out: Row = { ...row };
  for (const f of fields) if (f in out && !keep.includes(f)) out[f] = null;
  return out;
}

const RECORD = z.object({ table: z.string().regex(/^[a-z_]+$/), id: z.number().int().positive() }).strict();
type RecordRef = { table: string; id: number };

/** Compatibility at the tool boundary; storage and responses stay canonical. */
const canonicalRecord = (record: RecordRef): RecordRef => ({
  ...record,
  table:
    record.table === "intake_items"
      ? "intake_item"
      : record.table === "sets" || record.table === "set"
        ? "session_set"
        : record.table,
});

export interface LoadedRecord {
  table: string;
  id: number;
  /** Null when no such record exists. */
  row: (Row & { id: number }) | null;
  owner: number | null;
  household: number | null;
}

export type Loaded = LoadedRecord & { row: Row & { id: number } };

/**
 * Owners and households of rows already in hand (history's last version,
 * or loadRecords' rows). A row about a member of this household needs no
 * household read (the cached member list answers it).
 */
export async function resolveRecords(ctx: Ctx, table: string, rows: readonly (Row & { id: number })[]): Promise<Loaded[]> {
  const owners = await ownersOf(ctx.db, table, rows);
  const members = await ctx.members();
  const ours = (o: number | null) => o !== null && members.some((m) => m.id === o);
  const open = rows.map((r, i) => typeof r.household_id !== "number" && !ours(owners[i] ?? null));
  const asked = rows.filter((_, i) => open[i]);
  const found = asked.length === 0 ? [] : await householdsOf(ctx.db, table, asked, owners.filter((_, i) => open[i]));
  let next = 0;
  return rows.map((row, i) => ({
    table,
    id: row.id,
    row,
    owner: owners[i] ?? null,
    household: typeof row.household_id === "number" ? row.household_id : open[i] ? (found[next++] ?? null) : ctx.householdId,
  }));
}

/**
 * Records by table and id (decision 125): each table's rows in one
 * statement, then their owners and households through ownersOf and
 * householdsOf. Callers check the table first (AMENDABLE, RETRACTABLE,
 * STATE_TABLES): it is written into the SQL. A missing record comes back
 * with row null; checkRecord refuses it.
 */
export async function loadRecords(ctx: Ctx, refs: readonly { table: string; id: number }[]): Promise<LoadedRecord[]> {
  const byTable = new Map<string, number[]>();
  for (const r of refs) byTable.set(r.table, [...(byTable.get(r.table) ?? []), r.id]);
  const found = new Map<string, LoadedRecord>();
  for (const [table, ids] of byTable) {
    const rows = await all<Row & { id: number }>(ctx.db, `SELECT * FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify([...new Set(ids)]));
    for (const r of await resolveRecords(ctx, table, rows)) found.set(`${table}:${r.id}`, r);
  }
  return refs.map((r) => found.get(`${r.table}:${r.id}`) ?? { table: r.table, id: r.id, row: null, owner: null, household: null });
}

/** loadRecord's refusals, in its order: not_found (missing, or another household's), then not_visible for an owner-only kind. */
export function checkRecord(ctx: Ctx, r: LoadedRecord, notFound = `no ${r.table} ${r.id}`): asserts r is Loaded {
  if (!r.row || (r.household !== null && r.household !== ctx.householdId)) throw new ToolError("not_found", notFound, 404);
  const kind = Object.hasOwn(OWNER_ONLY, r.table) ? OWNER_ONLY[r.table] : undefined;
  if (kind) ctx.assertCanSee(kind, r.owner);
}

/** One record, checked: loadRecords and checkRecord for one ref. */
async function loadRecord(ctx: Ctx, table: string, id: number): Promise<Loaded> {
  const r = (await loadRecords(ctx, [{ table, id }]))[0] as LoadedRecord;
  checkRecord(ctx, r);
  return r;
}

/** A share of a cook (a portion, or a leftover serving) and the intake item column that links to it. */
const SHARE_LINK = { portion: "portion_id", leftover_serving: "leftover_serving_id" } as const;

type Linked = { table: "portion" | "leftover_serving" | "intake_item"; row: Row & { id: number } };

/**
 * Each share's intake item, and each intake item's share (its portion,
 * else its leftover serving), keyed "<table>:<id>". The schema gives them
 * separate state, but to a member they are one thing, so every state
 * change moves both in the same write. At most three statements for any
 * number of records (decision 125).
 */
export async function linkedPortionRecords(ctx: Ctx, records: readonly { table: string; row: Row }[]): Promise<Map<string, Linked>> {
  const out = new Map<string, Linked>();
  const ids = (table: string) => records.filter((d) => d.table === table).map((d) => d.row.id as number);
  const portions = ids("portion");
  const servings = ids("leftover_serving");
  if (portions.length > 0 || servings.length > 0) {
    const items = await all<Row & { id: number }>(
      ctx.db,
      "SELECT * FROM intake_item WHERE portion_id IN (SELECT value FROM json_each(?)) OR leftover_serving_id IN (SELECT value FROM json_each(?))",
      JSON.stringify(portions),
      JSON.stringify(servings),
    );
    for (const item of items) {
      if (item.portion_id != null && portions.includes(item.portion_id as number)) out.set(`portion:${String(item.portion_id)}`, { table: "intake_item", row: item });
      if (item.leftover_serving_id != null && servings.includes(item.leftover_serving_id as number)) out.set(`leftover_serving:${String(item.leftover_serving_id)}`, { table: "intake_item", row: item });
    }
  }
  const items = records.filter((d) => d.table === "intake_item");
  for (const share of ["portion", "leftover_serving"] as const) {
    // An item links to its portion when it has one, else to its serving (as one at a time always did).
    const list = items.filter((d) => (share === "portion" ? d.row.portion_id != null : d.row.portion_id == null && d.row.leftover_serving_id != null));
    if (list.length === 0) continue;
    const parents = await all<Row & { id: number }>(ctx.db, `SELECT * FROM ${share} WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(list.map((d) => d.row[SHARE_LINK[share]] as number)));
    for (const d of list) {
      const parent = parents.find((p) => p.id === d.row[SHARE_LINK[share]]);
      if (parent) out.set(`intake_item:${String(d.row.id)}`, { table: share, row: parent });
    }
  }
  return out;
}

/** One record's partner: linkedPortionRecords for one record. */
export async function linkedPortionRecord(ctx: Ctx, table: string, row: Row): Promise<Linked | null> {
  return (await linkedPortionRecords(ctx, [{ table, row }])).get(`${table}:${String(row.id)}`) ?? null;
}

/**
 * A share of a pot was removed or reduced, so a leftover it had eaten up may be back: clear
 * settled_on on those components' leftover marks, in this same write (each mark versioned).
 * settled_on only bounds the household's open-leftover read; the computed remainder is the
 * truth, so if nothing is left after all, that read finds no remainder and lists nothing.
 */
export function reopenLeftovers(ctx: Ctx, componentIds: readonly number[]): void {
  const ids = [...new Set(componentIds)];
  const tx = ctx.txOrThrow;
  // Set-based, with no read first: each settled mark gets an 'amend' version (its full row with settled_on
  // null, as WriteTx.update writes it), then the marks are cleared. Two statements per 98 components.
  // Its own INSERT, not versionsAcross: the rows are built in SQL, and versionsAcross would need a read first.
  for (let i = 0; i < ids.length; i += MAX_BOUND_PARAMS - 2) {
    const chunk = ids.slice(i, i + MAX_BOUND_PARAMS - 2);
    const where = `disposition = 'leftover' AND settled_on IS NOT NULL AND component_id IN (${chunk.map(() => "?").join(", ")})`;
    tx.exec(
      `INSERT INTO record_version (write_id, table_name, record_id, version, action, data, created_at)
       SELECT ?, 'remainder_disposition', d.id,
              (SELECT coalesce(max(version), 0) + 1 FROM record_version WHERE table_name = 'remainder_disposition' AND record_id = d.id), 'amend',
              json_object('id', d.id, 'component_id', d.component_id, 'disposition', d.disposition, 'amount_kind', d.amount_kind, 'fraction', d.fraction,
                          'weighed_g', d.weighed_g, 'recorded_on', d.recorded_on, 'provenance', d.provenance, 'note', d.note, 'settled_on', NULL), ?
       FROM remainder_disposition d WHERE ${where}`,
      tx.writeId, tx.at, ...chunk,
    );
    tx.exec(`UPDATE remainder_disposition SET settled_on = NULL WHERE ${where}`, ...chunk);
  }
}

/** The components whose pot loses a share when these records go. */
const shareComponents = (records: readonly { table: string; row: Row }[]) =>
  records.filter((x) => x.table === "portion" || x.table === "leftover_serving").map((x) => x.row.component_id as number);

async function nextVersion(ctx: Ctx, table: string, id: number): Promise<number> {
  return ((await first<{ v: number }>(ctx.db, "SELECT coalesce(max(version), 0) + 1 AS v FROM record_version WHERE table_name = ? AND record_id = ?", table, id))?.v ?? 1);
}

/**
 * Recompute what depends on an amended record, and enforce the rules that span rows.
 * For a pot, `effects.leftovers` gets the components whose recomputed remainder is a
 * leftover with food in it (the amend may have brought back one a serving had eaten up).
 */
async function recompute(
  ctx: Ctx,
  table: string,
  after: Row,
  effects: { leftovers?: number[] } = {},
  /** A reading's member field the caller used, so a question points at it: measurer_member (a name, the default) or measurer_member_id. */
  measurerField: "measurer_member" | "measurer_member_id" = "measurer_member",
): Promise<Record<string, unknown> | null> {
  switch (table) {
    case "intake_item": {
      const cat = await Catalogue.load(ctx);
      return { nutrients: await new NutritionReader(ctx, cat).itemNutrients(after as unknown as IntakeRow) };
    }
    case "portion":
    case "component":
    case "cook_line": {
      const cat = await Catalogue.load(ctx);
      const cookId =
        table === "portion"
          ? (await first<{ cook_id: number }>(ctx.db, "SELECT cook_id FROM component WHERE id = ?", after.component_id as number))?.cook_id
          : table === "component"
            ? (after.cook_id as number)
            : (await first<{ cook_id: number }>(ctx.db, "SELECT cook_id FROM component WHERE id = ?", after.component_id as number))?.cook_id;
      const loaded = await loadCook(ctx, cat, cookId as number);
      const swap = <T extends { id: number }>(rows: T[]) => rows.map((r) => (r.id === after.id ? ({ ...r, ...after } as T) : r));
      const portions = table === "portion" ? swap(loaded.portions) : loaded.portions;
      const components = table === "component" ? swap(loaded.components) : loaded.components;
      const lines = table === "cook_line" ? swap(loaded.lines) : loaded.lines;
      const result = computeCook(cat, components, lines, cookShares({ portions, servings: loaded.servings }), loaded.marks);
      cookProblemsToClarify(result.problems, ["changes"], await shareNames(ctx, { portions, servings: loaded.servings }));
      effects.leftovers = components.filter((c) => result.remainder.some((r) => r.component === c.name && r.status === "leftover")).map((c) => c.id);
      const mine = table === "portion" ? result.portions.find((p) => p.member === portionKey(after.id as number)) : null;
      return { cook_id: cookId, nutrients: mine?.nutrients ?? null, totals: result.totals, remainder: result.remainder };
    }
    case "session_set": {
      const set = after as unknown as SetRow;
      const implement = set.load_implement_id ? ((await loadImplements(ctx, { ids: [set.load_implement_id] }))[0] ?? null) : null;
      const exercise = await first<{ bodyweight_dominant: number; implement_kind: string }>(ctx.db, "SELECT bodyweight_dominant, implement_kind FROM exercise WHERE id = ?", set.exercise_id);
      const d = derive(set, implement, exercise ?? undefined);
      const rirEstimate = deriveRirAdjusted(set, implement, exercise ?? undefined);
      return { total_kg: d?.totalKg ?? null, volume_kg: d?.volumeKg ?? null, e1rm_kg: d?.e1rmKg ?? null, e1rm_rir_kg: rirEstimate?.e1rmKg ?? null };
    }
    case "reading": {
      // measurer and its member move together: "member" needs one of ours, everything else needs none.
      // The questions point at the member field the caller used (measurer_member, a name, unless they gave the id).
      const measurer = after.measurer as string | null;
      const who = after.measurer_member_id as number | null;
      const at = ["changes", measurerField];
      // The schema's NOT NULL and CHECK would refuse anything else as a raw constraint error; ask instead.
      if (measurer === null || !(MEASURERS as readonly string[]).includes(measurer)) throw new Clarify("invalid_measurer", `A measurer is one of ${MEASURERS.join(", ")}.`, [...MEASURERS], ["changes", "measurer"]);
      if (measurer === "member") {
        const members = await ctx.members();
        if (who == null) {
          throw new Clarify("measurer_needed", "Which member took the measurement?", members.map((m) => m.name), at);
        }
        if (!members.some((m) => m.id === who)) {
          throw new Clarify("measurer_needed", "That is not a member of this household.", members.map((m) => m.name), at);
        }
      } else if (who != null) {
        throw new Clarify("measurer_member_unused", `The measurer is "${measurer}", so no member takes the credit; clear ${measurerField} (null) or set measurer to "member".`, [], at);
      }
      return null;
    }
    case "phase": {
      const overlap = await first<{ name: string }>(
        ctx.db,
        "SELECT name FROM phase WHERE member_id = ? AND id <> ? AND starts_on <= coalesce(?, '9999-12-31') AND coalesce(ends_on, '9999-12-31') >= ?",
        after.member_id as number,
        after.id as number,
        (after.ends_on as string | null) ?? null,
        after.starts_on as string,
      );
      if (overlap) throw new Clarify("phase_overlap", `That overlaps the ${overlap.name} phase.`, [overlap.name], ["changes"]);
      return null;
    }
    case "prescription": {
      try {
        const json = (after.progression_rule as string | null) ?? null;
        if (json !== null && !RULE.safeParse(JSON.parse(json)).success) throw new SyntaxError("not a rule");
      } catch {
        throw new Clarify("invalid_rule", "The progression rule isn't a valid rule (rep_top or manual).", [], ["changes", "progression_rule"]);
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * A rename onto another record's name asks, as upsert_food_source and
 * upsert_recipe do (decision 127), instead of failing on the UNIQUE name:
 * a food clashes with another of the same name (ignoring case) and state,
 * a recipe with another of the same name.
 */
async function assertNameFree(ctx: Ctx, table: "food_source" | "recipe", name: string, before: Row & { id: number }): Promise<void> {
  const wanted = name.trim();
  const twin =
    table === "food_source"
      ? await first<{ ref: string }>(ctx.db, "SELECT ref FROM food_source WHERE household_id = ? AND name = ? COLLATE NOCASE AND state = ? AND id <> ?", ctx.householdId, wanted, before.state as string, before.id)
      : await first<{ ref: string }>(ctx.db, "SELECT ref FROM recipe WHERE household_id = ? AND name = ? COLLATE NOCASE AND id <> ?", ctx.householdId, wanted, before.id);
  if (!twin) return;
  if (table === "food_source") {
    throw new Clarify("duplicate_food_source", `${wanted} (${String(before.state)}) already exists as ${twin.ref}. Use that one, or choose another name?`, [twin.ref], ["changes", "name"]);
  }
  throw new Clarify("duplicate_recipe", `A recipe called ${wanted} already exists as ${twin.ref}. Use it, or choose another name?`, [twin.ref], ["changes", "name"]);
}

/** What amend takes on a food item instead of its stored amount columns: the amount as log_intake takes it. */
const AMOUNT_WORDS: readonly string[] = ["measure", "unit"];

/** A reading's measurer, by name as log_reading takes it (null clears it): amend resolves it to measurer_member_id. */
const MEASURER_WORDS: readonly string[] = ["measurer_member"];
const AMOUNT_UNITS = AMOUNT.unit.unwrap().options as readonly string[];

/**
 * A food item's amount with a new measure or unit (click test P2-8): the
 * value with a measure, or with a unit, resolved through the catalogue as
 * log_intake resolves it (the item's food pinned by its ref, so its state
 * stays), into the stored columns. Takes `measure` / `unit` out of changes.
 */
async function amountColumns(ctx: Ctx, before: Row, changes: Row): Promise<Row> {
  const measure = changes.measure;
  const unit = changes.unit;
  delete changes.measure;
  delete changes.unit;
  if (before.source_kind !== "food_source") throw new ToolError("not_amendable", "only a food item's amount has a measure or a unit", 400);
  const hasMeasure = measure !== undefined && measure !== null;
  const hasUnit = unit !== undefined && unit !== null;
  if (hasMeasure === hasUnit) throw new ToolError("measure_or_unit", "give the amount's measure or its unit, not both", 400);
  if (hasMeasure && (typeof measure !== "string" || measure.trim() === "")) throw new ToolError("invalid_measure", "a measure is its name, e.g. tsp or egg", 400);
  if (hasUnit && (typeof unit !== "string" || !AMOUNT_UNITS.includes(unit))) throw new ToolError("invalid_unit", `a unit is one of ${AMOUNT_UNITS.join(", ")}`, 400);
  const value = changes.amount_value;
  if (value === undefined || value === null) throw new Clarify("amount_needed", "How much, in the new measure?", [], ["changes", "amount_value"]);
  if (typeof value !== "number" || !(value > 0)) throw new ToolError("invalid_amount", "an amount is a number above 0", 400);
  const cat = await Catalogue.load(ctx);
  const food = cat.row(before.food_source_id as number).ref;
  const amount: AmountIn = hasMeasure ? { food, value, measure: (measure as string).trim() } : { food, value, unit: unit as AmountIn["unit"] };
  return cat.resolve(amount, ["changes", hasMeasure ? "measure" : "unit"]).stored;
}

const amend = writeTool({
  name: "amend",
  group: GROUP,
  description:
    "Change fields of one record with a reason, keeping every version. Returns before, after, the new version number and whatever it recomputed (nutrients, cook remainder, set total/volume/e1RM). A food item's amount takes a new measure as log_intake does: amount_value with measure (a named measure of the food) or unit, never both. A reading's measurer can be set after the fact: measurer with measurer_member (a member's name, as log_reading takes it; null clears it) when it is \"member\". The member's own edit of a draft about them confirms it; anyone else's edit of a member's confirmed record makes it a draft for that member again (state, draft_for). Changing a household meal's eaten_on or meal_slot moves its intake items with it in the same write (computed.cascaded).",
  input: {
    record: RECORD,
    changes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    reason: z.string().min(1),
    implausible_ok: z.literal(true).optional().describe("A reading's new value or unit is right although it is implausible (as log_reading's implausible_ok)."),
  },
  async run(ctx, input) {
    const { table, id } = canonicalRecord(input.record);
    const fields = Object.hasOwn(AMENDABLE, table) ? AMENDABLE[table] : undefined;
    if (!fields) {
      const singular = table.endsWith("s") ? table.slice(0, -1) : null;
      if (singular !== null && Object.hasOwn(AMENDABLE, singular)) {
        throw new ToolError("unknown_table", `unknown table ${table} (did you mean ${singular}?); amendable: ${Object.keys(AMENDABLE).join(", ")}`, 400);
      }
      throw new ToolError("not_amendable", `${table} records can't be amended`, 400);
    }
    const words = table === "intake_item" ? AMOUNT_WORDS : table === "reading" ? MEASURER_WORDS : [];
    const bad = Object.keys(input.changes).filter((k) => !fields.includes(k) && !words.includes(k));
    if (bad.length > 0) throw new ToolError("not_amendable", `can't amend ${bad.join(", ")} on ${table}; amendable: ${fields.join(", ")}`, 400);
    if (Object.keys(input.changes).length === 0) throw new ToolError("no_changes", "give at least one change", 400);

    const loaded = await loadRecord(ctx, table, id);
    const before = loaded.row;
    // A leftover serving's item is decided through its serving, and its amount is the serving's.
    if (table === "intake_item" && before.leftover_serving_id != null) {
      throw new ToolError("amend_the_serving", `intake_item ${id} is a leftover serving's item; retract leftover_serving ${String(before.leftover_serving_id)} and log a new serving instead`, 400);
    }
    const owner = loaded.owner;
    ctx.onBehalfOf(owner);
    const changes: Row = {};
    for (const [k, v] of Object.entries(input.changes)) changes[k] = typeof v === "boolean" ? (v ? 1 : 0) : v;
    // A food item's new measure or unit is resolved as log_intake resolves an amount (click test P2-8).
    if (table === "intake_item" && AMOUNT_WORDS.some((k) => k in changes)) Object.assign(changes, await amountColumns(ctx, before, changes));
    // A reading's measurer by name: one of ours, resolved as log_reading resolves it; null clears it.
    if (table === "reading" && "measurer_member" in changes) {
      if ("measurer_member_id" in changes) throw new ToolError("measurer_member_or_id", "give measurer_member or measurer_member_id, not both", 400);
      const name = changes.measurer_member;
      delete changes.measurer_member;
      if (name !== null && typeof name !== "string") throw new Clarify("measurer_needed", "Which member took the measurement?", (await ctx.members()).map((m) => m.name), ["changes", "measurer_member"]);
      changes.measurer_member_id = name === null ? null : (await ctx.member(name, ["changes", "measurer_member"])).id;
    }
    // A member id given as text ("2") is that id; any other text is not an id, so ask for the member.
    if (table === "reading" && "measurer_member_id" in input.changes && typeof changes.measurer_member_id === "string") {
      const raw = changes.measurer_member_id.trim();
      if (!/^\d+$/.test(raw)) {
        throw new Clarify("measurer_needed", "Which member took the measurement? Give their name as measurer_member, or their id.", (await ctx.members()).map((m) => m.name), ["changes", "measurer_member_id"]);
      }
      changes.measurer_member_id = Number(raw);
    }
    // Reps the member states are reported, not inferred, unless the change says otherwise.
    if (table === "session_set" && "reps" in changes && !("reps_inferred" in changes) && before.reps_inferred === 1) changes.reps_inferred = 0;
    // A composition's per-side load is its plates' sum: keep load_value / load_unit equal to it.
    if ((table === "session_set" || table === "workout_line") && typeof changes.plates === "string") {
      let parsed: ReturnType<typeof platesOf>;
      try {
        parsed = platesOf(z.array(PLATE).min(1).parse(JSON.parse(changes.plates)));
      } catch {
        throw new Clarify("invalid_plates", "Plates are a list of {value, unit, count} on each side.", [], ["changes", "plates"]);
      }
      const amount = compositionAmount(parsed);
      changes.plates = JSON.stringify(parsed);
      changes.load_value = amount.value;
      changes.load_unit = amount.unit;
      if (table === "workout_line") {
        changes.load_kind = "plates";
        changes.load_basis = "per_side";
      }
    }
    const after: Row = { ...before, ...changes };
    // A reading's new value or unit is checked as log_reading checks a new one (click test P1-2).
    if (table === "reading" && ("value" in changes || "unit" in changes) && !input.implausible_ok && ctx.writeInfo.origin !== "import") {
      const metric = await first<{ label: string; dimension: string }>(ctx.db, "SELECT label, dimension FROM metric WHERE code = ?", String(after.metric));
      const ask = metric
        ? await readingQuestion(
            ctx,
            {
              member_id: after.member_id as number, metric: after.metric as string, label: metric.label, dimension: metric.dimension, value: Number(after.value),
              unit: String(after.unit), side: (after.side as string | null) ?? null, measured_on: after.measured_on as string, id,
            },
            ["implausible_ok"],
          )
        : null;
      if (ask) throw ask;
    }
    // One meaning per word (spec §6): a rename can't take a word the household uses for something,
    // nor another record's name (decision 127).
    if (
      (ALIAS_KINDS as readonly string[]).includes(table) &&
      typeof changes.name === "string" &&
      changes.name.trim().toLowerCase() !== String(before.name).trim().toLowerCase()
    ) {
      await assertNotAnAlias(ctx, changes.name, ["changes", "name"]);
      if (table === "food_source" || table === "recipe") await assertNameFree(ctx, table, changes.name, before as Row & { id: number });
    }

    if (table === "session_set" && after.state === "confirmed" && after.rir_status !== "recorded" && owner !== null) {
      const member = await ctx.memberById(owner);
      if (member.programming_mode === "prescribed" && before.rir_status === "recorded") {
        throw new Clarify("rir_needed", "A confirmed set of a prescribed member keeps a recorded RIR.", [], ["changes", "rir_status"]);
      }
    }
    // An edit of a member's confirmed record by anyone else (another member, the agent talking with another
    // member, or the Inbox naming no one or another member) makes it a draft again, so its member is asked again; the 48 h runs from this edit (ticket 69).
    // Household records (no owner) are nobody's to consent to and keep their state.
    // The member's own edit never re-drafts, whatever the origin (the Inbox included; review P2-1).
    const redraft =
      (STATE_TABLES as readonly string[]).includes(table) && owner !== null && before.state === "confirmed" && ctx.stateFor(owner) !== "confirmed" && owner !== ctx.writeInfo.speaker?.id;
    if (redraft) {
      changes.state = "draft";
      changes.confirmed_at = null;
      after.state = "draft";
      after.confirmed_at = null;
    }
    // The edit of a draft by the member it concerns (or the agent talking with them) is acceptance.
    if ((STATE_TABLES as readonly string[]).includes(table) && before.state === "draft" && ctx.stateFor(owner) === "confirmed" && ctx.writeInfo.origin !== "coach") {
      const blankRir = table === "session_set" && after.rir_status === null;
      if (!blankRir) {
        changes.state = "confirmed";
        changes.confirmed_at = ctx.nowIso();
        after.state = "confirmed";
        after.confirmed_at = changes.confirmed_at;
      }
    }
    const effects: { leftovers?: number[] } = {};
    let computed = await recompute(ctx, table, after, effects, "measurer_member_id" in input.changes ? "measurer_member_id" : "measurer_member");
    // A corrected label is checked like a new one (upsert_food_source).
    if (table === "food_source" && ["kcal", "protein_g", "carbs_g", "fat_g", "energy_override_reason"].some((k) => k in changes)) {
      const energy = checkLabelEnergy(after as { kcal: number; protein_g: number; carbs_g: number; fat_g: number; energy_override_reason: string | null }, ["changes", "kcal"]);
      computed = { ...(computed ?? {}), energy_check: energy };
    }
    // Accepting a portion accepts its intake item (and the other way round) in the same write.
    if (changes.state === "confirmed") {
      const linked = await linkedPortionRecord(ctx, table, before);
      if (linked && linked.row.state === "draft") {
        const confirmed = { state: "confirmed", confirmed_at: changes.confirmed_at };
        ctx.txOrThrow.update(linked.table, linked.row.id, confirmed, { ...linked.row, ...confirmed }, "confirm");
        computed = { ...(computed ?? {}), linked: { table: linked.table, id: linked.row.id, state: "confirmed" } };
      }
    }
    // ...and a share and its item become drafts again together.
    if (redraft) {
      const linked = await linkedPortionRecord(ctx, table, before);
      if (linked && linked.row.state === "confirmed") {
        const drafted = { state: "draft", confirmed_at: null };
        ctx.txOrThrow.update(linked.table, linked.row.id, drafted, { ...linked.row, ...drafted });
        computed = { ...(computed ?? {}), linked: { table: linked.table, id: linked.row.id, state: "draft" } };
      }
    }
    const version = await nextVersion(ctx, table, id);
    ctx.txOrThrow.update(table, id, changes, after);
    // A meal's items belong to it: moving the meal's date or slot moves them too,
    // in the same write, so day_meals never leaves food under the old slot.
    let cascaded: { table: "intake_item"; ids: number[]; eaten_on: string; meal_slot: string } | null = null;
    if (table === "household_meal" && ("eaten_on" in changes || "meal_slot" in changes)) {
      const items = await all<Row & { id: number }>(ctx.db, "SELECT * FROM intake_item WHERE household_meal_id = ? ORDER BY id", id);
      if (items.length > 0) {
        const eatenOn = String(after.eaten_on);
        const mealSlot = String(after.meal_slot);
        const moved = items.map((item) => ({ ...item, eaten_on: eatenOn, meal_slot: mealSlot }));
        ctx.txOrThrow.exec("UPDATE intake_item SET eaten_on = ?1, meal_slot = ?2 WHERE household_meal_id = ?3", eatenOn, mealSlot, id);
        ctx.txOrThrow.versions("intake_item", "amend", moved.map((item) => ({ id: item.id, data: item })));
        cascaded = { table: "intake_item", ids: moved.map((item) => item.id), eaten_on: eatenOn, meal_slot: mealSlot };
      }
    }
    // A smaller portion may bring back a leftover a serving had eaten up.
    if (table === "portion" && ("fraction" in changes || "weighed_g" in changes)) reopenLeftovers(ctx, [before.component_id as number]);
    // A changed cooked weight (or a cook line) can leave food in a pot a weighed serving had eaten up: re-open
    // each of the pot's leftovers the recomputed remainder still holds. A line's amount moves no fraction today,
    // but a mark left settled by an earlier amend is cleared all the same.
    if ((table === "component" || table === "cook_line") && effects.leftovers && effects.leftovers.length > 0) reopenLeftovers(ctx, effects.leftovers);
    // Another member's note stays theirs: only a field this amend wrote comes back (decision 137).
    const shown = (row: Row) => withoutOwnerText(ctx, table, owner, row, Object.keys(input.changes));
    if (before.state === "draft" && after.state === "confirmed") {
      const linked = (computed as { linked?: { table: string; id: number; state: string } } | null | undefined)?.linked;
      await dropSettled(ctx, [{ table, id }, ...(linked?.state === "confirmed" ? [{ table: linked.table, id: linked.id }] : [])]);
    }
    // A state record says what it is now, and whose draft when it is a draft about another member (as log_intake's items say).
    const state = (STATE_TABLES as readonly string[]).includes(table) ? { state: after.state } : {};
    const draftFor = after.state === "draft" && owner !== null && owner !== ctx.writeInfo.speaker?.id ? { draft_for: (await ctx.memberById(owner)).name } : {};
    return { record: { table, id }, version, ...state, ...draftFor, before: withoutOwnerText(ctx, table, owner, before), after: shown(after), computed: cascaded ? { ...(computed ?? {}), cascaded } : computed };
  },
});

/** The most records one confirm or reject names: twice the app's 100-row "Waiting on you" list. */
export const MAX_DECIDE = 200;

/** Records that go with a draft when it is rejected (dependents()), for the author's check: whether each is stateful. */
const CHILDREN: Record<string, readonly { table: string; column: string; stateful: boolean; what: string }[]> = {
  session: [
    { table: "session_set", column: "session_id", stateful: true, what: "sets" },
    { table: "cardio_block", column: "session_id", stateful: false, what: "blocks" },
  ],
  blood_draw: [{ table: "lab_result", column: "draw_id", stateful: false, what: "results" }],
};

/**
 * Who may confirm or reject a draft: the member it concerns, or the agent
 * talking with them. A draft's author (the drafts list's logged_by: the
 * member through the app, or the member the agent was talking with) may
 * also reject it while nobody has consented to it: never once any version
 * of it was confirmed, never from the Inbox, and, for a session or a draw,
 * only when every set, block or result that goes with it is theirs too
 * (and every set a never-confirmed draft): a rejected session takes its
 * sets (ticket 69, review P0-1). Confirm stays the member's alone. Every
 * named record loads through loadRecords (one statement per table, decision
 * 125); a reject naming a draft that isn't the speaker's reads its authors
 * in one more statement, and a session's or draw's children in one before
 * that. The checks then run in the records' order, as they always did:
 * no_state, not_found, not_visible, then not_yours_to_decide and not_draft
 * with the record's index.
 */
async function decide(ctx: Ctx, records: { table: string; id: number }[], action: "confirm" | "reject") {
  const isState = (t: string) => (STATE_TABLES as readonly string[]).includes(t);
  const loaded = new Map((await loadRecords(ctx, records.filter((r) => isState(r.table)))).map((l) => [`${l.table}:${l.id}`, l]));
  const speaker = ctx.writeInfo.speaker;
  const byAuthor = action === "reject" && speaker !== null && ctx.writeInfo.origin !== "inbox";
  const asked = byAuthor ? [...loaded.values()].filter((l) => l.row?.state === "draft" && ctx.stateFor(l.owner) !== "confirmed") : [];
  const children = await childrenOf(ctx, asked);
  const authors = await authorsOf(ctx.db, [...asked, ...children]);
  const theirs = (r: { table: string; id: number }) => {
    const a = authors.get(`${r.table}:${r.id}`);
    return a !== undefined && !a.everConfirmed && a.loggedBy === speaker?.id;
  };
  /** Why the author may not reject it: not theirs, or a child that isn't (its kind); null when they may. */
  const authorRefusal = (l: LoadedRecord): string | null => {
    if (!theirs(l)) return "draft";
    const bad = children.find((c) => c.parent === `${l.table}:${l.id}` && (!theirs(c) || (c.state !== null && c.state !== "draft")));
    return bad ? bad.what : null;
  };
  const out = [];
  for (const [i, r] of records.entries()) {
    if (!isState(r.table)) throw new ToolError("no_state", `${r.table} records have no draft state`, 400);
    const l = loaded.get(`${r.table}:${r.id}`) as LoadedRecord;
    checkRecord(ctx, l);
    if (ctx.stateFor(l.owner) !== "confirmed") {
      const why = action === "reject" && byAuthor ? authorRefusal(l) : "draft";
      if (why === "draft") {
        const who = action === "reject" ? "only the member a draft is about (or the agent talking with them), or who logged it while it was never confirmed," : "only the member a draft is about (or the agent talking with them)";
        throw new ToolError("not_yours_to_decide", `${who} can ${action} it`, 403, { index: i });
      }
      if (why !== null) {
        const name = l.owner === null ? "its member" : (await ctx.memberById(l.owner)).name;
        throw new ToolError("not_yours_to_decide", `only ${name} can reject ${r.table} ${r.id}: ${name} has logged ${why} in it, or some are confirmed, and they would go with it`, 403, { index: i });
      }
    }
    if (l.row.state !== "draft") throw new ToolError("not_draft", `${r.table} ${r.id} is already confirmed`, 409, { index: i });
    out.push({ ...r, row: l.row, owner: l.owner });
  }
  return out;
}

/** The sets, blocks and results of these sessions and draws (CHILDREN), in one statement; none when there are none. */
async function childrenOf(ctx: Ctx, parents: readonly LoadedRecord[]): Promise<{ table: string; id: number; parent: string; state: string | null; what: string }[]> {
  const terms: string[] = [];
  const params: string[] = [];
  for (const [table, kids] of Object.entries(CHILDREN)) {
    const ids = parents.filter((p) => p.table === table).map((p) => p.id);
    if (ids.length === 0) continue;
    for (const k of kids) {
      terms.push(`SELECT '${k.table}' AS tbl, id, '${table}:' || ${k.column} AS parent, ${k.stateful ? "state" : "NULL"} AS state, '${k.what}' AS what FROM ${k.table} WHERE ${k.column} IN (SELECT value FROM json_each(?))`);
      params.push(JSON.stringify(ids));
    }
  }
  if (terms.length === 0) return [];
  const rows = await all<{ tbl: string; id: number; parent: string; state: string | null; what: string }>(ctx.db, terms.join(" UNION ALL "), ...params);
  return rows.map((r) => ({ table: r.tbl, id: r.id, parent: r.parent, state: r.state, what: r.what }));
}

const confirm = writeTool({
  name: "confirm",
  group: GROUP,
  description:
    "Confirm draft records. Only the member a draft is about can confirm it, through the app or while the agent is talking with them. A portion (or a leftover serving) and its intake item are confirmed together.",
  input: { records: z.array(RECORD).min(1).max(MAX_DECIDE) },
  async run(ctx, input) {
    const named = await decide(ctx, input.records.map(canonicalRecord), "confirm");
    // A portion brings its draft intake item (and an intake item its portion), each confirmed once.
    const links = await linkedPortionRecords(ctx, named);
    const decided: typeof named = [];
    const seen = new Set<string>();
    const take = (d: (typeof named)[number]) => {
      if (seen.has(`${d.table}:${d.id}`)) return;
      seen.add(`${d.table}:${d.id}`);
      decided.push(d);
    };
    for (const d of named) {
      take(d);
      const linked = links.get(`${d.table}:${d.id}`);
      if (linked && linked.row.state === "draft") take({ table: linked.table, id: linked.row.id, row: linked.row, owner: d.owner });
    }
    const now = ctx.nowIso();
    for (const d of decided) {
      if (d.table === "session_set" && d.row.rir_status === null) {
        const member = await ctx.memberById(d.owner as number);
        if (member.programming_mode === "prescribed") throw new Clarify("rir_needed", "That set has no RIR yet; amend it with the RIR first.", [d.id], ["records"]);
      }
    }
    // One UPDATE per table and every version in one statement (decision 126): the same rows and versions as one at a time.
    const tx = ctx.txOrThrow;
    for (const table of [...new Set(decided.map((d) => d.table))]) {
      const ids = decided.filter((d) => d.table === table).map((d) => d.id);
      const blankRir = table === "session_set" ? ", rir_status = coalesce(rir_status, 'not_recorded')" : "";
      tx.exec(`UPDATE ${table} SET state = 'confirmed', confirmed_at = ?${blankRir} WHERE id IN (SELECT value FROM json_each(?))`, now, JSON.stringify(ids));
    }
    tx.versionsAcross(
      "confirm",
      decided.map((d) => {
        const changes: Row = { state: "confirmed", confirmed_at: now };
        if (d.table === "session_set" && d.row.rir_status === null) changes.rir_status = "not_recorded";
        return { table: d.table, id: d.id, data: { ...d.row, ...changes } };
      }),
    );
    await dropSettled(ctx, decided.map((d) => ({ table: d.table, id: d.id })));
    if (decided.length === 1) ctx.onBehalfOf(decided[0]?.owner ?? null);
    return { confirmed: decided.map((d) => ({ table: d.table, id: d.id })) };
  },
});

/** Records that go with a rejected draft, deleted before it (children first). */
async function dependents(ctx: Ctx, table: string, id: number): Promise<{ table: string; row: Row & { id: number } }[]> {
  const rows = async (t: string, sql: string) => (await all<Row & { id: number }>(ctx.db, sql, id)).map((row) => ({ table: t, row }));
  switch (table) {
    case "portion":
      return rows("intake_item", "SELECT * FROM intake_item WHERE portion_id = ?");
    case "leftover_serving":
      return rows("intake_item", "SELECT * FROM intake_item WHERE leftover_serving_id = ?");
    case "session":
      return [...(await rows("session_set", "SELECT * FROM session_set WHERE session_id = ?")), ...(await rows("cardio_block", "SELECT * FROM cardio_block WHERE session_id = ?"))];
    case "blood_draw":
      return rows("lab_result", "SELECT * FROM lab_result WHERE draw_id = ?");
    case "cook":
    case "household_meal":
      throw new ToolError("reject_parts", `reject the ${table}'s portions and items instead; the ${table} itself stays`, 400);
    default:
      return [];
  }
}

type Confirmed = { data: Row; latest: number };
type Restored = { table: string; id: number; version: number; computed?: Record<string, unknown> };

/** What a restore puts back: what amend can change (and a food item's stored amount), and the state. */
const restoreKeys = (table: string): string[] => [...(AMENDABLE[table] ?? []), ...(table === "intake_item" ? ["amount_unit", "measure_id"] : []), "state", "confirmed_at"];

/**
 * Put back the version each record's member last confirmed (ticket 69, decision 154), set-based
 * (decision 96, re-review P1-R1): one UPDATE per table from one JSON of every row's values, every
 * version in one versionsAcross, the catalogue loaded once, every pot recomputed once from one
 * loadCooks (its problems asked as amend asks them), and sets derived from one implements read.
 * A constant number of statements however many records.
 */
async function restoreConfirmed(ctx: Ctx, records: readonly { table: string; id: number; row: Row & { id: number }; before: Confirmed }[]): Promise<{ restored: Restored[]; pots: Record<string, unknown>[] }> {
  const tx = ctx.txOrThrow;
  const afters = records.map((r) => {
    const keys = restoreKeys(r.table).filter((k) => k in r.row);
    const values: Row = {};
    for (const k of keys) values[k] = (k in r.before.data ? r.before.data[k] : r.row[k]) as Row[string];
    return { ...r, keys, after: { ...r.row, ...values } as Row & { id: number } };
  });
  for (const table of [...new Set(afters.map((a) => a.table))]) {
    const rows = afters.filter((a) => a.table === table);
    const keys = (rows[0] as (typeof rows)[number]).keys;
    const json = JSON.stringify(rows.map((a) => Object.fromEntries([["id", a.id], ...keys.map((k) => [k, a.after[k]])])));
    const set = keys.map((k) => `${k} = (SELECT json_extract(j.value, '$.${k}') FROM json_each(?1) j WHERE json_extract(j.value, '$.id') = ${table}.id)`).join(", ");
    tx.exec(`UPDATE ${table} SET ${set} WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))`, json);
  }
  tx.versionsAcross("amend", afters.map((a) => ({ table: a.table, id: a.id, data: a.after })));

  const computed = new Map<string, Record<string, unknown>>();
  const pots: Record<string, unknown>[] = [];
  const of = (table: string) => afters.filter((a) => a.table === table);
  const shares = of("portion");
  const items = of("intake_item");
  if (shares.length > 0 || items.some((a) => a.after.portion_id == null && a.after.leftover_serving_id == null)) {
    const cat = await Catalogue.load(ctx);
    if (shares.length > 0) {
      const components = await all<{ id: number; cook_id: number }>(ctx.db, "SELECT id, cook_id FROM component WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify([...new Set(shares.map((a) => a.after.component_id as number))]));
      const cookOf = new Map(components.map((c) => [c.id, c.cook_id]));
      const cooks = await loadCooks(ctx, cat, [...new Set(components.map((c) => c.cook_id))]);
      for (const [cookId, loaded] of cooks) {
        const mine = shares.filter((a) => cookOf.get(a.after.component_id as number) === cookId);
        const portions = loaded.portions.map((p) => ({ ...p, ...(mine.find((a) => a.id === p.id)?.after ?? {}) }));
        const result = computeCook(cat, loaded.components, loaded.lines, cookShares({ portions, servings: loaded.servings }), loaded.marks);
        cookProblemsToClarify(result.problems, ["records"], await shareNames(ctx, { portions, servings: loaded.servings }));
        pots.push({ cook_id: cookId, totals: result.totals, remainder: result.remainder });
        for (const a of mine) {
          const nutrients = result.portions.find((p) => p.member === portionKey(a.id))?.nutrients ?? null;
          computed.set(`portion:${a.id}`, { cook_id: cookId, nutrients });
          const item = items.find((i) => i.after.portion_id === a.id);
          if (item) computed.set(`intake_item:${item.id}`, { nutrients });
        }
      }
    }
    // A plain item's nutrients from the catalogue (its recipes read once); a share's came from its pot above.
    const plain = items.filter((a) => a.after.portion_id == null && a.after.leftover_serving_id == null);
    if (plain.length > 0) {
      const reader = new NutritionReader(ctx, cat);
      await reader.prefetch(plain.map((a) => a.after as unknown as IntakeRow));
      for (const a of plain) computed.set(`intake_item:${a.id}`, { nutrients: await reader.itemNutrients(a.after as unknown as IntakeRow) });
    }
  }
  const sets = of("session_set");
  if (sets.length > 0) {
    const impls = await loadImplements(ctx, { ids: [...new Set(sets.map((a) => a.after.load_implement_id).filter((x): x is number => typeof x === "number"))] });
    const exercises = await all<{ id: number; bodyweight_dominant: number; implement_kind: string }>(ctx.db, "SELECT id, bodyweight_dominant, implement_kind FROM exercise WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify([...new Set(sets.map((a) => a.after.exercise_id as number))]));
    for (const a of sets) {
      const set = a.after as unknown as SetRow;
      const implement = impls.find((m) => m.id === set.load_implement_id) ?? null;
      const exercise = exercises.find((e) => e.id === set.exercise_id);
      const d = derive(set, implement, exercise);
      const rirEstimate = deriveRirAdjusted(set, implement, exercise);
      computed.set(`session_set:${a.id}`, { total_kg: d?.totalKg ?? null, volume_kg: d?.volumeKg ?? null, e1rm_kg: d?.e1rmKg ?? null, e1rm_rir_kg: rirEstimate?.e1rmKg ?? null });
    }
  }
  const restored = afters.map((a) => {
    const c = computed.get(`${a.table}:${a.id}`);
    return { table: a.table, id: a.id, version: a.before.latest + 1, ...(c ? { computed: c } : {}) };
  });
  return { restored, pots };
}

const reject = writeTool({
  name: "reject",
  group: GROUP,
  description: "Reject draft records: each is deleted, and its last content is kept as a version with the reason. Only the member a draft is about can reject it, or whoever logged it while it was never confirmed (to withdraw their own guess). A record the member had confirmed and someone else then edited is not deleted: its member's reject restores the version they confirmed (restored).",
  input: { records: z.array(RECORD).min(1).max(MAX_DECIDE), reason: z.string().min(1) },
  async run(ctx, input) {
    const decided = await decide(ctx, input.records.map(canonicalRecord), "reject");
    for (const [i, d] of decided.entries()) {
      // A portion's share goes with its portion (which takes the item with it), so the split and the day agree.
      if (d.table === "intake_item" && d.row.portion_id !== null) {
        throw new ToolError("reject_the_portion", `intake_item ${d.id} is a share of a cooked meal; reject portion ${String(d.row.portion_id)} instead`, 400, { index: i });
      }
      if (d.table === "intake_item" && d.row.leftover_serving_id != null) {
        throw new ToolError("reject_the_serving", `intake_item ${d.id} is a leftover serving's item; reject leftover_serving ${String(d.row.leftover_serving_id)} instead`, 400, { index: i });
      }
    }
    // A record its member had confirmed is a draft again only because someone else edited it (decision 153):
    // its member's reject turns the edit down, restoring the version they confirmed, as a new version, and
    // keeps the record (a session's sets keep their own state). A share and its item are restored together.
    const confirmedBefore = await lastConfirmedOf(ctx.db, decided);
    const restoring = decided.filter((d) => confirmedBefore.has(`${d.table}:${d.id}`));
    let restored: Restored[] = [];
    let pots: Record<string, unknown>[] = [];
    if (restoring.length > 0) {
      const links = await linkedPortionRecords(ctx, restoring);
      const partners = restoring.flatMap((d) => {
        const l = links.get(`${d.table}:${d.id}`);
        return l && l.row.state === "draft" ? [{ table: l.table, id: l.row.id, row: l.row }] : [];
      });
      const partnerBefore = await lastConfirmedOf(ctx.db, partners);
      const all_ = [
        ...restoring.map((d) => ({ table: d.table, id: d.id, row: d.row, before: confirmedBefore.get(`${d.table}:${d.id}`) as Confirmed })),
        ...partners.flatMap((p) => {
          const before = partnerBefore.get(`${p.table}:${p.id}`);
          return before ? [{ ...p, before }] : [];
        }),
      ];
      ({ restored, pots } = await restoreConfirmed(ctx, all_));
    }
    const removing = decided.filter((d) => !confirmedBefore.has(`${d.table}:${d.id}`));
    for (const d of removing) {
      // A draft's dependents (a draw's results, a session's sets and blocks) go in one DELETE per table,
      // their versions through versions() (16 a statement), never two statements a row (decision 96).
      const deps = await dependents(ctx, d.table, d.id);
      for (const table of [...new Set(deps.map((x) => x.table))]) {
        const rows = deps.filter((x) => x.table === table).map((x) => x.row);
        ctx.txOrThrow.versions(table, "reject", rows.map((row) => ({ id: row.id, data: row })));
        ctx.txOrThrow.exec(`DELETE FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(rows.map((row) => row.id)));
      }
      ctx.txOrThrow.remove(d.table, d.id, d.row, "reject");
    }
    reopenLeftovers(ctx, shareComponents(decided));
    // Include every removed dependent and restored partner, not only the named rows:
    // those are settled by this write too, even when they alone hold a question.
    await dropSettled(ctx, ctx.txOrThrow.touched.filter((d) => (STATE_TABLES as readonly string[]).includes(d.table)));
    if (decided.length === 1) ctx.onBehalfOf(decided[0]?.owner ?? null);
    return { rejected: removing.map((d) => ({ table: d.table, id: d.id })), restored, ...(pots.length > 0 ? { pots } : {}) };
  },
});


const retract = writeTool({
  name: "retract",
  group: GROUP,
  description: "Remove a confirmed entry that should not exist, such as a duplicate or one logged on the wrong day. To change values, use amend.",
  input: { records: z.array(RECORD).min(1), reason: z.string().min(1) },
  async run(ctx, input) {
    if (!input.reason?.trim()) throw new ToolError("reason_required", "say why the entry should not exist", 400);
    const speaker = ctx.writeInfo.speaker;
    const removed: { table: string; row: Row & { id: number } }[] = [];
    const seen = new Set<string>();
    const add = (table: string, row: Row & { id: number }) => {
      if (seen.has(`${table}:${row.id}`)) return;
      seen.add(`${table}:${row.id}`);
      removed.push({ table, row });
    };
    const records = input.records.map(canonicalRecord);
    for (const [i, r] of records.entries()) {
      if (!(RETRACTABLE as readonly string[]).includes(r.table)) {
        throw new ToolError("not_retractable", `${r.table} records can't be retracted; retractable: ${RETRACTABLE.join(", ")}`, 400, { index: i });
      }
      const { row, owner } = await loadRecord(ctx, r.table, r.id);
      // Only the member the entry is about, as the speaker (in the app, or the agent talking with them).
      if (owner === null || owner !== speaker?.id || ctx.writeInfo.origin === "inbox") {
        throw new ToolError("not_yours_to_retract", "only the member an entry is about (or the agent talking with them) can retract it", 403, { index: i });
      }
      if (r.table === "intake_item" && row.portion_id !== null) {
        throw new ToolError("retract_the_portion", `intake_item ${r.id} is a share of a cooked meal; retract portion ${String(row.portion_id)} instead`, 400, { index: i });
      }
      if (r.table === "intake_item" && row.leftover_serving_id != null) {
        throw new ToolError("retract_the_serving", `intake_item ${r.id} is a leftover serving's item; retract leftover_serving ${String(row.leftover_serving_id)} instead`, 400, { index: i });
      }
      if (r.table === "session") {
        const leaving = new Set(records.filter((x) => x.table === "session_set").map((x) => x.id));
        const sets = await all<{ id: number }>(ctx.db, "SELECT id FROM session_set WHERE session_id = ?", r.id);
        if (sets.some((x) => !leaving.has(x.id))) {
          throw new ToolError("session_has_sets", `session ${r.id} still has sets; retract them first, or retract the sets you meant`, 400, { index: i });
        }
      }
      for (const dep of await dependents(ctx, r.table, r.id)) add(dep.table, dep.row);
      add(r.table, row);
    }
    for (const d of removed) ctx.txOrThrow.remove(d.table, d.row.id, d.row, "retract");
    reopenLeftovers(ctx, shareComponents(removed));
    ctx.onBehalfOf(speaker?.id ?? null);

    // Recompute what the removals change, as if the batch had run.
    const gone = (table: string) => new Set(removed.filter((d) => d.table === table).map((d) => d.row.id));
    const dates = [...new Set(removed.filter((d) => d.table === "intake_item").map((d) => d.row.eaten_on as string))].sort();
    const dayTotals = [];
    if (dates.length > 0) {
      const reader = new NutritionReader(ctx, await Catalogue.load(ctx));
      const member = await ctx.memberById(speaker?.id as number);
      for (const date of dates) dayTotals.push(await dayView(ctx, reader, member, date, [], gone("intake_item")));
    }
    const sessionIds = [...new Set(removed.filter((d) => d.table === "session_set" || d.table === "cardio_block").map((d) => d.row.session_id as number))]
      .filter((id) => !gone("session").has(id))
      .sort((a, b) => a - b);
    const sessions = [];
    for (const sessionId of sessionIds) {
      const sets = (await all<SetRow>(ctx.db, "SELECT * FROM session_set WHERE session_id = ?", sessionId)).filter((s) => !gone("session_set").has(s.id));
      const blocks = (await all<{ id: number }>(ctx.db, "SELECT id FROM cardio_block WHERE session_id = ?", sessionId)).filter((b) => !gone("cardio_block").has(b.id));
      const impls = await loadImplements(ctx, { ids: [...new Set(sets.map((s) => s.load_implement_id).filter((x): x is number => x !== null))] });
      const volume = sets
        .filter((s) => s.set_type !== "warm_up")
        .reduce((sum, s) => sum + (derive(s, impls.find((m) => m.id === s.load_implement_id) ?? null)?.volumeKg ?? 0), 0);
      sessions.push({ session_id: sessionId, sets: sets.length, cardio_blocks: blocks.length, volume_kg: volume });
    }
    return { retracted: removed.map((d) => ({ table: d.table, id: d.row.id })), computed: { day_totals: dayTotals, sessions } };
  },
});

const history = readTool({
  name: "history",
  group: GROUP,
  description: "Every version of one record, oldest first, with the write that made it (who, on whose behalf, from where, why). Each version names the actor (a member through the app), the speaker (the member the agent was talking with) and whose record it is.",
  input: { table: z.string().regex(/^[a-z_]+$/), id: z.number().int().positive() },
  async run(ctx, input) {
    const record = canonicalRecord(input);
    const rows = await all<{ data: string } & Row>(
      ctx.db,
      `SELECT v.version, v.action, v.data, v.created_at, v.write_id, w.resolver, w.resolver_detail, w.origin, w.channel, w.tool, w.reason,
              w.on_behalf_of_member_id, w.actor_member_id, a.name AS actor, s.name AS speaker, b.name AS on_behalf_of
       FROM record_version v JOIN write_log w ON w.id = v.write_id
       LEFT JOIN member a ON a.id = w.actor_member_id
       LEFT JOIN member s ON s.id = w.speaker_member_id
       LEFT JOIN member b ON b.id = w.on_behalf_of_member_id
       WHERE v.table_name = ? AND v.record_id = ? ORDER BY v.version`,
      record.table,
      record.id,
    );
    if (rows.length === 0) throw new ToolError("not_found", `no history for ${record.table} ${record.id}`, 404);
    const versions = rows.map((r) => ({ ...r, data: JSON.parse(r.data) as Row }));
    const latest = { ...(versions[versions.length - 1] as { data: Row }).data, id: record.id } as Row & { id: number };
    const [found] = await resolveRecords(ctx, record.table, [latest]);
    checkRecord(ctx, found as LoadedRecord, `no history for ${record.table} ${record.id}`);
    // An Inbox text is its sender's, whoever it is about (decision 157).
    if (record.table === "inbox_entry") ctx.assertSentInbox(typeof latest.created_by === "number" ? latest.created_by : null);
    // On another member's record: who, when and what changed, never the free text (decision 137):
    // its OWNER_TEXT fields, and each write's reason (the agent's or a member's words).
    const owner = (found as LoadedRecord).owner;
    if (!ctx.canSee(owner)) {
      return { table: record.table, id: record.id, versions: versions.map((v) => ({ ...v, reason: null, data: withoutOwnerText(ctx, record.table, owner, v.data) })) };
    }
    return { table: record.table, id: record.id, versions };
  },
});

export const RECORD_TOOLS: Tool[] = [amend, confirm, reject, retract, history];
