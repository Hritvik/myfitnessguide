/**
 * The Private shape, as the privacy tests use it (e2e spec §3, §5): each
 * owner's needles (words and numbers), and the ids of the owner's owner-only
 * records, read from the slot's D1 by member (ruling 4; the positive control
 * proves the owner sees them). Child tables find their owner through the
 * Worker's own OWNER_VIA, never a second copy of that knowledge.
 */
import { IN_LIST, OWNER_ONLY, OWNER_TEXT, OWNER_VIA } from "@myfitnessguide/worker/owner-only";
import { canariesOf, HOUSEHOLD_TEXT, needle, type CanaryMember } from "../../scripts/canaries.ts";
import { d1 } from "./d1.ts";
import { EMAILS, type MemberKey } from "./fixtures.ts";

export const CANARY_MEMBER: Record<MemberKey, CanaryMember> = { asha: "Asha", kabir: "Kabir", noor: "Noor" };

export function needlesOf(owner: MemberKey): string[] {
  return canariesOf(CANARY_MEMBER[owner]).map(needle);
}

/**
 * The owner's needles that another member must never see: every canary except the training text
 * that is household data (Worker decision 167), which another member may legitimately read.
 */
export function hiddenNeedlesOf(owner: MemberKey): string[] {
  return canariesOf(CANARY_MEMBER[owner])
    .filter((c) => c.kind === "text" && !HOUSEHOLD_TEXT.has(`${c.table}.${c.field}`))
    .map(needle);
}

/** The needles that occur in `text`, ignoring case. */
export function found(text: string, needles: readonly string[]): string[] {
  const t = text.toLowerCase();
  return needles.filter((n) => t.includes(n.toLowerCase()));
}

export interface Owner {
  key: MemberKey;
  name: string;
  today: string;
  ids: Record<string, number[]>;
}

/** Records whose owner is their sender, not the member they are about (Worker decision 157; F5). */
export const SENT_BY: Record<string, string> = { inbox_entry: "created_by" };

/**
 * Where an owner-only table's rows hang off the owner: the sender for a SENT_BY
 * table, the Worker's own OWNER_VIA for a child table (its parent's member, read
 * with every parent rather than a list of ids), else the row's member_id.
 */
function ownedWhere(table: string, me: string): string {
  const sender = SENT_BY[table];
  if (sender) return `${sender} = ${me}`;
  const via = (OWNER_VIA as Record<string, { column: string; sql: string }>)[table];
  if (!via) return `member_id = ${me}`;
  return `${via.column} IN (SELECT k FROM (${via.sql.replace(IN_LIST, "IS NOT NULL")}) WHERE v = ${me})`;
}

const cache = new Map<MemberKey, Record<string, number[]>>();

export function ownerOf(persist: string, key: MemberKey, name: string, today: string): Owner {
  let ids = cache.get(key);
  if (!ids) {
    const me = `(SELECT id FROM member WHERE email = '${EMAILS[key]}')`;
    // The owner-only kinds, plus the child records a correction or a history aims at (session_set,
    // intake_item). ownedRecords() keeps those out of the owner-only probes below.
    const tables = [...Object.keys(OWNER_ONLY), ...Object.keys(OWNER_TEXT), ...Object.keys(SENT_BY), "session_set", "intake_item"];
    // One statement: a prepared statement runs only its first, so the tables are one UNION ALL.
    const rows = d1(persist, tables.map((t) => `SELECT '${t}' AS t, id FROM ${t} WHERE ${ownedWhere(t, me)}`).join("\nUNION ALL\n"));
    ids = Object.fromEntries(tables.map((t) => [t, rows.filter((r) => r.t === t).map((r) => Number(r.id))]));
    cache.set(key, ids);
  }
  return { key, name, today, ids };
}

/** The owner's OWNER_ONLY and OWNER_TEXT records (amend, confirm, reject, retract and history aim at them). */
export function ownedRecords(o: Owner): { table: string; id: number }[] {
  const owned = new Set([...Object.keys(OWNER_ONLY), ...Object.keys(OWNER_TEXT)]);
  return Object.entries(o.ids).filter(([table]) => owned.has(table)).flatMap(([table, ids]) => ids.map((id) => ({ table, id })));
}

/** The Inbox entries the owner sent (resolve_inbox_entry and history aim at them; F5). */
export function sentRecords(o: Owner): { table: string; id: number }[] {
  return Object.keys(SENT_BY).flatMap((table) => (o.ids[table] ?? []).map((id) => ({ table, id })));
}
