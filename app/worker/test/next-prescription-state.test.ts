// next_prescription rows carry check_progression's answer and the chip state,
// the same object needs_you reads.
import { describe, expect, it } from "vitest";
import { setup, type Harness } from "./harness";
import { seedTraining } from "./seed";

const MONDAY = "2026-10-05";
const NEXT_MONDAY = "2026-10-12";
const rir = (low: number, high = low) => ({ low, high });

/** Upper A on Mondays: bench (no sets yet), pulldown (5 kg step on a full stack), curl (1 kg step the rack can't make), row (unknown top). */
function seed(x: Harness, s: ReturnType<typeof seedTraining> = seedTraining(x)) {
  const { t, h } = x;
  const row = t.insert("implement", { gym_id: s.gym, name: "Row stack", kind: "cable", unit: "kg", loading: "total", load_list_complete: 0 });
  for (const load of [30, 35, 40]) t.insert("implement_load", { implement_id: row, load, unit: "kg" });
  const cableRow = t.insert("exercise", { household_id: h.id, name: "Cable row", implement_kind: "cable" });
  const programme = t.insert("programme", { member_id: h.hritvik, name: "Base", schedule_kind: "weekday", active: 1, started_on: "2026-09-01" });
  const upper = t.insert("session_template", { programme_id: programme, name: "Upper A", session_type: "strength" });
  t.insert("schedule_slot", { programme_id: programme, weekday: 1, template_id: upper });
  const rule = (o: object) => JSON.stringify({ kind: "rep_top", ...o });
  const common = { template_id: upper, rir_target_low: 1, rir_target_high: 2 };
  t.insert("prescription", { ...common, position: 1, exercise_id: s.bench, sets: 3, rep_low: 8, rep_high: 12, load_value: 12.5, load_unit: "lb", load_basis: "per_side", load_implement_id: s.barbell, progression_rule: rule({ target_sets: 3, rep_top: 12, rir_floor: 1, increment: { min: 2.5 } }) });
  t.insert("prescription", { ...common, position: 2, exercise_id: s.pulldown, sets: 3, rep_low: 10, rep_high: 12, load_value: 40, load_unit: "kg", load_basis: "total", load_implement_id: s.stack, progression_rule: rule({ target_sets: 3, rep_top: 12, rir_floor: 1, increment: { min: 5 } }) });
  t.insert("prescription", { ...common, position: 3, exercise_id: s.curl, sets: 2, rep_low: 10, rep_high: 15, load_value: 10, load_unit: "kg", load_basis: "per_hand", load_implement_id: s.dumbbells, progression_rule: rule({ target_sets: 2, rep_top: 15, rir_floor: 1, increment: { min: 1, max: 1 } }) });
  t.insert("prescription", { ...common, position: 4, exercise_id: cableRow, sets: 3, rep_low: 10, rep_high: 12, load_value: 40, load_unit: "kg", load_basis: "total", load_implement_id: row, progression_rule: rule({ target_sets: 3, rep_top: 12, rir_floor: 1, increment: "smallest_step" }) });
  return { s, row };
}

async function trainToday(x: Harness, s: ReturnType<typeof seedTraining>, row: number, inferredPulldowns = false) {
  const session = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper A" })).session.id;
  for (let i = 0; i < 3; i++) {
    await x.ok("log_set", { session_id: session, exercise: "lat pulldown", reps: 12, reps_inferred: inferredPulldowns && i > 0, rir: rir(1, 2), load: { value: 40, unit: "kg", basis: "total", implement: s.stack } });
    await x.ok("log_set", { session_id: session, exercise: "Cable row", reps: 12, rir: rir(2), load: { value: 40, unit: "kg", basis: "total", implement: row } });
  }
}

const byExercise = (body: { prescriptions: { exercise: string }[] }) => Object.fromEntries(body.prescriptions.map((p) => [p.exercise, p]));

describe("next_prescription progression and state", () => {
  it("maps each prescription to its chip, with the progression check beside it", async () => {
    const x = setup();
    const { s, row } = seed(x);
    await trainToday(x, s, row);
    const body = await x.ok("next_prescription", { member: "Hritvik", date: NEXT_MONDAY });
    expect(body.session).toBe("Upper A");
    const p = byExercise(body);
    expect(p["Cable lat pulldown"]).toMatchObject({ progression: { verdict: "fired", nextLoad: 45 }, state: { kind: "ready", next_load: { value: 45, unit: "kg" } } });
    expect(p["Barbell bench press"]).toMatchObject({ progression: { verdict: "not_yet" }, state: { kind: "holding" } });
    expect(p["Dumbbell curl"]).toMatchObject({ progression: { verdict: "never", reason: "increment_not_on_implement" }, state: { kind: "cant_move" } });
    expect(p["Cable row"]).toMatchObject({ state: { kind: "check_at_gym", question: "Is there a 45 kg on the Row stack?", next_load: { value: 45, unit: "kg" } } });
    // Every field the skills read today is still there.
    expect(p["Cable lat pulldown"]).toHaveProperty("load.snap");
    expect(p["Cable lat pulldown"]).toHaveProperty("fallbacks");
  });

  it("names the sets to confirm when reps were inferred", async () => {
    const x = setup();
    const { s, row } = seed(x);
    await trainToday(x, s, row, true);
    const body = await x.ok("next_prescription", { member: "Hritvik", date: NEXT_MONDAY });
    const pulldown = byExercise(body)["Cable lat pulldown"] as unknown as { state: { kind: string; set_ids: number[] }; progression: { confirm_set_ids: number[] } };
    expect(pulldown.state.kind).toBe("needs_confirmation");
    expect(pulldown.state.set_ids).toEqual(pulldown.progression.confirm_set_ids);
    expect(pulldown.state.set_ids).toHaveLength(2);
  });

  it("is the same state needs_you reports", async () => {
    const x = setup();
    const { s, row } = seed(x);
    await trainToday(x, s, row);
    const next = await x.ok("next_prescription", { member: "Hritvik", date: NEXT_MONDAY });
    const needs = await x.ok("needs_you", { member: "Hritvik", date: NEXT_MONDAY }, "hritvik");
    const load = [...needs.cards, ...needs.more].find((c: { rule: string }) => c.rule === "load");
    for (const p of load.prescriptions) {
      expect(p.state).toEqual(next.prescriptions.find((r: { prescription_id: number }) => r.prescription_id === p.prescription_id).state);
    }
    expect(load.prescriptions.map((p: { exercise: string }) => p.exercise)).toEqual(["Cable lat pulldown", "Cable row"]);
  });

});
