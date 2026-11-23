// inventory_gaps: what isn't known yet at a member's gym, prioritised by the
// prescriptions coming up next, so the agent asks one small chunk a session.
import { describe, expect, it } from "vitest";
import { setup } from "./harness";
import { seedTraining } from "./seed";

const MONDAY = "2026-10-05";

async function ready() {
  const x = setup();
  const s = seedTraining(x);
  const { t, h } = x;
  const sled = t.insert("implement", { gym_id: s.gym, name: "Sled", kind: "plate_loaded", unit: "kg", loading: "plates_only", load_list_complete: 0 });
  const legCurl = t.insert("implement", { gym_id: s.gym, name: "Leg curl stack", kind: "machine", unit: "kg", loading: "total", load_list_complete: 0 });
  for (const load of [20, 25, 30]) t.insert("implement_load", { implement_id: legCurl, load, unit: "kg" });
  const press = t.insert("exercise", { household_id: h.id, name: "Sled press", implement_kind: "plate_loaded" });
  const curl = t.insert("exercise", { household_id: h.id, name: "Leg curl", implement_kind: "machine" });
  const programme = t.insert("programme", { member_id: h.hritvik, name: "Base", schedule_kind: "weekday", active: 1, started_on: "2026-09-01" });
  const upper = t.insert("session_template", { programme_id: programme, name: "Upper A", session_type: "strength" });
  const lower = t.insert("session_template", { programme_id: programme, name: "Lower A", session_type: "strength" });
  t.insert("schedule_slot", { programme_id: programme, weekday: 1, template_id: upper });
  t.insert("schedule_slot", { programme_id: programme, weekday: 2, template_id: lower });
  t.insert("prescription", { template_id: upper, position: 1, exercise_id: s.pulldown, sets: 3, rep_low: 8, rep_high: 12, load_value: 40, load_unit: "kg", load_basis: "total", load_implement_id: s.stack });
  t.insert("prescription", { template_id: lower, position: 1, exercise_id: curl, sets: 3, rep_low: 8, rep_high: 12, load_value: 25, load_unit: "kg", load_basis: "total", load_implement_id: legCurl });
  t.insert("prescription", { template_id: lower, position: 2, exercise_id: press, sets: 3, rep_low: 8, rep_high: 12, load_value: 20, load_unit: "kg", load_basis: "per_side" });
  await x.ok("record_plates", { gym: s.gym, unit: "lb", available: [5, 10], complete: false });
  return { x, s, sled, legCurl };
}

describe("inventory_gaps", () => {
  it("lists what is unknown, the next session's needs first, and offers one chunk to ask", async () => {
    const { x, s, sled, legCurl } = await ready();
    // Tuesday: Lower A is next (the leg curl, then the sled press).
    const body = await x.ok("inventory_gaps", { member: "Hritvik", date: "2026-10-06" });
    expect(body.next_session).toBe("Lower A");
    expect(body.gaps.map((g: { kind: string; implement_id: number | null }) => [g.kind, g.implement_id])).toEqual([
      ["stack_top", legCurl],
      ["sled_weight", sled],
      ["plate_denominations", null],
      // Nothing coming up uses these: the seeded barbell's weight and the fixed bars' top.
      ["bar_weight", s.barbell],
      ["rack_end", s.fixedBars],
    ]);
    expect(body.gaps[0].for_prescriptions).toEqual([expect.objectContaining({ exercise: "Leg curl", next_session: true })]);
    expect(body.gaps[2]).toMatchObject({ unit: "lb", unknown: [2.5, 25, 35, 45] });
    expect(body.ask).toEqual(body.gaps[0]);
  });

  it("a gap closes once it is recorded", async () => {
    const { x, s } = await ready();
    await x.ok("record_plates", { gym: s.gym, unit: "lb", available: [2.5, 25, 35, 45], complete: true });
    const body = await x.ok("inventory_gaps", { member: "Hritvik", date: MONDAY });
    expect(body.gaps.map((g: { kind: string }) => g.kind)).not.toContain("plate_denominations");
  });

  it("a bar or sled weight is recorded with amend on the implement", async () => {
    const { x, sled } = await ready();
    await x.ok("amend", { record: { table: "implement", id: sled }, changes: { bar_value: 25, bar_unit: "kg" }, reason: "the sled is marked 25 kg" });
    const body = await x.ok("inventory_gaps", { member: "Hritvik", date: MONDAY });
    expect(body.gaps.map((g: { kind: string }) => g.kind)).not.toContain("sled_weight");
  });

  it("a member without a home gym has no gaps", async () => {
    const { x } = await ready();
    const body = await x.ok("inventory_gaps", { member: "Kabir", date: MONDAY });
    expect(body).toMatchObject({ gaps: [], ask: null });
  });
});
