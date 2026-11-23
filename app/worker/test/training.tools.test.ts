import { describe, expect, it } from "vitest";
import { setup, type Harness } from "./harness";
import { seedTraining } from "./seed";

const MONDAY = "2026-10-05";

/** Hritvik's weekday programme: Upper A on Monday, Lower A on Tuesday. */
function seedProgramme(x: Harness, s: ReturnType<typeof seedTraining>) {
  const { t, h } = x;
  const programme = t.insert("programme", { member_id: h.hritvik, name: "Base", schedule_kind: "weekday", active: 1, started_on: "2026-09-01" });
  const upper = t.insert("session_template", { programme_id: programme, name: "Upper A", session_type: "strength" });
  const lower = t.insert("session_template", { programme_id: programme, name: "Lower A", session_type: "strength" });
  t.insert("schedule_slot", { programme_id: programme, weekday: 1, template_id: upper });
  t.insert("schedule_slot", { programme_id: programme, weekday: 2, template_id: lower });
  const rule = (o: object) => JSON.stringify({ kind: "rep_top", ...o });
  const bench = t.insert("prescription", {
    template_id: upper, position: 1, exercise_id: s.bench, sets: 3, rep_low: 8, rep_high: 12, rir_target_low: 1, rir_target_high: 2,
    rest_s: 150, load_value: 12.5, load_unit: "lb", load_basis: "per_side", load_implement_id: s.barbell,
    progression_rule: rule({ target_sets: 3, rep_top: 12, rir_floor: 1, increment: { min: 2.5 } }), cue: "pause on the chest",
  });
  t.insert("prescription_fallback", { prescription_id: bench, exercise_id: s.dbBench, rank: 1 });
  t.insert("prescription_fallback", { prescription_id: bench, exercise_id: s.pushup, rank: 2 });
  const pulldown = t.insert("prescription", {
    template_id: upper, position: 2, exercise_id: s.pulldown, sets: 3, rep_low: 10, rep_high: 12, rir_target_low: 1, rir_target_high: 2,
    load_value: 40, load_unit: "kg", load_basis: "total", load_implement_id: s.stack,
    progression_rule: rule({ target_sets: 3, rep_top: 12, rir_floor: 1, increment: { min: 5 } }),
  });
  const curl = t.insert("prescription", {
    template_id: upper, position: 3, exercise_id: s.curl, sets: 2, rep_low: 10, rep_high: 15, rir_target_low: 1, rir_target_high: 2,
    load_value: 10, load_unit: "kg", load_basis: "per_hand", load_implement_id: s.dumbbells,
    progression_rule: rule({ target_sets: 2, rep_top: 15, rir_floor: 1, increment: { min: 1, max: 1 } }),
  });
  const squat = t.insert("prescription", {
    template_id: lower, position: 1, exercise_id: s.calf, sets: 2, rep_low: 12, rep_high: 15, rir_target_low: 1, rir_target_high: 2,
    load_value: 10, load_unit: "kg", load_basis: "per_leg", load_implement_id: s.dumbbells,
  });
  return { programme, upper, lower, bench, pulldown, curl, squat };
}

async function ready() {
  const x = setup();
  const s = seedTraining(x);
  const p = seedProgramme(x, s);
  return { x, s, p };
}

const rir = (low: number, high = low) => ({ low, high });

async function benchSession(x: Harness) {
  return (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper A" })).session.id;
}

describe("start_session", () => {
  it("starts an open strength session at the member's home gym until end_session", async () => {
    const { x, s } = await ready();
    const body = await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper A" });
    expect(body.session).toMatchObject({ member: "Hritvik", gym_id: s.gym, template: "Upper A", state: "draft", week: 11 });
  });

  it("asks which gym, with the household's gyms, for a strength session of a member with no home gym", async () => {
    const { x } = await ready();
    const reply = await x.call("start_session", { member: "Kabir", date: MONDAY, session_type: "strength" });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "gym_needed", question: "Which gym are you at?", options: ["Cult Koramangala", "Asha's gym"], path: ["gym"] });
  });

  it("checks a stated weekday against the date", async () => {
    const { x } = await ready();
    const reply = await x.call("start_session", { member: "Hritvik", date: MONDAY, weekday: "tue", session_type: "strength" });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "weekday_mismatch", options: ["mon"] });
  });

  it("in Coach mode the session is a draft until end_session", async () => {
    const { x } = await ready();
    const body = await x.ok("start_session", { origin: "coach", member: "Hritvik", date: MONDAY, session_type: "strength" });
    expect(body.session.state).toBe("draft");
  });
});

describe("log_set", () => {
  it("computes the 12 Aug bench exactly: 20 kg bar + 12.5 lb per side", async () => {
    const { x, s } = await ready();
    const session = await benchSession(x);
    const body = await x.ok("log_set", {
      session_id: session, exercise: "bench", reps: 8, rir: rir(0),
      load: { value: 12.5, unit: "lb", basis: "per_side", implement: s.barbell, bar: { value: 20, unit: "kg" } },
    });
    expect(body.set.total_kg).toBeCloseTo(31.3398, 4);
    expect(body.set.volume_kg).toBeCloseTo(250.718, 3);
    // e1RM on a barbell is the whole bar (the split convention, 0021).
    expect(body.set.e1rm_kg).toBeCloseTo(39.6971, 3);
    expect(body.set.e1rm_rir_kg).toBeCloseTo(39.6971, 3);
    expect(body.set).toMatchObject({ exercise: "Barbell bench press", set_number: 1, set_type: "working", state: "confirmed" });
    expect(body.snap).toEqual({ status: "on_list", value: 12.5, unit: "lb" });
    expect(body.set.prescription_id).toEqual(expect.any(Number));
  });

  it("returns a RIR-adjusted chart estimate while retaining inferred-reps provenance", async () => {
    const { x, s } = await ready();
    const session = await benchSession(x);
    const body = await x.ok("log_set", {
      session_id: session, exercise: "lat pulldown", reps: 8, reps_inferred: true, rir: 2,
      load: { value: 40, unit: "kg", basis: "total", implement: s.stack },
    });
    expect(body.set).toMatchObject({ reps_inferred: true, e1rm_kg: null });
    expect(body.set.e1rm_rir_kg).toBeCloseTo(40 * (1 + 10 / 30), 9);
    expect(x.t.get("SELECT e1rm_rir_kg FROM v_set WHERE id = ?", body.set.id)?.e1rm_rir_kg).toBeCloseTo(body.set.e1rm_rir_kg, 9);
  });

  it("doubles a per-hand load, and counts a unilateral per-leg load once", async () => {
    const { x, s } = await ready();
    const session = await benchSession(x);
    const curl = await x.ok("log_set", { session_id: session, exercise: "db curl", reps: 12, rir: rir(2), load: { value: 10, unit: "kg", basis: "per_hand", implement: s.dumbbells } });
    expect(curl.set.total_kg).toBe(20);
    expect(curl.set.volume_kg).toBe(240);
    const calf = await x.ok("log_set", {
      session_id: session, exercise: "calf raise", reps: 15, rir: rir(1, 2),
      load: { value: 10, unit: "kg", basis: "per_leg", implement: s.dumbbells, unilateral: true },
    });
    expect(calf.set.total_kg).toBe(10);
  });

  it("picks the only implement of the exercise's kind at the gym", async () => {
    const { x } = await ready();
    const session = await benchSession(x);
    const body = await x.ok("log_set", { session_id: session, exercise: "lat pulldown", reps: 10, rir: rir(1, 2), load: { value: 40, unit: "kg", basis: "total" } });
    expect(body.set.implement).toBe("Lat pulldown stack");
  });

  it("a load not on the inventory becomes a flagged draft offering to add it", async () => {
    const { x, s } = await ready();
    const session = await benchSession(x);
    const body = await x.ok("log_set", { session_id: session, exercise: "db curl", reps: 12, rir: rir(2), load: { value: 11, unit: "kg", basis: "per_hand", implement: s.dumbbells } });
    expect(body.set.state).toBe("draft");
    expect(body.snap).toMatchObject({ status: "off_list", below: { value: 10, unit: "kg" }, above: { value: 12.5, unit: "kg" }, nearest: { value: 10, unit: "kg" } });
    expect(body.offer).toMatchObject({ tool: "add_implement_load", implement_id: s.dumbbells, load: { value: 11, unit: "kg" } });
  });

  it("asks for RIR before confirming a prescribed member's set", async () => {
    const { x, s } = await ready();
    const session = await benchSession(x);
    const reply = await x.call("log_set", { session_id: session, exercise: "bench", reps: 8, load: { value: 12.5, unit: "lb", basis: "per_side", implement: s.barbell, bar: { value: 20, unit: "kg" } } });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "rir_needed", path: ["rir"] });
    const notRecorded = await x.call("log_set", { session_id: session, exercise: "bench", reps: 8, rir: "not_recorded", load: { value: 12.5, unit: "lb", basis: "per_side", implement: s.barbell, bar: { value: 20, unit: "kg" } } });
    expect(notRecorded.body).toMatchObject({ status: "needs_clarification", reason: "rir_needed" });
  });

  it("record-only members may leave RIR out: it is stored as not recorded, and the set confirms", async () => {
    const { x } = await ready();
    const session = (await x.ok("start_session", { member: "Asha", date: MONDAY, session_type: "strength" }, "asha")).session.id;
    const body = await x.ok("log_set", { session_id: session, exercise: "db curl", reps: 12, load: { value: 5, unit: "kg", basis: "per_hand" } }, "asha");
    expect(body.set).toMatchObject({ state: "confirmed", rir: "not_recorded" });
    expect(body.snap).toEqual({ status: "no_inventory", value: 5, unit: "kg" });
  });

  it("asks which bar when plates per side come without one", async () => {
    const { x, s } = await ready();
    const session = await benchSession(x);
    const reply = await x.call("log_set", { session_id: session, exercise: "bench", reps: 8, rir: rir(1), load: { value: 12.5, unit: "lb", basis: "per_side", implement: s.barbell } });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "bar_needed", path: ["load", "bar"] });
  });

  it("warns, without blocking, when a load is implausible against history", async () => {
    const { x, s } = await ready();
    const session = await benchSession(x);
    await x.ok("log_set", { session_id: session, exercise: "lat pulldown", reps: 10, rir: rir(1, 2), load: { value: 40, unit: "kg", basis: "total" } });
    const tuesday = (await x.ok("start_session", { member: "Hritvik", date: "2026-10-06", session_type: "strength" })).session.id;
    const body = await x.ok("log_set", { session_id: tuesday, exercise: "lat pulldown", reps: 10, rir: rir(1, 2), load: { value: 88, unit: "kg", basis: "total", implement: s.stack, as_stated: true } });
    expect(body.implausible).toMatchObject({ likelyCause: "lb_entered_as_kg", referenceKg: 40 });
  });

  it("asks which exercise when the name matches none", async () => {
    const { x } = await ready();
    const session = await benchSession(x);
    const reply = await x.call("log_set", { session_id: session, exercise: "benchpress", reps: 8, rir: rir(1), load: "none" });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "unknown_exercise", path: ["exercise"] });
    expect(reply.body.options).toContain("Barbell bench press");
  });

  it("asks what the load was when none is given", async () => {
    const { x } = await ready();
    const session = await benchSession(x);
    const reply = await x.call("log_set", { session_id: session, exercise: "push-up", reps: 15, rir: rir(2) });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "load_needed" });
    const bodyweight = await x.ok("log_set", { session_id: session, exercise: "push-up", reps: 15, rir: rir(2), load: "none" });
    expect(bodyweight.set).toMatchObject({ load_status: "none", total_kg: null, volume_kg: null });
  });
});

describe("Coach mode: sets stay drafts until end_session", () => {
  it("confirms the session and its sets at end_session, and summarises it", async () => {
    const { x, s } = await ready();
    const session = (await x.ok("start_session", { origin: "coach", member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper A" })).session.id;
    const set = (reps: number) =>
      x.ok("log_set", { origin: "coach", session_id: session, exercise: "lat pulldown", reps, rir: rir(1, 2), load: { value: 40, unit: "kg", basis: "total", implement: s.stack } });
    expect((await set(12)).set.state).toBe("draft");
    await set(12);
    await set(12);
    const body = await x.ok("end_session", { origin: "coach", session_id: session });
    expect(body.session.state).toBe("confirmed");
    expect(body.confirmed_sets).toBe(3);
    expect(body.volume_kg).toBe(1440);
    expect(body.progression).toEqual([expect.objectContaining({ exercise: "Cable lat pulldown", verdict: "fired", nextLoad: 45 })]);
  });

  it("a Coach draft may leave RIR blank, but end_session asks for it", async () => {
    const { x, s } = await ready();
    const session = (await x.ok("start_session", { origin: "coach", member: "Hritvik", date: MONDAY, session_type: "strength" })).session.id;
    const logged = await x.ok("log_set", { origin: "coach", session_id: session, exercise: "lat pulldown", reps: 10, load: { value: 40, unit: "kg", basis: "total", implement: s.stack } });
    expect(logged.set).toMatchObject({ state: "draft", rir: null });
    const reply = await x.call("end_session", { origin: "coach", session_id: session });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "rir_needed", options: [logged.set.id] });
  });
});

describe("next_prescription", () => {
  it("gives today's session from the weekday plan, with loads snapped to the inventory", async () => {
    const { x } = await ready();
    const body = await x.ok("next_prescription", { member: "Hritvik", date: MONDAY });
    expect(body).toMatchObject({ session: "Upper A", date: MONDAY, layoff_policy: null });
    const bench = body.prescriptions[0];
    expect(bench).toMatchObject({ exercise: "Barbell bench press", sets: 3, rep_low: 8, rep_high: 12, cue: "pause on the chest" });
    expect(bench.load).toMatchObject({ value: 12.5, unit: "lb", basis: "per_side", snap: { status: "on_list", value: 12.5 } });
    expect(bench.fallbacks).toEqual(["Dumbbell bench press", "Push-up"]);
    expect(body.gaps.map((g: { exercise: string }) => g.exercise)).toEqual(["Barbell bench press", "Cable lat pulldown", "Dumbbell curl", "Single-leg calf raise"]);
  });

  it("moves to tomorrow once today is trained", async () => {
    const { x, s } = await ready();
    const session = await benchSession(x);
    await x.ok("log_set", { session_id: session, exercise: "lat pulldown", reps: 10, rir: rir(1, 2), load: { value: 40, unit: "kg", basis: "total", implement: s.stack } });
    const body = await x.ok("next_prescription", { member: "Hritvik", date: MONDAY });
    expect(body).toMatchObject({ session: "Lower A", date: "2026-10-06", layoff_policy: "normal" });
    expect(body.gaps.map((g: { exercise: string }) => g.exercise)).not.toContain("Cable lat pulldown");
  });

  it("record-only members get no prescriptions", async () => {
    const { x } = await ready();
    const body = await x.ok("next_prescription", { member: "Asha", date: MONDAY });
    expect(body).toMatchObject({ programming_mode: "record_only", session: null, prescriptions: [] });
  });
});

describe("check_progression", () => {
  async function pulldowns(x: Harness, s: ReturnType<typeof seedTraining>, sets: { reps: number; rir: unknown }[]) {
    const session = await benchSession(x);
    for (const set of sets) {
      await x.ok("log_set", { session_id: session, exercise: "lat pulldown", reps: set.reps, rir: set.rir, load: { value: 40, unit: "kg", basis: "total", implement: s.stack } });
    }
    return session;
  }

  it("fires when 3 x 12 is done at RIR 1 or more, moving to the next producible load", async () => {
    const { x, s, p } = await ready();
    await pulldowns(x, s, [{ reps: 12, rir: rir(1, 2) }, { reps: 12, rir: rir(1, 2) }, { reps: 12, rir: rir(1) }]);
    const body = await x.ok("check_progression", { prescription_id: p.pulldown });
    expect(body).toMatchObject({ verdict: "fired", reason: "rule_met", nextLoad: 45 });
  });

  it("is not yet when a set was ground out", async () => {
    const { x, s, p } = await ready();
    await pulldowns(x, s, [{ reps: 12, rir: rir(1, 2) }, { reps: 12, rir: rir(0) }, { reps: 12, rir: rir(1) }]);
    const body = await x.ok("check_progression", { prescription_id: p.pulldown });
    expect(body).toMatchObject({ verdict: "not_yet", reason: "ground_out" });
  });

  it("is never when the increment does not exist on the implement", async () => {
    const { x, p } = await ready();
    const body = await x.ok("check_progression", { prescription_id: p.curl });
    expect(body).toMatchObject({ verdict: "never", reason: "increment_not_on_implement" });
  });

  it("says why a prescription with no rule never fires", async () => {
    const { x, p } = await ready();
    const body = await x.ok("check_progression", { prescription_id: p.squat });
    expect(body).toMatchObject({ verdict: "never", reason: "no_rule" });
  });
});

describe("inferred reps", () => {
  const stack = (s: ReturnType<typeof seedTraining>) => ({ value: 40, unit: "kg", basis: "total", implement: s.stack });

  it("log_set stores a bulk-reported set with its reps flagged as inferred", async () => {
    const { x, s } = await ready();
    const session = await benchSession(x);
    const body = await x.ok("log_set", { session_id: session, exercise: "lat pulldown", reps: 12, reps_inferred: true, rir: rir(2), load: stack(s) });
    expect(body.set).toMatchObject({ reps: 12, reps_inferred: true });
    const plain = await x.ok("log_set", { session_id: session, exercise: "lat pulldown", reps: 12, rir: rir(2), load: stack(s) });
    expect(plain.set.reps_inferred).toBe(false);
  });

  it("a rule that would fire on inferred reps returns needs_confirmation with the sets to confirm, and fires once they are", async () => {
    const { x, s, p } = await ready();
    const session = await benchSession(x);
    const ids: number[] = [];
    for (const inferred of [false, true, true]) {
      ids.push((await x.ok("log_set", { session_id: session, exercise: "lat pulldown", reps: 12, reps_inferred: inferred, rir: rir(2), load: stack(s) })).set.id);
    }
    const asked = await x.ok("check_progression", { prescription_id: p.pulldown });
    expect(asked).toMatchObject({ verdict: "needs_confirmation", reason: "reps_inferred", nextLoad: 45, confirm_set_ids: [ids[1], ids[2]] });

    // The member says they were all 12s: amending the reps (or the flag) records them as reported.
    await x.ok("amend", { record: { table: "session_set", id: ids[1] }, changes: { reps: 12 }, reason: "member confirmed 12 reps" });
    await x.ok("amend", { record: { table: "session_set", id: ids[2] }, changes: { reps_inferred: false }, reason: "member confirmed 12 reps" });
    const fired = await x.ok("check_progression", { prescription_id: p.pulldown });
    expect(fired).toMatchObject({ verdict: "fired", nextLoad: 45 });
  });

  it("end_session reports the same state", async () => {
    const { x, s } = await ready();
    const session = (await x.ok("start_session", { origin: "coach", member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper A" })).session.id;
    for (let i = 0; i < 3; i++) {
      await x.ok("log_set", { origin: "coach", session_id: session, exercise: "lat pulldown", reps: 12, reps_inferred: true, rir: rir(2), load: stack(s) });
    }
    const body = await x.ok("end_session", { origin: "coach", session_id: session });
    expect(body.progression).toEqual([expect.objectContaining({ exercise: "Cable lat pulldown", verdict: "needs_confirmation" })]);
  });
});

describe("substitute", () => {
  it("ranks the fallbacks, saying which count as coverage and which the gym can do", async () => {
    const { x, p } = await ready();
    const body = await x.ok("substitute", { prescription_id: p.bench });
    expect(body.options.map((o: { exercise: string; covered: boolean }) => [o.exercise, o.covered])).toEqual([
      ["Dumbbell bench press", true],
      ["Push-up", false],
    ]);
    expect(body.options[1].mismatches).toEqual(["position"]);
    expect(body.options[0].available).toBe(true);
  });
});

describe("lift_history and last_trained", () => {
  it("matches a pattern across exercise names and aliases, with derived values", async () => {
    const { x, s } = await ready();
    const session = await benchSession(x);
    await x.ok("log_set", { session_id: session, exercise: "bench", reps: 8, rir: rir(0), load: { value: 12.5, unit: "lb", basis: "per_side", implement: s.barbell, bar: { value: 20, unit: "kg" } } });
    await x.ok("log_set", { session_id: session, exercise: "db bench", reps: 10, rir: rir(1), load: { value: 12.5, unit: "kg", basis: "per_hand", implement: s.dumbbells } });
    await x.ok("log_set", { session_id: session, exercise: "lat pulldown", reps: 10, rir: rir(1), load: { value: 40, unit: "kg", basis: "total" } });
    const body = await x.ok("lift_history", { member: "Hritvik", pattern: "*bench*" });
    expect(body.exercises.map((e: { exercise: string }) => e.exercise)).toEqual(["Barbell bench press", "Dumbbell bench press"]);
    const set = body.exercises[0].sessions[0].sets[0];
    expect(set.e1rm_kg).toBeCloseTo(39.6971, 3);
    expect(body.exercises[0].best_e1rm_kg).toBeCloseTo(39.6971, 3);
  });

  it("says when an exercise was last trained, and how long ago", async () => {
    const { x, s } = await ready();
    const session = (await x.ok("start_session", { member: "Hritvik", date: "2026-09-28", session_type: "strength", template: "Upper A" })).session.id;
    await x.ok("log_set", { session_id: session, exercise: "lat pulldown", reps: 10, rir: rir(1), load: { value: 40, unit: "kg", basis: "total", implement: s.stack } });
    const body = await x.ok("last_trained", { member: "Hritvik", exercise: "pulldown", date: MONDAY });
    expect(body).toMatchObject({ exercise: "Cable lat pulldown", last: "2026-09-28", days_since: 7 });
    const never = await x.ok("last_trained", { member: "Hritvik", exercise: "bench", date: MONDAY });
    expect(never).toMatchObject({ last: null, days_since: null });
    const template = await x.ok("last_trained", { member: "Hritvik", template: "Upper A", date: MONDAY });
    expect(template).toMatchObject({ template: "Upper A", last: "2026-09-28", days_since: 7 });
  });
});

describe("log_cardio", () => {
  it("logs a cardio session in blocks, with pace derived", async () => {
    const { x } = await ready();
    const body = await x.ok("log_cardio", {
      member: "Hritvik", date: MONDAY, session_type: "cardio", energy_kcal: 250,
      blocks: [
        { kind: "warm_up", activity: "walk", duration_s: 300, speed: { value: 5, unit: "km/h" }, incline_pct: 1 },
        { kind: "steady", activity: "incline walk", duration_s: 1800, distance: { value: 3, unit: "km" }, avg_hr: 132, max_hr: 141, hr_device: "Polar H10", conversational: true },
      ],
    });
    expect(body.session).toMatchObject({ session_type: "cardio", state: "confirmed", energy_kcal: 250 });
    expect(body.blocks[0].pace_min_per_km).toBeNull();
    expect(body.blocks[1].pace_min_per_km).toBeCloseTo(10, 9);
    expect(body.total_duration_s).toBe(2100);
  });

  it("logs a dance class with its energy cost and no gym", async () => {
    const { x } = await ready();
    const body = await x.ok("log_cardio", { member: "Hritvik", date: "2026-10-04", session_type: "class", energy_kcal: 400, blocks: [{ kind: "steady", activity: "dance", duration_s: 3600 }] });
    expect(body.session).toMatchObject({ session_type: "class", gym_id: null, energy_kcal: 400 });
  });
});

describe("inventory and add_implement_load", () => {
  it("lists a gym's implements and their producible loads", async () => {
    const { x } = await ready();
    const body = await x.ok("inventory", { gym: "Cult Koramangala" });
    const db = body.implements.find((i: { name: string }) => i.name === "Dumbbells");
    expect(db).toMatchObject({ unit: "kg", loading: "total", load_list_complete: true, loads: [2.5, 5, 7.5, 10, 12.5, 15, 17.5, 20].map((value) => ({ value, unit: "kg" })) });
  });

  it("adds a producible load, after which a set at that load snaps on the list", async () => {
    const { x, s } = await ready();
    const body = await x.ok("add_implement_load", { implement_id: s.dumbbells, loads: [11, 10] });
    expect(body.added).toEqual([{ value: 11, unit: "kg" }]);
    expect(body.implement.loads).toEqual([2.5, 5, 7.5, 10, 11, 12.5, 15, 17.5, 20].map((value) => ({ value, unit: "kg" })));
    const session = await benchSession(x);
    const set = await x.ok("log_set", { session_id: session, exercise: "db curl", reps: 12, rir: rir(2), load: { value: 11, unit: "kg", basis: "per_hand", implement: s.dumbbells } });
    expect(set.snap.status).toBe("on_list");
    expect(set.set.state).toBe("confirmed");
  });
});

describe("remove_implement_load", () => {
  it("removes a load the gym doesn't have, with the reason in the write log, after which it is off the list", async () => {
    const { x, s } = await ready();
    const body = await x.ok("remove_implement_load", { implement_id: s.dumbbells, loads: [15], reason: "There's no 15 kg dumbbell" });
    expect(body).toMatchObject({ removed: [{ value: 15, unit: "kg" }], not_listed: [], affected_prescriptions: [] });
    expect(body.implement.loads).toEqual([2.5, 5, 7.5, 10, 12.5, 17.5, 20].map((value) => ({ value, unit: "kg" })));
    expect(body.implement.absent).toEqual([{ value: 15, unit: "kg" }]);
    expect(x.t.get("SELECT tool, reason FROM write_log WHERE id = ?", body.write_id)).toEqual({ tool: "remove_implement_load", reason: "There's no 15 kg dumbbell" });
    const removedId = x.t.get("SELECT record_id FROM record_version WHERE table_name = 'implement_load' AND action = 'delete'")!.record_id as number;
    const history = await x.ok("history", { table: "implement_load", id: removedId });
    expect(history.versions.at(-1)).toMatchObject({ action: "delete", reason: "There's no 15 kg dumbbell", data: { load: 15 } });

    const session = await benchSession(x);
    const set = await x.ok("log_set", { session_id: session, exercise: "db curl", reps: 12, rir: rir(2), load: { value: 15, unit: "kg", basis: "per_hand", implement: s.dumbbells } });
    expect(set.snap).toMatchObject({ status: "off_list" });
  });

  it("needs a reason", async () => {
    const { x, s } = await ready();
    const reply = await x.call("remove_implement_load", { implement_id: s.dumbbells, loads: [15] });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "reason_needed" });
    expect(x.t.get("SELECT count(*) AS n FROM implement_load WHERE implement_id = ? AND load = 15", s.dumbbells)).toEqual({ n: 1 });
  });

  it("names the prescriptions whose current load is gone, and loads that weren't listed", async () => {
    const { x, s, p } = await ready();
    const body = await x.ok("remove_implement_load", { implement_id: s.dumbbells, loads: [10, 11], reason: "the 10s are missing" });
    expect(body).toMatchObject({ removed: [{ value: 10, unit: "kg" }], not_listed: [{ value: 11, unit: "kg" }] });
    expect(body.affected_prescriptions).toEqual([
      expect.objectContaining({ prescription_id: p.curl, exercise: "Dumbbell curl", load: { value: 10, unit: "kg" } }),
      expect.objectContaining({ prescription_id: p.squat, exercise: "Single-leg calf raise", load: { value: 10, unit: "kg" } }),
    ]);
  });
});
