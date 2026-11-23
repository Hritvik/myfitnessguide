/**
 * Every draft in the household, with who it is about, who logged it, a
 * short summary, and when auto-confirm will confirm it or why it never
 * will (autoconfirm.ts's own rule, so the app and the cron agree).
 *
 * One statement (decision 96): a UNION ALL generated from STATE_TABLES
 * (nested in groups of at most 5 terms, D1's compound SELECT limit),
 * one branch per state table from DRAFT_SOURCES. The map is typed over
 * STATE_TABLES, so a new state table fails the typecheck until it says
 * how to find its owner, household, summary and day.
 */
import { autoConfirmBlock, autoConfirmDeadline } from "./autoconfirm";
import type { Ctx } from "./context";
import { all } from "./db";
import { everConfirmedSql, firstWriteSql, LOGGED_BY, STATE_TABLES } from "./records";
import { OWNER_ONLY } from "./tools/records";
import { heldSql, openIdsSql } from "./questions";

type StateTable = (typeof STATE_TABLES)[number];

interface DraftSource {
  /** FROM clause; the state table itself is aliased `t`. */
  from: string;
  owner: string;
  household: string;
  summary: string;
  /** The day the draft is about (eaten, performed, measured, drawn, cooked), as SQL. */
  on: string;
  /** The meal slot, for food (redesign-a spec §5: a hand-off is one date and slot). */
  slot?: string;
  /** The record a draft belongs to for a hand-off: a set's session, a session itself. */
  parent?: string;
  /** The RIR status column, for the blank-RIR rule (session_set only). */
  rir?: string;
  /** Rows that follow another record's state and are counted with it. */
  follows?: string;
}

const DRAFT_SOURCES: Record<StateTable, DraftSource> = {
  session: {
    from: "session t JOIN member m ON m.id = t.member_id LEFT JOIN session_template tt ON tt.id = t.template_id",
    owner: "t.member_id", household: "m.household_id", summary: "coalesce(tt.name, t.session_type) || ' on ' || t.performed_on",
    on: "t.performed_on", parent: "t.id",
  },
  session_set: {
    from: "session_set t JOIN session se ON se.id = t.session_id JOIN member m ON m.id = se.member_id JOIN exercise e ON e.id = t.exercise_id",
    owner: "se.member_id", household: "m.household_id", summary: "e.name", rir: "t.rir_status",
    on: "se.performed_on", parent: "t.session_id",
  },
  cook: { from: "cook t", owner: "NULL", household: "t.household_id", summary: "t.name", on: "t.cooked_on" },
  household_meal: { from: "household_meal t", owner: "NULL", household: "t.household_id", summary: "'a household meal'", on: "t.eaten_on", slot: "t.meal_slot" },
  portion: {
    from: "portion t JOIN member m ON m.id = t.member_id JOIN component c ON c.id = t.component_id JOIN cook k ON k.id = c.cook_id",
    owner: "t.member_id", household: "m.household_id", summary: "k.name",
    on: "(SELECT i.eaten_on FROM intake_item i WHERE i.portion_id = t.id)", slot: "(SELECT i.meal_slot FROM intake_item i WHERE i.portion_id = t.id)",
  },
  leftover_serving: {
    from: "leftover_serving t JOIN member m ON m.id = t.member_id JOIN component c ON c.id = t.component_id JOIN cook k ON k.id = c.cook_id",
    owner: "t.member_id", household: "m.household_id", summary: "k.name || ', leftover'",
    on: "t.eaten_on", slot: "(SELECT i.meal_slot FROM intake_item i WHERE i.leftover_serving_id = t.id)",
  },
  intake_item: {
    from: "intake_item t JOIN member m ON m.id = t.member_id LEFT JOIN food_source f ON f.id = t.food_source_id LEFT JOIN recipe r ON r.id = t.recipe_id",
    owner: "t.member_id", household: "m.household_id", summary: "coalesce(f.name, r.name, t.label, t.manual_reason, 'an item')",
    on: "t.eaten_on", slot: "t.meal_slot",
    // A portion's item follows its portion, and a leftover serving's item its serving.
    follows: "t.portion_id IS NOT NULL OR t.leftover_serving_id IS NOT NULL",
  },
  reading: { from: "reading t JOIN member m ON m.id = t.member_id", owner: "t.member_id", household: "m.household_id", summary: "t.metric", on: "t.measured_on" },
  blood_draw: { from: "blood_draw t JOIN member m ON m.id = t.member_id", owner: "t.member_id", household: "m.household_id", summary: "t.lab", on: "t.drawn_on" },
};

const branch = (table: StateTable) => {
  const s = DRAFT_SOURCES[table];
  return `SELECT '${table}' AS tbl, t.id AS id, ${s.owner} AS owner, ${s.household} AS hh, ${s.rir ?? "NULL"} AS rir_status, ${s.summary} AS summary,
            ${s.on} AS on_date, ${s.slot ?? "NULL"} AS slot, ${s.parent ?? "NULL"} AS parent
          FROM ${s.from} WHERE t.state = 'draft'${s.follows ? ` AND NOT (${s.follows})` : ""}`;
};

const first_ = (column: string) => firstWriteSql(column, "d.tbl", "d.id");

/**
 * D1 refuses a compound SELECT of more than 5 terms, and there are more
 * state tables than that: the branches go in nested groups of at most 5,
 * each its own compound, so it stays one statement.
 */
const COMPOUND_LIMIT = 5;
const unionAll = (terms: string[]): string => {
  if (terms.length <= COMPOUND_LIMIT) return terms.join("\n UNION ALL ");
  const groups: string[] = [];
  for (let i = 0; i < terms.length; i += COMPOUND_LIMIT) groups.push(`SELECT * FROM (${terms.slice(i, i + COMPOUND_LIMIT).join("\n UNION ALL ")})`);
  return unionAll(groups);
};

const DRAFTS_SQL = `WITH d AS (${unionAll(STATE_TABLES.map(branch))})
SELECT d.*,
  (SELECT v.created_at FROM record_version v WHERE v.table_name = d.tbl AND v.record_id = d.id ORDER BY v.version DESC LIMIT 1) AS latest_at,
  (SELECT ${LOGGED_BY} FROM record_version v JOIN write_log w ON w.id = v.write_id WHERE v.table_name = d.tbl AND v.record_id = d.id ORDER BY v.version DESC LIMIT 1) AS latest_by,
  ${first_("v.created_at")} AS created_at,
  ${first_("w.origin")} AS created_origin,
  ${first_(LOGGED_BY)} AS logged_by,
  ${everConfirmedSql("d.tbl", "d.id")} AS ever_confirmed,
  ${heldSql("d.tbl", "d.id")} AS held,
  ${openIdsSql("d.tbl", "d.id")} AS open_question_ids
FROM d WHERE d.hh = ?`;

export interface DraftInfo {
  table: string;
  id: number;
  /** The member the draft is about; null for a household-level record. */
  owner: number | null;
  /** Who logged it: the member through the app, or the member the agent was talking with. */
  loggedBy: number | null;
  /** The first write's origin (app, live, coach, inbox, …): with no logger, the Inbox or Claude. */
  origin: string | null;
  /** A few words: the food, the exercise, the session, the cook. */
  summary: string;
  createdAt: string;
  /** The latest version's time, which the 48 h runs from. */
  latestAt: string | null;
  /** The day it is about, its meal slot (food), and the record it belongs to (a set's session). */
  on: string | null;
  slot: string | null;
  parent: number | null;
  /** Its member had confirmed it once (a re-draft, ticket 69), and who edited it last; editedBy is null otherwise. */
  everConfirmed: boolean;
  editedBy: number | null;
  /** The open questions holding it. */
  questionIds: number[];
  /** When it confirms by itself; null when it never does. */
  deadline: string | null;
  /** Why it never confirms by itself: the end of a Coach session, a blank RIR, or a question. */
  waits: "end_of_session" | "rir_needed" | "question" | null;
}

interface DraftRow {
  tbl: string;
  id: number;
  owner: number | null;
  rir_status: string | null;
  summary: string;
  on_date: string | null;
  slot: string | null;
  parent: number | null;
  latest_at: string | null;
  latest_by: number | null;
  created_at: string | null;
  created_origin: string | null;
  logged_by: number | null;
  ever_confirmed: number;
  held: number;
  open_question_ids: string;
}

const WAITS = { coach_until_end_session: "end_of_session", rir_blank: "rir_needed", question: "question" } as const;

/** Every draft in the caller's household, oldest first. One statement. */
export async function householdDrafts(ctx: Ctx): Promise<DraftInfo[]> {
  const rows = await all<DraftRow>(ctx.db, DRAFTS_SQL, ctx.householdId);
  const order = (t: string) => (STATE_TABLES as readonly string[]).indexOf(t);
  return rows
    .map((r) => {
      const everConfirmed = r.ever_confirmed === 1;
      const block = autoConfirmBlock(r.tbl, { rir_status: r.rir_status }, r.created_origin, everConfirmed, r.held === 1);
      return {
        table: r.tbl, id: r.id, owner: r.owner, loggedBy: r.logged_by, origin: r.created_origin, summary: r.summary, createdAt: r.created_at ?? "",
        latestAt: r.latest_at, on: r.on_date, slot: r.slot, parent: r.parent, everConfirmed, editedBy: everConfirmed ? r.latest_by : null, questionIds: JSON.parse(r.open_question_ids) as number[],
        deadline: block === null && r.latest_at !== null ? autoConfirmDeadline(r.latest_at) : null,
        waits: block === null ? null : WAITS[block],
      };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || order(a.table) - order(b.table) || a.id - b.id);
}

/** The drafts a caller may see: owner-only kinds (records.ts OWNER_ONLY) only for their member, or the agent. */
export function visibleDrafts(ctx: Ctx, drafts: readonly DraftInfo[]): DraftInfo[] {
  return drafts.filter((d) => !(d.table in OWNER_ONLY) || ctx.canSee(d.owner));
}

/**
 * The drafts about one member: the one owner filter every reader uses
 * (household_overview's table and waiting_on_you, needs_you, health_drafts),
 * so a count and a list come from one snapshot. Visibility is the
 * caller's (visibleDrafts) before this.
 */
export function draftsAbout(drafts: readonly DraftInfo[], memberId: number): DraftInfo[] {
  return drafts.filter((d) => d.owner === memberId);
}
