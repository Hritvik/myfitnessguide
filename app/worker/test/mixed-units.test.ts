// Mixed-unit load lists: each load stored in its native unit, inferred by
// which unit makes it a whole or half number; snapping across units; and a
// question when a reported load is clean in neither unit or in both.
import { describe, expect, it } from "vitest";
import { setup } from "./harness";
import { seedTraining } from "./seed";

const MONDAY = "2026-10-05";

async function ready() {
  const x = setup();
  const s = seedTraining(x);
  const stack = x.t.insert("implement", { gym_id: s.gym, name: "Pec deck stack", kind: "machine", unit: "lb", loading: "total", load_list_complete: 0 });
  x.t.insert("implement_load", { implement_id: stack, load: 40, unit: "lb" });
  x.t.insert("exercise", { household_id: x.h.id, name: "Pec deck", implement_kind: "machine" });
  const session = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength" })).session.id;
  return { x, s, stack, session };
}

describe("add_implement_load: a list may mix kg and lb", () => {
  it("stores each load in its native unit and lists them by weight", async () => {
    const { x, stack } = await ready();
    // 33.07 lb is the 15 kg starter weight; 50 lb is as stated.
    const body = await x.ok("add_implement_load", { implement_id: stack, loads: [33.07, { value: 50, unit: "lb" }] });
    expect(body.added).toEqual([{ value: 15, unit: "kg" }, { value: 50, unit: "lb" }]);
    expect(body.implement.loads).toEqual([{ value: 15, unit: "kg" }, { value: 40, unit: "lb" }, { value: 50, unit: "lb" }]);
    expect(x.t.all("SELECT load, unit FROM implement_load WHERE implement_id = ? ORDER BY id", stack)).toEqual([
      { load: 40, unit: "lb" },
      { load: 15, unit: "kg" },
      { load: 50, unit: "lb" },
    ]);
  });

  it("asks when a load is clean in both units, and takes the answer as stated", async () => {
    const { x, stack } = await ready();
    const asked = await x.call("add_implement_load", { implement_id: stack, loads: [{ value: 22, unit: "kg" }] });
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "unit_unclear", options: ["22 kg", "48.5 lb"], path: ["loads", 0] });
    const body = await x.ok("add_implement_load", { implement_id: stack, loads: [{ value: 22, unit: "kg" }], as_stated: true });
    expect(body.added).toEqual([{ value: 22, unit: "kg" }]);
  });

  it("asks when a load is clean in neither unit", async () => {
    const { x, stack } = await ready();
    const asked = await x.call("add_implement_load", { implement_id: stack, loads: [{ value: 13.33, unit: "kg" }] });
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "unit_unclear", options: [] });
  });

  it("a load once removed as absent can be added back", async () => {
    const { x, stack } = await ready();
    await x.ok("remove_implement_load", { implement_id: stack, loads: [60], reason: "no 60 lb plate on this stack" });
    expect(x.t.get("SELECT status FROM implement_load WHERE implement_id = ? AND load = 60", stack)).toEqual({ status: "absent" });
    const body = await x.ok("add_implement_load", { implement_id: stack, loads: [60] });
    expect(body.added).toEqual([{ value: 60, unit: "lb" }]);
    expect(body.implement.absent).toEqual([]);
  });
});

describe("add_implement_load: a stated ladder", () => {
  it("expands every step, in the unit it was stated in", async () => {
    const { x, stack } = await ready();
    const body = await x.ok("add_implement_load", { implement_id: stack, ranges: [{ from: 45, to: 60, step: 5, unit: "lb" }] });
    expect(body.added).toEqual([45, 50, 55, 60].map((value) => ({ value, unit: "lb" })));
  });

  it("trusts the stated unit even where the value is round in both", async () => {
    const { x, stack } = await ready();
    // 22 kg is also 48.5 lb: an explicit load would ask; a ladder says kg.
    const body = await x.ok("add_implement_load", { implement_id: stack, ranges: [{ from: 22, to: 22, step: 1, unit: "kg" }] });
    expect(body.added).toEqual([{ value: 22, unit: "kg" }]);
  });

  it("mixes a ladder with explicit loads and skips a load already named", async () => {
    const { x, stack } = await ready();
    const body = await x.ok("add_implement_load", {
      implement_id: stack,
      loads: [10],
      ranges: [{ from: 5, to: 25, step: 5, unit: "lb" }],
    });
    expect(body.added).toEqual([10, 5, 15, 20, 25].map((value) => ({ value, unit: "lb" })));
  });

  it("asks when a ladder runs backwards or names too many loads", async () => {
    const { x, stack } = await ready();
    const backwards = await x.call("add_implement_load", { implement_id: stack, ranges: [{ from: 60, to: 40, step: 5, unit: "lb" }] });
    expect(backwards.body).toMatchObject({ status: "needs_clarification", reason: "range_backwards" });
    const huge = await x.call("add_implement_load", {
      implement_id: stack,
      ranges: [{ from: 0, to: 34, step: 1, unit: "lb" }, { from: 100, to: 134, step: 1, unit: "lb" }],
    });
    expect(huge.body).toMatchObject({ status: "needs_clarification", reason: "range_too_large" });
  });

  it("asks which loads when neither a value nor a ladder is given", async () => {
    const { x, stack } = await ready();
    const asked = await x.call("add_implement_load", { implement_id: stack });
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "loads_needed" });
  });
});

describe("log_set: a reported load read in its native unit", () => {
  it("a pound load reported in kg is stored as the pound load, on the list", async () => {
    const { x, stack, session } = await ready();
    const body = await x.ok("log_set", { session_id: session, exercise: "Pec deck", reps: 12, rir: 2, load: { value: 18.14, unit: "kg", basis: "total", implement: stack } });
    expect(body.set).toMatchObject({ load_value: 40, load_unit: "lb", state: "confirmed" });
    expect(body.read_from).toEqual({ value: 18.14, unit: "kg" });
    expect(body.snap).toEqual({ status: "on_list", value: 40, unit: "lb" });
  });

  it("asks when the reported load is clean in both units and not on the list as stated", async () => {
    const { x, stack, session } = await ready();
    const asked = await x.call("log_set", { session_id: session, exercise: "Pec deck", reps: 12, rir: 2, load: { value: 22, unit: "kg", basis: "total", implement: stack } });
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "unit_unclear", path: ["load", "value"] });
    await x.ok("add_implement_load", { implement_id: stack, loads: [{ value: 22, unit: "kg" }], as_stated: true });
    const body = await x.ok("log_set", { session_id: session, exercise: "Pec deck", reps: 12, rir: 2, load: { value: 22, unit: "kg", basis: "total", implement: stack } });
    expect(body.snap).toEqual({ status: "on_list", value: 22, unit: "kg" });
  });

  it("asks when the reported load is clean in neither unit", async () => {
    const { x, s, session } = await ready();
    const asked = await x.call("log_set", { session_id: session, exercise: "db curl", reps: 12, rir: 2, load: { value: 7.33, unit: "kg", basis: "per_hand", implement: s.dumbbells } });
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "unit_unclear" });
  });
});

describe("inventory and v_implement show each load with its unit", () => {
  it("lists a mixed list lightest first", async () => {
    const { x, s, stack } = await ready();
    await x.ok("add_implement_load", { implement_id: stack, loads: [{ value: 10, unit: "kg" }] });
    const inv = await x.ok("inventory", { gym: s.gym });
    expect(inv.implements.find((i: { id: number }) => i.id === stack).loads).toEqual([{ value: 10, unit: "kg" }, { value: 40, unit: "lb" }]);
    expect(x.t.get("SELECT loads FROM v_implement WHERE id = ?", stack)).toEqual({ loads: "10.0 kg, 40.0 lb" });
  });
});
