/**
 * Saved workouts (spec §5): household-level, any member can log any
 * workout. Edits other than these go through amend; every change carries a
 * reason and is versioned.
 */
import { z } from "zod";
import { assertNotAnAlias } from "../aliases";
import type { Ctx } from "../context";
import { all, first, type Row } from "../db";
import { Clarify, ToolError } from "../errors";
import { readTool, writeTool, type Tool } from "../tool";
import { ExerciseIndex, sessionById, type SetRow } from "../training";
import { describeLine, loadWorkouts, lineColumns, workoutByRef, WORKOUT_LINE, type WorkoutLineIn, type WorkoutLineRow, type WorkoutOut } from "../workouts";
import { WORKOUT_LIFECYCLE_TOOLS } from "./template-lifecycle";

const GROUP = "workouts";

function reasonNeeded(reason: string | undefined, question: string): void {
  if (!reason) throw new Clarify("reason_needed", question, [], ["reason"]);
}

/**
 * Create a workout and its lines (positions from 1) in two createMany
 * statements, and return it as it will be stored (the batch hasn't run
 * yet, so it is described from the staged rows and their allocated ids).
 */
async function stageWorkout(ctx: Ctx, index: ExerciseIndex, name: string, note: string | null, lines: readonly WorkoutLineIn[], base: (string | number)[]): Promise<WorkoutOut> {
  const tx = ctx.txOrThrow;
  const trimmed = name.trim();
  if (!trimmed) throw new Clarify("name_needed", "What is the workout called?", [], ["name"]);
  await assertNotAnAlias(ctx, trimmed, ["name"]);
  const existing = await loadWorkouts(ctx, null, true);
  const taken = existing.find((w) => w.name.toLowerCase() === trimmed.toLowerCase());
  if (taken) {
    const next = taken.archived ? `Restore or rename the archived ${taken.name} instead.` : "Change it with update_workout, or choose another name?";
    throw new Clarify("duplicate_workout", `There is already a workout called ${taken.name}. ${next}`, [taken.name], ["name"]);
  }
  const rows = lines.map((line, i) => {
    const exercise = index.find(line.exercise, [...base, i, "exercise"]);
    return { exercise, columns: lineColumns(line, exercise.id, [...base, i]) };
  });
  await tx.reserve(["workout", "workout_line"]);
  const [id] = await tx.createMany("workout", [{ household_id: ctx.householdId, name: trimmed, note, created_at: ctx.nowIso() }]);
  const ids = await tx.createMany("workout_line", rows.map((r, i) => ({ workout_id: id, position: i + 1, ...r.columns })));
  return {
    id: id as number, name: trimmed, note, aliases: [], last_used: null,
    lines: rows.map((r, i) => describeLine({ id: ids[i] as number, workout_id: id as number, position: i + 1, exercise_name: r.exercise.name, ...r.columns } as unknown as WorkoutLineRow)),
  };
}

const workouts = readTool({
  name: "workouts",
  group: GROUP,
  description: "The household's saved workouts with their lines (each with its id, target, default load, RIR and rest) and aliases; the member's most recently used first.",
  input: { member: z.string().min(1).optional().describe("Order by this member's use; default the signed-in member.") },
  async run(ctx, input) {
    const member = input.member !== undefined ? await ctx.member(input.member) : ctx.caller.kind === "member" ? await ctx.memberById(ctx.caller.memberId) : null;
    return { workouts: await loadWorkouts(ctx, member?.id ?? null) };
  },
});

const createWorkout = writeTool({
  name: "create_workout",
  group: GROUP,
  description: "Create a saved workout: a name (unique ignoring case) and its lines in order, each one exercise with its sets, one target (reps low/high, a duration or a distance), an optional default load (value, unit and basis; plates per side on a bar; or none) and RIR range, and rest. Needs a reason. Household-level; confirmed on write.",
  input: { name: z.string().min(1), note: z.string().optional(), lines: z.array(WORKOUT_LINE).min(1).max(30) },
  async run(ctx, input) {
    reasonNeeded(input.reason, "Why is this workout being saved (for example, a routine for travel)?");
    const index = await ExerciseIndex.load(ctx);
    return { workout: await stageWorkout(ctx, index, input.name, input.note ?? null, input.lines, ["lines"]) };
  },
});

const WORKOUT_LINE_CHANGE = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), line: WORKOUT_LINE, position: z.number().int().min(1).optional() }).strict(),
  z.object({ action: z.literal("replace"), line_id: z.number().int().positive(), line: WORKOUT_LINE }).strict(),
  z.object({ action: z.literal("move"), line_id: z.number().int().positive(), position: z.number().int().min(1) }).strict(),
  z.object({ action: z.literal("remove"), line_id: z.number().int().positive() }).strict(),
]);

type StoredWorkoutLine = WorkoutLineRow & Row;
type PlannedWorkoutLine =
  | { kind: "existing"; row: StoredWorkoutLine; columns: Row; exerciseName: string; touched: boolean }
  | { kind: "new"; columns: Row; exerciseName: string };

function storedColumns(row: StoredWorkoutLine): Row {
  const { id: _id, workout_id: _workoutId, position: _position, exercise_name: _exerciseName, ...columns } = row;
  return columns;
}

const updateWorkout = writeTool({
  name: "update_workout",
  group: GROUP,
  description:
    "Atomically update a saved workout from a discussion: optionally rename it or change/clear its note, and add, fully replace, move or remove lines in order. Line additions and replacements use the same complete line shape as create_workout. The final workout must keep at least one line. Needs a reason and returns the complete ordered workout.",
  input: {
    workout: z.union([z.number().int().positive(), z.string().min(1)]).describe("Workout id, name or alias."),
    change_reason: z.string().min(1).optional().describe("Why the member wants this workout changed; public MCP clients should provide it so the audit history keeps their rationale."),
    name: z.string().min(1).optional().describe("New workout name; omit to keep it."),
    note: z.string().nullable().optional().describe("New note; null clears it; omit to keep it."),
    line_changes: z.array(WORKOUT_LINE_CHANGE).max(60).optional().describe("Ordered changes, applied from first to last."),
  },
  async run(ctx, input) {
    reasonNeeded(input.change_reason ?? input.reason, "Why is this workout changing?");
    if (input.name === undefined && input.note === undefined && (input.line_changes?.length ?? 0) === 0) {
      throw new Clarify("changes_needed", "What should change in this workout?", [], ["line_changes"]);
    }

    const ref = await workoutByRef(ctx, input.workout, ["workout"]);
    const storedWorkout = await first<Row & { id: number; name: string; note: string | null; household_id: number }>(
      ctx.db,
      "SELECT * FROM workout WHERE id = ? AND household_id = ?",
      ref.id,
      ctx.householdId,
    );
    if (!storedWorkout) throw new ToolError("not_found", `no workout ${ref.id}`, 404);

    const name = input.name?.trim() ?? storedWorkout.name;
    if (!name) throw new Clarify("name_needed", "What is the workout called?", [], ["name"]);
    if (input.name !== undefined) {
      await assertNotAnAlias(ctx, name, ["name"]);
      const duplicate = (await loadWorkouts(ctx, null, true)).find((workout) => workout.id !== ref.id && workout.name.toLowerCase() === name.toLowerCase());
      if (duplicate) {
        const next = duplicate.archived ? `Restore or rename the archived ${duplicate.name} instead.` : "Choose another name?";
        throw new Clarify("duplicate_workout", `There is already a workout called ${duplicate.name}. ${next}`, [duplicate.name], ["name"]);
      }
    }

    const rawLines = await all<StoredWorkoutLine>(
      ctx.db,
      `SELECT l.*, e.name AS exercise_name
       FROM workout_line l JOIN exercise e ON e.id = l.exercise_id
       WHERE l.workout_id = ? ORDER BY l.position`,
      ref.id,
    );
    let planned: PlannedWorkoutLine[] = rawLines.map((row) => ({ kind: "existing", row, columns: storedColumns(row), exerciseName: row.exercise_name, touched: false }));
    const index = await ExerciseIndex.load(ctx);

    const existingAt = (lineId: number, path: (string | number)[]) => {
      const position = planned.findIndex((line) => line.kind === "existing" && line.row.id === lineId);
      if (position < 0) throw new ToolError("not_found", `${ref.name} has no line ${lineId}`, 404);
      return position;
    };
    for (const [changeIndex, change] of (input.line_changes ?? []).entries()) {
      const path = ["line_changes", changeIndex] as (string | number)[];
      if (change.action === "add") {
        const exercise = index.find(change.line.exercise, [...path, "line", "exercise"]);
        const line = { kind: "new" as const, columns: lineColumns(change.line, exercise.id, [...path, "line"]), exerciseName: exercise.name };
        const at = Math.min(change.position ?? planned.length + 1, planned.length + 1) - 1;
        planned = [...planned.slice(0, at), line, ...planned.slice(at)];
      } else if (change.action === "replace") {
        const at = existingAt(change.line_id, [...path, "line_id"]);
        const exercise = index.find(change.line.exercise, [...path, "line", "exercise"]);
        const current = planned[at] as Extract<PlannedWorkoutLine, { kind: "existing" }>;
        planned = planned.map((line, index_) =>
          index_ === at ? { ...current, columns: lineColumns(change.line, exercise.id, [...path, "line"]), exerciseName: exercise.name, touched: true } : line,
        );
      } else if (change.action === "move") {
        const at = existingAt(change.line_id, [...path, "line_id"]);
        const moving = planned[at] as PlannedWorkoutLine;
        const without = [...planned.slice(0, at), ...planned.slice(at + 1)];
        const destination = Math.min(change.position, without.length + 1) - 1;
        planned = [...without.slice(0, destination), moving, ...without.slice(destination)];
      } else {
        const at = existingAt(change.line_id, [...path, "line_id"]);
        planned = [...planned.slice(0, at), ...planned.slice(at + 1)];
      }
    }
    if (planned.length === 0) throw new Clarify("no_lines", `A workout needs at least one line. What should ${name} keep or add?`, [], ["line_changes"]);
    if (planned.length > 30) throw new Clarify("too_many_lines", "A saved workout can have at most 30 lines. Which lines should it keep?", [], ["line_changes"]);

    const tx = ctx.txOrThrow;
    const workoutChanges: Row = {};
    if (name !== storedWorkout.name) workoutChanges.name = name;
    if (input.note !== undefined && input.note !== storedWorkout.note) workoutChanges.note = input.note;
    if (Object.keys(workoutChanges).length > 0) tx.update("workout", ref.id, workoutChanges, { ...storedWorkout, ...workoutChanges });

    const finalExistingIds = new Set(planned.flatMap((line) => (line.kind === "existing" ? [line.row.id] : [])));
    const removedRows = rawLines.filter((row) => !finalExistingIds.has(row.id));
    if ((input.line_changes?.length ?? 0) > 0) {
      tx.exec("UPDATE workout_line SET position = position + 1000000 WHERE workout_id = ?", ref.id);
      if (removedRows.length > 0) {
        tx.versions(
          "workout_line",
          "delete",
          removedRows.map((row) => ({ id: row.id, data: { ...storedColumns(row), id: row.id, workout_id: row.workout_id, position: row.position } })),
        );
        tx.exec("DELETE FROM workout_line WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(removedRows.map((row) => row.id)));
      }
    }

    const newLines = planned.filter((line): line is Extract<PlannedWorkoutLine, { kind: "new" }> => line.kind === "new");
    const newIds = await tx.createMany(
      "workout_line",
      newLines.map((line) => ({ workout_id: ref.id, position: planned.indexOf(line) + 1, ...line.columns })),
    );
    let nextNew = 0;
    const retainedRows: Row[] = [];
    const amendedRows: { id: number; data: Row }[] = [];
    const outputLines = planned.map((line, index_) => {
      const position = index_ + 1;
      if (line.kind === "new") {
        const id = newIds[nextNew++] as number;
        return describeLine({ id, workout_id: ref.id, position, exercise_name: line.exerciseName, ...line.columns } as unknown as WorkoutLineRow);
      }
      const changedPosition = line.row.position !== position;
      if ((input.line_changes?.length ?? 0) > 0) {
        const data = { id: line.row.id, workout_id: ref.id, position, ...line.columns };
        retainedRows.push(data);
        if (line.touched || changedPosition) amendedRows.push({ id: line.row.id, data });
      }
      return describeLine({ id: line.row.id, workout_id: ref.id, position, exercise_name: line.exerciseName, ...line.columns } as unknown as WorkoutLineRow);
    });
    if (retainedRows.length > 0) {
      const columns = [
        "position", "exercise_id", "set_type", "sets", "target_kind", "rep_low", "rep_high", "duration_s", "distance_value", "distance_unit",
        "load_kind", "load_value", "load_unit", "load_basis", "bar_value", "bar_unit", "plates", "rir_low", "rir_high", "rest_s", "note",
      ];
      const value = (column: string) => `(SELECT json_extract(value, '$.${column}') FROM json_each(?1) WHERE json_extract(value, '$.id') = workout_line.id)`;
      tx.exec(
        `UPDATE workout_line SET ${columns.map((column) => `${column} = ${value(column)}`).join(", ")}
         WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))`,
        JSON.stringify(retainedRows),
      );
      tx.versions("workout_line", "amend", amendedRows);
    }

    const previous = (await loadWorkouts(ctx, null)).find((workout) => workout.id === ref.id) as WorkoutOut;
    return { workout: { ...previous, name, note: input.note === undefined ? storedWorkout.note : input.note, lines: outputLines } };
  },
});

const addWorkoutLine = writeTool({
  name: "add_workout_line",
  group: GROUP,
  description: "Add one line to a saved workout, at the end or at a position (later lines move down), with the reason. Returns the line and the workout.",
  input: {
    workout: z.union([z.number().int().positive(), z.string().min(1)]).describe("Workout id, name or alias."),
    line: WORKOUT_LINE,
    position: z.number().int().min(1).optional().describe("Default: after the last line."),
  },
  async run(ctx, input) {
    reasonNeeded(input.reason, "Why does the workout gain this line?");
    const tx = ctx.txOrThrow;
    const ref = await workoutByRef(ctx, input.workout, ["workout"]);
    const workout = (await loadWorkouts(ctx, null)).find((w) => w.id === ref.id) as WorkoutOut;
    const index = await ExerciseIndex.load(ctx);
    const exercise = index.find(input.line.exercise, ["line", "exercise"]);
    const columns = lineColumns(input.line, exercise.id, ["line"]);
    const end = Math.max(0, ...workout.lines.map((l) => l.position));
    const position = Math.min(input.position ?? end + 1, end + 1);
    const later = workout.lines.filter((l) => l.position >= position);
    if (later.length > 0) {
      // Out of the way, then back one place further on, so positions stay unique (decision 96).
      tx.exec("UPDATE workout_line SET position = position + 1000000 WHERE workout_id = ? AND position >= ?", workout.id, position);
      tx.exec("UPDATE workout_line SET position = position - 999999 WHERE workout_id = ? AND position > 1000000", workout.id);
      const stored = await all<Row & { id: number; position: number }>(ctx.db, "SELECT * FROM workout_line WHERE workout_id = ? AND position >= ?", workout.id, position);
      tx.versions("workout_line", "amend", stored.map((r) => ({ id: r.id, data: { ...r, position: r.position + 1 } })));
    }
    const [id] = await tx.createMany("workout_line", [{ workout_id: workout.id, position, ...columns }]);
    const line = describeLine({ id: id as number, workout_id: workout.id, position, exercise_name: exercise.name, ...columns } as unknown as WorkoutLineRow);
    const lines = [...workout.lines.map((l) => (l.position >= position ? { ...l, position: l.position + 1 } : l)), line].sort((a, b) => a.position - b.position);
    return { line, workout: { ...workout, lines } };
  },
});

const removeWorkoutLine = writeTool({
  name: "remove_workout_line",
  group: GROUP,
  description: "Remove one line from a saved workout, with the reason (it goes to the write log and the line's history). A workout keeps at least one line.",
  input: { line_id: z.number().int().positive() },
  async run(ctx, input) {
    reasonNeeded(input.reason, "Why is the line coming out of the workout?");
    const line = await first<Row & { id: number; workout_id: number; position: number; household_id: number }>(
      ctx.db,
      "SELECT l.*, w.household_id FROM workout_line l JOIN workout w ON w.id = l.workout_id WHERE l.id = ?",
      input.line_id,
    );
    if (!line || line.household_id !== ctx.householdId) throw new ToolError("not_found", `no workout line ${input.line_id}`, 404);
    const workout = (await loadWorkouts(ctx, null)).find((w) => w.id === line.workout_id) as WorkoutOut;
    if (workout.lines.length === 1) throw new Clarify("no_lines", `That is ${workout.name}'s only line. Add another first, or keep it.`, [], ["line_id"]);
    const { household_id: _h, ...row } = line;
    ctx.txOrThrow.remove("workout_line", line.id, row, "delete");
    return { removed: { id: line.id, position: line.position }, workout: { ...workout, lines: workout.lines.filter((l) => l.id !== line.id) } };
  },
});

/** A set's type as a line holds it: a substitution is working sets (a line has no prescription to substitute). */
const lineSetType = (s: SetRow) => (s.set_type === "substitution" ? "working" : (s.set_type as "warm_up" | "working" | "back_off" | "calibration"));

/** Two sets share a load when every load field matches. */
const sameLoad = (a: SetRow, b: SetRow) =>
  (["load_status", "load_value", "load_unit", "load_basis", "bar_value", "bar_unit", "plates"] as const).every((k) => (a[k] ?? null) === (b[k] ?? null));

/** A line from a run of sets of one exercise and set type: the count, the range covered, the load only when all shared one, the RIR recorded. */
function lineFromRun(run: SetRow[], i: number): WorkoutLineIn & { exercise_id: number } {
  const first_ = run[0] as SetRow;
  const reps = run.map((s) => s.reps).filter((r): r is number => r !== null);
  // One target the line can hold: the reps range when every set has reps, else a duration or distance every set shares.
  // Anything else (steps only, reps on only some sets, durations that differ) asks rather than writing an empty or guessed one.
  const sameDuration = reps.length === 0 && first_.duration_s != null && run.every((s) => s.duration_s === first_.duration_s);
  const sameDistance =
    reps.length === 0 && first_.distance_value != null && run.every((s) => s.distance_value === first_.distance_value && s.distance_unit === first_.distance_unit);
  const target: Pick<WorkoutLineIn, "reps" | "duration_s" | "distance"> =
    reps.length === run.length
      ? { reps: { low: Math.min(...reps), high: Math.max(...reps) } }
      : sameDuration
        ? { duration_s: first_.duration_s as number }
        : sameDistance
          ? { distance: { value: first_.distance_value as number, unit: first_.distance_unit as "m" | "km" | "mi" } }
          : {};
  if (Object.keys(target).length === 0) {
    throw new Clarify(
      "target_needed",
      "A run of these sets has no reps, duration or distance they all share for a workout line. Save it with create_workout, giving that line its target?",
      [],
      ["session_id", i],
    );
  }
  const rirs = run.filter((s) => s.rir_status === "recorded");
  const allSame = run.every((s) => sameLoad(s, first_));
  const load: WorkoutLineIn["load"] =
    !allSame || first_.load_status === "not_recorded"
      ? undefined
      : first_.load_status === "none"
        ? "none"
        : first_.plates
          ? // Plates recorded with no bar (a plate-loaded machine) keep no bar: recorded, not guessed.
            { basis: "per_side", bar: first_.bar_value !== null ? { value: first_.bar_value, unit: first_.bar_unit as "kg" | "lb" } : null, plates: JSON.parse(first_.plates as string) }
          : { value: first_.load_value as number, unit: first_.load_unit as "kg" | "lb", basis: first_.load_basis as "total" | "per_side" | "per_hand" | "per_leg", ...(first_.bar_value !== null ? { bar: { value: first_.bar_value, unit: first_.bar_unit as "kg" | "lb" } } : {}) };
  const setType = lineSetType(first_);
  return {
    exercise_id: first_.exercise_id,
    exercise: String(first_.exercise_id),
    set_type: setType,
    sets: run.length,
    ...target,
    ...(load === undefined ? {} : { load }),
    ...(rirs.length > 0 ? { rir: { low: Math.min(...rirs.map((s) => s.rir_low as number)), high: Math.max(...rirs.map((s) => s.rir_high as number)) } } : {}),
  };
}

const saveSessionAsWorkout = writeTool({
  name: "save_session_as_workout",
  group: GROUP,
  description: "Save a session as a workout: each run of consecutive sets of one exercise becomes a line with its set count, the reps range it covered, the load when every set shared it (otherwise none: it is never guessed) and the RIR recorded; a cardio machine's block (a treadmill line log_workout stored as cardio) becomes a line after them, and any other block asks (block_not_a_line) rather than being dropped. A session with no sets asks (no_sets). Links the session to the new workout when it followed no template or workout. Needs a reason.",
  input: { session_id: z.number().int().positive(), name: z.string().min(1), note: z.string().optional() },
  async run(ctx, input) {
    reasonNeeded(input.reason, "Why save this session as a workout?");
    const session = await sessionById(ctx, input.session_id);
    const sets = await all<SetRow>(ctx.db, "SELECT * FROM session_set WHERE session_id = ? ORDER BY position", session.id);
    // A session of cardio alone is no workout (review P2).
    if (sets.length === 0) throw new Clarify("no_sets", "That session has no sets to save.", [], ["session_id"]);
    // A cardio machine's line that log_workout stored as a block (ticket 68) comes back as a line, after the sets;
    // a block that can't (no machine named, or no duration or distance) refuses the save rather than being dropped.
    const index = await ExerciseIndex.load(ctx);
    const blocks = await all<{ position: number; activity: string | null; duration_s: number | null; distance_value: number | null; distance_unit: string | null }>(
      ctx.db,
      "SELECT position, activity, duration_s, distance_value, distance_unit FROM cardio_block WHERE session_id = ? ORDER BY position",
      session.id,
    );
    const machine = (name: string | null) => index.entries.find((e) => e.implement_kind === "cardio_machine" && e.name.toLowerCase() === (name ?? "").toLowerCase());
    const blockLines: WorkoutLineIn[] = blocks.map((b) => {
      const e = machine(b.activity);
      const target = b.duration_s !== null ? { duration_s: b.duration_s } : b.distance_value !== null ? { distance: { value: b.distance_value, unit: b.distance_unit as "m" | "km" | "mi" } } : null;
      if (!e || !target) {
        const what = b.activity ? `"${b.activity}"` : "a block with no activity";
        throw new Clarify(
          "block_not_a_line",
          `This session's cardio block ${b.position} (${what}) isn't a cardio machine's timed or measured work, so it can't be a workout line. Remove that block, or save the workout with create_workout?`,
          [],
          ["session_id"],
        );
      }
      return { exercise: e.name, set_type: "working" as const, sets: 1, ...target, load: "none" as const };
    });
    const runs: SetRow[][] = [];
    for (const s of sets) {
      const last = runs.at(-1);
      const prev = last?.at(-1);
      if (last && prev && prev.exercise_id === s.exercise_id && lineSetType(prev) === lineSetType(s)) last.push(s);
      else runs.push([s]);
    }
    const lines = [
      ...runs.map((run, i) => lineFromRun(run, i)).map(({ exercise_id, ...l }) => ({ ...l, exercise: index.entries.find((e) => e.id === exercise_id)?.name ?? l.exercise })),
      ...blockLines,
    ];
    const workout = await stageWorkout(ctx, index, input.name, input.note ?? null, lines, ["session_id"]);
    const linked = session.template_id === null && (session.workout_id ?? null) === null;
    if (linked) {
      // The link changes the member's session: the write log says whose.
      ctx.onBehalfOf(session.member_id);
      ctx.txOrThrow.update("session", session.id, { workout_id: workout.id }, { ...session, workout_id: workout.id });
    }
    return { workout, linked };
  },
});

export const WORKOUT_TOOLS: Tool[] = [workouts, createWorkout, updateWorkout, ...WORKOUT_LIFECYCLE_TOOLS, addWorkoutLine, removeWorkoutLine, saveSessionAsWorkout];
