/**
 * The one-time Sheets import, in process. The importer calls the same tool
 * handlers the API serves, with the same zod validation, so imported rows
 * meet the same rules as new ones. Writes are made by resolver `importer`
 * with origin `import`, and each write log row carries the Sheets origin
 * (file, tab, row) in `resolver_detail`.
 *
 * The import-only tools below cover what has no API path yet (the
 * household, gyms, exercises, programmes, goal points and the legacy Agent
 * Audit rows). They validate like any tool, and they are deliberately NOT
 * in TOOLS, so the Worker never routes them.
 *
 * Node only: never imported by the Worker entry point.
 */
import { fileURLToPath } from "node:url";
import { Ctx } from "./context";
import { first, type Db } from "./db";
import { Clarify, ToolError } from "./errors";
import { IMPORT_TOOLS } from "./tools/import";
import type { Tool, ToolResult } from "./tool";
import { TOOLS } from "./tools";
import { WriteTx } from "./write";

export { IMPORT_TOOLS };
export type { Db, DbStatement, Row, Value } from "./db";

/** The D1 migrations, for building a local rehearsal database. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export interface ImportOrigin {
  file: string;
  tab: string;
  row: number;
}

export interface ImportMeta {
  /** The write time: the snapshot's capture time, so a rehearsal is deterministic. */
  at: string;
  origin: ImportOrigin;
  reason?: string;
  /** Extra audit facts kept with the write (typed values the app recomputes). */
  detail?: Record<string, unknown>;
  timeZone?: string;
}

export type ImportResponse = ToolResult & { status: string };

const BY_NAME = new Map<string, Tool>([...TOOLS, ...IMPORT_TOOLS].map((t) => [t.name, t]));

export function importTool(name: string): Tool | undefined {
  return BY_NAME.get(name);
}

/**
 * Run one read tool as the importer (the parity report reads the API's own
 * computations this way). Returns the API's response shape.
 */
export async function importRead(db: Db, toolName: string, input: Record<string, unknown>, at: string, timeZone = "Asia/Kolkata"): Promise<ImportResponse> {
  const tool = BY_NAME.get(toolName);
  if (!tool || tool.write) throw new Error(`${toolName} is not a read tool`);
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) {
    return { status: "invalid", issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message, code: i.code })) };
  }
  const household = await first<{ id: number }>(db, "SELECT id FROM household ORDER BY id LIMIT 1");
  const now = new Date(at);
  const ctx = new Ctx(db, { kind: "agent", resolver: "importer", householdId: household?.id ?? 0, clientId: "importer", channel: "import" }, () => now, timeZone);
  try {
    return { status: "ok", ...(await tool.run(ctx, parsed.data)) };
  } catch (error) {
    if (error instanceof Clarify || error instanceof ToolError) return error.toResponse() as ImportResponse;
    throw error;
  }
}

/**
 * Run one write tool as the importer. Returns the API's own response shapes:
 * `ok`, `invalid` (schema), `needs_clarification` or `error`. Nothing is
 * written unless the status is `ok`.
 */
export async function importWrite(db: Db, toolName: string, input: Record<string, unknown>, meta: ImportMeta): Promise<ImportResponse> {
  const tool = BY_NAME.get(toolName);
  if (!tool || !tool.write) throw new Error(`${toolName} is not a write tool`);
  const { file, tab, row } = meta.origin;
  const body = { idempotency_key: `import:${file}:${tab}:${row}:${toolName}`, ...input };
  const parsed = tool.input.safeParse(body);
  if (!parsed.success) {
    return { status: "invalid", issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message, code: i.code })) };
  }
  const household = await first<{ id: number }>(db, "SELECT id FROM household ORDER BY id LIMIT 1");
  const at = new Date(meta.at);
  const ctx = new Ctx(db, { kind: "agent", resolver: "importer", householdId: household?.id ?? 0, clientId: "importer", channel: "import" }, () => at, meta.timeZone ?? "Asia/Kolkata");
  const writeId = (await first<{ m: number }>(db, "SELECT coalesce(max(id), 0) + 1 AS m FROM write_log"))?.m ?? 1;
  const tx = new WriteTx(db, writeId, ctx.nowIso());
  ctx.tx = tx;
  ctx.write = { origin: "import", speaker: null, onBehalfOf: null };
  let result: ToolResult;
  try {
    result = await tool.run(ctx, parsed.data);
  } catch (error) {
    if (error instanceof Clarify || error instanceof ToolError) return error.toResponse() as ImportResponse;
    throw error;
  }
  const log = db
    .prepare(
      `INSERT INTO write_log (id, at, resolver, resolver_detail, actor_member_id, on_behalf_of_member_id, origin, tool, reason, channel)
       VALUES (?, ?, 'importer', ?, NULL, ?, 'import', ?, ?, 'import')`,
    )
    .bind(
      writeId,
      ctx.nowIso(),
      JSON.stringify({ origin: meta.origin, ...meta.detail }),
      ctx.write.onBehalfOf,
      tool.name,
      meta.reason ?? `import ${file} ${tab} row ${row}`,
    );
  try {
    await db.batch([log, ...tx.finish()]);
  } catch (error) {
    return new ToolError("constraint", error instanceof Error ? error.message : String(error), 422).toResponse() as ImportResponse;
  }
  return { status: "ok", write_id: writeId, ...result };
}
