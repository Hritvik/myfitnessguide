// Test harness: applies every D1 migration, in filename order, to a fresh
// in-memory SQLite database. node:sqlite enforces foreign keys by default,
// as D1 does.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

export type Row = Record<string, unknown>;

/** Terms allowed in one compound SELECT on D1 (measured on `wrangler d1 execute --local`: 5 runs, 6 fails). */
export const D1_COMPOUND_SELECT_LIMIT = 5;

export class TestDb {
  readonly db: DatabaseSync;

  /** `through` stops after that migration number ("0024"), as a database deployed before the later ones. */
  constructor(options: { through?: string } = {}) {
    this.db = new DatabaseSync(":memory:");
    // D1 (workerd's SQLite) refuses a compound SELECT of more than 5 terms; so does every test database.
    this.db.limits.compoundSelect = D1_COMPOUND_SELECT_LIMIT;
    for (const file of migrationFiles().filter((f) => options.through === undefined || f.slice(0, 4) <= options.through)) {
      this.db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
  }

  /** Apply the migrations after `after` ("0024"), as a deploy does to a database holding data. */
  migrateAfter(after: string): void {
    for (const file of migrationFiles().filter((f) => f.slice(0, 4) > after)) {
      this.db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
  }

  /** Insert one row and return its id. */
  insert(table: string, row: Row): number {
    const cols = Object.keys(row);
    const sql =
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
    const result = this.db.prepare(sql).run(...(Object.values(row) as never[]));
    return Number(result.lastInsertRowid);
  }

  all(sql: string, ...params: unknown[]): Row[] {
    return this.db.prepare(sql).all(...(params as never[])) as Row[];
  }

  get(sql: string, ...params: unknown[]): Row | undefined {
    return this.db.prepare(sql).get(...(params as never[])) as Row | undefined;
  }

  run(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...(params as never[]));
  }
}

export const NOW = "2026-10-05T07:30:00Z";
