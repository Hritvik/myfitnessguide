import { describe, expect, it } from "vitest";
import { toolWithinBudget } from "./budget";
import { setup } from "./harness";
import { seedUpperA } from "./input-seed";
import { seedTraining } from "./seed";

async function ready() {
  const x = setup();
  const seeded = seedTraining(x);
  seedUpperA(x, seeded);
  const workout = (
    await x.ok("create_workout", {
      name: "Travel day",
      note: "Old note",
      reason: "initial routine",
      lines: [
        { exercise: "db curl", sets: 3, reps: { low: 10, high: 12 } },
        { exercise: "pushups", sets: 2, reps: { low: 12, high: 15 }, load: "none" },
        { exercise: "incline walk", sets: 1, duration_s: 600 },
      ],
    })
  ).workout;
  return { x, workout };
}

describe("update_workout", () => {
  it("atomically patches details and adds, replaces, moves and removes lines", async () => {
    const { x, workout } = await ready();
    const result = await x.ok("update_workout", {
      workout: "Travel day",
      name: "Hotel full body",
      note: null,
      reason: "match the routine we discussed",
      line_changes: [
        { action: "replace", line_id: workout.lines[0].id, line: { exercise: "db curl", sets: 4, reps: { low: 8, high: 10 }, rest_s: 120 } },
        { action: "move", line_id: workout.lines[2].id, position: 1 },
        { action: "remove", line_id: workout.lines[1].id },
        { action: "add", position: 2, line: { exercise: "calf raise", sets: 3, reps: { low: 15, high: 20 } } },
      ],
    });

    expect(result.workout).toMatchObject({ id: workout.id, name: "Hotel full body", note: null });
    expect(result.workout.lines.map((line: { position: number; exercise: string; sets: number }) => [line.position, line.exercise, line.sets])).toEqual([
      [1, "Treadmill walk", 1],
      [2, "Single-leg calf raise", 3],
      [3, "Dumbbell curl", 4],
    ]);
    expect(result.workout.lines[2]).toMatchObject({ target: { kind: "reps", low: 8, high: 10 }, rest_s: 120 });
    expect(x.t.get("SELECT name, note FROM workout WHERE id = ?", workout.id)).toEqual({ name: "Hotel full body", note: null });
    expect(x.t.get("SELECT count(*) AS n FROM workout_line WHERE workout_id = ?", workout.id)).toEqual({ n: 3 });
    const persisted = (await x.ok("workouts", {})).workouts.find((item: { id: number }) => item.id === workout.id);
    expect(persisted.lines.map((line: { position: number; exercise: string; sets: number }) => [line.position, line.exercise, line.sets])).toEqual([
      [1, "Treadmill walk", 1],
      [2, "Single-leg calf raise", 3],
      [3, "Dumbbell curl", 4],
    ]);
    const versions = (lineId: number) =>
      x.t.all(
        `SELECT v.action, w.reason FROM record_version v JOIN write_log w ON w.id = v.write_id
         WHERE v.table_name = 'workout_line' AND v.record_id = ? ORDER BY v.version`,
        lineId,
      );
    expect(versions(workout.lines[0].id)).toEqual([
      { action: "create", reason: "initial routine" },
      { action: "amend", reason: "match the routine we discussed" },
    ]);
    expect(versions(workout.lines[1].id)).toEqual([
      { action: "create", reason: "initial routine" },
      { action: "delete", reason: "match the routine we discussed" },
    ]);
    expect(versions(result.workout.lines[1].id)).toEqual([{ action: "create", reason: "match the routine we discussed" }]);
  });

  it("validates the final workout before staging any write", async () => {
    const { x, workout } = await ready();
    const beforeVersions = x.t.get("SELECT count(*) AS n FROM record_version");
    const response = await x.call("update_workout", {
      workout: workout.id,
      name: "Should not persist",
      reason: "bad batch",
      line_changes: workout.lines.map((line: { id: number }) => ({ action: "remove", line_id: line.id })),
    });

    expect(response.body).toMatchObject({ status: "needs_clarification", reason: "no_lines" });
    expect(x.t.get("SELECT name FROM workout WHERE id = ?", workout.id)).toEqual({ name: "Travel day" });
    expect(x.t.get("SELECT count(*) AS n FROM workout_line WHERE workout_id = ?", workout.id)).toEqual({ n: 3 });
    expect(x.t.get("SELECT count(*) AS n FROM record_version")).toEqual(beforeVersions);
  });

  it("rejects a line id outside the selected workout without changing it", async () => {
    const { x, workout } = await ready();
    const other = (
      await x.ok("create_workout", {
        name: "Other",
        reason: "another routine",
        lines: [{ exercise: "bench", sets: 3, reps: { low: 8, high: 10 } }],
      })
    ).workout;

    const response = await x.call("update_workout", {
      workout: workout.id,
      name: "Should not persist",
      reason: "wrong line",
      line_changes: [{ action: "remove", line_id: other.lines[0].id }],
    });

    expect(response.body).toMatchObject({ status: "error", error: { code: "not_found" } });
    expect(x.t.get("SELECT name FROM workout WHERE id = ?", workout.id)).toEqual({ name: "Travel day" });
  });

  it("keeps a maximum-size replacement within the write budget", async () => {
    const x = setup();
    const seeded = seedTraining(x);
    seedUpperA(x, seeded);
    const workout = (
      await x.ok("create_workout", {
        name: "Thirty lines",
        reason: "stress fixture",
        lines: Array.from({ length: 30 }, () => ({ exercise: "pushups", sets: 2, reps: { low: 10, high: 12 }, load: "none" as const })),
      })
    ).workout;
    const run = await toolWithinBudget(x, "update_workout", {
      workout: workout.id,
      reason: "replace every prescription",
      line_changes: workout.lines.map((line: { id: number }) => ({
        action: "replace",
        line_id: line.id,
        line: { exercise: "pushups", sets: 3, reps: { low: 12, high: 15 }, load: "none" },
      })),
    });
    expect(run.body.status).toBe("ok");
  });
});
