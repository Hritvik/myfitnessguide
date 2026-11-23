// The split e1RM convention: a total on barbells and plate-loaded machines;
// per hand, per side or per leg on dumbbells and cables. Volume counts every
// limb. log_set (the domain) and v_set (query) must agree, set for set.
import { describe, expect, it } from "vitest";
import { setup } from "./harness";
import { seedTraining } from "./seed";

const MONDAY = "2026-10-05";

async function ready() {
  const x = setup();
  const s = seedTraining(x);
  x.t.insert("exercise", { household_id: x.h.id, name: "Cable fly", implement_kind: "cable" });
  x.t.insert("exercise", { household_id: x.h.id, name: "Sled press", implement_kind: "plate_loaded" });
  const session = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength" })).session.id;
  return { x, s, session };
}

const at0 = 0;

describe("split e1RM", () => {
  it("per hand on dumbbells: e1RM on one dumbbell, volume and total on both", async () => {
    const { x, s, session } = await ready();
    const { set } = await x.ok("log_set", { session_id: session, exercise: "Dumbbell curl", reps: 10, rir: at0, load: { value: 5, unit: "kg", basis: "per_hand", implement: s.dumbbells } });
    expect(set.total_kg).toBe(10);
    expect(set.volume_kg).toBe(100);
    expect(set.e1rm_kg).toBeCloseTo(5 * (1 + 10 / 30), 9);
  });

  it("plates per side on a barbell: e1RM on the whole bar", async () => {
    const { x, s, session } = await ready();
    const { set } = await x.ok("log_set", {
      session_id: session, exercise: "Barbell bench press", reps: 6, rir: at0,
      load: { value: 10, unit: "kg", basis: "per_side", implement: s.barbell, bar: { value: 20, unit: "kg" } },
    });
    expect(set.total_kg).toBe(40);
    expect(set.e1rm_kg).toBeCloseTo(48, 9);
  });

  it("per side on a cable: one side's stack", async () => {
    const { x, session } = await ready();
    const { set } = await x.ok("log_set", { session_id: session, exercise: "Cable fly", reps: 6, rir: at0, load: { value: 9, unit: "kg", basis: "per_side", bar: { value: 0, unit: "kg" } } });
    expect(set.volume_kg).toBe(108);
    expect(set.e1rm_kg).toBeCloseTo(10.8, 9);
  });

  it("per leg: a single-leg set covers both legs unless it is marked unilateral", async () => {
    const { x, s, session } = await ready();
    const both = await x.ok("log_set", { session_id: session, exercise: "Single-leg calf raise", reps: 9, rir: at0, load: { value: 7.5, unit: "kg", basis: "per_leg", implement: s.dumbbells } });
    expect(both.set).toMatchObject({ total_kg: 15, volume_kg: 135 });
    expect(both.set.e1rm_kg).toBeCloseTo(9.75, 9);
    const one = await x.ok("log_set", { session_id: session, exercise: "Single-leg calf raise", reps: 9, rir: at0, load: { value: 7.5, unit: "kg", basis: "per_leg", implement: s.dumbbells, unilateral: true } });
    expect(one.set).toMatchObject({ total_kg: 7.5, volume_kg: 67.5 });
    expect(one.set.e1rm_kg).toBeCloseTo(9.75, 9);
  });

  it("v_set agrees with log_set on total, volume and e1RM for every basis and kind", async () => {
    const { x, s, session } = await ready();
    const cases = [
      { exercise: "Dumbbell curl", reps: 9, rir: at0, load: { value: 6, unit: "kg", basis: "per_hand" } },
      { exercise: "Dumbbell curl", reps: 8, rir: at0, load: { value: 10, unit: "lb", basis: "per_hand", unilateral: true } },
      { exercise: "Single-leg calf raise", reps: 9, rir: at0, load: { value: 7.5, unit: "kg", basis: "per_leg" } },
      { exercise: "Cable fly", reps: 6, rir: at0, load: { value: 9, unit: "kg", basis: "per_side", bar: { value: 0, unit: "kg" } } },
      { exercise: "Sled press", reps: 6, rir: at0, load: { value: 20, unit: "kg", basis: "per_side", bar: { value: 0, unit: "kg" } } },
      { exercise: "Barbell bench press", reps: 6, rir: at0, load: { value: 12.5, unit: "lb", basis: "per_side", implement: s.barbell, bar: { value: 20, unit: "kg" } } },
      { exercise: "Cable lat pulldown", reps: 8, rir: at0, load: { value: 40, unit: "kg", basis: "total", implement: s.stack } },
    ];
    for (const c of cases) {
      const { set } = await x.ok("log_set", { session_id: session, ...c });
      const view = x.t.get("SELECT total_load_kg, volume_kg, e1rm_kg FROM v_set WHERE id = ?", set.id)!;
      const round = (v: unknown) => (v === null ? null : Number((v as number).toFixed(9)));
      expect([view.total_load_kg, view.volume_kg, view.e1rm_kg].map(round), JSON.stringify(c)).toEqual([set.total_kg, set.volume_kg, set.e1rm_kg].map(round));
    }
    expect(x.t.get("SELECT e1rm_kg FROM v_set WHERE exercise_name = 'Cable fly'")!.e1rm_kg).toBeCloseTo(10.8, 9);
    expect(x.t.get("SELECT e1rm_kg FROM v_set WHERE exercise_name = 'Sled press'")!.e1rm_kg).toBeCloseTo(48, 9);
  });
});
