/**
 * A node:sqlite database with every D1 migration applied, behind the
 * Worker's Db interface (the same adapter pattern as the worker's tests).
 * batch() is one transaction, as on D1. Foreign keys are enforced, as on D1.
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { MIGRATIONS_DIR } from "@myfitnessguide/worker/importing";
import type { Db, DbStatement, Row, Value } from "@myfitnessguide/worker/importing";

class Statement implements DbStatement {
  constructor(
    private readonly raw: DatabaseSync,
    readonly sql: string,
    readonly params: Value[] = [],
  ) {}

  bind(...values: Value[]): DbStatement {
    for (const v of values) if (v === undefined) throw new TypeError(`undefined bound in: ${this.sql}`);
    return new Statement(this.raw, this.sql, values);
  }

  private stmt(): StatementSync {
    return this.raw.prepare(this.sql);
  }

  async first<T = Row>(): Promise<T | null> {
    return (this.stmt().get(...(this.params as never[])) as T | undefined) ?? null;
  }

  async all<T = Row>(): Promise<{ results: T[] }> {
    return { results: this.stmt().all(...(this.params as never[])) as T[] };
  }

  runSync(): unknown {
    return this.stmt().run(...(this.params as never[]));
  }

  async run(): Promise<unknown> {
    return this.runSync();
  }
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
}

export class LocalDb implements Db {
  readonly raw: DatabaseSync;

  /** A fresh database at `path` (":memory:" for tests), with every migration applied. */
  constructor(path = ":memory:") {
    if (path !== ":memory:") {
      // Household data: the file (and the journal SQLite gives the same mode) is owner-only.
      rmSync(path, { force: true });
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, "", { mode: 0o600 });
      chmodSync(path, 0o600);
    }
    this.raw = new DatabaseSync(path);
    for (const file of migrationFiles()) this.raw.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }

  prepare(sql: string): DbStatement {
    return new Statement(this.raw, sql);
  }

  async batch(statements: DbStatement[]): Promise<unknown[]> {
    this.raw.exec("BEGIN");
    try {
      const out = statements.map((s) => (s as Statement).runSync());
      this.raw.exec("COMMIT");
      return out;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  all<T = Row>(sql: string, ...params: Value[]): T[] {
    return this.raw.prepare(sql).all(...(params as never[])) as T[];
  }

  get<T = Row>(sql: string, ...params: Value[]): T | undefined {
    return this.raw.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  close(): void {
    this.raw.close();
  }
}
