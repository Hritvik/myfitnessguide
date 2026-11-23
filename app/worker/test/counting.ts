// A Db wrapper that counts every statement D1 would execute, as D1's
// per-invocation query limit counts them: each first/all/run is one, and a
// batch is one per statement in it (developers.cloudflare.com/d1/platform/limits).
// Like D1, it refuses a statement binding more than 100 parameters.
import { MAX_BOUND_PARAMS, type Db, type DbStatement, type Row, type Value } from "../src/db";

class CountedStatement implements DbStatement {
  constructor(
    private readonly counter: CountingDb,
    readonly inner: DbStatement,
    readonly sql: string,
  ) {}

  bind(...values: Value[]): DbStatement {
    // D1 refuses a statement with more than 100 bound parameters.
    if (values.length > MAX_BOUND_PARAMS) throw new RangeError(`${values.length} bound parameters, over D1's ${MAX_BOUND_PARAMS}: ${this.sql}`);
    return new CountedStatement(this.counter, this.inner.bind(...values), this.sql);
  }

  async first<T = Row>(): Promise<T | null> {
    this.counter.record(this.sql);
    return this.inner.first<T>();
  }

  async all<T = Row>(): Promise<{ results: T[] }> {
    this.counter.record(this.sql);
    return this.inner.all<T>();
  }

  async run(): Promise<unknown> {
    this.counter.record(this.sql);
    return this.inner.run();
  }
}

export class CountingDb implements Db {
  /** Statements executed since the last reset, batch statements included. */
  count = 0;
  /** Their SQL, in order, for a failing budget's message. */
  log: string[] = [];

  constructor(readonly inner: Db) {}

  record(sql: string): void {
    this.count++;
    this.log.push(sql.replace(/\s+/g, " ").trim());
  }

  reset(): void {
    this.count = 0;
    this.log = [];
  }

  prepare(sql: string): DbStatement {
    return new CountedStatement(this, this.inner.prepare(sql), sql);
  }

  async batch(statements: DbStatement[]): Promise<unknown[]> {
    for (const s of statements) this.record((s as CountedStatement).sql);
    return this.inner.batch(statements.map((s) => (s as CountedStatement).inner));
  }
}
