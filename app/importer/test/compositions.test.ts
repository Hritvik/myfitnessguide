// Log loads as compositions and in their native units: where a row's note
// states the composition ("20 kg bar + 5 lb per side"), the set is imported
// as one; a row with the same load and no note takes that composition;
// anything else is read in the unit that makes it a whole or half number,
// and a load clean in neither (or both) is a ruling. Invented values only.
import { describe, expect, it } from "vitest";
import { rehearse } from "../src/rehearse";
import { basePeople, LOG_HEADER, members, set, snapshot } from "./fixture";

const D1 = 46240; // 2026-08-06
const D2 = 46242;
const LB = 0.45359237;

function noted(row: unknown[], note: string): unknown[] {
  const out = [...row];
  out[15] = note;
  return out;
}

function run() {
  const log = [
    LOG_HEADER,
    noted(set({ date: D1, session: "Upper A", exercise: "Bench Press", set: 1, reps: 8, rir: 2, weight: 24.5, total: 24.5 }), "20 kg bar + 5 lb per side."),
    set({ date: D2, session: "Upper A", exercise: "Bench Press", set: 1, reps: 8, rir: 2, weight: 24.5, total: 24.5 }),
    // The note states the next load, not this one: it doesn't match, so it is not this set's composition.
    noted(set({ date: D2, session: "Upper A", exercise: "Bench Press", set: 2, reps: 8, rir: 2, weight: 26.6, total: 26.6 }), "Moves to 20 kg bar + 10 lb/side next time."),
    noted(set({ date: D1, session: "Lower A", exercise: "Leg Press", set: 1, reps: 10, rir: 2, weight: 22.268, basis: "per side", total: 44.536 }), "MIXED PLATES: 20 kg + 5 lb per side."),
    set({ date: D2, session: "Lower A", exercise: "Leg Press", set: 1, reps: 10, rir: 2, weight: 22.27, basis: "per side", total: 44.54 }),
    set({ date: D1, session: "Upper A", exercise: "Lateral Raise", set: 1, reps: 12, rir: 2, weight: 2.27, basis: "per hand", total: 4.54 }),
  ];
  return rehearse({ snapshot: snapshot({ base: { People: basePeople() }, hritvik: { Log: log } } as never), members: members() });
}

describe("Log loads as compositions", () => {
  it("imports a composition the note states, and the same load without a note as that composition", async () => {
    const r = await run();
    const sets = r.db.all<{ exercise_name: string; load_basis: string; bar_value: number | null; bar_unit: string | null; plates: string | null; total: number }>(
      "SELECT exercise_name, load_basis, bar_value, bar_unit, plates, total_load_kg AS total FROM v_set ORDER BY id",
    );
    const bench = [{ value: 5, unit: "lb", count: 1 }];
    const sled = [{ value: 20, unit: "kg", count: 1 }, { value: 5, unit: "lb", count: 1 }];
    expect(sets.slice(0, 2).map((s) => [s.load_basis, s.bar_value, s.bar_unit, JSON.parse(s.plates as string)])).toEqual([
      ["per_side", 20, "kg", bench],
      ["per_side", 20, "kg", bench],
    ]);
    expect(sets[0]?.total).toBeCloseTo(20 + 2 * 5 * LB, 9);
    expect(sets.slice(3, 5).map((s) => JSON.parse(s.plates as string))).toEqual([sled, sled]);
    expect(sets[3]?.total).toBeCloseTo(2 * (20 + 5 * LB), 9);
    expect(r.db.get("SELECT count(*) AS n FROM session_set WHERE plates IS NOT NULL")).toEqual({ n: 4 });
  });

  it("a note that doesn't match the load is not its composition; a load clean in no unit is a ruling proposing it as typed", async () => {
    const r = await run();
    const ruling = r.rulings.find((x) => x.id === "hritvik/Log!4/load_unit");
    expect(ruling).toMatchObject({ kind: "semantic", decision: "pending", proposal: { value: 26.6, unit: "kg" } });
    expect(r.db.get("SELECT load_value, load_unit, plates FROM v_set WHERE exercise_name = 'Bench Press' AND id = 3")).toEqual({ load_value: 26.6, load_unit: "kg", plates: null });
  });

  it("reads a pound load typed in kg as the pound load", async () => {
    const r = await run();
    expect(r.db.get("SELECT load_value, load_unit FROM v_set WHERE exercise_name = 'Lateral Raise'")).toEqual({ load_value: 5, load_unit: "lb" });
  });

  it("parity compares the typed totals with the composition's exact total", async () => {
    const r = await run();
    expect(r.parity.differences.filter((d) => d.group.startsWith("Log") && d.status === "unexplained")).toEqual([]);
  });
});

describe("the split e1RM convention at import", () => {
  it("a plate-loaded e1RM typed on the total matches; one typed per side is a typed-error", async () => {
    const log = [
      LOG_HEADER,
      set({ date: D1, session: "Lower A", exercise: "Hack Squat", set: 1, reps: 6, rir: 0, weight: 20, basis: "per side", total: 40, volume: 240, e1rm: 48 }),
      set({ date: D1, session: "Lower A", exercise: "Hack Squat", set: 2, reps: 6, rir: 0, weight: 20, basis: "per side", total: 40, volume: 240, e1rm: 24 }),
      set({ date: D1, session: "Upper A", exercise: "Lateral Raise", set: 1, reps: 6, rir: 0, weight: 5, basis: "per hand", total: 10, volume: 60, e1rm: 12 }),
    ];
    const r = await rehearse({ snapshot: snapshot({ base: { People: basePeople() }, hritvik: { Log: log } } as never), members: members() });
    expect(r.parity.differences.find((d) => d.id === "hritvik/Log!2/parity/e1rm_kg")).toBeUndefined();
    expect(r.parity.differences.find((d) => d.id === "hritvik/Log!3/parity/e1rm_kg")).toMatchObject({ cause: "typed-error", decision: "pending" });
    // Dumbbells: per hand. 5 kg x 6 at RIR 0 is 6 per hand; 12 was typed on both hands.
    expect(r.parity.differences.find((d) => d.id === "hritvik/Log!4/parity/e1rm_kg")).toMatchObject({ cause: "typed-error" });
  });
});
