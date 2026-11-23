// e1RM on bodyweight-dominant exercises: the domain (through log_set) and
// v_set (through query) must agree, set for set.
import { describe, expect, it } from "vitest";
import { setup, type Harness } from "./harness";
import { seedTraining } from "./seed";

const MONDAY = "2026-10-05";

async function ready() {
  const x = setup();
  const s = seedTraining(x);
  const goblet = x.t.insert("exercise", { household_id: x.h.id, name: "Goblet squat", implement_kind: "dumbbell" });
  const session = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength" })).session.id;
  return { x, s, goblet, session };
}

const db = (s: ReturnType<typeof seedTraining>, value: number) => ({ value, unit: "kg", basis: "total", implement: s.dumbbells });

async function flag(x: Harness, id: number, on = true) {
  return x.ok("amend", { record: { table: "exercise", id }, changes: { bodyweight_dominant: on }, reason: "the dumbbell is a fraction of what moves" });
}

describe("bodyweight-dominant exercises", () => {
  it("an exercise is flagged with amend, and its sets get no e1RM while keeping their volume", async () => {
    const { x, s, goblet, session } = await ready();
    const flagged = await flag(x, goblet);
    expect(flagged.after).toMatchObject({ name: "Goblet squat", bodyweight_dominant: 1 });
    const body = await x.ok("log_set", { session_id: session, exercise: "Goblet squat", reps: 8, rir: 0, load: db(s, 10) });
    expect(body.set).toMatchObject({ total_kg: 10, volume_kg: 80, e1rm_kg: null });
  });

  it("lift_history leaves it out of the best e1RM", async () => {
    const { x, s, goblet, session } = await ready();
    await flag(x, goblet);
    await x.ok("log_set", { session_id: session, exercise: "Goblet squat", reps: 8, rir: 0, load: db(s, 10) });
    const body = await x.ok("lift_history", { member: "Hritvik", pattern: "goblet" });
    expect(body.exercises[0]).toMatchObject({ exercise: "Goblet squat", best_e1rm_kg: null });
  });

  it("v_set agrees with the domain on every set, flagged or not", async () => {
    const { x, s, goblet, session } = await ready();
    await flag(x, goblet);
    const cases = [
      { exercise: "Goblet squat", reps: 8, rir: 0, load: db(s, 10) },
      { exercise: "Goblet squat", reps: 12, rir: 0, load: db(s, 20) },
      { exercise: "Goblet squat", reps: 8, rir: 2, load: db(s, 10) },
      { exercise: "Dumbbell curl", reps: 8, rir: 0, load: { ...db(s, 10), basis: "per_hand" } },
      { exercise: "Dumbbell curl", reps: 13, rir: 0, load: { ...db(s, 10), basis: "per_hand" } },
      { exercise: "Push-up", reps: 15, rir: 0, load: "none" },
    ];
    for (const c of cases) {
      const { set } = await x.ok("log_set", { session_id: session, ...c });
      const view = x.t.get("SELECT total_load_kg, volume_kg, e1rm_kg FROM v_set WHERE id = ?", set.id)!;
      const pair = { domain: [set.volume_kg, set.e1rm_kg], view: [view.volume_kg, view.e1rm_kg] };
      expect(pair.view.map((v) => (v === null ? null : Number((v as number).toFixed(9)))), JSON.stringify(c))
        .toEqual(pair.domain.map((v) => (v === null ? null : Number((v as number).toFixed(9)))));
    }
    expect(x.t.get("SELECT count(*) AS n FROM v_set WHERE e1rm_kg IS NOT NULL")).toEqual({ n: 1 });
  });

  it("unflagging it brings the e1RM back, in both", async () => {
    const { x, s, goblet, session } = await ready();
    await flag(x, goblet);
    const { set } = await x.ok("log_set", { session_id: session, exercise: "Goblet squat", reps: 6, rir: 0, load: db(s, 15) });
    await flag(x, goblet, false);
    const amended = await x.ok("amend", { record: { table: "session_set", id: set.id }, changes: { note: "re-checked" }, reason: "re-check" });
    expect(amended.computed.e1rm_kg).toBeCloseTo(18, 9);
    expect(x.t.get("SELECT e1rm_kg FROM v_set WHERE id = ?", set.id)!.e1rm_kg).toBeCloseTo(18, 9);
  });
});
