// A node:sqlite adapter for the Db interface (the D1 subset the API uses),
// over an in-memory database with every migration applied. batch() is one
// transaction, as on D1.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { Db, DbStatement, Row, Value } from "../src/db";
import { TestDb } from "./db";

class Statement implements DbStatement {
  constructor(
    private readonly raw: DatabaseSync,
    readonly sql: string,
    readonly params: Value[] = [],
  ) {}

  bind(...values: Value[]): DbStatement {
    for (const v of values) {
      if (v === undefined) throw new TypeError(`undefined bound in: ${this.sql}`);
    }
    return new Statement(this.raw, this.sql, values);
  }

  private stmt(): StatementSync {
    return this.raw.prepare(this.sql);
  }

  async first<T = Row>(): Promise<T | null> {
    return ((this.stmt().get(...(this.params as never[])) as T | undefined) ?? null);
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

export class SqliteDb implements Db {
  readonly test: TestDb;
  /** Every statement batch() ran, for tests that count writes. */
  batches = 0;

  constructor() {
    this.test = new TestDb();
  }

  get raw(): DatabaseSync {
    return this.test.db;
  }

  prepare(sql: string): DbStatement {
    return new Statement(this.raw, sql);
  }

  async batch(statements: DbStatement[]): Promise<unknown[]> {
    this.batches++;
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
}
