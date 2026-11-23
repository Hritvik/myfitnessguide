import { z } from "zod";
import { all } from "../db";
import { ToolError } from "../errors";
import { checkQuery, QueryRefused, tokenize } from "../query";
import { readTool, type Tool } from "../tool";

/**
 * Views over owner-only data: readings, blood draws, flags and member
 * notes, and the views whose text cites them (decision 135): targets'
 * reasoning, goal points, phases' intent, prescriptions' coach notes,
 * heart rate zones, and training views with free text (decision 137). A
 * view has no row filter, so each is agent only.
 */
export const OWNER_ONLY_VIEWS = new Set([
  "v_reading", "v_weight_7d", "v_lab_result", "v_flag", "v_member_note", "v_method_change",
  "v_target", "v_goal_point", "v_phase", "v_prescription", "v_hr_zone",
  // Training's free text (decision 137): v_session names the phase, v_cardio_block carries the block's note.
  "v_session", "v_cardio_block",
]);
/** Raw tables a member may name, as columns: reference data whose names are also view columns. */
const REFERENCE_TABLES = new Set(["unit", "metric"]);

/**
 * What a member's query would be refused over (decision 138): every view
 * it reads that is owner-only, and any word anywhere that names an
 * owner-only view or a raw table, so a parse the checker gets wrong can't
 * reach them. `unit` and `metric` are reference tables whose names are also
 * view columns. Members are refused `query` outright today (decision 136);
 * this is the gate a member-facing query must pass if that is lifted.
 */
export function memberRefusal(sql: string, readViews: readonly string[], tables: ReadonlySet<string>): string[] {
  const named = tokenize(sql)
    .filter((t) => t.kind === "word" || t.kind === "quoted")
    .map((t) => t.text.toLowerCase())
    .filter((n) => OWNER_ONLY_VIEWS.has(n) || (tables.has(n) && !REFERENCE_TABLES.has(n)));
  return [...new Set([...readViews.filter((v) => OWNER_ONLY_VIEWS.has(v)), ...named])];
}

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 1000;

const query = readTool({
  name: "query",
  group: "query",
  description:
    "Read-only SQL over the curated v_* views (sessions with volume and e1RM, intake with macros, readings with trends, and more). One SELECT (CTEs allowed, not recursive); any raw table is refused. Views include drafts with a state column. Rows are capped by limit (default 200, max 1000). The agent's tool: a signed-in member is refused.",
  input: {
    sql: z.string().min(1).max(20_000),
    params: z.array(z.union([z.string(), z.number(), z.null()])).max(100).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  },
  async run(ctx, input) {
    // The agent's tool only (decision 136): the app never calls it, and a member's own SQL could reach owner-only rows.
    if (ctx.caller.kind === "member") throw new ToolError("not_visible", "query is the agent's tool; the app's screens read the same data", 403);
    const schema = await all<{ type: string; name: string }>(ctx.db, "SELECT type, lower(name) AS name FROM sqlite_master WHERE type IN ('table', 'view')");
    const views = new Set(schema.filter((s) => s.type === "view").map((s) => s.name));
    const tables = new Set(schema.filter((s) => s.type === "table").map((s) => s.name));
    let checked;
    try {
      checked = checkQuery(input.sql, views, tables);
    } catch (error) {
      if (error instanceof QueryRefused) throw new ToolError("query_refused", error.message, 400);
      throw error;
    }
    const limit = input.limit ?? DEFAULT_LIMIT;
    let rows: Record<string, unknown>[];
    try {
      rows = await all(ctx.db, `SELECT * FROM (${checked.sql}\n) LIMIT ?`, ...(input.params ?? []), limit + 1);
    } catch (error) {
      throw new ToolError("query_error", error instanceof Error ? error.message : String(error), 400);
    }
    const truncated = rows.length > limit;
    if (truncated) rows = rows.slice(0, limit);
    return { columns: rows[0] ? Object.keys(rows[0]) : [], rows, row_count: rows.length, truncated, limit, views: checked.views };
  },
});

export const QUERY_TOOLS: Tool[] = [query];
