// The equipment inventory of a prescribed member's gym, read from the
// Guide's gym notes, the Program's equipment remarks and what was lifted.
// Every implement is a ruling with its proposal. Invented values only.
import { describe, expect, it } from "vitest";
import { rehearse } from "../src/rehearse";
import { basePeople, LOG_HEADER, members, PROGRAM_HEADER, set, snapshot } from "./fixture";

const D1 = 46240; // 2026-08-06

const guide = [
  ["GUIDE", "All prose lives here."],
  [],
  ["Section", "Item", "Detail"],
  ["EQUIPMENT REALITY", "Barbell", "20 kg Olympic, loadable. PLATES ARE POUNDS. 2.5 lb plates confirmed."],
  ["", "Pre-weighted fixed bars", "Available; the rack goes 15 kg then 25 kg. Top of the rack NOT established."],
  ["ALSO KNOWN", "Sport", "Plays tennis."],
];

const program = [
  PROGRAM_HEADER,
  ["Upper A", 1, "Incline Barbell Press", "Press", 3, "8-10", 2, "90s", 12.5, "lb", "per side", "", "Add 2.5 lb per side when 3x10", "Bar + 12.5 lb/side; tried 15 lb/side once.", "", ""],
  ["Upper A", 2, "Shoulder Press Machine", "Press", 3, "10-12", 2, "90s", 25, "kg", "total", "", "Add 5kg when 3x12 - THIS MACHINE STEPS IN 5 kg", "", "", ""],
  ["Upper A", 3, "Seated Leg Curl", "Hams", 3, "10-12", 1, "60s", 41, "kg", "total", "", "", "STACK MEASURED: 6 kg INCREMENTS FROM 35 kg UPWARD (35, 41, 47).", "", ""],
  ["Upper A", 4, "Lateral Raise", "Delts", 3, "12-15", 1, "45s", 5, "kg", "per hand", "", "", "kg rack runs 5/7.5/10; lb rack 5/10/15/20...; 12.5 kg dumbbells do not exist here", "", ""],
  ["Upper A", 5, "Hack Squat", "Quads", 3, "8-10", 2, "90s", 10, "kg", "per side", "", "", "Plate load per side; sled unmarked; the gym has no 1.25 kg plate.", "", ""],
];

const log = [
  LOG_HEADER,
  set({ date: D1, session: "Upper A", exercise: "Shoulder Press Machine", set: 1, reps: 12, rir: 2, weight: 20, total: 20 }),
  set({ date: D1, session: "Upper A", exercise: "Shoulder Press Machine", set: 2, reps: 10, rir: 1, weight: 22.5, total: 22.5 }),
  set({ date: D1, session: "Upper A", exercise: "Seated Leg Curl", set: 1, reps: 12, rir: 1, weight: 29, total: 29 }),
  set({ date: D1, session: "Upper A", exercise: "Hack Squat", set: 1, reps: 10, rir: 2, weight: 10, basis: "per side", total: 20 }),
  set({ date: D1, session: "Upper A", exercise: "Hack Squat", set: 2, reps: 10, rir: 2, weight: 7.94, basis: "per side", total: 15.88 }),
];

function run() {
  return rehearse({ snapshot: snapshot({ base: { People: basePeople(), Guide: guide }, hritvik: { Program: program, Log: log } } as never), members: members() });
}

describe("gym inventory", () => {
  it("builds the dumbbell racks, the fixed bars and a stack per machine with loads in their own units; barbells and sleds list none", async () => {
    const r = await run();
    const rows = r.db.all<{ name: string; kind: string; unit: string; loading: string; complete: number; bar: string | null; loads: string | null; absent: string | null }>(
      "SELECT name, kind, unit, loading, load_list_complete AS complete, bar_value || ' ' || bar_unit AS bar, loads, absent_loads AS absent FROM v_implement ORDER BY id",
    );
    expect(rows).toEqual([
      { name: "Dumbbells (kg)", kind: "dumbbell", unit: "kg", loading: "total", complete: 1, bar: null, loads: "5.0 kg, 7.5 kg, 10.0 kg", absent: "12.5 kg" },
      { name: "Dumbbells (lb)", kind: "dumbbell", unit: "lb", loading: "total", complete: 0, bar: null, loads: "5.0 lb, 10.0 lb, 15.0 lb, 20.0 lb", absent: null },
      { name: "Loadable barbell", kind: "barbell", unit: "kg", loading: "per_side", complete: 0, bar: "20.0 kg", loads: null, absent: null },
      { name: "Fixed bars", kind: "fixed_bar", unit: "kg", loading: "total", complete: 0, bar: null, loads: "15.0 kg, 25.0 kg", absent: null },
      { name: "Shoulder Press Machine (machine stack)", kind: "machine", unit: "kg", loading: "total", complete: 0, bar: null, loads: "5.0 kg, 10.0 kg, 15.0 kg, 20.0 kg, 25.0 kg", absent: null },
      { name: "Seated Leg Curl (machine stack)", kind: "machine", unit: "kg", loading: "total", complete: 0, bar: null, loads: "29.0 kg, 35.0 kg, 41.0 kg, 47.0 kg", absent: null },
      { name: "Hack Squat (plates per side)", kind: "plate_loaded", unit: "kg", loading: "plates_only", complete: 0, bar: null, loads: null, absent: null },
    ]);
  });

  it("infers the gym's plates from what was lifted on plate-loaded kit, never all known", async () => {
    const r = await run();
    // 10 kg a side; 7.94 kg a side is 17.5 lb (10 + 5 + 2.5); the Guide confirms 2.5 lb plates; a note rules out 1.25 kg.
    expect(r.db.all("SELECT unit, complete, value, status FROM v_plate ORDER BY unit, value")).toEqual([
      { unit: "kg", complete: 0, value: 1.25, status: "absent" },
      { unit: "kg", complete: 0, value: 10, status: "inferred" },
      { unit: "lb", complete: 0, value: 2.5, status: "confirmed" },
      { unit: "lb", complete: 0, value: 5, status: "inferred" },
      { unit: "lb", complete: 0, value: 10, status: "inferred" },
    ]);
  });

  it("raises every implement as a pending ruling, names loads it left out, and links prescriptions on the list or plate-loaded", async () => {
    const r = await run();
    const inv = r.rulings.filter((x) => x.code === "implement_inventory");
    expect(inv.map((x) => x.decision)).toEqual(Array(7).fill("pending"));
    const machine = inv.find((x) => x.id.endsWith("/shoulder_press_machine_machine_stack"));
    expect(machine?.problem).toContain("22.5");
    const linked = r.db.all("SELECT e.name, i.name AS implement FROM prescription p JOIN exercise e ON e.id = p.exercise_id JOIN implement i ON i.id = p.load_implement_id ORDER BY p.position");
    expect(linked).toEqual([
      { name: "Incline Barbell Press", implement: "Loadable barbell" },
      { name: "Shoulder Press Machine", implement: "Shoulder Press Machine (machine stack)" },
      { name: "Seated Leg Curl", implement: "Seated Leg Curl (machine stack)" },
      { name: "Lateral Raise", implement: "Dumbbells (kg)" },
      { name: "Hack Squat", implement: "Hack Squat (plates per side)" },
    ]);
  });

  it("applies a ruling's mixed_units / top directives to the proposal", async () => {
    const first = await run();
    const kgRack = first.rulings.find((x) => x.id.endsWith("/dumbbells_kg"))!;
    const again = await rehearse({
      snapshot: snapshot({ base: { People: basePeople(), Guide: guide }, hritvik: { Program: program, Log: log } } as never),
      members: members(),
      previousRulings: [{ ...kgRack, decision: "accepted", decided_by: "test", override: { mixed_units: true, top: "unknown, filled on the go" } }],
    });
    expect(again.db.get("SELECT load_list_complete AS complete, loads FROM v_implement WHERE name = 'Dumbbells (kg)'")).toEqual({ complete: 0, loads: "5.0 kg, 7.5 kg, 10.0 kg" });
  });

  it("leaves the logged sets as they were: no implement, no snapping", async () => {
    const r = await run();
    expect(r.db.get("SELECT count(*) AS n FROM session_set WHERE load_implement_id IS NOT NULL OR state <> 'confirmed'")).toEqual({ n: 0 });
  });
});
