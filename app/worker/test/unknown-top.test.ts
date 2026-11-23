// An implement whose top is unknown: when the next load would go above the
// highest known load, check_progression proposes the next normal step marked
// unverified ("check it exists") instead of "never", with what to call once
// the member has checked; programme_change accepts it; next_prescription
// marks it; add_implement_load / remove_implement_load settle it.
import { describe, expect, it } from "vitest";
import { setup, type Harness } from "./harness";
import { seedTraining } from "./seed";

const MONDAY = "2026-10-05";
const DAY = "2026-10-05";

async function ready() {
  const x = setup();
  const s = seedTraining(x);
  // A cable stack whose top is unknown: 30, 35, 40 kg known.
  const row = x.t.insert("implement", { gym_id: s.gym, name: "Row stack", kind: "cable", unit: "kg", loading: "total", load_list_complete: 0 });
  for (const load of [30, 35, 40]) x.t.insert("implement_load", { implement_id: row, load, unit: "kg" });
  const exercise = x.t.insert("exercise", { household_id: x.h.id, name: "Cable row", implement_kind: "cable" });
  const programme = x.t.insert("programme", { member_id: x.h.hritvik, name: "Base", schedule_kind: "weekday", active: 1, started_on: "2026-09-01" });
  const upper = x.t.insert("session_template", { programme_id: programme, name: "Upper A", session_type: "strength" });
  x.t.insert("schedule_slot", { programme_id: programme, weekday: 1, template_id: upper });
  const p = x.t.insert("prescription", {
    template_id: upper, position: 1, exercise_id: exercise, sets: 3, rep_low: 10, rep_high: 12, rir_target_low: 1, rir_target_high: 2,
    load_value: 40, load_unit: "kg", load_basis: "total", load_implement_id: row,
    progression_rule: JSON.stringify({ kind: "rep_top", target_sets: 3, rep_top: 12, rir_floor: 1, increment: "smallest_step" }),
  });
  return { x, s, row, p };
}

async function topSets(x: Harness, row: number) {
  const session = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper A" })).session.id;
  for (let i = 0; i < 3; i++) await x.ok("log_set", { session_id: session, exercise: "Cable row", reps: 12, rir: 2, load: { value: 40, unit: "kg", basis: "total", implement: row } });
}

describe("check_progression above an unknown top", () => {
  it("proposes the next normal step, unverified, with what to record either way", async () => {
    const { x, row, p } = await ready();
    await topSets(x, row);
    const body = await x.ok("check_progression", { prescription_id: p });
    expect(body).toMatchObject({ verdict: "fired", nextLoad: 45, nextLoadUnit: "kg", unverified: true });
    expect(body.message).toContain("check it exists");
    expect(body.offer).toEqual({
      if_exists: { tool: "add_implement_load", implement_id: row, loads: [{ value: 45, unit: "kg" }] },
      if_not: { tool: "remove_implement_load", implement_id: row, loads: [{ value: 45, unit: "kg" }] },
    });
  });

  it("once the step is confirmed in use and recorded, it is an ordinary step", async () => {
    const { x, row, p } = await ready();
    await topSets(x, row);
    await x.ok("add_implement_load", { implement_id: row, loads: [45] });
    const body = await x.ok("check_progression", { prescription_id: p });
    expect(body).toMatchObject({ verdict: "fired", nextLoad: 45 });
    expect(body).not.toHaveProperty("unverified");
  });

  it("once the step is recorded as absent, the next one is proposed", async () => {
    const { x, row, p } = await ready();
    await topSets(x, row);
    await x.ok("remove_implement_load", { implement_id: row, loads: [45], reason: "the stack stops at 40 plus a 50 pin" });
    const body = await x.ok("check_progression", { prescription_id: p });
    expect(body).toMatchObject({ nextLoad: 50, unverified: true });
  });
});

describe("programme_change and next_prescription with an unverified load", () => {
  it("accepts a load above the unknown top, marked unverified, and next_prescription says so", async () => {
    const { x, p } = await ready();
    const change = await x.ok("programme_change", { member: "Hritvik", change: { kind: "load_change", prescription_id: p, date: DAY, load: { value: 45, unit: "kg", basis: "total" }, reason: "progression fired" } });
    expect(change.load_change).toMatchObject({ current: { value: 45, unit: "kg" }, unverified: true });
    const next = await x.ok("next_prescription", { member: "Hritvik", date: DAY });
    expect(next.prescriptions[0].load).toMatchObject({ value: 45, unverified: true, snap: { status: "off_list", mayExist: true } });
  });

  it("a load on the list is not unverified", async () => {
    const { x } = await ready();
    const next = await x.ok("next_prescription", { member: "Hritvik", date: DAY });
    expect(next.prescriptions[0].load).toMatchObject({ value: 40, unverified: false });
  });
});
