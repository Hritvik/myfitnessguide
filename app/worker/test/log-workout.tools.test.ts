// log_workout: a whole session's sets in one atomic, idempotent write, with
// each linked prescription's progression state checked against them.
import { describe, expect, it } from "vitest";
import { toolWithinBudget } from "./budget";
import { setup } from "./harness";
import { bar20, busyInput, MONDAY, seedUpperA } from "./input-seed";
import { seedTraining } from "./seed";

async function ready() {
  const x = setup();
  const s = seedTraining(x);
  const p = seedUpperA(x, s);
  return { x, s, p };
}

const bench = (reps: number, rir = 2) => ({ exercise: "bench", reps, rir, load: { value: 12.5, unit: "lb", basis: "per_side", bar: bar20 } });
const pulldown = (reps: number, rir = 2) => ({ exercise: "lat pulldown", reps, rir, load: { value: 40, unit: "kg", basis: "total" } });
const curl = (reps: number, rir = 2) => ({ exercise: "db curl", reps, rir, load: { value: 10, unit: "kg", basis: "per_hand" } });
const upperA = () => [bench(10), bench(10), bench(9), pulldown(12), pulldown(12), pulldown(12), curl(12), curl(11)];
/** check_progression's answer without its envelope: the progression log_workout returns. */
const asChecked = ({ status: _s, prescription_id: _p, exercise: _e, ...rest }: Record<string, unknown>) => rest;
const count = (x: Awaited<ReturnType<typeof ready>>["x"], table: string) => (x.t.get(`SELECT count(*) AS n FROM ${table}`)?.n as number);

describe("log_workout", () => {
  it("logs the next programme session in one write: one session from its template, linked sets numbered per exercise", async () => {
    const { x, p } = await ready();
    const batches = x.db.batches;
    const body = await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "programme" }, sets: upperA() });
    expect(x.db.batches).toBe(batches + 1);
    expect(body.session).toMatchObject({ created: true, template: "Upper A", workout: null, state: "confirmed" });
    expect(body.sets.map((s: { set: { exercise: string; set_number: number; position: number; prescription_id: number } }) => [s.set.exercise, s.set.set_number, s.set.position, s.set.prescription_id])).toEqual([
      ["Barbell bench press", 1, 1, p.bench], ["Barbell bench press", 2, 2, p.bench], ["Barbell bench press", 3, 3, p.bench],
      ["Cable lat pulldown", 1, 4, p.pulldown], ["Cable lat pulldown", 2, 5, p.pulldown], ["Cable lat pulldown", 3, 6, p.pulldown],
      ["Dumbbell curl", 1, 7, p.curl], ["Dumbbell curl", 2, 8, p.curl],
    ]);
    expect(count(x, "session_set")).toBe(8);
  });

  it("returns each lift's progression state checked against these sets", async () => {
    const { x, p } = await ready();
    const body = await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "programme" }, sets: upperA() });
    const state = (id: number) => body.progression.find((r: { prescription_id: number }) => r.prescription_id === id);
    expect(state(p.pulldown)).toMatchObject({ exercise: "Cable lat pulldown", state: { kind: "ready", next_load: { value: 45, unit: "kg" } } });
    expect(state(p.bench)).toMatchObject({ state: { kind: "holding" } });
    expect(state(p.curl).progression.verdict).toBe("not_yet");
  });

  it("is idempotent: the same key replays the first answer and writes nothing more", async () => {
    const { x } = await ready();
    const input = { member: "Hritvik", date: MONDAY, source: { kind: "programme" }, sets: upperA(), idempotency_key: "w-1" };
    const first = await x.call("log_workout", input);
    const again = await x.call("log_workout", input);
    expect(again.body).toEqual(first.body);
    expect(count(x, "session")).toBe(1);
    expect(count(x, "session_set")).toBe(8);
  });

  it("is atomic: a question on the thirteenth set writes nothing", async () => {
    const { x } = await ready();
    const sets = [...upperA(), bench(8), bench(8), pulldown(10), curl(10), { ...curl(10), exercise: "zercher thing" }];
    const reply = await x.call("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "programme" }, sets });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "unknown_exercise", path: ["sets", 12, "exercise"] });
    expect(count(x, "session")).toBe(0);
    expect(count(x, "session_set")).toBe(0);
  });

  it("needs RIR on a prescribed member's own working sets, at the set's path", async () => {
    const { x } = await ready();
    const reply = await x.call("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "programme" }, sets: [bench(10), { ...bench(10), rir: undefined }] });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "rir_needed", path: ["sets", 1, "rir"] });
  });

  it("asks RIR only of counted reps: a timed or measured working set confirms without it, as not recorded (click test P2-13)", async () => {
    const { x } = await ready();
    const body = await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "none" }, sets: [
      { exercise: "pushups", duration_s: 45, load: "none" },
      { exercise: "pushups", distance: { value: 20, unit: "m" }, load: "none" },
    ] });
    expect(body.sets.map((s: { set: { rir: unknown; state: string; duration_s: number | null } }) => [s.set.rir, s.set.state])).toEqual([["not_recorded", "confirmed"], ["not_recorded", "confirmed"]]);
    // A set with reps still needs it, and a given RIR on a timed set is kept.
    const reps = await x.call("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "none" }, sets: [{ exercise: "pushups", reps: 12, duration_s: 40, load: "none" }] });
    expect(reps.body).toMatchObject({ status: "needs_clarification", reason: "rir_needed" });
    const kept = await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "none" }, sets: [{ exercise: "pushups", duration_s: 40, rir: 1, load: "none" }] });
    expect(kept.sets[0].set.rir).toEqual({ low: 1, high: 1 });
  });

  it("takes a record-only member's sets without RIR, from a saved workout, and links the session to it", async () => {
    const { x } = await ready();
    const w = x.t.insert("workout", { household_id: x.h.id, name: "Hotel legs", created_at: "2026-10-01T00:00:00Z" });
    const body = await x.ok("log_workout", { member: "Asha", date: MONDAY, source: { kind: "workout", workout: "hotel legs" }, sets: [{ exercise: "pushups", reps: 15, load: "none" }, { exercise: "pushups", reps: 12, load: "none" }] }, "asha");
    expect(body.session).toMatchObject({ created: true, template: null, workout: "Hotel legs" });
    expect(x.t.get("SELECT workout_id, template_id FROM session WHERE id = ?", body.session.id)).toEqual({ workout_id: w, template_id: null });
    expect(body.sets.map((s: { set: { rir: unknown; state: string } }) => [s.set.rir, s.set.state])).toEqual([["not_recorded", "confirmed"], ["not_recorded", "confirmed"]]);
    expect(body.progression).toEqual([]);
  });

  it("logs free sets with no template and no workout", async () => {
    const { x } = await ready();
    const body = await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "none" }, sets: [pulldown(12)] });
    expect(body.session).toMatchObject({ template: null, workout: null });
    expect(body.sets[0].set.prescription_id).toBeNull();
    expect(body.progression).toEqual([]);
  });

  it("writes another member's session and sets as drafts", async () => {
    const { x } = await ready();
    const body = await x.ok("log_workout", { member: "Asha", date: MONDAY, source: { kind: "none" }, sets: [{ exercise: "pushups", reps: 15, load: "none" }] });
    expect(body.session.state).toBe("draft");
    expect(body.sets[0].set.state).toBe("draft");
  });

  it("appends to the session the member already has that day", async () => {
    const { x, p } = await ready();
    const started = await x.ok("log_set", { member: "Hritvik", date: MONDAY, ...bench(10) });
    const body = await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "programme" }, sets: [bench(10), pulldown(12)] });
    expect(body.session).toMatchObject({ id: started.session.id, created: false, template: "Upper A" });
    expect(body.sets.map((s: { set: { set_number: number; position: number } }) => [s.set.set_number, s.set.position])).toEqual([[2, 2], [1, 3]]);
    // The bench's progression reads the stored set and the staged one together, as check_progression does once both are written.
    const check = await x.ok("check_progression", { prescription_id: p.bench, session_id: started.session.id });
    const benchState = body.progression.find((r: { prescription_id: number }) => r.prescription_id === p.bench);
    expect(benchState.progression).toEqual(asChecked(check));
    expect(benchState.progression.message).toBe("2 working sets; the rule needs 3");
    expect(body.progression.find((r: { prescription_id: number }) => r.prescription_id === p.pulldown).progression.message).toBe("1 working sets; the rule needs 3");
  });

  it("checks progression against the prescription's implement when it is at another gym, as check_progression does", async () => {
    const { x, p } = await ready();
    const other = x.t.insert("gym", { household_id: x.h.id, name: "Invented old gym" });
    const stack = x.t.insert("implement", { gym_id: other, name: "Invented old stack", kind: "cable", unit: "kg", loading: "total", load_list_complete: 0 });
    for (const load of [40, 42.5]) x.t.insert("implement_load", { implement_id: stack, load, unit: "kg" });
    x.t.run("UPDATE prescription SET load_implement_id = ? WHERE id = ?", stack, p.pulldown);
    const run = await toolWithinBudget(x, "log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "programme" }, sets: upperA() });
    const body = run.body;
    expect(body.sets[3].set.implement).toBe("Lat pulldown stack");
    const check = await x.ok("check_progression", { prescription_id: p.pulldown, session_id: body.session.id });
    const pulldownState = body.progression.find((r: { prescription_id: number }) => r.prescription_id === p.pulldown);
    expect(pulldownState.progression).toEqual(asChecked(check));
    expect(pulldownState.state.kind).toBe("check_at_gym");
  });

  it("asks which programme session a plain session that day is, rather than attaching the schedule's next", async () => {
    const { x, s, p } = await ready();
    const plain = x.t.insert("session", { member_id: x.h.hritvik, performed_on: MONDAY, gym_id: s.gym, session_type: "strength", state: "confirmed", confirmed_at: "2026-10-01T00:00:00Z" });
    const reply = await x.call("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "programme" }, sets: [bench(10)] });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "which_template", path: ["source", "template"], options: expect.arrayContaining(["Upper A", "Lower A"]) });
    expect(x.t.get("SELECT template_id FROM session WHERE id = ?", plain)).toEqual({ template_id: null });
    expect(count(x, "session_set")).toBe(0);
    const named = await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "programme", template: "Upper A" }, sets: [bench(10)] });
    expect(named.session).toMatchObject({ id: plain, created: false, template: "Upper A" });
    expect(x.t.get("SELECT template_id FROM session WHERE id = ?", plain)).toEqual({ template_id: p.upper });
    expect(named.sets[0].set.prescription_id).toBe(p.bench);
  });

  it("replays a question under the same key writing nothing, then takes the corrected call under that key", async () => {
    const { x } = await ready();
    const wrong = { member: "Hritvik", date: MONDAY, source: { kind: "programme" }, sets: [bench(10), { ...curl(10), exercise: "zercher thing" }], idempotency_key: "w-2" };
    const first = await x.call("log_workout", wrong);
    const again = await x.call("log_workout", wrong);
    expect(first.body).toMatchObject({ status: "needs_clarification", reason: "unknown_exercise", path: ["sets", 1, "exercise"] });
    expect(again.body).toEqual(first.body);
    expect(count(x, "session")).toBe(0);
    expect(count(x, "session_set")).toBe(0);
    const fixed = await x.ok("log_workout", { ...wrong, sets: [bench(10), curl(10)] });
    expect(fixed.sets).toHaveLength(2);
    expect(count(x, "session_set")).toBe(2);
  });

  it("asks which gym with the household's gyms when the member has none, and takes the answer as gym", async () => {
    const { x, s } = await ready();
    const input = { member: "Kabir", date: MONDAY, source: { kind: "none" }, sets: [{ exercise: "pushups", reps: 10, rir: 2, load: "none" }] };
    const reply = await x.call("log_workout", input);
    expect(reply.body).toMatchObject({
      status: "needs_clarification", reason: "gym_needed", question: "Which gym are you at?", options: ["Cult Koramangala", "Asha's gym"], path: ["gym"],
    });
    expect(count(x, "session")).toBe(0);
    const body = await x.ok("log_workout", { ...input, gym: "Asha's gym" });
    expect(x.t.get("SELECT gym_id FROM session WHERE id = ?", body.session.id)).toEqual({ gym_id: s.ashaGym });
  });

  it("asks when that day's session follows something else", async () => {
    const { x } = await ready();
    await x.ok("log_set", { member: "Hritvik", date: MONDAY, ...bench(10) });
    x.t.insert("workout", { household_id: x.h.id, name: "Hotel legs", created_at: "2026-10-01T00:00:00Z" });
    const reply = await x.call("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "workout", workout: "Hotel legs" }, sets: [pulldown(12)] });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "session_source_conflict", options: ["none"] });
  });

  it("asks a record-only member's programme source, and an unknown template", async () => {
    const { x } = await ready();
    expect((await x.call("log_workout", { member: "Asha", date: MONDAY, source: { kind: "programme" }, sets: [pulldown(12)] }, "asha")).body).toMatchObject({ reason: "not_prescribed" });
    expect((await x.call("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "programme", template: "Push day" }, sets: [pulldown(12)] })).body).toMatchObject({
      reason: "unknown_template", options: expect.arrayContaining(["Upper A", "Lower A"]),
    });
  });

  it("stays within the budget at 13 sets, at 40 implements", async () => {
    const { x } = await busyInput(40);
    const sets = [bench(10), bench(10), bench(9), bench(9), bench(8), pulldown(12), pulldown(12), pulldown(11), pulldown(10), curl(12), curl(12), curl(11), curl(10)];
    const run = await toolWithinBudget(x, "log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "programme" }, sets });
    expect(run.body.sets).toHaveLength(13);
  });
});

describe("log_workout: a cardio-machine line is a cardio block (ticket 68)", () => {
  it("saves a treadmill line in the workout's session as a cardio block, not a set, in the same write", async () => {
    const { x } = await ready();
    const batches = x.db.batches;
    const body = await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "none" }, sets: [
      pulldown(12),
      { exercise: "incline walk", duration_s: 1600, load: "none", note: "zone 2" },
      { exercise: "treadmill walk", distance: { value: 2, unit: "km" }, load: "none" },
    ] });
    expect(x.db.batches).toBe(batches + 1);
    expect(body.sets.map((s: { set: { exercise: string } }) => s.set.exercise)).toEqual(["Cable lat pulldown"]);
    expect(body.cardio).toEqual([
      { index: 1, id: expect.any(Number), activity: "Treadmill walk", duration_s: 1600, distance: null, position: 1 },
      { index: 2, id: expect.any(Number), activity: "Treadmill walk", duration_s: null, distance: { value: 2, unit: "km" }, position: 2 },
    ]);
    expect(count(x, "session_set")).toBe(1);
    expect(x.t.all("SELECT session_id, position, kind, activity, duration_s, distance_value, distance_unit, note FROM cardio_block ORDER BY position")).toEqual([
      { session_id: body.session.id, position: 1, kind: "steady", activity: "Treadmill walk", duration_s: 1600, distance_value: null, distance_unit: null, note: "zone 2" },
      { session_id: body.session.id, position: 2, kind: "steady", activity: "Treadmill walk", duration_s: null, distance_value: 2, distance_unit: "km", note: null },
    ]);
  });

  it("appends to blocks the session already has, and a counted cardio-machine line stays a set", async () => {
    const { x } = await ready();
    const first = await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "none" }, sets: [{ exercise: "incline walk", duration_s: 600, load: "none" }] });
    const again = await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "none" }, sets: [{ exercise: "incline walk", duration_s: 300, load: "none" }, { exercise: "incline walk", reps: 20, rir: 2, load: "none" }] });
    expect(again.session.id).toBe(first.session.id);
    expect(again.cardio.map((c: { position: number }) => c.position)).toEqual([2]);
    expect(again.sets).toHaveLength(1);
  });

  it("counts the block as performing a cardio-machine prescription, as a cardio session does", async () => {
    const { x, s, p } = await ready();
    x.t.insert("prescription", { template_id: p.upper, position: 9, exercise_id: s.walk, sets: 1, target_kind: "duration", duration_low_s: 1200, duration_high_s: 1800, progression_rule: JSON.stringify({ kind: "manual" }) });
    const gaps = async () => ((await x.ok("next_prescription", { member: "Hritvik", date: MONDAY })).gaps as { exercise: string }[]).map((g) => g.exercise);
    expect(await gaps()).toContain("Treadmill walk");
    await x.ok("log_workout", { member: "Hritvik", date: "2026-10-02", source: { kind: "none" }, sets: [{ exercise: "incline walk", duration_s: 1500, load: "none" }] });
    expect(await gaps()).not.toContain("Treadmill walk");
  });
});

describe("log_workout: what a treadmill block keeps (review P1-2)", () => {
  it("copies the line's steps, and a warm-up line is a warm-up block", async () => {
    const { x } = await ready();
    const body = await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "none" }, sets: [
      { exercise: "incline walk", set_type: "warm_up", duration_s: 300, steps: 450, load: "none" },
      { exercise: "incline walk", duration_s: 1200, steps: 2100, load: "none" },
    ] });
    expect(body.cardio).toHaveLength(2);
    expect(x.t.all("SELECT kind, duration_s, steps FROM cardio_block ORDER BY position")).toEqual([
      { kind: "warm_up", duration_s: 300, steps: 450 },
      { kind: "steady", duration_s: 1200, steps: 2100 },
    ]);
  });

  it("keeps a line that names its prescription as a set, so the prescription keeps its progression", async () => {
    const { x, s, p } = await ready();
    const walk = x.t.insert("prescription", { template_id: p.upper, position: 9, exercise_id: s.walk, sets: 1, target_kind: "duration", duration_low_s: 1200, duration_high_s: 1800, progression_rule: JSON.stringify({ kind: "manual" }) });
    const body = await x.ok("log_workout", { member: "Hritvik", date: MONDAY, source: { kind: "programme" }, sets: [
      { exercise: "incline walk", prescription_id: walk, duration_s: 1500, load: "none" },
      { exercise: "incline walk", substituted_prescription_id: walk, set_type: "substitution", duration_s: 600, load: "none" },
    ] });
    expect(body.cardio).toEqual([]);
    expect(body.sets.map((r: { set: { prescription_id: number | null } }) => r.set.prescription_id)).toEqual([walk, null]);
    expect(body.progression.map((r: { prescription_id: number }) => r.prescription_id)).toContain(walk);
  });
});
