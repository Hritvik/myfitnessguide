/**
 * Claude's questions (redesign-a spec §5). A question is open (ask_member), answered (answer_question: the
 * answer is stored and sent as an Inbox entry from its member), closed when that entry is resolved or rejected,
 * and dropped by a confirm, reject or amend that leaves none of its blocked records a draft. **Live** (R1): an
 * open question counts, shows and can be answered only while it has no blocks or one of them is still a draft,
 * decided at read time, so end_session, retract and a rolled-back Worker's cron settle it too, with no hook.
 * While open or answered it holds its drafts and their linked share/item partners from auto-confirm. A block
 * expires at its first settling version after the question's creation write, so re-drafts cannot revive it.
 * Every change is versioned, set-based (R2).
 */
import type { Ctx } from "./context";
import { all } from "./db";
import { STATE_TABLES } from "./records";

const HOLDING = "('open', 'answered')";

/** Match the record itself or its linked share/item partner. SQL expressions are supplied by code only. */
function blocksRecordSql(table: string, id: string): string {
  return `((qb.table_name = ${table} AND qb.record_id = ${id})
    OR (${table} = 'portion' AND qb.table_name = 'intake_item' AND qb.record_id IN (SELECT i.id FROM intake_item i WHERE i.portion_id = ${id}))
    OR (${table} = 'leftover_serving' AND qb.table_name = 'intake_item' AND qb.record_id IN (SELECT i.id FROM intake_item i WHERE i.leftover_serving_id = ${id}))
    OR (${table} = 'intake_item' AND qb.table_name = 'portion' AND qb.record_id IN (SELECT i.portion_id FROM intake_item i WHERE i.id = ${id}))
    OR (${table} = 'intake_item' AND qb.table_name = 'leftover_serving' AND qb.record_id IN (SELECT i.leftover_serving_id FROM intake_item i WHERE i.id = ${id})))`;
}

/** A block's current draft must still belong to the consent interval in which the question was asked. */
function activeBlockSql(q: string, b: string): string {
  const draft = `((CASE ${b}.table_name ${STATE_TABLES.map((t) => `WHEN '${t}' THEN (SELECT state FROM ${t} WHERE id = ${b}.record_id)`).join(" ")} END) = 'draft')`;
  // Write ids order committed versions even when the fixed clock gives every write the same timestamp.
  // Once settled by any Worker (including a rolled-back cron), a later re-draft cannot revive this block.
  return `(${draft} AND NOT EXISTS (
    SELECT 1 FROM record_version settled
    WHERE settled.table_name = ${b}.table_name AND settled.record_id = ${b}.record_id
      AND settled.write_id > (SELECT asked.write_id FROM record_version asked WHERE asked.table_name = 'question' AND asked.record_id = ${q}.id ORDER BY asked.version LIMIT 1)
      AND (settled.action IN ('confirm', 'reject', 'delete', 'retract') OR json_extract(settled.data, '$.state') = 'confirmed')
  ))`;
}

/** SQL, 1 or 0: whether an open or answered question holds the record (table and id as SQL expressions). */
export function heldSql(table: string, id: string): string {
  return `EXISTS (SELECT 1 FROM question_block qb JOIN question q ON q.id = qb.question_id WHERE ${blocksRecordSql(table, id)} AND q.status IN ${HOLDING} AND ${activeBlockSql("q", "qb")})`;
}

/** SQL: a JSON array of the open questions holding the record (the record is a draft, so they are live). */
export function openIdsSql(table: string, id: string): string {
  return `(SELECT json_group_array(DISTINCT q.id) FROM question_block qb JOIN question q ON q.id = qb.question_id WHERE ${blocksRecordSql(table, id)} AND q.status = 'open' AND ${activeBlockSql("q", "qb")})`;
}

/** SQL, 1 or 0, over a question aliased `q`: live while it has no blocks, or one of them is still a draft (R1). */
export function liveSql(q: string): string {
  return `(NOT EXISTS (SELECT 1 FROM question_block b WHERE b.question_id = ${q}.id) OR EXISTS (SELECT 1 FROM question_block b WHERE b.question_id = ${q}.id AND ${activeBlockSql(q, "b")}))`;
}

export interface QuestionRow {
  id: number;
  member_id: number;
  inbox_entry_id: number | null;
  text: string;
  choices: string;
  /** The drafts it holds, [{table, id}], written once (R3). */
  blocks: string;
  status: "open" | "answered" | "closed" | "dropped";
  answer: string | null;
  answer_inbox_entry_id: number | null;
  asked_at: string;
  answered_at: string | null;
  closed_at: string | null;
}

export interface QuestionOut {
  id: number;
  member: string;
  text: string;
  choices: string[];
  status: QuestionRow["status"];
  answer: string | null;
  asked_at: string;
  answered_at: string | null;
  inbox_entry_id: number | null;
  blocks: { table: string; id: number }[];
}

export const questionOut = (q: QuestionRow, member: string): QuestionOut => ({
  id: q.id, member, text: q.text, choices: JSON.parse(q.choices) as string[], status: q.status, answer: q.answer,
  asked_at: q.asked_at, answered_at: q.answered_at, inbox_entry_id: q.inbox_entry_id, blocks: JSON.parse(q.blocks) as { table: string; id: number }[],
});

/** Set one status on many questions: one UPDATE and their versions in one statement (decision 96, R2). */
function settle(ctx: Ctx, rows: readonly QuestionRow[], status: "closed" | "dropped"): number[] {
  if (rows.length === 0) return [];
  const at = ctx.nowIso();
  const tx = ctx.txOrThrow;
  tx.exec("UPDATE question SET status = ?, closed_at = ? WHERE id IN (SELECT value FROM json_each(?))", status, at, JSON.stringify(rows.map((q) => q.id)));
  tx.versionsAcross("amend", rows.map((q) => ({ table: "question", id: q.id, data: { ...q, status, closed_at: at } })));
  return rows.map((q) => q.id);
}

/**
 * Drop every open or answered question holding one of the records this write decides (confirm, reject, amend
 * and its linked confirm) once none of its records is left a draft: one read, one UPDATE, one versions INSERT.
 */
export async function dropSettled(ctx: Ctx, deciding: readonly { table: string; id: number }[]): Promise<number[]> {
  if (deciding.length === 0) return [];
  const rows = await all<QuestionRow & { left: string }>(
    ctx.db,
    `SELECT q.*, (SELECT json_group_array(json_object('table', b.table_name, 'id', b.record_id, 'draft', ${activeBlockSql("q", "b")})) FROM question_block b WHERE b.question_id = q.id) AS left
     FROM question q
     WHERE q.status IN ${HOLDING} AND q.id IN (
       SELECT qb.question_id FROM question_block qb JOIN json_each(?1) j ON qb.table_name = json_extract(j.value, '$[0]') AND qb.record_id = json_extract(j.value, '$[1]'))`,
    JSON.stringify(deciding.map((d) => [d.table, d.id])),
  );
  const leaving = new Set(deciding.map((d) => `${d.table}:${d.id}`));
  const settled = rows
    .filter((r) => (JSON.parse(r.left) as { table: string; id: number; draft: number }[]).every((b) => b.draft !== 1 || leaving.has(`${b.table}:${b.id}`)))
    .map(({ left: _l, ...q }) => q);
  return settle(ctx, settled, "dropped");
}

/** Close the answered question whose answer is this Inbox entry (resolve_inbox_entry, in its write). */
export async function closeAnswered(ctx: Ctx, entryId: number): Promise<number[]> {
  const rows = await all<QuestionRow>(ctx.db, "SELECT * FROM question WHERE answer_inbox_entry_id = ? AND status = 'answered'", entryId);
  return settle(ctx, rows, "closed");
}

export interface OpenQuestion {
  id: number;
  text: string;
  choices: string[];
  asked_at: string;
  /** The member's own Inbox text the question is about (a question quotes only its recipient's text, spec §6). */
  quote: { text: string; sent_at: string } | null;
  blocks: { table: string; id: number }[];
}

/** A member's open, live questions, oldest first, each with its quote and blocks: one statement. */
export async function openQuestions(ctx: Ctx, memberId: number): Promise<OpenQuestion[]> {
  const rows = await all<QuestionRow & { entry_text: string | null; entry_at: string | null; entry_by: number | null }>(
    ctx.db,
    `SELECT q.*, e.text AS entry_text, e.created_at AS entry_at, e.created_by AS entry_by
     FROM question q LEFT JOIN inbox_entry e ON e.id = q.inbox_entry_id
     WHERE q.member_id = ? AND q.status = 'open' AND ${liveSql("q")} ORDER BY q.asked_at, q.id`,
    memberId,
  );
  return rows.map((r) => ({
    id: r.id, text: r.text, choices: JSON.parse(r.choices) as string[], asked_at: r.asked_at,
    quote: r.entry_text !== null && r.entry_at !== null && r.entry_by === memberId ? { text: r.entry_text, sent_at: r.entry_at } : null,
    blocks: JSON.parse(r.blocks) as { table: string; id: number }[],
  }));
}
