/**
 * Saved workouts (spec §5): household-level lists of exercises with
 * default sets, reps and loads, the training counterpart of a recipe.
 */
import { compositionAmount } from "@myfitnessguide/domain";
import { z } from "zod";
import type { Ctx } from "./context";
import { all, type Row } from "./db";
import { Clarify } from "./errors";
import { fuzzyRank } from "./fuzzy";
import { PROGRAMME_LOAD, programmeLoad, platesOf, type ProgrammeLoad } from "./sets";
import { storedPlates } from "./training";

export interface WorkoutRef {
  id: number;
  name: string;
}

/** A workout by id, name or alias (ignoring case), in one statement; unknown asks with the closest names. */
export async function workoutByRef(ctx: Ctx, ref: number | string, path: (string | number)[], includeArchived = false): Promise<WorkoutRef> {
  const rows = await all<{ id: number; name: string; aliases: string }>(
    ctx.db,
    `SELECT w.id, w.name, (SELECT json_group_array(a.alias) FROM alias a WHERE a.household_id = w.household_id AND a.kind = 'workout' AND a.target_id = w.id) AS aliases
     FROM workout w WHERE w.household_id = ? AND (? OR w.archived_at IS NULL) ORDER BY w.name`,
    ctx.householdId,
    includeArchived ? 1 : 0,
  );
  const named = rows.map((r) => ({ id: r.id, name: r.name, aliases: JSON.parse(r.aliases) as string[] }));
  const key = typeof ref === "string" ? ref.trim().toLowerCase() : null;
  const hit = named.find((w) => (typeof ref === "number" ? w.id === ref : w.name.toLowerCase() === key || w.aliases.some((a) => a.toLowerCase() === key)));
  if (hit) return { id: hit.id, name: hit.name };
  const options = typeof ref === "string" ? fuzzyRank(ref, named.map((w) => ({ item: w.name, names: [w.name, ...w.aliases] }))).slice(0, 5) : named.map((w) => w.name).slice(0, 5);
  throw new Clarify("unknown_workout", `Which workout is ${ref}?`, options, path);
}

/**
 * A line's default load: a programme load, whose bar may also be null for
 * plates with no bar (a plate-loaded machine whose own weight isn't
 * counted), as distinct from a bar left out, which asks.
 */
const LINE_LOAD = {
  ...PROGRAMME_LOAD,
  bar: z
    .union([z.object({ value: z.number().min(0).lt(100), unit: z.enum(["kg", "lb"]) }).strict(), z.null()])
    .optional()
    .describe("The bar or sled, for plates per side; null for no bar (a plate-loaded machine). Plates with the bar left out ask for it."),
};

export const WORKOUT_LINE = z
  .object({
    exercise: z.string().min(1).describe("Exercise name or alias."),
    set_type: z.enum(["warm_up", "working", "back_off", "calibration"]).optional().describe("Default working."),
    sets: z.number().int().min(1).max(20),
    reps: z.object({ low: z.number().int().min(0).max(200), high: z.number().int().min(0).max(200) }).strict().optional(),
    duration_s: z.number().int().positive().optional(),
    distance: z.object({ value: z.number().positive(), unit: z.enum(["m", "km", "mi"]) }).strict().optional(),
    load: z
      .union([z.object(LINE_LOAD).strict(), z.literal("none")])
      .optional()
      .describe("The default load: a value with unit and basis, plates per side on a bar (units may mix), or none for bodyweight."),
    rir: z.object({ low: z.number().int().min(0).max(10), high: z.number().int().min(0).max(10) }).strict().optional(),
    rest_s: z.number().int().positive().optional(),
    note: z.string().optional(),
  })
  .strict();
export type WorkoutLineIn = z.infer<typeof WORKOUT_LINE>;

/** A line's columns, checked: one target, a rep and RIR range that run low to high, a load as a programme load is read. */
/** A line's load as a programme load is read, except that plates with a null bar are stored with no bar. */
function lineLoad(load: Exclude<WorkoutLineIn["load"], "none" | undefined>, path: (string | number)[]): ProgrammeLoad {
  const { bar, ...rest } = load;
  if (bar !== null) return programmeLoad(bar === undefined ? rest : { ...rest, bar }, null, path);
  if (!rest.plates) return programmeLoad(rest, null, path);
  if (rest.basis !== "per_side") throw new Clarify("bar_only_per_side", "A bar or plates go with a per-side load. Is the load per side?", [], [...path, "basis"]);
  const plates = platesOf(rest.plates);
  const amount = compositionAmount(plates);
  return { value: amount.value, unit: amount.unit, basis: "per_side", bar: null, plates };
}

export function lineColumns(line: WorkoutLineIn, exerciseId: number, path: (string | number)[]): Row {
  const targets = [line.reps, line.duration_s, line.distance].filter((t) => t !== undefined).length;
  if (targets !== 1) throw new Clarify("target_needed", "Give each line one target: reps (low and high), a duration or a distance.", [], [...path, "reps"]);
  if (line.reps && line.reps.low > line.reps.high) throw new Clarify("rep_range", "The rep range runs low to high; which numbers?", [], [...path, "reps"]);
  if (line.rir && line.rir.low > line.rir.high) throw new Clarify("rir_range", "The RIR range runs low to high; which numbers?", [], [...path, "rir"]);
  let load: Row = { load_kind: null, load_value: null, load_unit: null, load_basis: null, bar_value: null, bar_unit: null, plates: null };
  if (line.load === "none") load = { ...load, load_kind: "none" };
  else if (line.load) {
    const pl = lineLoad(line.load, [...path, "load"]);
    load = {
      load_kind: pl.plates ? "plates" : "value", load_value: pl.value, load_unit: pl.unit, load_basis: pl.basis,
      bar_value: pl.bar?.value ?? null, bar_unit: pl.bar?.unit ?? null, plates: pl.plates ? JSON.stringify(pl.plates) : null,
    };
  }
  return {
    exercise_id: exerciseId, set_type: line.set_type ?? "working", sets: line.sets,
    target_kind: line.reps ? "reps" : line.duration_s !== undefined ? "duration" : "distance",
    rep_low: line.reps?.low ?? null, rep_high: line.reps?.high ?? null, duration_s: line.duration_s ?? null,
    distance_value: line.distance?.value ?? null, distance_unit: line.distance?.unit ?? null, ...load,
    rir_low: line.rir?.low ?? null, rir_high: line.rir?.high ?? null, rest_s: line.rest_s ?? null, note: line.note ?? null,
  };
}

export interface WorkoutLineRow {
  id: number;
  workout_id: number;
  position: number;
  exercise_id: number;
  exercise_name: string;
  set_type: string;
  sets: number;
  target_kind: "reps" | "duration" | "distance";
  rep_low: number | null;
  rep_high: number | null;
  duration_s: number | null;
  distance_value: number | null;
  distance_unit: string | null;
  load_kind: "value" | "plates" | "none" | null;
  load_value: number | null;
  load_unit: "kg" | "lb" | null;
  load_basis: string | null;
  bar_value: number | null;
  bar_unit: string | null;
  plates: string | null;
  rir_low: number | null;
  rir_high: number | null;
  rest_s: number | null;
  note: string | null;
}

export function describeLine(l: WorkoutLineRow) {
  const target =
    l.target_kind === "reps"
      ? { kind: "reps" as const, low: l.rep_low as number, high: l.rep_high as number }
      : l.target_kind === "duration"
        ? { kind: "duration" as const, seconds: l.duration_s as number }
        : { kind: "distance" as const, value: l.distance_value as number, unit: l.distance_unit as string };
  const load =
    l.load_kind === null
      ? null
      : l.load_kind === "none"
        ? ("none" as const)
        : {
            value: l.load_value as number, unit: l.load_unit as "kg" | "lb", basis: l.load_basis as string,
            bar: l.bar_value === null ? null : { value: l.bar_value, unit: l.bar_unit as string }, plates: storedPlates(l.plates),
          };
  return {
    id: l.id, position: l.position, exercise: l.exercise_name, set_type: l.set_type, sets: l.sets, target, load,
    rir: l.rir_low === null ? null : { low: l.rir_low, high: l.rir_high as number }, rest_s: l.rest_s, note: l.note,
  };
}
export type WorkoutLineOut = ReturnType<typeof describeLine>;

export interface WorkoutOut {
  id: number;
  name: string;
  note: string | null;
  aliases: string[];
  last_used: string | null;
  archived?: boolean;
  archived_at?: string | null;
  archived_reason?: string | null;
  lines: WorkoutLineOut[];
}

const LINE_JSON = `json_object('id', l.id, 'workout_id', l.workout_id, 'position', l.position, 'exercise_id', l.exercise_id, 'exercise_name', e.name,
  'set_type', l.set_type, 'sets', l.sets, 'target_kind', l.target_kind, 'rep_low', l.rep_low, 'rep_high', l.rep_high, 'duration_s', l.duration_s,
  'distance_value', l.distance_value, 'distance_unit', l.distance_unit, 'load_kind', l.load_kind, 'load_value', l.load_value, 'load_unit', l.load_unit,
  'load_basis', l.load_basis, 'bar_value', l.bar_value, 'bar_unit', l.bar_unit, 'plates', l.plates, 'rir_low', l.rir_low, 'rir_high', l.rir_high,
  'rest_s', l.rest_s, 'note', l.note)`;

/** Every workout of the household with its lines and aliases, in one statement; the member's most recently used first, then by name. */
export async function loadWorkouts(ctx: Ctx, memberId: number | null, includeArchived = false): Promise<WorkoutOut[]> {
  const rows = await all<{ id: number; name: string; note: string | null; archived_at: string | null; archived_reason: string | null; lines: string; aliases: string; last_used: string | null }>(
    ctx.db,
    `SELECT w.id, w.name, w.note, w.archived_at, w.archived_reason,
       (SELECT json_group_array(${LINE_JSON}) FROM workout_line l JOIN exercise e ON e.id = l.exercise_id WHERE l.workout_id = w.id) AS lines,
       (SELECT json_group_array(a.alias) FROM alias a WHERE a.household_id = w.household_id AND a.kind = 'workout' AND a.target_id = w.id) AS aliases,
       (SELECT max(se.performed_on) FROM session se WHERE se.workout_id = w.id AND se.member_id = ?) AS last_used
     FROM workout w WHERE w.household_id = ? AND (? OR w.archived_at IS NULL)
     ORDER BY last_used IS NULL, last_used DESC, w.name COLLATE NOCASE`,
    memberId,
    ctx.householdId,
    includeArchived ? 1 : 0,
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, note: r.note, aliases: JSON.parse(r.aliases) as string[], last_used: r.last_used,
    archived: r.archived_at !== null, archived_at: r.archived_at, archived_reason: r.archived_reason,
    lines: (JSON.parse(r.lines) as WorkoutLineRow[]).sort((a, b) => a.position - b.position).map(describeLine),
  }));
}
