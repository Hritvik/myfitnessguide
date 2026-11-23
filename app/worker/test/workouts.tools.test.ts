// Saved workouts: household-level lists of exercises with default sets,
// reps and loads; created, edited with a reason (versioned), and saved from
// a session.
import { describe, expect, it } from "vitest";
import { toolWithinBudget } from "./budget";
import { setup } from "./harness";
import { bar20, busyInput, MONDAY, seedUpperA } from "./input-seed";
import { seedTraining } from "./seed";

async function ready() {
  const x = setup();
  const s = seedTraining(x);
  seedUpperA(x, s);
  return { x, s };
}

const hotelLegs = () => ({
  name: "Hotel legs",
  reason: "a workout for travel",
  lines: [
    { exercise: "db curl", sets: 3, reps: { low: 10, high: 12 }, load: { value: 10, unit: "kg", basis: "per_hand" }, rir: { low: 1, high: 2 }, rest_s: 90 },
    { exercise: "pushups", sets: 2, reps: { low: 12, high: 15 }, load: "none" },
    { exercise: "incline walk", sets: 1, duration_s: 600 },
    { exercise: "bench", sets: 3, reps: { low: 8, high: 10 }, load: { basis: "per_side", bar: bar20, plates: [{ value: 10, unit: "kg" }, { value: 5, unit: "lb" }] } },
  ],
});

describe("create_workout", () => {
  it("creates a household workout with numbered lines, each with its id, target, load and RIR", async () => {
    const { x } = await ready();
    const body = await x.ok("create_workout", hotelLegs(), "asha");
    expect(body.workout).toMatchObject({ name: "Hotel legs", last_used: null });
    expect(body.workout.lines.map((l: { id: number; position: number; exercise: string }) => [typeof l.id, l.position, l.exercise])).toEqual([
      ["number", 1, "Dumbbell curl"], ["number", 2, "Push-up"], ["number", 3, "Treadmill walk"], ["number", 4, "Barbell bench press"],
    ]);
    expect(body.workout.lines[0]).toMatchObject({ sets: 3, target: { kind: "reps", low: 10, high: 12 }, load: { value: 10, unit: "kg", basis: "per_hand", bar: null, plates: null }, rir: { low: 1, high: 2 }, rest_s: 90 });
    expect(body.workout.lines[1].load).toBe("none");
    expect(body.workout.lines[2].target).toEqual({ kind: "duration", seconds: 600 });
    expect(body.workout.lines[3].load).toMatchObject({ basis: "per_side", bar: { value: 20, unit: "kg" }, plates: [{ value: 10, unit: "kg", count: 1 }, { value: 5, unit: "lb", count: 1 }] });
  });

  it("refuses a name already taken, ignoring case, and needs a reason and one target per line", async () => {
    const { x } = await ready();
    await x.ok("create_workout", hotelLegs());
    expect((await x.call("create_workout", { ...hotelLegs(), name: "HOTEL LEGS" })).body).toMatchObject({ status: "needs_clarification", reason: "duplicate_workout" });
    expect((await x.call("create_workout", { ...hotelLegs(), name: "Other", reason: undefined })).body).toMatchObject({ reason: "reason_needed" });
    const twoTargets = { ...hotelLegs(), name: "Other", lines: [{ exercise: "pushups", sets: 2, reps: { low: 10, high: 12 }, duration_s: 30 }] };
    expect((await x.call("create_workout", twoTargets)).body).toMatchObject({ reason: "target_needed", path: ["lines", 0, "reps"] });
  });
});

describe("workouts", () => {
  it("lists the household's workouts, the member's most recently used first", async () => {
    const { x } = await ready();
    await x.ok("create_workout", hotelLegs());
    await x.ok("create_workout", { name: "Arms", reason: "arms day", lines: [{ exercise: "db curl", sets: 3, reps: { low: 10, high: 12 } }] });
    await x.ok("log_workout", { member: "Hritvik", date: "2026-10-02", source: { kind: "workout", workout: "Hotel legs" }, sets: [{ exercise: "pushups", reps: 12, rir: 2, load: "none" }] });
    const body = await x.ok("workouts", { member: "Hritvik" }, "hritvik");
    expect(body.workouts.map((w: { name: string; last_used: string | null }) => [w.name, w.last_used])).toEqual([["Hotel legs", "2026-10-02"], ["Arms", null]]);
    expect((await x.ok("workouts", {}, "asha")).workouts.map((w: { name: string }) => w.name)).toEqual(["Arms", "Hotel legs"]);
  });
});

describe("add_workout_line and remove_workout_line", () => {
  it("adds a line at a position, moving later lines down, and removes one, each versioned with its reason", async () => {
    const { x } = await ready();
    const w = (await x.ok("create_workout", hotelLegs())).workout;
    const added = await x.ok("add_workout_line", { workout: "hotel legs", line: { exercise: "calf raise", sets: 2, reps: { low: 15, high: 20 } }, position: 1, reason: "calves first" });
    expect(added.workout.lines.map((l: { exercise: string; position: number }) => [l.exercise, l.position])).toEqual([
      ["Single-leg calf raise", 1], ["Dumbbell curl", 2], ["Push-up", 3], ["Treadmill walk", 4], ["Barbell bench press", 5],
    ]);
    const moved = w.lines[0].id;
    expect(x.t.all("SELECT version, action, json_extract(data, '$.position') AS position FROM record_version WHERE table_name = 'workout_line' AND record_id = ? ORDER BY version", moved)).toEqual([
      { version: 1, action: "create", position: 1 },
      { version: 2, action: "amend", position: 2 },
    ]);
    const removed = await x.ok("remove_workout_line", { line_id: moved, reason: "no dumbbells at the hotel" });
    expect(removed.removed).toEqual({ id: moved, position: 2 });
    expect(x.t.get("SELECT action FROM record_version WHERE table_name = 'workout_line' AND record_id = ? ORDER BY version DESC LIMIT 1", moved)).toEqual({ action: "delete" });
  });

  it("keeps at least one line", async () => {
    const { x } = await ready();
    const w = (await x.ok("create_workout", { name: "One", reason: "r", lines: [{ exercise: "pushups", sets: 1, reps: { low: 10, high: 10 } }] })).workout;
    expect((await x.call("remove_workout_line", { line_id: w.lines[0].id, reason: "r" })).body).toMatchObject({ reason: "no_lines" });
  });
});

describe("amend on workouts", () => {
  it("changes a line's sets and a workout's name with a reason, keeping every version", async () => {
    const { x } = await ready();
    const w = (await x.ok("create_workout", hotelLegs())).workout;
    await x.ok("amend", { record: { table: "workout_line", id: w.lines[0].id }, changes: { sets: 4 }, reason: "four sets now" });
    await x.ok("amend", { record: { table: "workout", id: w.id }, changes: { name: "Travel legs" }, reason: "renamed" });
    const after = (await x.ok("workouts", {})).workouts[0];
    expect(after).toMatchObject({ name: "Travel legs" });
    expect(after.lines[0].sets).toBe(4);
    expect((await x.ok("history", { table: "workout_line", id: w.lines[0].id })).versions.map((v: { action: string; reason: string }) => [v.action, v.reason])).toEqual([
      ["create", "a workout for travel"],
      ["amend", "four sets now"],
    ]);
  });

  it("keeps a plates line's load the plates' sum", async () => {
    const { x } = await ready();
    const w = (await x.ok("create_workout", hotelLegs())).workout;
    const body = await x.ok("amend", { record: { table: "workout_line", id: w.lines[3].id }, changes: { plates: JSON.stringify([{ value: 15, unit: "kg", count: 1 }]) }, reason: "heavier" });
    expect(body.after).toMatchObject({ load_kind: "plates", load_value: 15, load_unit: "kg" });
  });
});

describe("save_session_as_workout", () => {
  it("makes a line of each run of one exercise, with the load only where every set shared it, and links the session", async () => {
    const { x } = await ready();
    const sets = [
      { exercise: "db curl", reps: 12, rir: 2, load: { value: 10, unit: "kg", basis: "per_hand" } },
      { exercise: "db curl", reps: 10, rir: 1, load: { value: 10, unit: "kg", basis: "per_hand" } },
      { exercise: "lat pulldown", reps: 12, rir: 2, load: { value: 40, unit: "kg", basis: "total" } },
      { exercise: "lat pulldown", reps: 9, rir: 1, load: { value: 45, unit: "kg", basis: "total" } },
    ];
    const session = (await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "none" }, sets })).session.id;
    const body = await x.ok("save_session_as_workout", { session_id: session, name: "Monday pull", reason: "worth repeating" }, "hritvik");
    expect(body.linked).toBe(true);
    expect(body.workout.lines).toEqual([
      expect.objectContaining({ position: 1, exercise: "Dumbbell curl", sets: 2, target: { kind: "reps", low: 10, high: 12 }, load: { value: 10, unit: "kg", basis: "per_hand", bar: null, plates: null }, rir: { low: 1, high: 2 } }),
      expect.objectContaining({ position: 2, exercise: "Cable lat pulldown", sets: 2, target: { kind: "reps", low: 9, high: 12 }, load: null, rir: { low: 1, high: 2 } }),
    ]);
    expect(x.t.get("SELECT workout_id FROM session WHERE id = ?", session)).toEqual({ workout_id: body.workout.id });
  });

  it("does not link a session that follows a programme template", async () => {
    const { x } = await ready();
    const logged = await x.ok("log_set", { member: "Hritvik", date: MONDAY, exercise: "lat pulldown", reps: 12, rir: 2, load: { value: 40, unit: "kg", basis: "total" } });
    const body = await x.ok("save_session_as_workout", { session_id: logged.session.id, name: "Copy", reason: "r" });
    expect(body.linked).toBe(false);
  });
});

describe("save_session_as_workout without a target", () => {
  it("asks rather than writing a line with no reps, duration or distance (a steps-only set)", async () => {
    const { x } = await ready();
    const sets = [{ exercise: "incline walk", steps: 3000, rir: 2, load: "none" }];
    const session = (await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "none" }, sets })).session.id;
    expect((await x.call("save_session_as_workout", { session_id: session, name: "Walk", reason: "r" }, "hritvik")).body).toMatchObject({ status: "needs_clarification", reason: "target_needed" });
    expect(x.t.all("SELECT id FROM workout")).toEqual([]);
  });
});

describe("plates with no bar (a plate-loaded machine)", () => {
  async function sled() {
    const { x, s } = await ready();
    const id = x.t.insert("implement", { gym_id: s.gym, name: "Sled", kind: "plate_loaded", unit: "kg", loading: "plates_only", load_list_complete: 0 });
    x.t.insert("exercise", { household_id: x.h.id, name: "Sled press", implement_kind: "plate_loaded" });
    await x.ok("record_plates", { gym: s.gym, unit: "kg", available: [5, 10, 20], complete: true });
    return { x, s, sled: id };
  }

  it("create_workout holds a bar-less plates line when the bar is given as null, and still asks when it is left out", async () => {
    const { x } = await sled();
    const line = { exercise: "Sled press", sets: 3, reps: { low: 8, high: 10 }, load: { basis: "per_side", bar: null, plates: [{ value: 20, unit: "kg" }, { value: 5, unit: "kg" }] } };
    const body = await x.ok("create_workout", { name: "Sled day", reason: "r", lines: [line] });
    expect(body.workout.lines[0].load).toEqual({ value: 25, unit: "kg", basis: "per_side", bar: null, plates: [{ value: 20, unit: "kg", count: 1 }, { value: 5, unit: "kg", count: 1 }] });
    const { bar: _bar, ...noBar } = line.load;
    expect((await x.call("create_workout", { name: "Other", reason: "r", lines: [{ ...line, load: noBar }] })).body).toMatchObject({ reason: "bar_needed" });
  });

  it("save_session_as_workout keeps a plate-loaded machine run's plates with no bar", async () => {
    const { x, sled: id } = await sled();
    const set = { exercise: "Sled press", reps: 10, rir: 1, load: { basis: "per_side", implement: id, plates: [{ value: 20, unit: "kg" }] } };
    const session = (await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "none" }, sets: [set, set] })).session.id;
    const body = await x.ok("save_session_as_workout", { session_id: session, name: "Sled", reason: "r" }, "hritvik");
    expect(body.workout.lines[0]).toMatchObject({ sets: 2, load: { value: 20, unit: "kg", basis: "per_side", bar: null, plates: [{ value: 20, unit: "kg", count: 1 }] } });
  });
});

describe("save_session_as_workout: runs, targets, names and attribution", () => {
  it("asks when a duration run's sets disagree, and keeps the duration when they agree", async () => {
    const { x } = await ready();
    const walk = (duration_s: number) => ({ exercise: "pushups", duration_s, rir: 2, load: "none" });
    const differ = (await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "none" }, sets: [walk(600), walk(300)] })).session.id;
    expect((await x.call("save_session_as_workout", { session_id: differ, name: "Walk", reason: "r" }, "hritvik")).body).toMatchObject({ reason: "target_needed" });
    const agree = (await x.ok("log_workout", { member: "Hritvik", date: "2026-10-06", source: { kind: "none" }, sets: [walk(600), walk(600)] })).session.id;
    expect((await x.ok("save_session_as_workout", { session_id: agree, name: "Walk", reason: "r" }, "hritvik")).workout.lines[0]).toMatchObject({ sets: 2, target: { kind: "duration", seconds: 600 } });
  });

  it("keeps a treadmill line that log_workout stored as a cardio block (ticket 68)", async () => {
    const { x } = await ready();
    const session = (await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "none" }, sets: [
      { exercise: "lat pulldown", reps: 12, rir: 2, load: { value: 40, unit: "kg", basis: "total" } },
      { exercise: "incline walk", duration_s: 1200, load: "none" },
    ] })).session.id;
    const saved = await x.ok("save_session_as_workout", { session_id: session, name: "Pull and walk", reason: "r" }, "hritvik");
    expect(saved.workout.lines.map((l: { exercise: string }) => l.exercise)).toEqual(["Cable lat pulldown", "Treadmill walk"]);
    expect(saved.workout.lines[1]).toMatchObject({ sets: 1, target: { kind: "duration", seconds: 1200 } });
  });

  it("refuses a session of cardio alone, and a block it can't make a line of, never dropping it (review P2)", async () => {
    const { x } = await ready();
    const walkOnly = (await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "none" }, sets: [{ exercise: "incline walk", duration_s: 1200, load: "none" }] })).session.id;
    expect((await x.call("save_session_as_workout", { session_id: walkOnly, name: "Walk", reason: "r" }, "hritvik")).body).toMatchObject({ status: "needs_clarification", reason: "no_sets" });
    const class_ = (await x.ok("log_cardio", { member: "Hritvik", date: "2026-10-06", session_type: "class", blocks: [{ kind: "steady", duration_s: 1800 }] }, "hritvik")).session.id;
    expect((await x.call("save_session_as_workout", { session_id: class_, name: "Dance", reason: "r" }, "hritvik")).body).toMatchObject({ reason: "no_sets" });
    // A gym session with a block that names no cardio machine: refused, saying which.
    const mixed = (await x.ok("log_workout", { member: "Hritvik", date: "2026-10-07", source: { kind: "none" }, sets: [{ exercise: "pushups", reps: 12, rir: 2, load: "none" }] })).session.id;
    x.t.insert("cardio_block", { session_id: mixed, position: 1, kind: "steady", activity: "skipping", duration_s: 300 });
    const refused = await x.call("save_session_as_workout", { session_id: mixed, name: "Push and skip", reason: "r" }, "hritvik");
    expect(refused.body).toMatchObject({ status: "needs_clarification", reason: "block_not_a_line" });
    expect(refused.body.question).toMatch(/skipping/);
    expect(x.t.get("SELECT count(*) AS n FROM workout WHERE name = 'Push and skip'")).toEqual({ n: 0 });
  });

  it("asks for a name that is only spaces, from create_workout and save_session_as_workout", async () => {
    const { x } = await ready();
    expect((await x.call("create_workout", { ...hotelLegs(), name: "   " })).body).toMatchObject({ status: "needs_clarification", reason: "name_needed" });
    const session = (await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "none" }, sets: [{ exercise: "pushups", reps: 12, rir: 2, load: "none" }] })).session.id;
    expect((await x.call("save_session_as_workout", { session_id: session, name: " ", reason: "r" })).body).toMatchObject({ status: "needs_clarification", reason: "name_needed" });
  });

  it("puts a substitution set in the same run as the working sets around it", async () => {
    const { x, s } = await ready();
    const curl = { exercise: "db curl", reps: 10, rir: 2, load: { value: 10, unit: "kg", basis: "per_hand" } };
    const logged = await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "none" }, sets: [curl, curl, curl] });
    const p = (x.t.get("SELECT id FROM prescription WHERE exercise_id = ?", s.curl) as { id: number }).id;
    x.t.run("UPDATE session_set SET set_type = 'substitution', substituted_prescription_id = ? WHERE id = ?", p, logged.sets[1].set.id);
    expect(x.t.all("SELECT set_type FROM session_set WHERE session_id = ? ORDER BY position", logged.session.id).map((r) => (r as { set_type: string }).set_type)).toEqual(["working", "substitution", "working"]);
    const body = await x.ok("save_session_as_workout", { session_id: logged.session.id, name: "Curls", reason: "r" }, "hritvik");
    expect(body.workout.lines).toHaveLength(1);
    expect(body.workout.lines[0]).toMatchObject({ set_type: "working", sets: 3 });
  });

  it("attributes linking another member's session to that member", async () => {
    const { x } = await ready();
    const session = (await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "none" }, sets: [{ exercise: "pushups", reps: 12, rir: 2, load: "none" }] }, "hritvik")).session.id;
    const body = await x.ok("save_session_as_workout", { session_id: session, name: "Push", reason: "r" }, "asha");
    expect(body.linked).toBe(true);
    expect(x.t.get("SELECT on_behalf_of_member_id FROM write_log WHERE tool = 'save_session_as_workout'")).toEqual({ on_behalf_of_member_id: x.h.hritvik });
  });
});

describe("workout budgets", () => {
  it("create_workout and workouts stay within the budget at 40 implements", async () => {
    const { x } = await busyInput(40);
    await toolWithinBudget(x, "create_workout", hotelLegs());
    await toolWithinBudget(x, "workouts", { member: "Hritvik" }, "hritvik");
  });

  it("add_workout_line, remove_workout_line, save_session_as_workout and amend of a workout and a line stay within the budget at 40 implements", async () => {
    const { x } = await busyInput(40);
    const w = (await x.ok("create_workout", hotelLegs())).workout;
    await toolWithinBudget(x, "add_workout_line", { workout: "hotel legs", line: { exercise: "calf raise", sets: 2, reps: { low: 15, high: 20 } }, position: 1, reason: "calves first" });
    await toolWithinBudget(x, "remove_workout_line", { line_id: w.lines[0].id, reason: "no dumbbells at the hotel" });
    await toolWithinBudget(x, "amend", { record: { table: "workout_line", id: w.lines[3].id }, changes: { plates: JSON.stringify([{ value: 15, unit: "kg", count: 1 }]) }, reason: "heavier" });
    await toolWithinBudget(x, "amend", { record: { table: "workout", id: w.id }, changes: { name: "Travel legs" }, reason: "renamed" });
    const sets = Array.from({ length: 13 }, (_, i) => ({ exercise: i < 7 ? "db curl" : "lat pulldown", reps: 10 + (i % 3), rir: 2, load: { value: i < 7 ? 10 : 40, unit: "kg", basis: i < 7 ? "per_hand" : "total", implement: i < 7 ? "Dumbbells" : "Lat pulldown stack" } }));
    const session = (await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "none" }, sets })).session.id;
    const saved = await toolWithinBudget(x, "save_session_as_workout", { session_id: session, name: "Monday pull", reason: "worth repeating" }, "hritvik");
    expect(saved.body.linked).toBe(true);
  });
});
