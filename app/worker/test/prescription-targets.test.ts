// Prescriptions with a duration, distance or RIR-less rep target, and
// progression rules with a unit-and-basis increment, the smallest
// producible step, a RIR floor read from the prescription, a cue and
// per_leg. Programmes are created through the import-only tool, then read
// through the API.
import { describe, expect, it } from "vitest";
import { importWrite } from "../src/importing";
import { setup, type Harness } from "./harness";
import { seedTraining } from "./seed";

const AT = "2026-10-05T07:00:00Z";
let row = 0;
const meta = () => ({ at: AT, origin: { file: "hritvik", tab: "Program", row: ++row } });

async function programme(x: Harness, prescriptions: Record<string, unknown>[]) {
  const r = await importWrite(x.db, "create_programme", {
    member: "Hritvik", name: "Programme", schedule_kind: "rotation", started_on: "2026-09-01",
    templates: [{ name: "Upper", session_type: "strength", prescriptions }],
    slots: [{ rotation_position: 1, template: "Upper" }],
  }, meta());
  return r;
}

async function ready() {
  const x = setup();
  const s = seedTraining(x);
  x.t.insert("exercise", { household_id: x.h.id, name: "Dead hang", implement_kind: "bodyweight" });
  x.t.insert("exercise", { household_id: x.h.id, name: "Farmer carry", implement_kind: "dumbbell" });
  return { x, s };
}

describe("non-rep prescriptions", () => {
  it("holds duration, distance and RIR-less rep targets, and next_prescription lists them in order", async () => {
    const { x } = await ready();
    const r = await programme(x, [
      { exercise: "Barbell bench press", sets: 3, rep_low: 6, rep_high: 8, rir_target_low: 1, rir_target_high: 2 },
      { exercise: "Dead hang", target: { kind: "duration" }, sets: 2, progression_rule: { kind: "manual" } },
      { exercise: "Treadmill walk", target: { kind: "duration", low_s: 1200, high_s: 1500 }, progression_rule: { kind: "manual" } },
      { exercise: "Farmer carry", target: { kind: "distance", value: 30, unit: "m" }, sets: 2, progression_rule: { kind: "manual" } },
      { exercise: "Push-up", sets: 2, rep_low: 10, rep_high: 12, progression_rule: { kind: "manual" } },
    ]);
    expect(r.status).toBe("ok");
    const next = await x.ok("next_prescription", { member: "Hritvik", date: "2026-10-05" });
    expect(next.prescriptions.map((p: Record<string, unknown>) => [p.exercise, p.target, p.rir_target])).toEqual([
      ["Barbell bench press", { kind: "reps", low: 6, high: 8 }, { low: 1, high: 2 }],
      ["Dead hang", { kind: "duration", low_s: null, high_s: null }, null],
      ["Treadmill walk", { kind: "duration", low_s: 1200, high_s: 1500 }, null],
      ["Farmer carry", { kind: "distance", value: 30, unit: "m" }, null],
      ["Push-up", { kind: "reps", low: 10, high: 12 }, null],
    ]);
    const prog = await x.ok("programme", { member: "Hritvik" });
    expect(prog.templates[0].prescriptions[1]).toMatchObject({ exercise: "Dead hang", sets: 2, target: { kind: "duration" }, rir_target: null });
    const check = await x.ok("check_progression", { prescription_id: next.prescriptions[1].prescription_id });
    expect(check).toMatchObject({ verdict: "never", reason: "manual_rule" });
  });

  it("a cardio-machine prescription counts as performed once a cardio session is logged, not as a gap", async () => {
    const { x } = await ready();
    await programme(x, [{ exercise: "Treadmill walk", target: { kind: "duration", low_s: 1200, high_s: 1500 }, progression_rule: { kind: "manual" } }]);
    const before = await x.ok("next_prescription", { member: "Hritvik", date: "2026-10-05" });
    expect(before.gaps.map((g: { exercise: string }) => g.exercise)).toEqual(["Treadmill walk"]);
    await x.ok("log_cardio", { member: "Hritvik", date: "2026-10-04", session_type: "cardio", blocks: [{ kind: "steady", duration_s: 1200 }] });
    const after = await x.ok("next_prescription", { member: "Hritvik", date: "2026-10-05" });
    expect(after.gaps).toEqual([]);
  });

  it("refuses a rep_top rule on a non-rep target, and a rep range on a duration", async () => {
    const { x } = await ready();
    const rule = await programme(x, [{ exercise: "Dead hang", target: { kind: "duration" }, sets: 2, progression_rule: { kind: "rep_top", target_sets: 2, rep_top: 10, rir_floor: 1 } }]);
    expect(rule).toMatchObject({ status: "needs_clarification", reason: "rule_needs_reps" });
    const both = await programme(x, [{ exercise: "Dead hang", target: { kind: "duration" }, sets: 2, rep_low: 5, rep_high: 8 }]);
    expect(both).toMatchObject({ status: "needs_clarification", reason: "target_conflict" });
  });
});

describe("richer progression rules", () => {
  async function trained(x: Harness, prescription: Record<string, unknown>, sets: Record<string, unknown>[]) {
    expect((await programme(x, [prescription])).status).toBe("ok");
    const session = (await x.ok("start_session", { member: "Hritvik", date: "2026-10-05", session_type: "strength", template: "Upper" })).session.id;
    for (const s of sets) await x.ok("log_set", { session_id: session, exercise: prescription.exercise, ...s });
    const p = x.t.get("SELECT id FROM prescription")!.id as number;
    return x.ok("check_progression", { prescription_id: p });
  }

  it("an increment in kg per hand moves a pound dumbbell by the matching step", async () => {
    const { x, s } = await ready();
    x.t.run("UPDATE implement SET unit = 'lb' WHERE id = ?", s.dumbbells);
    x.t.run("DELETE FROM implement_load WHERE implement_id = ?", s.dumbbells);
    for (const l of [5, 10, 15, 20]) x.t.insert("implement_load", { implement_id: s.dumbbells, load: l, unit: "lb" });
    const set = { reps: 12, rir: 2, load: { value: 10, unit: "lb", basis: "per_hand", implement: s.dumbbells } };
    const check = await trained(x, {
      exercise: "Dumbbell curl", sets: 2, rep_low: 10, rep_high: 12, rir_target_low: 1, rir_target_high: 2,
      load: { value: 10, unit: "lb", basis: "per_hand" },
      progression_rule: { kind: "rep_top", target_sets: 2, rep_top: 12, rir_floor: 2, increment: { min: 2.268, max: 2.268, unit: "kg", basis: "per_hand" } },
    }, [set, set]);
    expect(check).toMatchObject({ verdict: "fired", nextLoad: 15 });
  });

  it("an increment on the total is halved for a per-hand load", async () => {
    const { x, s } = await ready();
    const set = { reps: 12, rir: 2, load: { value: 5, unit: "kg", basis: "per_hand", implement: s.dumbbells } };
    const check = await trained(x, {
      exercise: "Dumbbell curl", sets: 2, rep_low: 10, rep_high: 12, rir_target_low: 1, rir_target_high: 2,
      load: { value: 5, unit: "kg", basis: "per_hand" },
      progression_rule: { kind: "rep_top", target_sets: 2, rep_top: 12, rir_floor: 2, increment: { min: 5, unit: "kg", basis: "total" } },
    }, [set, set]);
    expect(check).toMatchObject({ verdict: "fired", nextLoad: 7.5 });
  });

  it("the smallest producible step, and a RIR floor read from the prescription", async () => {
    const { x, s } = await ready();
    const set = (rir: number) => ({ reps: 10, rir, load: { value: 30, unit: "kg", basis: "total", implement: s.stack } });
    const rx = {
      exercise: "Cable lat pulldown", sets: 2, rep_low: 8, rep_high: 10, rir_target_low: 2, rir_target_high: 3,
      load: { value: 30, unit: "kg", basis: "total" },
      progression_rule: { kind: "rep_top", target_sets: 2, rep_top: 10, rir_floor: "from_prescription", increment: "smallest_step", cue: "Pause at the chest." },
    };
    const ground = await trained(x, rx, [set(1), set(1)]);
    expect(ground).toMatchObject({ verdict: "not_yet", reason: "ground_out" });
    const prog = await x.ok("programme", { member: "Hritvik" });
    expect(prog.templates[0].prescriptions[0].progression_rule).toMatchObject({ rir_floor: "from_prescription", increment: "smallest_step", cue: "Pause at the chest." });
  });

  it("fires to the next stack plate on the smallest step", async () => {
    const { x, s } = await ready();
    const set = { reps: 10, rir: 2, load: { value: 30, unit: "kg", basis: "total", implement: s.stack } };
    const check = await trained(x, {
      exercise: "Cable lat pulldown", sets: 2, rep_low: 8, rep_high: 10, rir_target_low: 2, rir_target_high: 3,
      load: { value: 30, unit: "kg", basis: "total" },
      progression_rule: { kind: "rep_top", target_sets: 2, rep_top: 10, rir_floor: "from_prescription", increment: "smallest_step", per_leg: false },
    }, [set, set]);
    expect(check).toMatchObject({ verdict: "fired", nextLoad: 35 });
  });
});
