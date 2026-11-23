/**
 * The final-load SQL: the rehearsal database's rows as plain INSERTs, for
 * `wrangler d1 execute gym-tracker --remote --file <chunk>` against a D1
 * database with the same migrations applied and no data.
 *
 * D1 limits respected: one SQL statement stays under 100 KB (multi-row
 * INSERTs are cut at MAX_STATEMENT_BYTES), files are cut at a size wrangler
 * uploads comfortably, and nothing opens a transaction (D1 runs a file
 * atomically itself and refuses BEGIN/COMMIT). Tables are ordered so every
 * foreign key points at rows already loaded. Reference rows the migrations
 * seed (units, metrics) are left out.
 *
 * Generating it never executes it. See README.md for the cutover commands.
 */
import { LocalDb } from "./sqlite";

export const MAX_STATEMENT_BYTES = 90_000;
export const MAX_FILE_BYTES = 1_000_000;

export interface SqlChunk {
  name: string;
  sql: string;
  statements: number;
  rows: number;
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

export function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`cannot dump ${v}`);
    return String(v);
  }
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString("hex")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Tables in an order where every foreign key's target comes first. */
export function tableOrder(db: LocalDb): string[] {
  const tables = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%' ORDER BY name")
    .map((t) => t.name);
  const deps = new Map(tables.map((t) => [t, new Set(db.all<{ table: string }>(`SELECT "table" FROM pragma_foreign_key_list('${t}')`).map((r) => r.table).filter((x) => x !== t))]));
  const out: string[] = [];
  const done = new Set<string>();
  while (out.length < tables.length) {
    const ready = tables.filter((t) => !done.has(t) && [...(deps.get(t) ?? [])].every((d) => done.has(d) || !deps.has(d)));
    if (ready.length === 0) throw new Error(`foreign-key cycle among ${tables.filter((t) => !done.has(t)).join(", ")}`);
    for (const t of ready) {
      out.push(t);
      done.add(t);
    }
  }
  return out;
}

/** Rows loaded per table, leaving out the rows the migrations seed. */
export function loadedCounts(db: LocalDb): Record<string, number> {
  const seeded = new LocalDb();
  const out: Record<string, number> = {};
  for (const table of tableOrder(db)) {
    const n = (db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0) - (seeded.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0);
    if (n > 0) out[table] = n;
  }
  seeded.close();
  return out;
}

export function sqlDump(db: LocalDb, options: { maxStatementBytes?: number; maxFileBytes?: number; header?: string } = {}): SqlChunk[] {
  const maxStatement = options.maxStatementBytes ?? MAX_STATEMENT_BYTES;
  const maxFile = options.maxFileBytes ?? MAX_FILE_BYTES;
  const seeded = new LocalDb();
  const seededRows = new Map<string, Set<string>>();
  const statements: { sql: string; rows: number }[] = [];
  for (const table of tableOrder(db)) {
    const seed = new Set(seeded.all(`SELECT * FROM ${table}`).map((r) => JSON.stringify(r)));
    seededRows.set(table, seed);
    const rows = db.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY rowid`).filter((r) => !seed.has(JSON.stringify(r)));
    if (rows.length === 0) continue;
    const cols = Object.keys(rows[0] as Record<string, unknown>);
    const head = `INSERT INTO ${table} (${cols.join(", ")}) VALUES\n`;
    let values: string[] = [];
    let size = bytes(head);
    const flush = () => {
      if (values.length === 0) return;
      statements.push({ sql: `${head}${values.join(",\n")};\n`, rows: values.length });
      values = [];
      size = bytes(head);
    };
    for (const row of rows) {
      const tuple = `(${cols.map((c) => literal(row[c])).join(", ")})`;
      const add = bytes(tuple) + 2;
      if (bytes(head) + add + 2 > maxStatement) throw new Error(`one ${table} row is larger than a D1 statement allows`);
      if (size + add + 2 > maxStatement) flush();
      values.push(tuple);
      size += add;
    }
    flush();
  }
  seeded.close();
  const header = options.header ?? "-- Gym Tracker final load. Apply in order, to a D1 database with every migration applied and no data.";
  const chunks: SqlChunk[] = [];
  let current: { sql: string[]; size: number; statements: number; rows: number } = { sql: [], size: 0, statements: 0, rows: 0 };
  const close = () => {
    if (current.statements === 0) return;
    const name = `final-load-${String(chunks.length + 1).padStart(3, "0")}.sql`;
    chunks.push({ name, sql: `${header}\n-- ${name}\n${current.sql.join("")}`, statements: current.statements, rows: current.rows });
    current = { sql: [], size: 0, statements: 0, rows: 0 };
  };
  for (const s of statements) {
    if (current.size + bytes(s.sql) > maxFile) close();
    current.sql.push(s.sql);
    current.size += bytes(s.sql);
    current.statements++;
    current.rows += s.rows;
  }
  close();
  return chunks;
}
