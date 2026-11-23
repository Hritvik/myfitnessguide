import { describe, expect, it } from "vitest";
import { addRow, asksToKeep, fromNext, fromWorkout, loggedLines, newBlock, offerSaveAsWorkout, progressLines, removeRow, saveAsWorkoutPlan, swap, workoutChanges, workoutInput, workoutPlan, type Block } from "../src/workout";
import type { LogWorkout, NextForEntry, WorkoutOut } from "../src/types";

const next: NextForEntry = {
  programming_mode: "prescribed", session: "Upper A",
  prescriptions: [
    { prescription_id: 1, exercise: "Barbell bench press", sets: 2, target: { kind: "reps", low: 8, high: 12 }, rir_target: { low: 1, high: 2 }, load: { value: 12.27, unit: "kg", basis: "per_side", bar: { value: 20, unit: "kg" }, plates: [{ value: 10, unit: "kg", count: 1 }, { value: 5, unit: "lb", count: 1 }] } },
    { prescription_id: 2, exercise: "Cable row", sets: 1, target: { kind: "reps", low: 10, high: 12 }, rir_target: { low: 1, high: 2 }, load: { value: 35, unit: "kg", basis: "total", bar: null, plates: null } },
  ],
};
const legs: WorkoutOut = {
  id: 5, name: "Hotel legs", note: null, aliases: [], last_used: null,
  lines: [
    { id: 51, position: 1, exercise: "Goblet squat", set_type: "working", sets: 3, target: { kind: "reps", low: 10, high: 12 }, load: { value: 16, unit: "kg", basis: "total", bar: null, plates: null }, rir: { low: 1, high: 2 }, rest_s: 90, note: null },
    { id: 52, position: 2, exercise: "Push-up", set_type: "working", sets: 2, target: { kind: "reps", low: 12, high: 15 }, load: "none", rir: null, rest_s: null, note: null },
  ],
};
const done = (b: Block, reps = "10", rir = "2"): Block => ({ ...b, rows: b.rows.map((r) => ({ ...r, reps, rir })) });

describe("pre-filling", () => {
  it("fills the next programme session from next_prescription: loads in, reps and RIR left for the member", () => {
    const out = fromNext(next);
    expect(out?.source).toEqual({ kind: "programme", template: "Upper A" });
    expect(out?.blocks.map((b) => [b.exercise, b.prescriptionId, b.rows.length, b.target])).toEqual([["Barbell bench press", 1, 2, "8-12 reps at RIR 1-2"], ["Cable row", 2, 1, "10-12 reps at RIR 1-2"]]);
    expect(out?.blocks[0]?.rows[0]).toMatchObject({ setType: "working", reps: "", rir: "", load: { kind: "plates", build: { bar: { value: 20, unit: "kg" }, plates: [{ value: 10, unit: "kg", count: 1 }, { value: 5, unit: "lb", count: 1 }] } } });
    expect(out?.blocks[1]?.rows[0]?.load).toEqual({ kind: "value", value: "35", unit: "kg", basis: "total" });
    expect(fromNext({ programming_mode: "record_only", session: null })).toBeNull();
  });

  it("fills a saved workout's lines", () => {
    const out = fromWorkout(legs);
    expect(out.source).toEqual({ kind: "workout", id: 5, name: "Hotel legs" });
    expect(out.blocks.map((b) => [b.exercise, b.lineId, b.rows.length])).toEqual([["Goblet squat", 51, 3], ["Push-up", 52, 2]]);
    expect(out.blocks[1]?.rows[0]?.load).toEqual({ kind: "none" });
  });
});

describe("workoutInput", () => {
  it("builds log_workout from the blocks, a swap logged as a substitution", () => {
    const { source, blocks } = fromNext(next) as { source: never; blocks: Block[] };
    const swapped = swap(done(blocks[1] as Block, "12"), "Seated row machine");
    const out = workoutInput("Asha", "2026-10-06", source, [done(blocks[0] as Block), swapped], "prescribed");
    expect(out).toEqual({
      input: {
        member: "Asha", date: "2026-10-06", source: { kind: "programme", template: "Upper A" },
        sets: [
          { exercise: "Barbell bench press", set_type: "working", reps: 10, rir: { low: 2, high: 2 }, load: { basis: "per_side", plates: [{ value: 10, unit: "kg", count: 1 }, { value: 5, unit: "lb", count: 1 }], bar: { value: 20, unit: "kg" } } },
          { exercise: "Barbell bench press", set_type: "working", reps: 10, rir: { low: 2, high: 2 }, load: { basis: "per_side", plates: [{ value: 10, unit: "kg", count: 1 }, { value: 5, unit: "lb", count: 1 }], bar: { value: 20, unit: "kg" } } },
          { exercise: "Seated row machine", set_type: "substitution", substituted_prescription_id: 2, reps: 12, rir: { low: 2, high: 2 }, load: { value: 35, unit: "kg", basis: "total" } },
        ],
      },
    });
  });

  it("needs reps on every set, and RIR on a prescribed member's working sets, naming the set", () => {
    const { source, blocks } = fromWorkout(legs);
    expect(workoutInput("Asha", "2026-10-06", source, blocks, "prescribed")).toEqual({ error: "Goblet squat, set 1: enter the reps." });
    expect(workoutInput("Asha", "2026-10-06", source, [done(blocks[0] as Block, "10", ""), done(blocks[1] as Block)], "prescribed")).toEqual({ error: "Goblet squat, set 1: enter the reps in reserve." });
    expect(workoutInput("Noor", "2026-10-06", source, [done(blocks[0] as Block, "10", ""), done(blocks[1] as Block, "12", "")], "record_only")).toMatchObject({ input: { source: { kind: "workout", workout: 5 } } });
  });

  it("adds and removes sets and exercises", () => {
    const b = addRow(done(newBlock("Calf raise")));
    expect(b.rows).toHaveLength(2);
    expect(b.rows[1]).toMatchObject({ reps: "", rir: "" });
    expect(removeRow(b, 0).rows).toHaveLength(1);
  });
});

describe("keep these changes?", () => {
  it("never asks for a programme session, and not when a saved workout is unchanged", () => {
    const n = fromNext(next) as { source: never; blocks: Block[] };
    expect(asksToKeep(n.source, null)).toBe(false);
    expect(asksToKeep({ kind: "programme", template: "Upper A" }, { remove: [1], add: [], amend: [] })).toBe(false);
    expect(workoutChanges(legs, fromWorkout(legs).blocks)).toBeNull();
  });

  it("finds a changed set count, a swapped exercise, an added and a removed one", () => {
    const { blocks } = fromWorkout(legs);
    const changed = [addRow(blocks[0] as Block), newBlock("Calf raise")];
    expect(workoutChanges(legs, changed)).toEqual({
      remove: [52],
      add: [{ exercise: "Calf raise", sets: 1 }],
      amend: [{ lineId: 51, changes: { sets: 4 } }],
    });
    expect(workoutChanges(legs, [...fromWorkout(legs).blocks, done(newBlock("Calf raise"), "15")])?.add).toEqual([{ exercise: "Calf raise", sets: 1, reps: { low: 15, high: 15 } }]);
    const swappedLine = [swap(blocks[0] as Block, "Leg press"), blocks[1] as Block];
    expect(workoutChanges(legs, swappedLine)).toEqual({ remove: [51], add: [{ exercise: "Leg press", sets: 3, reps: { low: 10, high: 12 }, position: 1 }], amend: [] });
    expect(asksToKeep({ kind: "workout", id: 5, name: "Hotel legs" }, workoutChanges(legs, changed))).toBe(true);
  });

  it("a swapped line carries the reps logged, else its replaced line's own target; a second swap stays a swap", () => {
    const { blocks } = fromWorkout(legs);
    const once = swap(blocks[0] as Block, "Leg press");
    const twice = swap(once, "Hack squat");
    expect(twice.lineId).toBe(-51);
    expect(workoutChanges(legs, [done(twice, "8"), blocks[1] as Block])?.add).toEqual([{ exercise: "Hack squat", sets: 3, reps: { low: 8, high: 8 }, position: 1 }]);
  });

  it("never writes an invented rep target: an added exercise with no reps logged is asked for", () => {
    const { source, blocks } = fromWorkout(legs);
    const changed = [done(blocks[0] as Block), done(blocks[1] as Block), newBlock("Calf raise")];
    const input = (workoutInput("Asha", "2026-10-06", source, [done(blocks[0] as Block), done(blocks[1] as Block)], "prescribed") as { input: Record<string, unknown> }).input;
    const changes = workoutChanges(legs, changed);
    expect(workoutPlan(input, "update", legs, changes, changed)).toEqual({ error: "Calf raise: enter the reps, seconds or distance to save it in the workout." });
    expect(workoutPlan(input, "new", legs, changes, changed, "Mix")).toEqual({ error: "Calf raise: enter the reps to save it in the workout." });
    const withReps = [...changed.slice(0, 2), done(newBlock("Calf raise"), "15")];
    const plan = workoutPlan(input, "update", legs, workoutChanges(legs, withReps), withReps) as { steps: { tool: string; input: Record<string, unknown> }[] };
    expect(plan.steps.map((s) => s.tool)).toEqual(["log_workout", "add_workout_line"]);
    expect(plan.steps[1]?.input).toMatchObject({ workout: 5, line: { exercise: "Calf raise", sets: 1, reps: { low: 15, high: 15 } } });
  });

  it("logs first, then updates the workout for everyone or saves a new one, each step its own key", () => {
    const { source, blocks } = fromWorkout(legs);
    const changed = [done(addRow(blocks[0] as Block)), done(blocks[1] as Block)];
    const input = (workoutInput("Asha", "2026-10-06", source, changed, "prescribed") as { input: Record<string, unknown> }).input;
    const changes = workoutChanges(legs, changed);
    expect((workoutPlan(input, "once", legs, changes, changed) as { steps: { tool: string }[] }).steps.map((s) => s.tool)).toEqual(["log_workout"]);
    const update = workoutPlan(input, "update", legs, changes, changed) as { steps: { tool: string; input: Record<string, unknown> }[]; done: string };
    expect(update.steps.map((s) => s.tool)).toEqual(["log_workout", "amend"]);
    expect(update.steps[1]?.input).toMatchObject({ record: { table: "workout_line", id: 51 }, changes: { sets: 4 }, reason: "Changed when logging on 2026-10-06" });
    expect(update.done).toBe("Logged, and Hotel legs is updated for everyone.");
    expect(workoutPlan(input, "new", legs, changes, changed)).toEqual({ error: "Name the new workout." });
    const fresh = workoutPlan(input, "new", legs, changes, changed, "Hotel legs, longer") as { steps: { tool: string; input: Record<string, unknown> }[] };
    expect(fresh.steps.map((s) => s.tool)).toEqual(["log_workout", "create_workout"]);
    expect(fresh.steps[1]?.input).toMatchObject({ name: "Hotel legs, longer", lines: [{ exercise: "Goblet squat", sets: 4, reps: { low: 10, high: 10 } }, { exercise: "Push-up", sets: 2, reps: { low: 10, high: 10 }, load: "none" }] });
    expect(new Set(fresh.steps.map((s) => s.input.idempotency_key)).size).toBe(2);
  });
});

describe("after the save", () => {
  const result = (over: Partial<LogWorkout> = {}): LogWorkout => ({
    session: { id: 9, created: true, template: "Upper A", workout: null, state: "confirmed" },
    sets: [],
    progression: [
      { prescription_id: 2, exercise: "Cable row", state: { kind: "ready", next_load: { value: 40, unit: "kg", plates: null } } },
      { prescription_id: 1, exercise: "Barbell bench press", state: { kind: "holding", reason: "set 1 reached 10 reps; the rule needs 12" } },
      { prescription_id: 3, exercise: "Lat pulldown", state: { kind: "check_at_gym", question: "Is there a 45 kg on the stack?", next_load: { value: 45, unit: "kg", plates: null } } },
    ],
    ...over,
  });

  it("words each lift's state from log_workout", () => {
    expect(progressLines(result())).toEqual([
      "Cable row: ready, 40 kg next time.",
      "Barbell bench press: holding (set 1 reached 10 reps; the rule needs 12).",
      "Lat pulldown: check at the gym. Is there a 45 kg on the stack?",
    ]);
  });

  it("says a reason without the API's own aside in brackets (click test P2-18)", () => {
    expect(progressLines(result({ progression: [{ prescription_id: 9, exercise: "Dead hang", state: { kind: "cant_move", reason: "the load moves only by hand (manual rule)" } }] }))).toEqual(["Dead hang: can't move (the load moves only by hand)."]);
  });

  it("says how many sets were saved and where, even with no prescription to report", () => {
    const legs = result({ session: { id: 9, created: true, template: null, workout: "Hotel legs", state: "confirmed" }, sets: [{}, {}, {}, {}, {}], progression: [] });
    expect(loggedLines(legs)).toEqual(["5 sets saved in Hotel legs."]);
    expect(loggedLines(result({ sets: [{}] }))[0]).toBe("1 set saved in Upper A.");
    // A treadmill line is saved as a cardio block (ticket 68).
    expect(loggedLines(result({ sets: [{}], cardio: [{ index: 1, id: 4, activity: "Treadmill walk", duration_s: 1200, distance: null, position: 1 }] }))[0]).toBe("1 set and 1 cardio block saved in Upper A.");
    expect(loggedLines(result({ sets: [], cardio: [{ index: 0, id: 4, activity: "Treadmill walk", duration_s: 1200, distance: null, position: 1 }] }))[0]).toBe("1 cardio block saved in Upper A.");
    expect(loggedLines(result())).toHaveLength(4);
  });

  it("says plainly which sets went in as drafts and why (click test P1-5)", () => {
    const set = (n: number, state: string, more: Record<string, unknown> = {}) => ({
      set: { id: 100 + n, exercise: n <= 4 ? "Romanian deadlift" : "Leg press", set_number: n <= 4 ? n : n - 4, state, implement: n <= 4 ? "Olympic bar" : "Leg press machine", load_value: 32.5, load_unit: "kg" },
      snap: null, offer: null, ...more,
    });
    const offList = { snap: { status: "off_list", value: 32.5, unit: "kg" }, offer: { tool: "record_plates" } };
    const sets = [1, 2, 3, 4].map((n) => set(n, "draft", offList)).concat([5, 6].map((n) => set(n, "confirmed")));
    expect(loggedLines(result({ sets, progression: [] }))).toEqual([
      "6 sets saved in Upper A.",
      "4 of them went in as drafts, not confirmed: Romanian deadlift sets 1-4, because 32.5 kg isn't on the gym's list for the Olympic bar. Confirm them on Train if that is what you lifted.",
    ]);
    // A draft for another reason (coach mode, a set for someone else) says so without a reason it doesn't have.
    expect(loggedLines(result({ sets: [set(5, "draft")], progression: [] }))[1]).toBe("1 of them went in as a draft, not confirmed: Leg press set 1. Confirm it on Train if that is what you lifted.");
    expect(loggedLines(result({ sets: [set(5, "confirmed")], progression: [] }))).toEqual(["1 set saved in Upper A."]);
  });

  it("a workout logged for another member says they confirm the drafts on their Train (review round)", () => {
    const draft = { set: { id: 1, exercise: "Leg press", set_number: 1, state: "draft", implement: null }, snap: null, offer: null };
    expect(loggedLines(result({ sets: [draft, { ...draft, set: { ...draft.set, id: 2, set_number: 2 } }], progression: [] }), { member: "Kabir", own: false })[1]).toBe(
      "2 of them went in as drafts, not confirmed: Leg press sets 1-2. Kabir confirms them on their Train.",
    );
    expect(loggedLines(result({ sets: [draft], progression: [] }), { member: "Kabir", own: false })[1]).toBe("1 of them went in as a draft, not confirmed: Leg press set 1. Kabir confirms it on their Train.");
  });

  it("offers once to save a session that came from no workout and no programme", () => {
    expect(offerSaveAsWorkout(result())).toBe(false);
    expect(offerSaveAsWorkout(result({ session: { id: 9, created: true, template: null, workout: null, state: "confirmed" } }))).toBe(true);
    expect(saveAsWorkoutPlan(9, "")).toEqual({ error: "Name the workout." });
    expect((saveAsWorkoutPlan(9, "Tuesday mix") as { steps: { tool: string; input: Record<string, unknown> }[] }).steps[0]).toMatchObject({ tool: "save_session_as_workout", input: { session_id: 9, name: "Tuesday mix", reason: "Saved from the app" } });
  });
});

describe("plan order for the workout's lines", () => {
  const oneLine: WorkoutOut = { ...legs, lines: [legs.lines[0] as WorkoutOut["lines"][number]] };
  const tools = (p: unknown) => (p as { steps: { tool: string; input: Record<string, unknown> }[] }).steps;
  const planFor = (w: WorkoutOut, blocks: Block[]) => {
    const { source } = fromWorkout(w);
    const input = (workoutInput("Asha", "2026-10-06", source, blocks, "record_only") as { input: Record<string, unknown> }).input;
    return workoutPlan(input, "update", w, workoutChanges(w, blocks), blocks);
  };

  it("adds before it removes, so a one-line workout can be swapped", () => {
    const { blocks } = fromWorkout(oneLine);
    const steps = tools(planFor(oneLine, [done(swap(blocks[0] as Block, "Leg press"), "8")]));
    expect(steps.map((s) => s.tool)).toEqual(["log_workout", "add_workout_line", "remove_workout_line"]);
    expect(steps[1]?.input).toMatchObject({ workout: 5, position: 1, line: { exercise: "Leg press" } });
  });

  it("replacing every line adds each at its old line's shifted position, then removes the old ones", () => {
    const { blocks } = fromWorkout(legs);
    const steps = tools(planFor(legs, [done(swap(blocks[0] as Block, "Leg press")), done(swap(blocks[1] as Block, "Dip"))]));
    expect(steps.map((s) => s.tool)).toEqual(["log_workout", "add_workout_line", "add_workout_line", "remove_workout_line", "remove_workout_line"]);
    expect(steps.slice(1, 3).map((s) => s.input.position)).toEqual([1, 3]);
    expect(steps.slice(3).map((s) => s.input.line_id)).toEqual([51, 52]);
  });
});

describe("holds and carries", () => {
  const timed: NextForEntry = { programming_mode: "prescribed", session: "Core", prescriptions: [
    { prescription_id: 7, exercise: "Plank", sets: 2, target: { kind: "duration", low_s: 30, high_s: 45 }, rir_target: null, load: null },
    { prescription_id: 8, exercise: "Farmer carry", sets: 1, target: { kind: "distance", value: 20, unit: "m" }, rir_target: null, load: { value: 24, unit: "kg", basis: "per_hand", bar: null, plates: null } },
  ] };

  it("counts a plank in seconds and a carry in distance, needing neither reps nor RIR", () => {
    const { source, blocks } = fromNext(timed) as { source: never; blocks: Block[] };
    expect(blocks.map((b) => [b.target, b.rows[0]?.kind])).toEqual([["30-45 s", "duration"], ["20 m", "distance"]]);
    expect(workoutInput("Asha", "2026-10-06", source, blocks, "prescribed")).toEqual({ error: "Plank, set 1: enter the seconds." });
    const plank = { ...(blocks[0] as Block), rows: (blocks[0] as Block).rows.map((r) => ({ ...r, secs: "40", load: { kind: "none" as const } })) };
    expect(workoutInput("Asha", "2026-10-06", source, [plank, blocks[1] as Block], "prescribed")).toEqual({ error: "Farmer carry, set 1: enter the distance." });
    const carry = { ...(blocks[1] as Block), rows: (blocks[1] as Block).rows.map((r) => ({ ...r, dist: "20" })) };
    const out = workoutInput("Asha", "2026-10-06", source, [plank, carry], "prescribed") as { input: { sets: Record<string, unknown>[] } };
    expect(out.input.sets[0]).toEqual({ exercise: "Plank", set_type: "working", duration_s: 40, load: "none" });
    expect(out.input.sets[2]).toMatchObject({ exercise: "Farmer carry", distance: { value: 20, unit: "m" }, load: { value: 24, unit: "kg", basis: "per_hand" } });
    expect(out.input.sets[2]).not.toHaveProperty("reps");
  });
});

describe("a timed line with no load prescribed (click test P2-13)", () => {
  it("starts with no load, so a treadmill's minutes save without a load or RIR", () => {
    const z2: NextForEntry = { programming_mode: "prescribed", session: "Lower A", prescriptions: [
      { prescription_id: 9, exercise: "Zone 2 Treadmill", sets: 1, target: { kind: "duration", low_s: 1500, high_s: 1800 }, rir_target: null, load: null },
    ] };
    const { source, blocks } = fromNext(z2) as { source: never; blocks: Block[] };
    expect(blocks[0]?.rows[0]?.load).toEqual({ kind: "none" });
    const walked = { ...(blocks[0] as Block), rows: (blocks[0] as Block).rows.map((r) => ({ ...r, secs: "1600" })) };
    expect(workoutInput("Asha", "2026-10-06", source, [walked], "prescribed")).toMatchObject({ input: { sets: [{ exercise: "Zone 2 Treadmill", duration_s: 1600, load: "none" }] } });
    // A counted line with no load prescribed still asks for one.
    expect(newBlock("Goblet squat").rows[0]?.load).toEqual({ kind: "value", value: "", unit: "kg", basis: "total" });
  });
});

describe("save as new", () => {
  it("gives a default load only when every set agrees, and keeps warm-ups as warm-ups", () => {
    const { source, blocks } = fromWorkout(legs);
    const squat = blocks[0] as Block;
    const mixed: Block = { ...squat, rows: [{ ...squat.rows[0] as Block["rows"][number], setType: "warm_up", reps: "8", rir: "", load: { kind: "value", value: "10", unit: "kg", basis: "total" } }, ...squat.rows.slice(1).map((r, i) => ({ ...r, reps: "10", rir: "2", load: { kind: "value" as const, value: i === 0 ? "16" : "18", unit: "kg" as const, basis: "total" as const } }))] };
    const changed = [mixed, done(blocks[1] as Block), done(newBlock("Calf raise"), "15")];
    const input = (workoutInput("Asha", "2026-10-06", source, changed.slice(0, 2), "record_only") as { input: Record<string, unknown> }).input;
    const plan = workoutPlan(input, "new", legs, workoutChanges(legs, changed), changed, "Mix") as unknown as { steps: { input: { lines: Record<string, unknown>[] } }[] };
    expect(plan).toHaveProperty("steps");
    const lines = plan.steps[1]?.input.lines ?? [];
    expect(lines[0]).toEqual({ exercise: "Goblet squat", set_type: "warm_up", sets: 1, reps: { low: 8, high: 8 }, load: { value: 10, unit: "kg", basis: "total" } });
    expect(lines[1]).toMatchObject({ set_type: "working", sets: 2, reps: { low: 10, high: 10 } });
    expect(lines[1]).not.toHaveProperty("load");
  });
});


describe("a set's load is given or chosen, never defaulted", () => {
  const { source, blocks } = fromWorkout(legs);
  const withLoad = (load: Block["rows"][number]["load"]): Block[] => [done({ ...(blocks[0] as Block), rows: (blocks[0] as Block).rows.slice(0, 1).map((r) => ({ ...r, load })) }), done({ ...(blocks[1] as Block), rows: (blocks[1] as Block).rows.slice(0, 1) })];
  const first = (bs: Block[]) => ((workoutInput("Noor", "2026-10-06", source, bs, "record_only") as { input: { sets: Record<string, unknown>[] } }).input.sets[0]);

  it("a blank load is an inline error", () => {
    expect(workoutInput("Noor", "2026-10-06", source, withLoad({ kind: "value", value: "", unit: "kg", basis: "total" }), "record_only")).toEqual({ error: "Goblet squat, set 1: give a load, or choose Bodyweight / Not recorded." });
  });
  it("Bodyweight sends none, Not recorded sends not_recorded, a value sends the value", () => {
    expect(first(withLoad({ kind: "none" }))).toEqual({ exercise: "Goblet squat", set_type: "working", reps: 10, rir: { low: 2, high: 2 }, load: "none" });
    expect(first(withLoad({ kind: "not_recorded" }))).toMatchObject({ load: "not_recorded" });
    expect(first(withLoad({ kind: "value", value: "16", unit: "kg", basis: "total" }))).toMatchObject({ load: { value: 16, unit: "kg", basis: "total" } });
  });
});
