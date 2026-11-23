import type { Db, Row } from "./db";
import { all } from "./db";
import { IN_LIST, OWNER_VIA, STATE_TABLES, type ViaTable } from "./owner-only";

export { STATE_TABLES };

type StateTable = (typeof STATE_TABLES)[number];

/**
 * How each state table finds the member a record is about: its own
 * member_id, its parent's (OWNER_VIA), or nobody (household-level). Typed
 * over STATE_TABLES, so a new state table fails the typecheck until it
 * says (decision 125). Every reader goes through ownersOf.
 */
export const STATE_OWNER: Record<StateTable, "member_id" | "household" | { via: ViaTable }> = {
  session: "member_id",
  session_set: { via: "session_set" },
  cook: "household",
  household_meal: "household",
  portion: "member_id",
  leftover_serving: "member_id",
  intake_item: "member_id",
  reading: "member_id",
  blood_draw: "member_id",
};

/** Tables with neither household_id nor an owner, and the one statement that reads many parents' households. */
const HOUSEHOLD_VIA: Record<string, { column: string; sql: string }> = {
  component: { column: "cook_id", sql: `SELECT id AS k, household_id AS v FROM cook WHERE id ${IN_LIST}` },
  cook_line: { column: "component_id", sql: `SELECT c.id AS k, k.household_id AS v FROM component c JOIN cook k ON k.id = c.cook_id WHERE c.id ${IN_LIST}` },
  recipe_line: { column: "recipe_id", sql: `SELECT id AS k, household_id AS v FROM recipe WHERE id ${IN_LIST}` },
  measure: { column: "food_source_id", sql: `SELECT id AS k, household_id AS v FROM food_source WHERE id ${IN_LIST}` },
  implement: { column: "gym_id", sql: `SELECT id AS k, household_id AS v FROM gym WHERE id ${IN_LIST}` },
  yield: { column: "to_food_source_id", sql: `SELECT id AS k, household_id AS v FROM food_source WHERE id ${IN_LIST}` },
  workout_line: { column: "workout_id", sql: `SELECT id AS k, household_id AS v FROM workout WHERE id ${IN_LIST}` },
  member_note_version: { column: "note_id", sql: `SELECT id AS k, household_id AS v FROM member_note WHERE id ${IN_LIST}` },
};

const isState = (table: string): table is StateTable => (STATE_TABLES as readonly string[]).includes(table);

function ownerPath(table: string): "member_id" | "household" | { via: ViaTable } {
  if (isState(table)) return STATE_OWNER[table];
  return Object.hasOwn(OWNER_VIA, table) ? { via: table as ViaTable } : "member_id";
}

/** Parent id → value, for many parents in one statement; none when there is nothing to read. */
async function pairs(db: Db, sql: string, keys: readonly number[]): Promise<Map<number, number>> {
  if (keys.length === 0) return new Map();
  return new Map((await all<{ k: number; v: number }>(db, sql, JSON.stringify(keys))).map((x) => [x.k, x.v]));
}

/**
 * The member each record is about, or null for a household-level record:
 * for many rows of one table in at most one statement. Used for
 * visibility, for the write log, and for who may confirm a draft.
 */
export async function ownersOf(db: Db, table: string, rows: readonly Row[]): Promise<(number | null)[]> {
  const path = ownerPath(table);
  if (path === "household") return rows.map(() => null);
  const own = (r: Row) => (typeof r.member_id === "number" ? r.member_id : null);
  if (path === "member_id") return rows.map(own);
  const via = OWNER_VIA[path.via];
  const parents = await pairs(db, via.sql, [...new Set(rows.flatMap((r) => (own(r) === null && typeof r[via.column] === "number" ? [r[via.column] as number] : [])))]);
  return rows.map((r) => own(r) ?? parents.get(r[via.column] as number) ?? null);
}

/** One record's owner: ownersOf for one row. */
export async function ownerOf(db: Db, table: string, row: Row): Promise<number | null> {
  return (await ownersOf(db, table, [row]))[0] ?? null;
}

/**
 * The household each record belongs to, to refuse ids from elsewhere, for
 * many rows of one table: their own household_id, their owner's (one
 * statement), or their parent's (one statement). Null when it can't be
 * told (then members decide).
 */
export async function householdsOf(db: Db, table: string, rows: readonly Row[], owners: readonly (number | null)[]): Promise<(number | null)[]> {
  const marked = (r: Row) => typeof r.household_id === "number";
  const byMember = await pairs(db, `SELECT id AS k, household_id AS v FROM member WHERE id ${IN_LIST}`, [...new Set(rows.flatMap((r, i) => (!marked(r) && owners[i] != null ? [owners[i] as number] : [])))]);
  const via = Object.hasOwn(HOUSEHOLD_VIA, table) ? HOUSEHOLD_VIA[table] : undefined;
  const byParent = via ? await pairs(db, via.sql, [...new Set(rows.flatMap((r, i) => (!marked(r) && owners[i] == null && typeof r[via.column] === "number" ? [r[via.column] as number] : [])))]) : new Map<number, number>();
  return rows.map((r, i) => {
    if (marked(r)) return r.household_id as number;
    const owner = owners[i] ?? null;
    if (owner !== null) return byMember.get(owner) ?? null;
    return via ? (byParent.get(r[via.column] as number) ?? null) : null;
  });
}

/** One record's household: householdsOf for one row. */
export async function householdOf(db: Db, table: string, row: Row): Promise<number | null> {
  return (await householdsOf(db, table, [row], [await ownerOf(db, table, row)]))[0] ?? null;
}

/**
 * SQL for a column of the write that created a record (its first version),
 * the record's table and id given as SQL expressions; `w` is that write.
 */
export function firstWriteSql(column: string, table: string, id: string): string {
  return `(SELECT ${column} FROM record_version v JOIN write_log w ON w.id = v.write_id WHERE v.table_name = ${table} AND v.record_id = ${id} ORDER BY v.version ASC LIMIT 1)`;
}

/** Who logged a record, read on the write that created it: the member through the app, or the member the agent was talking with. */
export const LOGGED_BY = "coalesce(w.actor_member_id, w.speaker_member_id)";

/** SQL, 1 or 0: whether any version of the record (table and id as SQL expressions) has it confirmed. */
export function everConfirmedSql(table: string, id: string): string {
  return `EXISTS (SELECT 1 FROM record_version c WHERE c.table_name = ${table} AND c.record_id = ${id} AND json_extract(c.data, '$.state') = 'confirmed')`;
}

/**
 * Who logged each record (the drafts list's logged_by, the same SQL) and
 * whether any version of it was ever confirmed. One statement for any
 * number of records; none for none. reject reads it (ticket 69).
 */
export async function authorsOf(db: Db, refs: readonly { table: string; id: number }[]): Promise<Map<string, { loggedBy: number | null; everConfirmed: boolean }>> {
  if (refs.length === 0) return new Map();
  const rows = await all<{ tbl: string; id: number; logged_by: number | null; ever_confirmed: number }>(
    db,
    `WITH d(tbl, id) AS (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))
     SELECT d.tbl, d.id, ${firstWriteSql(LOGGED_BY, "d.tbl", "d.id")} AS logged_by, ${everConfirmedSql("d.tbl", "d.id")} AS ever_confirmed FROM d`,
    JSON.stringify(refs.map((r) => [r.table, r.id])),
  );
  return new Map(rows.map((r) => [`${r.tbl}:${r.id}`, { loggedBy: r.logged_by, everConfirmed: r.ever_confirmed === 1 }]));
}

/**
 * Each record's latest version that has it confirmed (its data), and its
 * latest version number, for records that were ever confirmed; one
 * statement for any number of records, none for none. reject restores it
 * when a member turns down someone else's edit (ticket 69, review P1-1).
 */
export async function lastConfirmedOf(db: Db, refs: readonly { table: string; id: number }[]): Promise<Map<string, { data: Row; latest: number }>> {
  if (refs.length === 0) return new Map();
  const rows = await all<{ tbl: string; id: number; data: string; latest: number }>(
    db,
    `WITH d(tbl, id) AS (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))
     SELECT d.tbl, d.id,
       (SELECT c.data FROM record_version c WHERE c.table_name = d.tbl AND c.record_id = d.id AND json_extract(c.data, '$.state') = 'confirmed' ORDER BY c.version DESC LIMIT 1) AS data,
       (SELECT max(v.version) FROM record_version v WHERE v.table_name = d.tbl AND v.record_id = d.id) AS latest
     FROM d`,
    JSON.stringify(refs.map((r) => [r.table, r.id])),
  );
  return new Map(rows.filter((r) => r.data !== null).map((r) => [`${r.tbl}:${r.id}`, { data: JSON.parse(r.data) as Row, latest: r.latest }]));
}
