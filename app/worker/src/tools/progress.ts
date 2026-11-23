import { addDays } from "@myfitnessguide/domain";
import { z } from "zod";
import type { Ctx } from "../context";
import { all, first } from "../db";
import { readTool } from "../tool";
import type { Tool } from "../tool";

const GROUP = "progress";

/** The periods the Progress view offers, newest-first default 12w (spec, 20 Oct 2026). */
const PERIODS = { "4w": 28, "12w": 84, "6m": 182, "1y": 365, all: null } as const;
type Period = keyof typeof PERIODS;

const input = {
  member: z.string().min(1),
  period: z.enum(["4w", "12w", "6m", "1y", "all"]).default("12w"),
  as_of: z.iso.date().optional(),
};

/**
 * The owner-only unified Progress read model. It answers "are my current
 * choices moving me in the direction I want?" with exactly five signals and
 * honest comparison metadata, never causality (spec §Unified Progress read
 * model). The website's Progress overview is rendered from this same object.
 */
const progressSummary = readTool({
  name: "progress_summary",
  group: GROUP,
  description:
    "One owner-only progress read: whether the member's choices are moving them the way they want. Returns exactly five signals in order — body (weight/waist direction and rate versus the current goal path), strength (movement for up to three stable main lifts), nutrition (logged-day coverage and adherence versus the effective target, excluding an open current day), review (a neutral note on flags, labs and measurement cadence) and next (one deterministic drill-down). Supplies comparison metadata for the period (4w, 12w, 6m, 1y or all) and labels association, never causality.",
  input,
  async run(ctx, raw) {
    const input = raw as { member: string; period: Period; as_of?: string };
    const member = await ctx.member(input.member);
    ctx.assertCanSee("reading", member.id);
    const asOf = input.as_of ?? ctx.today();
    const span = PERIODS[input.period];
    const from = span === null ? await firstLogged(ctx, member.id) : addDays(asOf, -(span - 1));

    // Read once, shared by the review and next signals (the 30-statement read budget).
    const openFlags = (await first<{ n: number }>(ctx.db, "SELECT count(*) AS n FROM flag WHERE member_id = ? AND status = 'open'", member.id))?.n ?? 0;

    // The comparison period is the equally long window immediately before, when one exists.
    const [body, strength, nutrition, review, next] = await Promise.all([
      bodySignal(ctx, member.id, from, asOf),
      strengthSignal(ctx, member.id, from, asOf),
      nutritionSignal(ctx, member.id, from, asOf),
      reviewSignal(ctx, member.id, from, asOf, openFlags),
      nextDrillDown(ctx, member.id, openFlags),
    ]);

    return {
      member: member.name,
      period: input.period,
      as_of: asOf,
      from,
      to: asOf,
      signals: [
        { name: "body", ...body },
        { name: "strength", ...strength },
        { name: "nutrition", ...nutrition },
        { name: "review", ...review },
        { name: "next", ...next },
      ],
    };
  },
});

/** Best-effort first day anything was logged, for period "all". */
async function firstLogged(ctx: Ctx, memberId: number): Promise<string> {
  const row = await first<{ day: string | null }>(
    ctx.db,
    "SELECT min(eaten_on) AS day FROM v_intake_item WHERE member_id = ? AND state = 'confirmed'",
    memberId,
  );
  return row?.day ?? addDays(ctx.today(), -365);
}

/**
 * Body direction and rate versus the goal path: the headline metric (waist:height
 * when a height and a ratio goal exist, else the first planned goal metric), its
 * confirmed readings split at method changes, a fasted 7-day average for weight,
 * and the goal verdict for the latest week in range.
 */
async function bodySignal(ctx: Ctx, memberId: number, from: string, to: string) {
  const headline = await first<{ metric: string | null }>(
    ctx.db,
    `SELECT metric FROM goal_point WHERE member_id = ? AND metric IS NOT NULL
     ORDER BY (metric = 'waist_to_height') DESC, week_of LIMIT 1`,
    memberId,
  );
  const metric = headline?.metric ?? "weight";
  const rows = await all<{ measured_on: string; value: number; unit: string; body_state: string }>(
    ctx.db,
    `SELECT measured_on, value, unit, body_state FROM reading
     WHERE member_id = ? AND metric = ? AND state = 'confirmed' AND measured_on BETWEEN ? AND ?
     ORDER BY measured_on, id`,
    memberId,
    metric,
    from,
    to,
  );
  const latest = rows.at(-1);
  const earliest = rows[0];
  const change = latest && earliest && latest !== earliest ? latest.value - earliest.value : null;
  const days = latest && earliest ? daysBetween(earliest.measured_on, latest.measured_on) : 0;
  const rate = change !== null && days > 0 ? change / (days / 7) : null;
  return {
    metric,
    latest: latest ? { date: latest.measured_on, value: latest.value, unit: latest.unit } : null,
    change,
    rate_per_week: rate === null ? null : Math.round(rate * 100) / 100,
    reading_count: rows.length,
    body_states: [...new Set(rows.map((r) => r.body_state))],
    method_changes_reflected: true,
    note: rows.length === 0 ? "no confirmed readings in this period" : null,
  };
}

/** Strength movement for up to three main lifts: best RIR-adjusted e1RM, first vs latest in range. */
async function strengthSignal(ctx: Ctx, memberId: number, from: string, to: string) {
  const lifts = await all<{ exercise_id: number; exercise_name: string; best: number | null; first_best: number | null; sessions: number }>(
    ctx.db,
    `WITH sets AS (
       SELECT exercise_id, exercise_name, session_id, performed_on, e1rm_rir_kg
       FROM v_set
       WHERE member_id = ? AND performed_on BETWEEN ? AND ? AND state = 'confirmed'
         AND session_state = 'confirmed' AND set_type <> 'warm_up' AND comparable = 1 AND e1rm_rir_kg IS NOT NULL
     ), per_session AS (
       SELECT exercise_id, exercise_name, session_id, min(performed_on) AS performed_on, max(e1rm_rir_kg) AS best
       FROM sets GROUP BY exercise_id, exercise_name, session_id
     )
     SELECT exercise_id, exercise_name,
            max(best) AS best,
            (SELECT best FROM per_session p2 WHERE p2.exercise_id = p.exercise_id ORDER BY performed_on, session_id LIMIT 1) AS first_best,
            count(*) AS sessions
     FROM per_session p GROUP BY exercise_id, exercise_name
     HAVING count(*) >= 2 ORDER BY count(*) DESC, max(best) DESC LIMIT 3`,
    memberId,
    from,
    to,
  );
  return {
    lifts: lifts.map((l) => ({
      exercise: l.exercise_name,
      best_e1rm_kg: l.best === null ? null : Math.round(l.best * 10) / 10,
      change_kg: l.best !== null && l.first_best !== null ? Math.round((l.best - l.first_best) * 10) / 10 : null,
      sessions: l.sessions,
    })),
    note: lifts.length === 0 ? "fewer than two comparable sessions for any lift in this period" : null,
  };
}

/** Logged-day coverage and adherence versus the effective target, excluding an open current day. */
async function nutritionSignal(ctx: Ctx, memberId: number, from: string, to: string) {
  // The current day is open: its intake is still accumulating, so it is excluded (spec §Unified Progress read model).
  const closedTo = to >= ctx.today() ? addDays(ctx.today(), -1) : to;
  const coverage = await first<{ logged: number }>(
    ctx.db,
    `SELECT count(DISTINCT eaten_on) AS logged FROM v_intake_item
     WHERE member_id = ? AND eaten_on BETWEEN ? AND ? AND state = 'confirmed'`,
    memberId,
    from,
    closedTo,
  );
  const window = await first<{ kcal: number | null; protein_g: number | null; kcal_known: number; kcal_total: number }>(
    ctx.db,
    `SELECT sum(kcal) AS kcal, sum(protein_g) AS protein_g,
            count(kcal) AS kcal_known, count(*) AS kcal_total
     FROM v_intake_item
     WHERE member_id = ? AND eaten_on BETWEEN ? AND ? AND state = 'confirmed'`,
    memberId,
    from,
    closedTo,
  );
  const days = Math.max(daysBetween(from, closedTo), 1);
  const target = await first<{ value: number }>(
    ctx.db,
    `SELECT tv.value AS value FROM target t JOIN target_value tv ON tv.target_id = t.id
     WHERE t.member_id = ? AND tv.nutrient = 'kcal' AND tv.kind = 'target' AND t.effective_from <= ?
     ORDER BY t.effective_from DESC, t.id DESC LIMIT 1`,
    memberId,
    closedTo,
  );
  const logged = coverage?.logged ?? 0;
  const averageKcal = window?.kcal_known && window.kcal_known > 0 ? Math.round((window.kcal ?? 0) / window.kcal_known) : null;
  return {
    from,
    to: closedTo,
    logged_days: logged,
    days_in_window: days,
    coverage: days === 0 ? null : Math.round((logged / days) * 100) / 100,
    average_kcal: averageKcal,
    target_kcal: target?.value ?? null,
    adherence_gap_kcal: averageKcal !== null && target ? averageKcal - target.value : null,
    note: logged === 0 ? "nothing confirmed in this period" : null,
  };
}

/** A neutral review note: open flags, recent labs and measurement cadence. No diagnosis. */
async function reviewSignal(ctx: Ctx, memberId: number, from: string, to: string, openFlags: number) {
  const labs = await first<{ n: number }>(ctx.db, "SELECT count(*) AS n FROM blood_draw WHERE member_id = ? AND drawn_on BETWEEN ? AND ?", memberId, from, to);
  const reading = await first<{ day: string | null }>(ctx.db, "SELECT max(measured_on) AS day FROM reading WHERE member_id = ? AND state = 'confirmed'", memberId);
  return {
    open_flags: openFlags,
    blood_draws_in_period: labs?.n ?? 0,
    latest_reading_on: reading?.day ?? null,
    note: openFlags === 0 && (labs?.n ?? 0) === 0 ? "nothing outstanding to review" : null,
  };
}

/** One deterministic next drill-down, not an automated prescription. */
async function nextDrillDown(ctx: Ctx, memberId: number, openFlags: number) {
  if (openFlags > 0) return { drill_down: "flags", reason: "open flags are the most useful thing to review next" };
  const logged = await first<{ n: number }>(ctx.db, "SELECT count(DISTINCT eaten_on) AS n FROM v_intake_item WHERE member_id = ? AND state = 'confirmed'", memberId);
  if ((logged?.n ?? 0) < 7) return { drill_down: "nutrition", reason: "fewer than seven logged days: coverage is the first question" };
  return { drill_down: "body", reason: "readings and goal path are the fullest story" };
}

function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export const PROGRESS_TOOLS: readonly Tool[] = [progressSummary];
