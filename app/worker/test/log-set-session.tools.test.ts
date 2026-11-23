// log_set with member and date: the "+ → Set" Save. It finds the member's
// strength session that day or creates it (with the programme session that
// was next on that date), asks when there are several, and writes the
// session and the set in one batch.
import { describe, expect, it } from "vitest";
import { LOG_SET_BUDGET, toolWithinBudget } from "./budget";
import { setup } from "./harness";
import { busyInput, MONDAY, seedUpperA } from "./input-seed";
import { seedTraining } from "./seed";

async function ready() {
  const x = setup();
  const s = seedTraining(x);
  const p = seedUpperA(x, s);
  return { x, s, p };
}

const pulldown = (over: Record<string, unknown> = {}) => ({ exercise: "lat pulldown", reps: 12, rir: 2, load: { value: 40, unit: "kg", basis: "total" }, ...over });

describe("log_set with member and date", () => {
  it("creates the member's strength session at their home gym with the next programme session, in one write", async () => {
    const { x, s, p } = await ready();
    const batches = x.db.batches;
    const body = await x.ok("log_set", { member: "Hritvik", date: MONDAY, ...pulldown() });
    expect(x.db.batches).toBe(batches + 1);
    expect(body.session).toMatchObject({ created: true, template: "Upper A", workout: null });
    expect(x.t.get("SELECT member_id, performed_on, gym_id, session_type, template_id, workout_id, state FROM session WHERE id = ?", body.session.id)).toEqual({
      member_id: x.h.hritvik, performed_on: MONDAY, gym_id: s.gym, session_type: "strength", template_id: p.upper, workout_id: null, state: "confirmed",
    });
    expect(body.set).toMatchObject({ exercise: "Cable lat pulldown", prescription_id: p.pulldown, set_number: 1, position: 1, state: "confirmed" });
    expect(x.t.all("SELECT table_name, action FROM record_version WHERE write_id = ? ORDER BY table_name", x.t.get("SELECT max(id) AS m FROM write_log")?.m)).toEqual([
      { table_name: "session", action: "create" },
      { table_name: "session_set", action: "create" },
    ]);
  });

  it("finds the same session for the next set", async () => {
    const { x } = await ready();
    const first = await x.ok("log_set", { member: "Hritvik", date: MONDAY, ...pulldown() });
    const second = await x.ok("log_set", { member: "Hritvik", date: MONDAY, ...pulldown({ reps: 11 }) });
    expect(second.session).toMatchObject({ id: first.session.id, created: false, template: "Upper A" });
    expect(second.set).toMatchObject({ set_number: 2, position: 2 });
    expect(x.t.get("SELECT count(*) AS n FROM session")).toEqual({ n: 1 });
  });

  it("on a past date takes the programme session that was next then, not today's", async () => {
    // Wednesday 30 September: Lower A by the weekday schedule.
    const { x, p } = await ready();
    const body = await x.ok("log_set", { member: "Hritvik", date: "2026-09-30", exercise: "calf raise", reps: 12, rir: 2, load: { value: 10, unit: "kg", basis: "per_leg" } });
    expect(body.session).toMatchObject({ created: true, template: "Lower A" });
    expect(body.set.prescription_id).toBe(p.calf);
    expect(x.t.get("SELECT performed_on FROM session WHERE id = ?", body.session.id)).toEqual({ performed_on: "2026-09-30" });
  });

  it("asks which session when the member has several that day, and takes the answer as session_id", async () => {
    const { x } = await ready();
    const a = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper A" })).session.id;
    const b = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength" })).session.id;
    const reply = await x.call("log_set", { member: "Hritvik", date: MONDAY, ...pulldown() });
    expect(reply.body).toMatchObject({
      status: "needs_clarification", reason: "session_choice", path: ["session_id"],
      options: [{ session_id: a, template: "Upper A", workout: null, sets: 0 }, { session_id: b, template: null, workout: null, sets: 0 }],
    });
    expect(x.t.get("SELECT count(*) AS n FROM session_set")).toEqual({ n: 0 });
    expect((await x.ok("log_set", { session_id: b, ...pulldown() })).set.session_id).toBe(b);
  });

  it("does not count a cardio session that day", async () => {
    const { x } = await ready();
    await x.ok("log_cardio", { member: "Hritvik", date: MONDAY, session_type: "cardio", blocks: [{ kind: "steady", duration_s: 1200 }] });
    expect((await x.ok("log_set", { member: "Hritvik", date: MONDAY, ...pulldown() })).session.created).toBe(true);
  });

  it("creates a record-only member's session with no template, and needs no RIR", async () => {
    const { x } = await ready();
    const body = await x.ok("log_set", { member: "Asha", date: MONDAY, exercise: "pushups", reps: 15, load: "none" }, "asha");
    expect(body.session).toMatchObject({ created: true, template: null });
    expect(body.set).toMatchObject({ exercise: "Push-up", rir: "not_recorded", state: "confirmed" });
  });

  it("logs another member's set and session as drafts", async () => {
    const { x } = await ready();
    const body = await x.ok("log_set", { member: "Asha", date: MONDAY, exercise: "pushups", reps: 15, load: "none" });
    expect(body.set.state).toBe("draft");
    expect(x.t.get("SELECT state FROM session WHERE id = ?", body.session.id)).toEqual({ state: "draft" });
  });

  it("keeps a Coach-mode session and set drafts", async () => {
    const { x } = await ready();
    const body = await x.ok("log_set", { origin: "coach", member: "Hritvik", date: MONDAY, ...pulldown() });
    expect(body.set.state).toBe("draft");
    expect(x.t.get("SELECT state FROM session WHERE id = ?", body.session.id)).toEqual({ state: "draft" });
  });

  it("writes nothing when the set asks a question", async () => {
    const { x } = await ready();
    const reply = await x.call("log_set", { member: "Hritvik", date: MONDAY, ...pulldown({ rir: undefined }) });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "rir_needed", path: ["rir"] });
    expect(x.t.get("SELECT count(*) AS n FROM session")).toEqual({ n: 0 });
  });

  it("asks which gym, in the member's words, with the household's gyms, when the member has none on record", async () => {
    const { x } = await ready();
    const reply = await x.call("log_set", { member: "Kabir", date: MONDAY, exercise: "pushups", reps: 10, rir: 2, load: "none" });
    expect(reply.body).toMatchObject({
      status: "needs_clarification", reason: "gym_needed", question: "Which gym are you at?", options: ["Cult Koramangala", "Asha's gym"], path: ["gym"],
    });
    expect(x.t.get("SELECT count(*) AS n FROM session")).toEqual({ n: 0 });
  });

  it("takes the answer as gym and starts the session at that gym", async () => {
    const { x, s } = await ready();
    const body = await x.ok("log_set", { member: "Kabir", date: MONDAY, gym: "asha's gym", exercise: "pushups", reps: 10, rir: 2, load: "none" });
    expect(body.session).toMatchObject({ created: true });
    expect(x.t.get("SELECT gym_id FROM session WHERE id = ?", body.session.id)).toEqual({ gym_id: s.ashaGym });
  });

  it("a gym given overrides the home gym for a new session, and an unknown one asks", async () => {
    const { x, s } = await ready();
    const body = await x.ok("log_set", { member: "Hritvik", date: MONDAY, gym: s.ashaGym, ...pulldown({ load: "none", exercise: "pushups" }) });
    expect(x.t.get("SELECT gym_id FROM session WHERE id = ?", body.session.id)).toEqual({ gym_id: s.ashaGym });
    const reply = await x.call("log_set", { member: "Kabir", date: MONDAY, gym: "Nowhere", exercise: "pushups", reps: 10, rir: 2, load: "none" });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "unknown_gym", path: ["gym"] });
  });

  it("preview_set takes the same gym", async () => {
    const { x } = await ready();
    const ask = await x.call("preview_set", { member: "Kabir", date: MONDAY, exercise: "pushups", reps: 10, rir: 2, load: "none" });
    expect(ask.body).toMatchObject({ reason: "gym_needed", options: ["Cult Koramangala", "Asha's gym"] });
    const body = await x.ok("preview_set", { member: "Kabir", date: MONDAY, gym: "Cult Koramangala", exercise: "pushups", reps: 10, rir: 2, load: "none" });
    expect(body.session).toMatchObject({ would_create: true });
  });

  it("takes session_id, or member and date, not both and not neither", async () => {
    const { x } = await ready();
    const s = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength" })).session.id;
    expect((await x.call("log_set", { session_id: s, member: "Hritvik", date: MONDAY, ...pulldown() })).body.error.code).toBe("session_or_member");
    expect((await x.call("log_set", { member: "Hritvik", ...pulldown() })).body.error.code).toBe("session_or_member");
  });
});

describe("log_set budgets, by member and date", () => {
  it(`creating the session: at most ${LOG_SET_BUDGET} at 40 implements`, async () => {
    const { x } = await busyInput(40);
    const run = await toolWithinBudget(x, "log_set", { member: "Hritvik", date: MONDAY, ...pulldown() }, "agent", LOG_SET_BUDGET);
    expect(run.body.session.created).toBe(true);
  });

  it(`finding the session that day: at most ${LOG_SET_BUDGET} at 40 implements`, async () => {
    const { x } = await busyInput(40);
    await x.ok("log_set", { member: "Hritvik", date: MONDAY, ...pulldown() });
    const run = await toolWithinBudget(x, "log_set", { member: "Hritvik", date: MONDAY, ...pulldown({ reps: 11 }) }, "agent", LOG_SET_BUDGET);
    expect(run.body.session.created).toBe(false);
  });

  it(`creating the session at a gym given: at most ${LOG_SET_BUDGET} at 40 implements`, async () => {
    const { x } = await busyInput(40);
    const run = await toolWithinBudget(x, "log_set", { member: "Hritvik", date: MONDAY, gym: "Cult Koramangala", ...pulldown() }, "agent", LOG_SET_BUDGET);
    expect(run.body.session.created).toBe(true);
  });
});

describe("\"Which cable?\" names the gym's cables (click test P1-6)", () => {
  it("asks with every cable at the session's gym as options, at load.implement, and the named answer logs the set", async () => {
    const x = setup();
    const s = seedTraining(x);
    const crossover = x.t.insert("implement", { gym_id: s.gym, name: "Cable crossover", kind: "cable", unit: "kg", loading: "total", load_list_complete: 1 });
    x.t.insert("implement_load", { implement_id: crossover, load: 40, unit: "kg" });
    const session = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength" })).session.id;
    const asked = await x.call("log_set", { session_id: session, ...pulldown() });
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "implement_needed", path: ["load", "implement"] });
    expect([...asked.body.options].sort()).toEqual(["Cable crossover", "Lat pulldown stack"]);
    const body = await x.ok("log_set", { session_id: session, ...pulldown({ load: { value: 40, unit: "kg", basis: "total", implement: "Cable crossover" } }) });
    expect(body.set).toMatchObject({ exercise: "Cable lat pulldown", implement: "Cable crossover", state: "confirmed" });
  });
});
