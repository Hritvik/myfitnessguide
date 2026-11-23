/**
 * The durable prep schedule: what a saved plan derived, and what is still
 * pending (decision 169). The rule itself is the domain's buildPrepSchedule;
 * this module is the D1 read/write side and the local-clock helpers.
 */
import type { PrepTask } from "@myfitnessguide/domain";
import { addDays } from "@myfitnessguide/domain";
import type { Ctx } from "./context";
import { all, type Row } from "./db";

export interface PrepTaskRow extends Row {
  id: number;
  household_id: number;
  meal_plan_id: number;
  task_key: string;
  action: string;
  who: "eater" | "cook" | "anyone";
  status: "pending" | "done" | "skipped";
  due_on: string;
  window_start: string;
  window_end: string;
  settled_on: string | null;
  settled_by: number | null;
  settled_reason: string | null;
  canonical_json: string;
  created_at: string;
}

/** How far ahead a freshly logged meal looks for its next prep. */
export const NEXT_PREP_HORIZON_H = 18;

function addHours(dateTime: string, hours: number): string {
  const [date, time] = dateTime.split("T") as [string, string];
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [h, min] = time.split(":").map(Number) as [number, number];
  const moved = new Date(Date.UTC(y, m - 1, d, h, min) + hours * 3_600_000);
  return `${moved.toISOString().slice(0, 10)}T${moved.toISOString().slice(11, 16)}`;
}

/** The household's wall clock now, as YYYY-MM-DDTHH:MM. */
export function localNow(ctx: Ctx): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ctx.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(ctx.clock());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour") === "24" ? "00" : get("hour")}:${get("minute")}`;
}

/** The household's wall clock now, shifted by hours, as YYYY-MM-DDTHH:MM. */
export function localHoursFromNow(ctx: Ctx, hours: number): string {
  return addHours(localNow(ctx), hours);
}

export function taskOf(row: PrepTaskRow): PrepTask & { id: number; status: string } {
  return { ...(JSON.parse(row.canonical_json) as PrepTask), id: row.id, status: row.status };
}

/** Every task of one plan revision, in order. */
export async function loadPlanPrepTasks(ctx: Ctx, planId: number): Promise<PrepTaskRow[]> {
  return all<PrepTaskRow>(ctx.db, "SELECT * FROM prep_task WHERE meal_plan_id = ? ORDER BY window_start, id", planId);
}

/**
 * The pending tasks of the current active plan in a date window, one
 * statement. The member filter is applied in JavaScript because `assignees`
 * is part of the task's JSON.
 */
export async function pendingPrepTasks(ctx: Ctx, options: { from: string; to: string; member?: string; includeCook?: boolean }): Promise<(PrepTask & { id: number; status: string })[]> {
  const rows = await all<PrepTaskRow>(
    ctx.db,
    `SELECT t.* FROM prep_task t JOIN meal_plan p ON p.id = t.meal_plan_id
      WHERE t.household_id = ?1 AND p.status = 'active' AND p.archived_at IS NULL AND p.superseded_at IS NULL
        AND p.effective_from <= ?3 AND p.effective_to >= ?2
        AND t.status = 'pending' AND t.due_on BETWEEN ?2 AND ?3
      ORDER BY t.window_start, t.id`,
    ctx.householdId, options.from, options.to,
  );
  const member = options.member?.trim().toLowerCase();
  return rows
    .map(taskOf)
    .filter((task) => {
      if (member === undefined) return true;
      if (task.who === "anyone") return true;
      if (task.who === "cook") return options.includeCook === true;
      return task.assignees.some((name) => name.trim().toLowerCase() === member);
    });
}

/** The tasks a member should act on now: their window is open or opens within the horizon. */
export function dueNow(tasks: readonly (PrepTask & { id: number; status: string })[], now: string): (PrepTask & { id: number; status: string })[] {
  const horizon = addHours(now, NEXT_PREP_HORIZON_H);
  return tasks.filter((task) => task.window_start <= horizon && task.window_end >= addHours(now, -24));
}

/** What a member should do now for their next meals, for a just-logged meal. One statement. */
export async function nextPrepFor(ctx: Ctx, member: { name: string }, date: string): Promise<(PrepTask & { id: number; status: string })[]> {
  const tasks = await pendingPrepTasks(ctx, { from: date, to: addDays(date, 1), member: member.name });
  return dueNow(tasks, localNow(ctx));
}

/**
 * Open cooked batches: confirmed cooks in the last week with a component
 * whose portions do not account for it and no disposition. One statement.
 */
export async function preparedBatches(ctx: Ctx, today: string): Promise<Row[]> {
  return all<Row>(
    ctx.db,
    `WITH open AS (
       SELECT k.id AS cook_id, k.name AS cook, k.cooked_on,
              c.id AS component_id, c.name AS component,
              CASE
                WHEN c.cooked_weight_g IS NOT NULL
                THEN MAX(0.0, 1.0
                  - (SELECT COALESCE(sum(p.weighed_g), 0) FROM portion p WHERE p.component_id = c.id AND p.kind = 'weighed') / c.cooked_weight_g
                  - (SELECT COALESCE(sum(p.fraction), 0) FROM portion p WHERE p.component_id = c.id AND p.kind = 'fraction'))
                ELSE MAX(0.0, 1.0 - (SELECT COALESCE(sum(p.fraction), 0) FROM portion p WHERE p.component_id = c.id AND p.kind = 'fraction'))
              END AS fraction
       FROM cook k JOIN component c ON c.cook_id = k.id
       WHERE k.household_id = ?1 AND k.state = 'confirmed' AND k.cooked_on BETWEEN date(?2, '-7 day') AND ?2
         AND NOT EXISTS (SELECT 1 FROM remainder_disposition d WHERE d.component_id = c.id)
     )
     SELECT * FROM open WHERE fraction > 0.05 ORDER BY cooked_on DESC, cook_id DESC, component_id LIMIT 20`,
    ctx.householdId, today,
  );
}
