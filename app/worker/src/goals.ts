/**
 * Goal points: one validator and row builder for set_goal_point and the
 * import-only create_goal_point, so both store the same thing. A goal's
 * week is stored as its Sunday (weekStart), the way goalVerdict reads
 * weeks; the Sheets import gives the sheet's date, which can be a Monday.
 */
import { addDays, weekStart } from "@myfitnessguide/domain";
import type { Ctx, Member } from "./context";
import { all, first } from "./db";
import { Clarify } from "./errors";
import { fuzzyRank } from "./fuzzy";
import { findExercise } from "./training";

export interface GoalInput {
  metric?: string | undefined;
  exercise?: string | undefined;
  week_of: string;
  tier: "planned" | "stretch";
  basis: "absolute" | "bodyweight_multiple";
  low: number;
  high: number;
  unit?: string | undefined;
  headline?: boolean | undefined;
  note?: string | undefined;
}

export interface GoalPointRow {
  member_id: number;
  metric: string | null;
  exercise_id: number | null;
  week_of: string;
  tier: "planned" | "stretch";
  basis: "absolute" | "bodyweight_multiple";
  value_low: number;
  value_high: number;
  unit: string | null;
  headline: number;
  note: string | null;
}

/** Metrics with no measured unit: their goal points take this unit when none is given. */
const UNITLESS: Record<string, string> = { waist_to_height: "ratio" };

async function unitsOf(ctx: Ctx, dimension: string): Promise<string[]> {
  return (await all<{ code: string }>(ctx.db, "SELECT code FROM unit WHERE dimension = ? ORDER BY code", dimension)).map((u) => u.code);
}

/** A validated goal_point row; asks rather than guessing. */
export async function goalPointRow(ctx: Ctx, member: Member, g: GoalInput): Promise<GoalPointRow> {
  if ((g.metric === undefined) === (g.exercise === undefined)) throw new Clarify("goal_subject", "Is the goal on a metric or an exercise?", [], ["metric"]);
  if (g.low > g.high) throw new Clarify("goal_range", "The goal range runs low to high; which numbers?", [], ["range"]);
  let metric: { code: string; dimension: string } | null = null;
  if (g.metric !== undefined) {
    const metrics = await all<{ code: string; dimension: string }>(ctx.db, "SELECT code, dimension FROM metric ORDER BY code");
    metric = metrics.find((m) => m.code === g.metric?.trim().toLowerCase()) ?? null;
    if (!metric) {
      const options = fuzzyRank(g.metric, metrics.map((m) => ({ item: m.code, names: [m.code, m.code.replace(/_/g, " ")] })));
      throw new Clarify("unknown_metric", `Which metric is ${g.metric}?`, options.length > 0 ? options : metrics.map((m) => m.code), ["metric"]);
    }
  }
  const exercise = g.exercise === undefined ? null : await findExercise(ctx, g.exercise, ["exercise"]);
  let unit: string | null = null;
  if (g.basis === "absolute") {
    // An exercise goal is a load (mass); a metric goal is in its metric's dimension.
    const dimension = metric?.dimension ?? "mass";
    unit = g.unit ?? (metric ? UNITLESS[metric.code] : undefined) ?? null;
    if (unit === null) throw new Clarify("unit_needed", `In what unit is the ${metric?.code ?? exercise?.name} goal?`, await unitsOf(ctx, dimension), ["unit"]);
    const fits = await first<{ code: string }>(ctx.db, "SELECT code FROM unit WHERE code = ? AND dimension = ?", unit, dimension);
    if (!fits) {
      const units = await unitsOf(ctx, dimension);
      throw new Clarify("unit_mismatch", `${metric?.code ?? exercise?.name} goals are in ${units.join(" or ")}; which was it?`, units, ["unit"]);
    }
  } else if (g.unit !== undefined) {
    throw new Clarify("multiple_has_no_unit", "A bodyweight multiple has no unit.", [], ["unit"]);
  }
  return {
    member_id: member.id, metric: metric?.code ?? null, exercise_id: exercise?.id ?? null, week_of: weekStart(g.week_of), tier: g.tier, basis: g.basis,
    value_low: g.low, value_high: g.high, unit, headline: g.headline ? 1 : 0, note: g.note ?? null,
  };
}

/** The stored goal point this one replaces: same member, subject, tier and basis, anywhere in its Sunday-to-Saturday week. */
export async function findGoalPoint(ctx: Ctx, row: GoalPointRow): Promise<(GoalPointRow & { id: number }) | null> {
  return first<GoalPointRow & { id: number }>(
    ctx.db,
    `SELECT * FROM goal_point WHERE member_id = ? AND coalesce(metric, '') = ? AND coalesce(exercise_id, 0) = ? AND tier = ? AND basis = ?
       AND week_of BETWEEN ? AND ? ORDER BY id LIMIT 1`,
    row.member_id,
    row.metric ?? "",
    row.exercise_id ?? 0,
    row.tier,
    row.basis,
    row.week_of,
    addDays(row.week_of, 6),
  );
}
