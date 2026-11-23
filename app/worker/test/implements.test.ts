// Gym inventories at import (create_implement), and log_set choosing the
// implement a set's prescription names when the gym has several of a kind.
import { describe, expect, it } from "vitest";
import { importWrite } from "../src/importing";
import { setup, type Harness } from "./harness";

const AT = "2026-10-05T07:00:00Z";
let row = 0;
const meta = () => ({ at: AT, origin: { file: "hritvik", tab: "Guide", row: ++row } });

async function ok(x: Harness, tool: string, input: Record<string, unknown>) {
  const r = await importWrite(x.db, tool, input, meta());
  if (r.status !== "ok") throw new Error(`${tool}: ${JSON.stringify(r)}`);
  return r;
}

async function ready() {
  const x = setup();
  await ok(x, "create_gym", { name: "Test gym", home_of: ["Hritvik"] });
  await ok(x, "create_exercise", { name: "Curl", implement_kind: "dumbbell" });
  await ok(x, "create_exercise", { name: "Row machine", implement_kind: "machine" });
  await ok(x, "create_programme", {
    member: "Hritvik", name: "P", schedule_kind: "rotation", started_on: "2026-09-01",
    templates: [{ name: "Upper", session_type: "strength", prescriptions: [
      { exercise: "Curl", sets: 3, rep_low: 8, rep_high: 12, rir_target_low: 1, rir_target_high: 2, load: { value: 20, unit: "lb", basis: "per_hand" } },
      { exercise: "Row machine", sets: 3, rep_low: 8, rep_high: 12, rir_target_low: 1, rir_target_high: 2, load: { value: 40, unit: "kg", basis: "total" } },
    ] }],
    slots: [{ rotation_position: 1, template: "Upper" }],
  });
  return x;
}

describe("create_implement", () => {
  it("creates an implement with its loads and maximum flag, linking the prescriptions named", async () => {
    const x = await ready();
    const curl = x.t.get("SELECT id FROM prescription WHERE position = 1")!.id as number;
    const r = await ok(x, "create_implement", {
      gym: "Test gym", name: "Dumbbells (lb)", kind: "dumbbell", unit: "lb", loading: "total", loads: [5, 10, 15, 20, 25],
      load_list_complete: false, note: "Heavier pairs not checked.", link_prescriptions: [curl],
    });
    expect(r.implement).toMatchObject({ name: "Dumbbells (lb)", loads: [5, 10, 15, 20, 25].map((value) => ({ value, unit: "lb" })), load_list_complete: false, linked_prescriptions: [curl] });
    expect(x.t.get("SELECT load_implement_id FROM prescription WHERE id = ?", curl)).toEqual({ load_implement_id: (r.implement as { id: number }).id });
    const inv = await x.ok("inventory", { member: "Hritvik" });
    expect(inv.implements[0]).toMatchObject({ name: "Dumbbells (lb)", unit: "lb", load_list_complete: false, loads: [5, 10, 15, 20, 25].map((value) => ({ value, unit: "lb" })) });
  });

  it("refuses to link a prescription at another gym's member or of another kind", async () => {
    const x = await ready();
    const row = x.t.get("SELECT id FROM prescription WHERE position = 2")!.id as number;
    const r = await importWrite(x.db, "create_implement", { gym: "Test gym", name: "Dumbbells (kg)", kind: "dumbbell", unit: "kg", loading: "total", loads: [5, 10], link_prescriptions: [row] }, meta());
    expect(r).toMatchObject({ status: "needs_clarification", reason: "link_kind_mismatch" });
  });
});

describe("log_set picks the prescription's implement", () => {
  it("uses the implement the set's prescription is linked to when the gym has several of the kind", async () => {
    const x = await ready();
    const curl = x.t.get("SELECT id FROM prescription WHERE position = 1")!.id as number;
    await ok(x, "create_implement", { gym: "Test gym", name: "Dumbbells (kg)", kind: "dumbbell", unit: "kg", loading: "total", loads: [5, 7.5, 10] });
    await ok(x, "create_implement", { gym: "Test gym", name: "Dumbbells (lb)", kind: "dumbbell", unit: "lb", loading: "total", loads: [10, 15, 20], link_prescriptions: [curl] });
    const session = (await x.ok("start_session", { member: "Hritvik", date: "2026-10-05", session_type: "strength", template: "Upper" })).session.id;
    const body = await x.ok("log_set", { session_id: session, exercise: "Curl", reps: 10, rir: 2, load: { value: 20, unit: "lb", basis: "per_hand" } });
    expect(body.set.implement).toBe("Dumbbells (lb)");
    expect(body.snap).toMatchObject({ status: "on_list" });
  });
});
