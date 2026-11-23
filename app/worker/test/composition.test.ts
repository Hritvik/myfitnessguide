// A set's load as a composition (a bar plus kg and lb plates on each side),
// and plate-loaded kit whose loads are combinations of the gym's plates.
// log_set, amend and v_set agree with the domain.
import { describe, expect, it } from "vitest";
import { setup } from "./harness";
import { seedTraining } from "./seed";

const MONDAY = "2026-10-05";
const LB = 0.45359237;

async function ready() {
  const x = setup();
  const s = seedTraining(x);
  const bar = x.t.insert("implement", { gym_id: s.gym, name: "Loadable bar", kind: "barbell", unit: "kg", loading: "per_side", load_list_complete: 0, bar_value: 20, bar_unit: "kg" });
  const sled = x.t.insert("implement", { gym_id: s.gym, name: "Sled", kind: "plate_loaded", unit: "kg", loading: "plates_only", load_list_complete: 0 });
  x.t.insert("exercise", { household_id: x.h.id, name: "Sled press", implement_kind: "plate_loaded" });
  await x.ok("record_plates", { gym: s.gym, unit: "kg", available: [5, 10, 20], absent: [2.5], complete: true });
  await x.ok("record_plates", { gym: s.gym, unit: "lb", available: [2.5, 5], complete: false });
  const session = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength" })).session.id;
  return { x, s, bar, sled, session };
}

const view = (x: Awaited<ReturnType<typeof ready>>["x"], id: number) =>
  x.t.get("SELECT total_load_kg, volume_kg, e1rm_kg, plates FROM v_set WHERE id = ?", id)!;

describe("log_set: a composition of mixed-unit plates", () => {
  it("a 20 kg bar with 10 kg + 5 lb per side: exact total, the bar from the implement, e1RM on the whole bar", async () => {
    const { x, bar, session } = await ready();
    const body = await x.ok("log_set", {
      session_id: session, exercise: "bench", reps: 6, rir: 0,
      load: { basis: "per_side", implement: bar, plates: [{ value: 10, unit: "kg" }, { value: 5, unit: "lb" }] },
    });
    const total = 20 + 2 * (10 + 5 * LB);
    expect(body.set.total_kg).toBeCloseTo(total, 9);
    expect(body.set.e1rm_kg).toBeCloseTo(total * 1.2, 9);
    expect(body.set).toMatchObject({ bar: { value: 20, unit: "kg" }, plates: [{ value: 10, unit: "kg", count: 1 }, { value: 5, unit: "lb", count: 1 }], state: "confirmed" });
    expect(body.snap).toMatchObject({ status: "on_list" });
    const v = view(x, body.set.id);
    expect(v.total_load_kg).toBeCloseTo(total, 9);
    expect(v.e1rm_kg).toBeCloseTo(body.set.e1rm_kg, 9);
    expect(JSON.parse(v.plates as string)).toEqual(body.set.plates);
  });

  it("plates on a sled of unknown weight: both sides' plates only", async () => {
    const { x, sled, session } = await ready();
    const body = await x.ok("log_set", {
      session_id: session, exercise: "Sled press", reps: 10, rir: 1,
      load: { basis: "per_side", implement: sled, plates: [{ value: 20, unit: "kg" }, { value: 2.5, unit: "lb", count: 2 }] },
    });
    expect(body.set.total_kg).toBeCloseTo(2 * (20 + 5 * LB), 9);
    expect(view(x, body.set.id).total_load_kg).toBeCloseTo(body.set.total_kg, 9);
  });

  it("a plate the gym doesn't have makes the set a draft offering to record the plates", async () => {
    const { x, bar, session } = await ready();
    const body = await x.ok("log_set", { session_id: session, exercise: "bench", reps: 6, rir: 2, load: { basis: "per_side", implement: bar, plates: [{ value: 2.5, unit: "kg" }] } });
    expect(body.set.state).toBe("draft");
    expect(body.snap).toMatchObject({ status: "off_list", mayExist: true });
    expect(body.offer).toMatchObject({ tool: "record_plates" });
  });

  it("a single per-side value on plate-loaded kit snaps onto a plate combination", async () => {
    const { x, bar, session } = await ready();
    const body = await x.ok("log_set", { session_id: session, exercise: "bench", reps: 6, rir: 2, load: { value: 15, unit: "kg", basis: "per_side", implement: bar } });
    expect(body.snap).toMatchObject({ status: "on_list", value: 15, unit: "kg", plates: [{ value: 10, unit: "kg", count: 1 }, { value: 5, unit: "kg", count: 1 }] });
  });

  it("plates only go with a per-side load", async () => {
    const { x, s, session } = await ready();
    const asked = await x.call("log_set", { session_id: session, exercise: "db curl", reps: 6, rir: 2, load: { basis: "per_hand", implement: s.dumbbells, plates: [{ value: 5, unit: "kg" }] } });
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "bar_only_per_side" });
  });
});

describe("amend: changing a composition recomputes it, and v_set agrees", () => {
  it("swaps a plate and keeps the stored per-side load equal to the plates", async () => {
    const { x, bar, session } = await ready();
    const { set } = await x.ok("log_set", { session_id: session, exercise: "bench", reps: 6, rir: 0, load: { basis: "per_side", implement: bar, plates: [{ value: 10, unit: "kg" }] } });
    const plates = JSON.stringify([{ value: 10, unit: "kg" }, { value: 2.5, unit: "lb" }]);
    const body = await x.ok("amend", { record: { table: "session_set", id: set.id }, changes: { plates }, reason: "a 2.5 lb plate was on too" });
    const total = 20 + 2 * (10 + 2.5 * LB);
    expect(body.computed.total_kg).toBeCloseTo(total, 9);
    expect(body.computed.e1rm_rir_kg).toBeCloseTo(total * 1.2, 9);
    expect(body.after).toMatchObject({ load_unit: "kg" });
    expect(body.after.load_value).toBeCloseTo(10 + 2.5 * LB, 9);
    expect(view(x, set.id).total_load_kg).toBeCloseTo(total, 9);
    expect(view(x, set.id).e1rm_kg).toBeCloseTo(body.computed.e1rm_kg, 9);
  });

  it("refuses plates that aren't plates", async () => {
    const { x, bar, session } = await ready();
    const { set } = await x.ok("log_set", { session_id: session, exercise: "bench", reps: 6, rir: 0, load: { basis: "per_side", implement: bar, plates: [{ value: 10, unit: "kg" }] } });
    const asked = await x.call("amend", { record: { table: "session_set", id: set.id }, changes: { plates: "[{\"value\": 10}]" }, reason: "typo" });
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "invalid_plates" });
  });
});

describe("record_plates and inventory", () => {
  it("records a gym's plates per unit, and the inventory shows plate-loaded kit as made from them", async () => {
    const { x, s, bar } = await ready();
    const inv = await x.ok("inventory", { gym: s.gym });
    expect(inv.plates).toEqual([
      { unit: "kg", complete: true, note: null, plates: [{ value: 2.5, status: "absent" }, { value: 5, status: "confirmed" }, { value: 10, status: "confirmed" }, { value: 20, status: "confirmed" }] },
      { unit: "lb", complete: false, note: null, plates: [{ value: 2.5, status: "confirmed" }, { value: 5, status: "confirmed" }] },
    ]);
    const loadable = inv.implements.find((i: { id: number }) => i.id === bar);
    expect(loadable).toMatchObject({ loads: null, bar: { value: 20, unit: "kg" }, plates: { complete: false } });
  });

  it("refuses a plate listed both ways", async () => {
    const { x, s } = await ready();
    const asked = await x.call("record_plates", { gym: s.gym, unit: "kg", available: [1.25], absent: [1.25] });
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "plate_both_ways" });
  });

  it("points plate-loaded kit at record_plates instead of a load list", async () => {
    const { x, bar } = await ready();
    const asked = await x.call("add_implement_load", { implement_id: bar, loads: [25] });
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "plates_loaded", use: "record_plates" });
  });
});
