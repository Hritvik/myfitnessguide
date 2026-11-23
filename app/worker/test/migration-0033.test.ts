import { rirAdjustedE1rm, type Load } from "@myfitnessguide/domain";
import { describe, expect, it } from "vitest";
import { NOW, TestDb } from "./db";
import { exercise, gym, household, implement, session, set } from "./fixtures";

const BEFORE = "0032";

type SetCase = {
  name: string;
  exerciseId: number;
  implementId: number | null;
  load: Load;
  row: Record<string, unknown>;
  comparable: 0 | 1;
};

function populated() {
  const t = new TestDb({ through: BEFORE });
  const h = household(t);
  const gymId = gym(t, h);
  const barbell = implement(t, gymId, { name: "Barbell", kind: "barbell", loading: "per_side", bar_value: 20, bar_unit: "kg" });
  const cable = implement(t, gymId, { name: "Cable", kind: "cable", loading: "total" });
  const dumbbells = implement(t, gymId, { name: "Dumbbells", kind: "dumbbell", loading: "total" });
  const machine = implement(t, gymId, { name: "Machine", kind: "machine", loading: "total" });
  const sled = implement(t, gymId, { name: "Sled", kind: "plate_loaded", loading: "plates_only" });
  const exercises = {
    total: exercise(t, h, { name: "Machine press", implement_kind: "machine" }),
    barbell: exercise(t, h, { name: "Barbell press", implement_kind: "barbell" }),
    cable: exercise(t, h, { name: "Cable fly", implement_kind: "cable" }),
    hand: exercise(t, h, { name: "Dumbbell curl", implement_kind: "dumbbell" }),
    leg: exercise(t, h, { name: "Single-leg extension", implement_kind: "machine" }),
    sled: exercise(t, h, { name: "Sled press", implement_kind: "plate_loaded" }),
    assisted: exercise(t, h, { name: "Assisted pull-up", implement_kind: "machine" }),
    bodyweight: exercise(t, h, { name: "Weighted push-up", implement_kind: "bodyweight", bodyweight_dominant: 1 }),
  };
  const sessionId = session(t, h.hritvik, gymId, { state: "confirmed", confirmed_at: NOW });
  const base = { reps: 8, load_status: "entered", rir_status: "recorded", rir_low: 2, rir_high: 3, state: "confirmed", confirmed_at: NOW };
  const cases: SetCase[] = [
    {
      name: "total",
      exerciseId: exercises.total,
      implementId: machine,
      load: { value: 30, unit: "kg", basis: "total", implement: { id: "machine", unit: "kg", kind: "machine" } },
      row: { load_value: 30, load_unit: "kg", load_basis: "total" },
      comparable: 1,
    },
    {
      name: "barbell per side",
      exerciseId: exercises.barbell,
      implementId: barbell,
      load: { value: 10, unit: "kg", basis: "per_side", implement: { id: "barbell", unit: "kg", kind: "barbell", barKg: 20 } },
      row: { load_value: 10, load_unit: "kg", load_basis: "per_side", bar_value: 20, bar_unit: "kg" },
      comparable: 1,
    },
    {
      name: "empty bar",
      exerciseId: exercises.barbell,
      implementId: barbell,
      load: { value: 0, unit: "kg", basis: "per_side", implement: { id: "barbell", unit: "kg", kind: "barbell", barKg: 20 } },
      row: { load_value: 0, load_unit: "kg", load_basis: "per_side", bar_value: 20, bar_unit: "kg" },
      comparable: 1,
    },
    {
      name: "cable per side",
      exerciseId: exercises.cable,
      implementId: cable,
      load: { value: 10, unit: "kg", basis: "per_side", implement: { id: "cable", unit: "kg", kind: "cable", barKg: 0 } },
      row: { load_value: 10, load_unit: "kg", load_basis: "per_side", bar_value: 0, bar_unit: "kg" },
      comparable: 1,
    },
    {
      name: "per hand",
      exerciseId: exercises.hand,
      implementId: dumbbells,
      load: { value: 10, unit: "kg", basis: "per_hand", implement: { id: "dumbbells", unit: "kg", kind: "dumbbell" } },
      row: { load_value: 10, load_unit: "kg", load_basis: "per_hand" },
      comparable: 1,
    },
    {
      name: "unilateral per leg",
      exerciseId: exercises.leg,
      implementId: machine,
      load: { value: 10, unit: "kg", basis: "per_leg", unilateral: true, implement: { id: "machine", unit: "kg", kind: "machine" } },
      row: { load_value: 10, load_unit: "kg", load_basis: "per_leg", unilateral: 1 },
      comparable: 1,
    },
    {
      name: "plates only",
      exerciseId: exercises.sled,
      implementId: sled,
      load: { value: 20, unit: "kg", basis: "plates_only", implement: { id: "sled", unit: "kg", kind: "plate_loaded" } },
      row: { load_value: 20, load_unit: "kg", load_basis: "per_side" },
      comparable: 0,
    },
    {
      name: "assisted",
      exerciseId: exercises.assisted,
      implementId: machine,
      load: { value: 20, unit: "kg", basis: "total", implement: { id: "machine", unit: "kg", kind: "machine", assisted: true } },
      row: { load_value: -20, load_unit: "kg", load_basis: "total" },
      comparable: 0,
    },
    {
      name: "bodyweight dominant",
      exerciseId: exercises.bodyweight,
      implementId: machine,
      load: { value: 20, unit: "kg", basis: "total", implement: { id: "machine", unit: "kg", kind: "machine" } },
      row: { load_value: 20, load_unit: "kg", load_basis: "total" },
      comparable: 0,
    },
    {
      name: "zero total",
      exerciseId: exercises.total,
      implementId: machine,
      load: { value: 0, unit: "kg", basis: "total", implement: { id: "machine", unit: "kg", kind: "machine" } },
      row: { load_value: 0, load_unit: "kg", load_basis: "total" },
      comparable: 0,
    },
  ];

  const ids = cases.map((candidate) =>
    set(t, sessionId, candidate.exerciseId, { ...base, ...candidate.row, load_implement_id: candidate.implementId }),
  );
  const strictId = set(t, sessionId, exercises.total, {
    ...base,
    reps: 5,
    rir_low: 0,
    rir_high: 0,
    load_value: 70,
    load_unit: "kg",
    load_basis: "total",
    load_implement_id: machine,
  });
  const cappedId = set(t, sessionId, exercises.total, {
    ...base,
    reps: 11,
    load_value: 30,
    load_unit: "kg",
    load_basis: "total",
    load_implement_id: machine,
  });
  t.insert("method_change", { member_id: h.hritvik, metric: "weight", changed_on: "2026-08-01", note: "New scale" });
  const exerciseChange = t.insert("method_change", {
    member_id: h.hritvik,
    exercise_id: exercises.total,
    changed_on: "2026-09-01",
    note: "Paused reps",
  });
  return { t, h, cases, ids, strictId, cappedId, exerciseChange };
}

describe("migration 0033 charts", () => {
  it("upgrades a populated 0032 database without changing any existing v_set field", () => {
    const { t } = populated();
    const before = t.all("SELECT * FROM v_set ORDER BY id");
    t.migrateAfter(BEFORE);
    const after = t.all("SELECT * FROM v_set ORDER BY id");
    expect(
      after.map(
        ({
          e1rm_rir_kg: _rir,
          comparable: _comparable,
          structure: _structure,
          segments: _segments,
          rir_scope: _rirScope,
          carry_type: _carryType,
          sides: _sides,
          distance_basis: _distanceBasis,
          version: _version,
          draft_reason: _draftReason,
          total_reps: _totalReps,
          ...old
        }) => old,
      ),
    ).toEqual(before);
    expect(t.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(t.get("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
  });

  it("matches the domain RIR estimate for every load convention and excludes non-comparable loads", () => {
    const { t, cases, ids, strictId, cappedId } = populated();
    t.migrateAfter(BEFORE);
    for (const [index, candidate] of cases.entries()) {
      const row = t.get("SELECT comparable, e1rm_rir_kg FROM v_set WHERE id = ?", ids[index])!;
      const expected = rirAdjustedE1rm({
        load: candidate.load,
        reps: 8,
        rir: { low: 2, high: 3 },
        bodyweightDominant: candidate.name === "bodyweight dominant",
      });
      expect(row.comparable, candidate.name).toBe(candidate.comparable);
      if (expected === null) expect(row.e1rm_rir_kg, candidate.name).toBeNull();
      else expect(row.e1rm_rir_kg, candidate.name).toBeCloseTo(expected.e1rmKg, 12);
    }
    expect(t.get("SELECT e1rm_rir_kg FROM v_set WHERE id = ?", cappedId)?.e1rm_rir_kg).toBeNull();
    expect(t.get("SELECT e1rm_kg, e1rm_rir_kg FROM v_set WHERE id = ?", strictId)).toEqual({
      e1rm_kg: 70 * (1 + 5 / 30),
      e1rm_rir_kg: 70 * (1 + 5 / 30),
    });
  });

  it("exposes only exercise method changes through the household view and keeps the body view intact", () => {
    const { t, h, exerciseChange } = populated();
    t.migrateAfter(BEFORE);
    expect(t.all("SELECT id, member_id, note FROM v_exercise_method_change")).toEqual([
      { id: exerciseChange, member_id: h.hritvik, note: "Paused reps" },
    ]);
    expect(t.all("SELECT note FROM v_method_change ORDER BY id")).toEqual([{ note: "New scale" }, { note: "Paused reps" }]);
  });
});
