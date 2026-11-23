/**
 * The D1 subset the API uses. The Worker passes its real D1 binding, which
 * satisfies this structurally; tests pass a node:sqlite adapter.
 *
 * Writes are always one `batch`, which D1 runs as a single transaction, so
 * a tool call either lands whole or not at all.
 */
export type Value = string | number | null;
export type Row = Record<string, unknown>;

export interface DbStatement {
  bind(...values: Value[]): DbStatement;
  first<T = Row>(): Promise<T | null>;
  all<T = Row>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface Db {
  prepare(sql: string): DbStatement;
  batch(statements: DbStatement[]): Promise<unknown[]>;
}

/** Small read helpers over a Db. */
export async function first<T = Row>(db: Db, sql: string, ...params: Value[]): Promise<T | null> {
  return db.prepare(sql).bind(...params).first<T>();
}

export async function all<T = Row>(db: Db, sql: string, ...params: Value[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...params).all<T>()).results;
}

/** D1 binds at most 100 parameters to one statement. */
export const MAX_BOUND_PARAMS = 100;

/**
 * Rows for a set of keys, in as few statements as D1 allows: `sql` gets
 * the `?, ?, ...` list for an `IN (...)`, `prefix` params bind before it.
 * Keys are deduplicated and split into chunks under the 100-parameter
 * limit, one statement per chunk, so a caller never runs one query per
 * row (decision 96). Rows come back chunk by chunk, each in the
 * statement's own order: order across chunks only when a caller needs it.
 */
export async function allIn<T = Row>(db: Db, sql: (placeholders: string) => string, keys: readonly Value[], ...prefix: Value[]): Promise<T[]> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return [];
  const size = MAX_BOUND_PARAMS - prefix.length;
  const out: T[] = [];
  for (let i = 0; i < unique.length; i += size) {
    const chunk = unique.slice(i, i + size);
    out.push(...(await all<T>(db, sql(chunk.map(() => "?").join(", ")), ...prefix, ...chunk)));
  }
  return out;
}
