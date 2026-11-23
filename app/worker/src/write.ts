import { type Db, type DbStatement, type Row, type Value } from "./db";

/**
 * One tool call's writes, collected and then run as a single D1 batch (one
 * transaction). Ids are allocated up front, past every id the table has
 * held (lastId), so a call can link the rows it creates and return their
 * ids without reading back. Two concurrent calls colliding on an id fail the batch, and the
 * caller retries.
 *
 * Every record touched gets a `record_version` pointing at this call's
 * write_log row, so amend history is complete.
 */
export class WriteTx {
  readonly statements: DbStatement[] = [];
  private readonly nextIds = new Map<string, number>();
  /** Records this call touched: table -> ids. */
  readonly touched: { table: string; id: number; action: string }[] = [];

  constructor(
    readonly db: Db,
    readonly writeId: number,
    readonly at: string,
  ) {}

  /** Rows createMany inserted: their first versions go into one statement at finish(). */
  private readonly created: { table: string; id: number; data: Row }[] = [];
  /** "table:id" of every createMany row, so a later version of one in this call is refused. */
  private readonly createdKeys = new Set<string>();
  /** The lowest id allocate() may hand out per table, past ids a createMany row kept. */
  private readonly floors = new Map<string, number>();

  /** The next id of several tables in one statement (decision 96); allocate() then hands them out. */
  async reserve(tables: readonly string[]): Promise<void> {
    const fresh = [...new Set(tables)].filter((t) => !this.nextIds.has(t));
    if (fresh.length === 0) return;
    const row = await this.db.prepare(`SELECT ${fresh.map((t) => `${lastId(t)} AS "${t}"`).join(", ")}`).first<Record<string, number>>();
    for (const t of fresh) this.nextIds.set(t, (row?.[t] ?? 0) + 1);
  }

  /**
   * Insert many rows of one table, one statement per distinct key set
   * (usually one): the rows travel as one JSON parameter and are read back
   * with json_each, so D1's 100-parameter limit never applies (decision
   * 96). A column a row omits is left out of its statement, so the
   * column's DEFAULT applies, as with create(). A row with a numeric `id`
   * keeps it (and later allocations go past it); the others get the next
   * ids. Each row's first version is written by finish(), after every
   * staged statement, so a createMany row must not be updated, removed or
   * versioned again in the same call: that throws. The table and column
   * names are code, never input.
   */
  async createMany(table: string, rows: readonly Row[]): Promise<number[]> {
    if (!/^[a-z_]+$/.test(table)) throw new Error(`not a table name: ${table}`);
    if (rows.length === 0) return [];
    // Kept ids first, so no allocated id meets one of them.
    for (const r of rows) if (typeof r.id === "number") this.floors.set(table, Math.max(this.floors.get(table) ?? 0, r.id + 1));
    const full: (Row & { id: number })[] = [];
    for (const r of rows) full.push(typeof r.id === "number" ? (r as Row & { id: number }) : { id: await this.allocate(table), ...r });
    const shapes = new Map<string, { cols: string[]; rows: (Row & { id: number })[] }>();
    for (const r of full) {
      const cols = Object.keys(r).sort();
      for (const c of cols) if (!/^[a-z_]+$/.test(c)) throw new Error(`not a column name: ${c}`);
      const key = cols.join(",");
      const shape = shapes.get(key) ?? { cols, rows: [] };
      shape.rows.push(r);
      shapes.set(key, shape);
    }
    for (const { cols, rows: group } of shapes.values()) {
      const json = JSON.stringify(group.map((r) => Object.fromEntries(cols.map((c) => [c, toValue(r[c])]))));
      this.statements.push(
        this.db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) SELECT ${cols.map((c) => `json_extract(value, '$.${c}')`).join(", ")} FROM json_each(?)`).bind(json),
      );
    }
    for (const r of full) {
      this.touched.push({ table, id: r.id, action: "create" });
      this.created.push({ table, id: r.id, data: r });
      this.createdKeys.add(`${table}:${r.id}`);
    }
    return full.map((r) => r.id);
  }

  private assertNotCreated(table: string, id: number): void {
    if (this.createdKeys.has(`${table}:${id}`)) {
      throw new Error(`${table} ${id} was made by createMany in this call; its first version is written at finish(), so it can't be changed in the same call`);
    }
  }

  /**
   * The call's statements for the batch: everything staged, then one
   * statement with the first version of every createMany row, across
   * tables. An allocated id is never one a removed record had (lastId), so
   * a first version is version 1; a kept id (the importer's) is the
   * caller's to choose.
   */
  finish(): DbStatement[] {
    if (this.created.length === 0) return [...this.statements];
    return [...this.statements, ...this.versionRows("create", this.created)];
  }

  async allocate(table: string): Promise<number> {
    let next = this.nextIds.get(table);
    if (next === undefined) {
      const row = await this.db.prepare(`SELECT ${lastId(table)} AS m`).first<{ m: number }>();
      next = (row?.m ?? 0) + 1;
    }
    next = Math.max(next, this.floors.get(table) ?? 0);
    this.nextIds.set(table, next + 1);
    return next;
  }

  /** Insert a row that has an integer id, and record its first version. */
  async create(table: string, row: Row): Promise<number> {
    const id = await this.allocate(table);
    const full = { id, ...row };
    this.raw(table, full);
    this.version(table, id, "create", full);
    return id;
  }

  /** Insert a row with no version (join and composite-key tables). */
  raw(table: string, row: Row): void {
    const cols = Object.keys(row);
    const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
    this.statements.push(this.db.prepare(sql).bind(...cols.map((c) => toValue(row[c]))));
  }

  /** Run any statement as part of this call. */
  exec(sql: string, ...params: Value[]): void {
    this.statements.push(this.db.prepare(sql).bind(...params));
  }

  /** Update a versioned record; `after` is the full row after the change. */
  update(table: string, id: number, changes: Row, after: Row, action: "amend" | "confirm" = "amend"): void {
    this.assertNotCreated(table, id);
    const cols = Object.keys(changes);
    if (cols.length > 0) {
      const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`;
      this.statements.push(this.db.prepare(sql).bind(...cols.map((c) => toValue(changes[c])), id));
    }
    this.version(table, id, action, after);
  }

  /** Delete a record, keeping its last content as a version. */
  remove(table: string, id: number, before: Row, action: "reject" | "delete" | "retract"): void {
    this.assertNotCreated(table, id);
    this.version(table, id, action, before);
    this.statements.push(this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id));
  }

  /**
   * Every version of many records, across tables, in one statement: the
   * rows travel as one JSON parameter and are read back with json_each,
   * so neither the number of records nor of tables adds a statement and
   * D1's 100-parameter limit never applies (decision 126). D1 caps a bound
   * value at 2,000,000 bytes, so a batch whose JSON passes VERSION_JSON_BYTES
   * (long notes) is split into as many statements as it needs; any batch
   * under it is one. versionsAcross(), versions() and finish() use it;
   * version() (one row) and reopenLeftovers (its rows built in SQL) have
   * their own INSERTs.
   */
  private versionRows(action: string, records: readonly { table: string; id: number; data: Row }[]): DbStatement[] {
    const entries = records.map((r) => JSON.stringify({ t: r.table, id: r.id, data: JSON.stringify(r.data) }));
    return chunkJson(entries, VERSION_JSON_BYTES).map((json) =>
      this.db
        .prepare(
          `INSERT INTO record_version (write_id, table_name, record_id, version, action, data, created_at)
           SELECT ?, json_extract(j.value, '$.t'), json_extract(j.value, '$.id'),
                  (SELECT coalesce(max(v.version), 0) + 1 FROM record_version v
                    WHERE v.table_name = json_extract(j.value, '$.t') AND v.record_id = json_extract(j.value, '$.id')),
                  ?, json_extract(j.value, '$.data'), ?
           FROM json_each(?) AS j`,
        )
        .bind(this.writeId, action, this.at, json),
    );
  }

  /**
   * Versions for many records across tables, each touched once in this
   * call (a record named twice is refused: one statement can't give it two
   * versions), in one statement. The table names are code, never input.
   */
  versionsAcross(action: string, records: readonly { table: string; id: number; data: Row }[]): void {
    if (records.length === 0) return;
    const seen = new Set<string>();
    for (const r of records) {
      if (!/^[a-z_]+$/.test(r.table)) throw new Error(`not a table name: ${r.table}`);
      this.assertNotCreated(r.table, r.id);
      const key = `${r.table}:${r.id}`;
      if (seen.has(key)) throw new Error(`${r.table} ${r.id} is named twice in one versionsAcross call; give each record once`);
      seen.add(key);
    }
    for (const r of records) this.touched.push({ table: r.table, id: r.id, action });
    this.statements.push(...this.versionRows(action, records));
  }

  /** Versions for many records of one table: versionsAcross for one table. */
  versions(table: string, action: string, records: readonly { id: number; data: Row }[]): void {
    this.versionsAcross(action, records.map((r) => ({ table, id: r.id, data: r.data })));
  }

  version(table: string, id: number, action: string, data: Row): void {
    this.assertNotCreated(table, id);
    this.touched.push({ table, id, action });
    this.statements.push(
      this.db
        .prepare(
          `INSERT INTO record_version (write_id, table_name, record_id, version, action, data, created_at)
           VALUES (?, ?, ?, (SELECT coalesce(max(version), 0) + 1 FROM record_version WHERE table_name = ? AND record_id = ?), ?, ?, ?)`,
        )
        .bind(this.writeId, table, id, table, id, action, JSON.stringify(data), this.at),
    );
  }
}

/**
 * The highest id a table has ever handed out, as one scalar subquery: its
 * max(id), or a removed record's id still in record_version, whichever is
 * higher (decision 131). A rejected or retracted top record's id is never
 * handed out again, so a new record never continues its versions. Both
 * reads are index seeks (the rowid, and record_version's UNIQUE
 * (table_name, record_id, version)); no statement is added.
 */
export function lastId(table: string): string {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`not a table name: ${table}`);
  return `max(coalesce((SELECT max(id) FROM "${table}"), 0), coalesce((SELECT record_id FROM record_version WHERE table_name = '${table}' ORDER BY record_id DESC LIMIT 1), 0))`;
}

export function toValue(v: unknown): Value {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  return JSON.stringify(v);
}

/** The most JSON one versions statement binds: under D1's 2,000,000-byte value cap, with room to spare. */
export const VERSION_JSON_BYTES = 1_500_000;

/**
 * JSON arrays of the entries, each at most maxBytes of UTF-8 (an entry larger
 * than that goes alone). The common case is one array: a UTF-16 length that is
 * under a third of maxBytes can't pass it, so no bytes are counted.
 */
export function chunkJson(entries: readonly string[], maxBytes: number): string[] {
  const chars = entries.reduce((n, e) => n + e.length + 1, 1);
  if (chars * 3 <= maxBytes) return [`[${entries.join(",")}]`];
  const encoder = new TextEncoder();
  const out: string[] = [];
  let chunk: string[] = [];
  let bytes = 2;
  for (const e of entries) {
    const size = encoder.encode(e).length + 1;
    if (chunk.length > 0 && bytes + size > maxBytes) {
      out.push(`[${chunk.join(",")}]`);
      chunk = [];
      bytes = 2;
    }
    chunk.push(e);
    bytes += size;
  }
  if (chunk.length > 0) out.push(`[${chunk.join(",")}]`);
  return out;
}
