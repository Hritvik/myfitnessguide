import { describe, expect, it } from "vitest";
import { setup, type Harness } from "./harness";
import { seedTraining } from "./seed";

const MONDAY = "2026-10-05";

function seedProgramme(x: Harness, exerciseId: number) {
  const programme = x.t.insert("programme", { member_id: x.h.hritvik, name: "Base", schedule_kind: "weekday", active: 1, started_on: "2026-09-01" });
  const template = x.t.insert("session_template", { programme_id: programme, name: "Upper", session_type: "strength" });
  x.t.insert("schedule_slot", { programme_id: programme, weekday: 1, template_id: template });
  x.t.insert("prescription", {
    template_id: template, position: 1, exercise_id: exerciseId, sets: 2, rep_low: 8, rep_high: 12,
    rir_target_low: 1, rir_target_high: 2, cue: "Private coaching cue", fallback_note: "Private fallback prose",
  });
  return template;
}

describe("resumable training sessions", () => {
  it("a signed-in member starts an open draft that active_session can resume", async () => {
    const x = setup();
    seedTraining(x);
    const started = await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength" }, "hritvik");
    expect(started.session).toMatchObject({ state: "draft", resumed: false });
    const active = await x.ok("active_session", { member: "Hritvik", date: MONDAY }, "hritvik");
    expect(active).toMatchObject({ active_state: "one", session: { id: started.session.id } });
  });

  it("start_session resumes the one exact same-day draft unless start_new is explicit", async () => {
    const x = setup();
    const s = seedTraining(x);
    seedProgramme(x, s.bench);
    const first = await x.ok("start_session", { origin: "coach", member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper" });
    const resumed = await x.ok("start_session", { origin: "coach", member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper" });
    expect(resumed.session).toMatchObject({ id: first.session.id, resumed: true });
    expect((x.t.get("SELECT count(*) AS n FROM session") as { n: number }).n).toBe(1);

    const fresh = await x.ok("start_session", { origin: "coach", member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper", start_new: true });
    expect(fresh.session).toMatchObject({ resumed: false });
    expect(fresh.session.id).not.toBe(first.session.id);
  });

  it("asks which one when legacy data has multiple exact draft matches", async () => {
    const x = setup();
    const s = seedTraining(x);
    const template = seedProgramme(x, s.bench);
    for (let i = 0; i < 2; i++) x.t.insert("session", {
      member_id: x.h.hritvik, performed_on: MONDAY, gym_id: s.gym, session_type: "strength", template_id: template,
      state: "draft", confirmed_at: null,
    });
    const reply = await x.call("start_session", { origin: "coach", member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper" });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "multiple_active_sessions", path: ["start_new"] });
    expect(reply.body.options).toHaveLength(2);
  });

  it("active_session returns ordered work, the next unfinished prescription, and capped stale drafts", async () => {
    const x = setup();
    const s = seedTraining(x);
    seedProgramme(x, s.bench);
    const session = (await x.ok("start_session", { origin: "coach", member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper" })).session.id;
    await x.ok("log_set", { origin: "coach", session_id: session, exercise: "bench", reps: 10, rir: 2, load: "none" });
    for (let i = 1; i <= 7; i++) x.t.insert("session", {
      member_id: x.h.hritvik, performed_on: `2026-09-${String(i).padStart(2, "0")}`, gym_id: s.gym,
      session_type: "strength", state: "draft", confirmed_at: null,
    });

    const body = await x.ok("active_session", { member: "Hritvik", date: MONDAY }, "hritvik");
    expect(body.active_state).toBe("one");
    expect(body.session.sets).toEqual([expect.objectContaining({ exercise: "Barbell bench press", set_number: 1, reps: 10 })]);
    expect(body.session.next).toMatchObject({ exercise: "Barbell bench press", completed_sets: 1, target_sets: 2, cue: "Private coaching cue", fallback_note: "Private fallback prose" });
    expect(body.stale).toHaveLength(5);
    expect(body.stale.map((v: { date: string }) => v.date)).toEqual(["2026-09-07", "2026-09-06", "2026-09-05", "2026-09-04", "2026-09-03"]);
    expect(body.stale_more).toBe(2);
  });

  it("does not treat confirmed legacy null-ended sessions as active or stale, and redacts coaching prose from another member", async () => {
    const x = setup();
    const s = seedTraining(x);
    const template = seedProgramme(x, s.bench);
    x.t.insert("session", { member_id: x.h.hritvik, performed_on: "2026-10-04", gym_id: s.gym, session_type: "strength", template_id: template, state: "confirmed", confirmed_at: "2026-10-04T08:00:00Z" });
    const draft = (await x.ok("start_session", { origin: "coach", member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper" })).session.id;
    const hers = await x.ok("active_session", { member: "Hritvik", date: MONDAY }, "asha");
    expect(hers.session.id).toBe(draft);
    expect(hers.session.next).toMatchObject({ cue: null, fallback_note: null });
    expect(hers.stale).toEqual([]);
  });

  it("record-only sessions have no next prescription and zero/multiple states are explicit", async () => {
    const x = setup();
    seedTraining(x);
    expect(await x.ok("active_session", { member: "Asha", date: MONDAY }, "asha")).toMatchObject({ active_state: "none", session: null });
    await x.ok("start_session", { origin: "coach", speaker: "Asha", member: "Asha", date: MONDAY, session_type: "strength" });
    await x.ok("start_session", { origin: "coach", speaker: "Asha", member: "Asha", date: MONDAY, session_type: "strength", start_new: true });
    const body = await x.ok("active_session", { member: "Asha", date: MONDAY }, "asha");
    expect(body.active_state).toBe("multiple");
    expect(body.session).toBeNull();
    expect(body.alternatives).toHaveLength(2);
    expect(body.alternatives.every((v: { next: unknown }) => v.next === null)).toBe(true);
  });

  it("bounds active alternatives and refuses creating an eleventh open draft", async () => {
    const x = setup();
    const s = seedTraining(x);
    for (let i = 0; i < 10; i++) x.t.insert("session", {
      member_id: x.h.hritvik, performed_on: MONDAY, gym_id: s.gym, session_type: "strength", state: "draft", confirmed_at: null,
    });
    const active = await x.ok("active_session", { member: "Hritvik", date: MONDAY }, "hritvik");
    expect(active).toMatchObject({ active_state: "multiple", alternatives_truncated: false });
    expect(active.alternatives).toHaveLength(10);
    const reply = await x.call("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength", start_new: true }, "hritvik");
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "too_many_active_sessions" });

    x.t.insert("session", { member_id: x.h.hritvik, performed_on: MONDAY, gym_id: s.gym, session_type: "strength", state: "draft", confirmed_at: null });
    const truncated = await x.ok("active_session", { member: "Hritvik", date: MONDAY }, "hritvik");
    expect(truncated).toMatchObject({ active_state: "multiple", alternatives_truncated: true });
    expect(truncated.alternatives).toHaveLength(10);
  });

  it("caps returned sets per active session and reports truncation", async () => {
    const x = setup();
    const s = seedTraining(x);
    const session = (await x.ok("start_session", { member: "Asha", date: MONDAY, session_type: "strength" }, "asha")).session.id;
    for (let i = 1; i <= 201; i++) x.t.insert("session_set", {
      session_id: session, exercise_id: s.curl, set_number: i, set_type: "working", reps: 10,
      load_status: "not_recorded", rir_status: "not_recorded", state: "confirmed", confirmed_at: "2026-10-05T07:30:00Z", position: i,
    });
    const body = await x.ok("active_session", { member: "Asha", date: MONDAY }, "asha");
    expect(body.session.sets).toHaveLength(200);
    expect(body.session).toMatchObject({ sets_truncated: true, prescriptions_truncated: false });
  });

  it("computes completion from all efforts when the completing set is beyond the 200 returned rows", async () => {
    const x = setup();
    const s = seedTraining(x);
    const template = seedProgramme(x, s.bench);
    const prescription = (x.t.get("SELECT id FROM prescription WHERE template_id = ?", template) as { id: number }).id;
    const session = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper" }, "hritvik")).session.id;
    x.t.insert("session_set", {
      session_id: session, exercise_id: s.bench, position: 1, set_number: 1, set_type: "working", prescription_id: prescription,
      reps: 10, load_status: "none", rir_status: "recorded", rir_low: 2, rir_high: 2, state: "confirmed", confirmed_at: "2026-10-05T07:30:00Z",
    });
    for (let position = 2; position <= 200; position++) x.t.insert("session_set", {
      session_id: session, exercise_id: s.curl, position, set_number: position - 1, set_type: "working",
      reps: 10, load_status: "not_recorded", rir_status: "not_recorded", state: "confirmed", confirmed_at: "2026-10-05T07:30:00Z",
    });
    x.t.insert("session_set", {
      session_id: session, exercise_id: s.bench, position: 201, set_number: 2, set_type: "working", prescription_id: prescription,
      reps: 10, load_status: "none", rir_status: "recorded", rir_low: 2, rir_high: 2, state: "confirmed", confirmed_at: "2026-10-05T07:30:00Z",
    });

    const body = await x.ok("active_session", { member: "Hritvik", date: MONDAY }, "hritvik");
    expect(body.session).toMatchObject({ sets_truncated: true, next: null });
    expect(body.session.sets).toHaveLength(200);
    expect(body.session.sets.some((set: { position: number }) => set.position === 201)).toBe(false);
  });

  it("uses structured continuous targets, substitutions for completion, and canonical set position order", async () => {
    const x = setup();
    const s = seedTraining(x);
    const template = seedProgramme(x, s.bench);
    const rep = (x.t.get("SELECT id FROM prescription WHERE template_id = ? AND position = 1", template) as { id: number }).id;
    const duration = x.t.insert("prescription", {
      template_id: template, position: 2, exercise_id: s.walk, target_kind: "duration", sets: null,
      rep_low: null, rep_high: null, rir_target_low: null, rir_target_high: null,
      duration_low_s: 1200, duration_high_s: 1800,
    });
    const session = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper" }, "hritvik")).session.id;
    for (const position of [2, 3]) x.t.insert("session_set", {
      session_id: session, exercise_id: s.dbBench, position, set_number: position - 1, set_type: "substitution",
      prescription_id: null, substituted_prescription_id: rep, reps: 10, load_status: "none",
      rir_status: "recorded", rir_low: 2, rir_high: 2, state: "confirmed", confirmed_at: "2026-10-05T07:30:00Z",
    });
    const remaining = await x.ok("active_session", { member: "Hritvik", date: MONDAY }, "hritvik");
    expect(remaining.session.next).toMatchObject({
      prescription_id: duration, completed_sets: 0, target_sets: null,
      target: { kind: "duration", low_s: 1200, high_s: 1800 },
    });

    x.t.insert("session_set", {
      session_id: session, exercise_id: s.walk, position: 1, set_number: 1, set_type: "working",
      prescription_id: duration, duration_s: 1200, load_status: "none",
      rir_status: "not_recorded", state: "confirmed", confirmed_at: "2026-10-05T07:30:00Z",
    });
    const complete = await x.ok("active_session", { member: "Hritvik", date: MONDAY }, "hritvik");
    expect(complete.session.next).toBeNull();
    expect(complete.session.sets.map((set: { position: number }) => set.position)).toEqual([1, 2, 3]);
  });

  it("end_session always records the supplied timestamp or the trusted current time", async () => {
    const x = setup();
    seedTraining(x);
    const first = (await x.ok("start_session", { origin: "coach", member: "Hritvik", date: MONDAY, session_type: "strength" })).session.id;
    await x.ok("end_session", { origin: "coach", session_id: first, ended_at: "2026-10-05T08:15:00Z" });
    expect(x.t.get("SELECT ended_at FROM session WHERE id = ?", first)).toEqual({ ended_at: "2026-10-05T08:15:00Z" });

    const second = (await x.ok("start_session", { origin: "coach", member: "Hritvik", date: "2026-10-06", session_type: "strength" })).session.id;
    const future = await x.call("end_session", { origin: "coach", session_id: second });
    expect(future.body).toMatchObject({ status: "needs_clarification", reason: "cannot_end_future_session" });
    expect(x.t.get("SELECT ended_at FROM session WHERE id = ?", second)).toEqual({ ended_at: null });
    const tooEarly = await x.call("end_session", { origin: "coach", session_id: second, ended_at: "2026-10-05T23:59:59Z" });
    expect(tooEarly.body).toMatchObject({ status: "error", error: { code: "end_before_session_date" } });
    await x.ok("end_session", { origin: "coach", session_id: second, ended_at: "2026-10-06T07:30:00Z" });
    expect(x.t.get("SELECT ended_at FROM session WHERE id = ?", second)).toEqual({ ended_at: "2026-10-06T07:30:00Z" });

    x.advanceHours(2);
    await x.ok("end_session", { origin: "coach", session_id: second });
    expect(x.t.get("SELECT ended_at FROM session WHERE id = ?", second)).toEqual({ ended_at: "2026-10-06T07:30:00Z" });
  });

  it("only the session owner or agent may end it, and refusal writes nothing", async () => {
    const x = setup();
    seedTraining(x);
    const session = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength" }, "hritvik")).session.id;
    const reply = await x.call("end_session", { session_id: session }, "asha");
    expect(reply).toMatchObject({ http: 403, body: { status: "error", error: { code: "not_visible" } } });
    expect(x.t.get("SELECT state, ended_at FROM session WHERE id = ?", session)).toEqual({ state: "draft", ended_at: null });
  });

  it("stays within the read query budget and validates an end cannot precede the start", async () => {
    const x = setup();
    seedTraining(x);
    const session = (await x.ok("start_session", {
      origin: "coach", member: "Hritvik", date: MONDAY, session_type: "strength", started_at: "2026-10-05T08:00:00Z",
    })).session.id;
    const run = await x.counted("active_session", { member: "Hritvik", date: MONDAY });
    expect(run.body.active_state).toBe("one");
    expect(run.statements).toBeLessThanOrEqual(30);
    const reply = await x.call("end_session", { origin: "coach", session_id: session, ended_at: "2026-10-05T07:59:59Z" });
    expect(reply.body).toMatchObject({ status: "error", error: { code: "end_before_start" } });
  });
});
