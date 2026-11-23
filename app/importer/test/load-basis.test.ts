// Load bases the app has no word for: "per ankle" reads as per leg, and any
// other unknown basis is a ruling whose decided override is honoured, on Log
// sets and on Program loads alike. Invented values only.
import { describe, expect, it } from "vitest";
import { rehearse } from "../src/rehearse";
import type { Ruling } from "../src/rulings";
import { basePeople, LOG_HEADER, members, PROGRAM_HEADER, set, snapshot } from "./fixture";

const D1 = 46240; // 2026-08-06

function ruled(id: string, override: unknown, decision: "accepted" | "rejected" = "accepted"): Ruling {
  const m = /^([^/]+)\/([^!]+)!(\d+)\/([^/]+)/.exec(id) as RegExpExecArray;
  return {
    id, origin: { file: m[1] as string, tab: m[2] as string, row: Number(m[3]) }, code: m[4] as string, kind: "semantic", cause: null,
    problem: "", proposed_fix: "", proposal: null, decision, decided_by: "Test", override, day: null, row: {}, note: null,
  };
}

function run(hritvik: Record<string, unknown[][]>, previousRulings: Ruling[] = []) {
  return rehearse({ snapshot: snapshot({ base: { People: basePeople() }, hritvik } as never), members: members(), previousRulings });
}

const SET_COLUMNS = "SELECT exercise_name, reps, load_status, load_value, load_unit, load_basis, unilateral, round(total_load_kg, 3) AS total FROM v_set ORDER BY id";

describe("Log load basis", () => {
  it('reads "per ankle" as per leg: each ankle carries the value, the total is both', async () => {
    const r = await run({
      Log: [LOG_HEADER, set({ date: D1, session: "Core", exercise: "Hanging Knee Raise", set: 1, reps: 9, rir: 1, weight: 1.5, basis: "per ankle", total: 3 })],
    });
    expect(r.db.all(SET_COLUMNS)).toEqual([
      { exercise_name: "Hanging Knee Raise", reps: 9, load_status: "entered", load_value: 1.5, load_unit: "kg", load_basis: "per_leg", unilateral: 0, total: 3 },
    ]);
    expect(r.rulings.filter((x) => x.code === "load_basis")).toEqual([]);
  });

  const paw = [LOG_HEADER, set({ date: D1, session: "Core", exercise: "Hanging Knee Raise", set: 1, reps: 9, rir: 1, weight: 2, basis: "per paw", total: 4 })];

  it("leaves a set with an unknown basis out while its ruling is pending", async () => {
    const r = await run({ Log: paw });
    expect(r.db.all(SET_COLUMNS)).toEqual([]);
    expect(r.rulings.find((x) => x.id === "hritvik/Log!2/load_basis")).toMatchObject({ kind: "semantic", decision: "pending", proposal: null });
  });

  it("logs the set with the basis a decided override gives", async () => {
    const r = await run({ Log: paw }, [ruled("hritvik/Log!2/load_basis", { basis: "per_leg" })]);
    expect(r.db.all(SET_COLUMNS)).toEqual([
      { exercise_name: "Hanging Knee Raise", reps: 9, load_status: "entered", load_value: 2, load_unit: "kg", load_basis: "per_leg", unilateral: 0, total: 4 },
    ]);
    expect(r.rulings.find((x) => x.id === "hritvik/Log!2/load_basis")).toMatchObject({ decision: "accepted", override: { basis: "per_leg" } });
  });

  it("leaves the set out when the ruling is rejected", async () => {
    const r = await run({ Log: paw }, [ruled("hritvik/Log!2/load_basis", { basis: "per_leg" }, "rejected")]);
    expect(r.db.all(SET_COLUMNS)).toEqual([]);
  });

  it("raises a new ruling for an override basis the app does not know", async () => {
    const r = await run({ Log: paw }, [ruled("hritvik/Log!2/load_basis", { basis: "per tail" })]);
    expect(r.db.all(SET_COLUMNS)).toEqual([]);
    expect(r.rulings.find((x) => x.id === "hritvik/Log!2/load_basis_override")).toMatchObject({ kind: "semantic", decision: "pending" });
  });
});

describe("Program load basis", () => {
  const program = (basis: string) => [
    PROGRAM_HEADER,
    ["Core", 1, "Hanging Knee Raise", "Core", 3, "12-15", 1, "60s", 1, "kg", basis, "", "Add a little when the top of the range is easy", "", "", ""],
  ];
  const PRESCRIPTION = "SELECT exercise_name, current_load_value AS value, current_load_unit AS unit, current_load_basis AS basis FROM v_prescription";

  it('reads "per ankle" as per leg', async () => {
    const r = await run({ Program: program("per ankle") });
    expect(r.db.all(PRESCRIPTION)).toEqual([{ exercise_name: "Hanging Knee Raise", value: 1, unit: "kg", basis: "per_leg" }]);
    expect(r.rulings.filter((x) => x.code === "load_basis")).toEqual([]);
  });

  it("raises a ruling for an unknown basis instead of dropping the load silently; the prescription loads without it", async () => {
    const r = await run({ Program: program("per paw") });
    expect(r.rulings.find((x) => x.id === "hritvik/Program!2/load_basis")).toMatchObject({ kind: "semantic", decision: "pending", proposal: null, row: { C: "Hanging Knee Raise", I: 1, J: "kg", K: "per paw" } });
    expect(r.db.all(PRESCRIPTION)).toEqual([{ exercise_name: "Hanging Knee Raise", value: null, unit: null, basis: null }]);
  });

  it("stores the load with the basis a decided override gives", async () => {
    const r = await run({ Program: program("per paw") }, [ruled("hritvik/Program!2/load_basis", { basis: "per_leg" })]);
    expect(r.db.all(PRESCRIPTION)).toEqual([{ exercise_name: "Hanging Knee Raise", value: 1, unit: "kg", basis: "per_leg" }]);
  });
});
