import { isoSeconds } from "./context";
import { all, first, type Db, type Row } from "./db";
import { everConfirmedSql, STATE_TABLES } from "./records";
import { WriteTx } from "./write";
import { heldSql } from "./questions";

/** A draft about another member, or from the Inbox, confirms after this long without an edit or a rejection. */
export const AUTO_CONFIRM_HOURS = 48;

/**
 * Why a draft never confirms by itself, or null: an open or answered question holds it;
 * Coach-mode drafts wait for end_session; a set with blank RIR waits for its RIR.
 * A record that was once confirmed (at end_session) and is a draft again because someone else edited it (ticket 69)
 * waits for no session: its 48 h runs from the edit.
 */
export type AutoConfirmBlock = "coach_until_end_session" | "rir_blank" | "question";

export function autoConfirmBlock(table: string, row: { rir_status?: unknown }, createdOrigin: string | null, everConfirmed = false, held = false): AutoConfirmBlock | null {
  if (held) return "question";
  if (createdOrigin === "coach" && !everConfirmed) return "coach_until_end_session";
  if (table === "session_set" && row.rir_status === null) return "rir_blank";
  return null;
}

/** When a draft whose latest version was written at `latestAt` confirms by itself. */
export function autoConfirmDeadline(latestAt: string): string {
  return isoSeconds(new Date(Date.parse(latestAt) + AUTO_CONFIRM_HOURS * 3_600_000));
}

export interface AutoConfirmResult {
  write_id: number | null;
  confirmed: { table: string; id: number }[];
  skipped: { table: string; id: number; reason: string }[];
}

/**
 * Confirm every draft whose latest version is at least 48 h old, as one
 * write by the `system` resolver with origin `auto_confirm`, recorded with
 * provenance `inferred`. A Cron Trigger calls this with its scheduled time;
 * tests inject the clock.
 *
 * Not confirmed: drafts created in Coach mode (they wait for end_session),
 * and sets with blank RIR (a confirmed set must say recorded or not).
 */
export async function autoConfirm(db: Db, now: Date): Promise<AutoConfirmResult> {
  const at = isoSeconds(now);
  const cutoff = isoSeconds(new Date(now.getTime() - AUTO_CONFIRM_HOURS * 3_600_000));
  for (let attempt = 1; ; attempt++) {
    const writeId = (await first<{ m: number }>(db, "SELECT coalesce(max(id), 0) + 1 AS m FROM write_log"))?.m ?? 1;
    const tx = new WriteTx(db, writeId, at);
    const result: AutoConfirmResult = { write_id: null, confirmed: [], skipped: [] };
    // STATE_TABLES lists portion and leftover_serving before intake_item, so a share's item can follow it in this write.
    const confirmedShares = new Set<string>();
    for (const table of STATE_TABLES) {
      const rows = await all<Row & { id: number; _latest_at: string; _created_origin: string | null; _ever_confirmed: number; _held: number }>(
        db,
        `SELECT t.*,
           (SELECT v.created_at FROM record_version v WHERE v.table_name = ?1 AND v.record_id = t.id ORDER BY v.version DESC LIMIT 1) AS _latest_at,
           (SELECT w.origin FROM record_version v JOIN write_log w ON w.id = v.write_id
             WHERE v.table_name = ?1 AND v.record_id = t.id ORDER BY v.version ASC LIMIT 1) AS _created_origin,
           ${everConfirmedSql("?1", "t.id")} AS _ever_confirmed,
           ${heldSql("?1", "t.id")} AS _held
         FROM ${table} t WHERE t.state = 'draft' ORDER BY t.id`,
        table,
      );
      for (const row of rows) {
        const share =
          table === "intake_item" && row.portion_id !== null ? { table: "portion", id: row.portion_id as number }
          : table === "intake_item" && row.leftover_serving_id != null ? { table: "leftover_serving", id: row.leftover_serving_id as number }
          : null;
        if (share) {
          // A share's intake item keeps its share's state: it confirms with it, and waits while the share is
          // still a draft (an edit may have restarted the share's 48 h).
          const withShare = confirmedShares.has(`${share.table}:${share.id}`);
          const parent = withShare ? null : await first<{ state: string }>(db, `SELECT state FROM ${share.table} WHERE id = ?`, share.id);
          if (!withShare && parent?.state === "draft") continue;
          if (!withShare && (row._latest_at === null || row._latest_at > cutoff)) continue;
        } else if (row._latest_at === null || row._latest_at > cutoff) continue;
        const block = autoConfirmBlock(table, { rir_status: row.rir_status }, row._created_origin, row._ever_confirmed === 1, row._held === 1);
        if (block) {
          result.skipped.push({ table, id: row.id, reason: block });
          continue;
        }
        const { _latest_at: _a, _created_origin: _o, _ever_confirmed: _e, _held: _h, ...data } = row;
        const changes = { state: "confirmed", confirmed_at: at };
        tx.update(table, row.id, changes, { ...data, ...changes }, "confirm");
        result.confirmed.push({ table, id: row.id });
        if (table === "portion" || table === "leftover_serving") confirmedShares.add(`${table}:${row.id}`);
      }
    }
    if (result.confirmed.length === 0) return result;
    const log = db
      .prepare(
        `INSERT INTO write_log (id, at, resolver, resolver_detail, actor_member_id, on_behalf_of_member_id, origin, tool, reason, channel)
         VALUES (?, ?, 'system', 'provenance: inferred', NULL, NULL, 'auto_confirm', 'auto_confirm', ?, 'unattended')`,
      )
      .bind(writeId, at, `auto-confirmed after ${AUTO_CONFIRM_HOURS} h with no edit or rejection`);
    try {
      await db.batch([log, ...tx.finish()]);
      return { ...result, write_id: writeId };
    } catch (error) {
      if (attempt < 3 && /UNIQUE constraint failed: write_log\.id/.test(String(error))) continue;
      throw error;
    }
  }
}
