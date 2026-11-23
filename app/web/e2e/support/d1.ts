/**
 * Reading a slot's local D1 (plan rulings 4 and 5): straight from Miniflare's
 * SQLite file, opened read-only, so a check can never write to the copy it
 * checks, needs no wrangler process, and works whether or not the slot's
 * Worker is running. Never remote.
 */
import type { SQLInputValue } from "node:sqlite";
import { openD1 } from "../../scripts/d1-file.ts";

/** One read-only statement against a slot's local D1. */
export function d1(persist: string, sql: string, ...params: SQLInputValue[]): Record<string, unknown>[] {
  const db = openD1(persist);
  try {
    return db.prepare(sql).all(...params) as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

/** The first column of the first row, as a number. */
export function count(persist: string, sql: string, ...params: SQLInputValue[]): number {
  const row = d1(persist, sql, ...params)[0] ?? {};
  return Number(Object.values(row)[0]);
}

/** The write log's rows: a read-only project's copy must end with as many as it started with (spec §3, `pristine`). */
export function writeCount(persist: string): number {
  return count(persist, "SELECT count(*) AS n FROM write_log");
}
