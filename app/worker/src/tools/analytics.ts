import { addDays, weekStart } from "@myfitnessguide/domain";
import { z } from "zod";
import type { Ctx } from "../context";
import { all } from "../db";
import { ToolError } from "../errors";
import type { Tool, ToolResult } from "../tool";

const nutritionMetric = z.enum(["kcal", "protein_g", "carbs_g", "fat_g", "item_count"]);
const trainingMetric = z.enum(["sessions", "working_sets", "volume_kg", "best_e1rm_kg", "best_top_set_kg"]);
const common = {
  member: z.string().min(1),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  limit: z.number().int().min(1).max(100).default(100),
};
const inputSchema = z.discriminatedUnion("dataset", [
  z.object({ dataset: z.literal("nutrition"), metric: nutritionMetric, group_by: z.enum(["day", "week", "meal_slot"]), ...common }).strict(),
  z.object({ dataset: z.literal("training"), metric: trainingMetric, group_by: z.enum(["week", "exercise"]), ...common }).strict(),
]);
type AnalyticsInput = z.infer<typeof inputSchema>;

type AggregateRow = {
  period?: string;
  exercise_id?: number;
  exercise?: string;
  meal_slot?: string;
  value: number | null;
  known: number;
  total: number;
};

const daysInclusive = (from: string, to: string): number =>
  Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

function range(ctx: Ctx, input: AnalyticsInput): { from: string; to: string } {
  const to = input.to ?? ctx.today();
  const from = input.from ?? (input.dataset === "nutrition" ? addDays(to, -27) : addDays(weekStart(to), -77));
  const days = daysInclusive(from, to);
  if (days < 1) throw new ToolError("invalid_range", "from must not be after to", 400);
  if (days > 366) throw new ToolError("range_too_large", "analytics covers at most 366 days", 400);
  return { from, to };
}

const weekExpr = (column: string) => `date(${column}, '-' || strftime('%w', ${column}) || ' days')`;

function nutritionSql(metric: z.infer<typeof nutritionMetric>, group: "day" | "week" | "meal_slot"): string {
  const period = group === "week" ? weekExpr("eaten_on") : "eaten_on";
  const dimensions = group === "meal_slot" ? "meal_slot" : `${period} AS period`;
  const grouping = group === "meal_slot" ? "meal_slot" : "period";
  const value = metric === "item_count" ? "count(*)" : `sum(${metric})`;
  const known = metric === "item_count" ? "count(*)" : `count(${metric})`;
  return `SELECT ${dimensions}, ${value} AS value, ${known} AS known, count(*) AS total
          FROM v_intake_item WHERE member_id = ? AND eaten_on BETWEEN ? AND ? AND state = 'confirmed'
          GROUP BY ${grouping}
          ORDER BY ${group === "meal_slot" ? "CASE meal_slot WHEN 'pre_workout' THEN 1 WHEN 'breakfast' THEN 2 WHEN 'lunch' THEN 3 WHEN 'snack' THEN 4 WHEN 'dinner' THEN 5 ELSE 6 END, meal_slot" : "period"}
          LIMIT ?`;
}

function trainingSql(metric: z.infer<typeof trainingMetric>, group: "week" | "exercise"): string {
  if (metric === "sessions" && group === "week") {
    return `SELECT ${weekExpr("performed_on")} AS period, count(*) AS value, count(*) AS known, count(*) AS total
            FROM session WHERE member_id = ? AND performed_on BETWEEN ? AND ? AND state = 'confirmed'
            GROUP BY period ORDER BY period LIMIT ?`;
  }
  const bucket = group === "week"
    ? `${weekExpr("performed_on")} AS period`
    : "exercise_id, exercise_name AS exercise";
  const grouping = group === "week" ? "period" : "exercise_id, exercise_name";
  const value = metric === "sessions" ? "count(DISTINCT session_id)"
    : metric === "working_sets" ? "count(*)"
    : metric === "volume_kg" ? "sum(volume_kg)"
    : metric === "best_e1rm_kg" ? "max(CASE WHEN comparable = 1 THEN e1rm_rir_kg END)"
    : "max(total_load_kg)";
  const known = metric === "sessions" ? "count(DISTINCT session_id)"
    : metric === "working_sets" ? "count(*)"
    : metric === "volume_kg" ? "count(volume_kg)"
    : metric === "best_e1rm_kg" ? "count(CASE WHEN comparable = 1 THEN e1rm_rir_kg END)"
    : "count(total_load_kg)";
  const total = metric === "sessions" ? "count(DISTINCT session_id)" : "count(*)";
  return `SELECT ${bucket}, ${value} AS value, ${known} AS known, ${total} AS total
          FROM v_set WHERE member_id = ? AND performed_on BETWEEN ? AND ? AND state = 'confirmed' AND session_state = 'confirmed' AND set_type <> 'warm_up'
          GROUP BY ${grouping} ORDER BY ${group === "week" ? "period" : "lower(exercise_name), exercise_id"} LIMIT ?`;
}

function unavailable(metric: string, known: number, total: number): string | null {
  if (known > 0 || total === 0) return null;
  if (metric === "best_e1rm_kg") return "no working sets have a comparable RIR-adjusted e1RM";
  if (metric === "best_top_set_kg") return "no working sets have a known load";
  if (metric === "volume_kg") return "no working sets have computable volume";
  return `no items have known ${metric}`;
}

function describe(row: AggregateRow, metric: string): Record<string, unknown> {
  const total = Number(row.total);
  const known = Number(row.known);
  return {
    ...(row.period === undefined ? {} : { period: row.period }),
    ...(row.meal_slot === undefined ? {} : { meal_slot: row.meal_slot }),
    ...(row.exercise_id === undefined ? {} : { exercise_id: row.exercise_id, exercise: row.exercise }),
    value: row.value === null ? null : Number(row.value),
    value_known: known,
    value_total: total,
    value_coverage: total === 0 ? null : known / total,
    value_complete: total > 0 && known === total,
    reason: unavailable(metric, known, total),
  };
}

const analytics: Tool = {
  name: "analytics",
  group: "analytics",
  description:
    "Safe household-visible confirmed nutrition and training aggregates for questions and comparisons. Uses fixed semantic datasets, metrics and groupings—never SQL or caller-selected identifiers. value_coverage describes known values among logged rows; unlogged dates are omitted. Training excludes warm-ups and unavailable values are null, never zero.",
  write: false,
  input: inputSchema,
  async run(ctx: Ctx, raw: unknown): Promise<ToolResult> {
    const input = raw as AnalyticsInput;
    const member = await ctx.member(input.member);
    const { from, to } = range(ctx, input);
    const sql = input.dataset === "nutrition"
      ? nutritionSql(input.metric, input.group_by)
      : trainingSql(input.metric, input.group_by);
    // Fetch one sentinel row so `truncated` is truthful while the public
    // response remains capped at 100 rows.
    const fetched = await all<AggregateRow>(ctx.db, sql, member.id, from, to, input.limit + 1);
    const rows = fetched.slice(0, input.limit);
    return {
      dataset: input.dataset,
      member: member.name,
      metric: input.metric,
      group_by: input.group_by,
      from,
      to,
      rows: rows.map((row) => describe(row, input.metric)),
      empty_reason: rows.length === 0
        ? input.dataset === "nutrition"
          ? "no nutrition items in the selected period"
          : input.metric === "sessions" && input.group_by === "week"
            ? "no training sessions in the selected period"
            : "no working sets in the selected period"
        : null,
      truncated: fetched.length > input.limit,
    };
  },
};

export const ANALYTICS_TOOLS: readonly Tool[] = [analytics];
