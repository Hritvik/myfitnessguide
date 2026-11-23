import type { Db, DbStatement, Row, Value } from "../src/db";

class TimedStatement implements DbStatement {
  constructor(
    private readonly timer: TimedDb,
    readonly inner: DbStatement,
  ) {}

  bind(...values: Value[]): DbStatement {
    return new TimedStatement(this.timer, this.inner.bind(...values));
  }

  private async time<T>(run: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await run();
    } finally {
      this.timer.sqlMs += performance.now() - started;
    }
  }

  first<T = Row>(): Promise<T | null> {
    return this.time(() => this.inner.first<T>());
  }

  all<T = Row>(): Promise<{ results: T[] }> {
    return this.time(() => this.inner.all<T>());
  }

  run(): Promise<unknown> {
    return this.time(() => this.inner.run());
  }
}

/** Measures time inside the Db adapter, so a caller can subtract SQL wall time. */
export class TimedDb implements Db {
  sqlMs = 0;

  constructor(readonly inner: Db) {}

  reset(): void {
    this.sqlMs = 0;
  }

  prepare(sql: string): DbStatement {
    return new TimedStatement(this, this.inner.prepare(sql));
  }

  async batch(statements: DbStatement[]): Promise<unknown[]> {
    const started = performance.now();
    try {
      return await this.inner.batch(statements.map((statement) => (statement as TimedStatement).inner));
    } finally {
      this.sqlMs += performance.now() - started;
    }
  }
}
