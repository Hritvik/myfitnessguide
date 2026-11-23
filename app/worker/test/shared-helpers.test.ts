// The helpers several tools share: which session is next, when a cadence
// was last done, and a prescription's progression state. Each tool that
// reads them must agree with the helper.
import { describe, expect, it } from "vitest";
import { Ctx } from "../src/context";
import { cadenceStatus, nextSessionPlan, prescriptionById, prescriptionState, progressionOf } from "../src/training";
import { setup, type Harness } from "./harness";
import { seedTraining } from "./seed";

const MONDAY = "2026-10-05";

function agentCtx(x: Harness): Ctx {
  return new Ctx(x.db, { kind: "agent", resolver: "claude_code", householdId: x.h.id, clientId: "test" }, () => x.clock.now, "Asia/Kolkata");
}

/** Upper A on Monday, Lower A on Tuesday; the pulldown has a 5 kg rep-top rule. */
function seedProgramme(x: Harness, s: ReturnType<typeof seedTraining>) {
  const { t, h } = x;
  const programme = t.insert("programme", { member_id: h.hritvik, name: "Base", schedule_kind: "weekday", active: 1, started_on: "2026-09-01" });
  const upper = t.insert("session_template", { programme_id: programme, name: "Upper A", session_type: "strength" });
  const lower = t.insert("session_template", { programme_id: programme, name: "Lower A", session_type: "strength" });
  t.insert("schedule_slot", { programme_id: programme, weekday: 1, template_id: upper });
  t.insert("schedule_slot", { programme_id: programme, weekday: 2, template_id: lower });
  const pulldown = t.insert("prescription", {
    template_id: upper, position: 1, exercise_id: s.pulldown, sets: 3, rep_low: 10, rep_high: 12, rir_target_low: 1, rir_target_high: 2,
    load_value: 40, load_unit: "kg", load_basis: "total", load_implement_id: s.stack,
    progression_rule: JSON.stringify({ kind: "rep_top", target_sets: 3, rep_top: 12, rir_floor: 1, increment: { min: 5 } }),
  });
  const calf = t.insert("prescription", {
    template_id: lower, position: 1, exercise_id: s.calf, sets: 2, rep_low: 12, rep_high: 15, rir_target_low: 1, rir_target_high: 2,
    load_value: 10, load_unit: "kg", load_basis: "per_leg", load_implement_id: s.dumbbells,
  });
  return { programme, upper, lower, pulldown, calf };
}

const stack = (s: ReturnType<typeof seedTraining>) => ({ value: 40, unit: "kg", basis: "total", implement: s.stack });

describe("nextSessionPlan", () => {
  it("is what next_prescription and inventory_gaps name, before and after training today", async () => {
    const x = setup();
    const s = seedTraining(x);
    seedProgramme(x, s);
    const ctx = agentCtx(x);

    const before = await nextSessionPlan(ctx, x.h.hritvik, MONDAY);
    expect(before?.next).toEqual({ session: "Upper A", date: MONDAY });
    expect((await x.ok("next_prescription", { member: "Hritvik", date: MONDAY })).session).toBe("Upper A");
    expect((await x.ok("inventory_gaps", { member: "Hritvik", date: MONDAY })).next_session).toBe("Upper A");

    const session = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper A" })).session.id;
    await x.ok("log_set", { session_id: session, exercise: "lat pulldown", reps: 10, rir: { low: 1, high: 2 }, load: stack(s) });

    const after = await nextSessionPlan(ctx, x.h.hritvik, MONDAY);
    expect(after?.next).toEqual({ session: "Lower A", date: "2026-10-06" });
    expect(after?.prescriptions.filter((p) => p.template_id === after.templateId).map((p) => p.exercise_name)).toEqual(["Single-leg calf raise"]);
    expect((await x.ok("next_prescription", { member: "Hritvik", date: MONDAY })).session).toBe("Lower A");
    expect((await x.ok("inventory_gaps", { member: "Hritvik", date: MONDAY })).next_session).toBe("Lower A");
  });

  it("is null without an active programme", async () => {
    const x = setup();
    seedTraining(x);
    expect(await nextSessionPlan(agentCtx(x), x.h.hritvik, MONDAY)).toBeNull();
  });
});

describe("cadenceStatus", () => {
  it("gives each active cadence's last date, the same one staleness reports", async () => {
    const x = setup();
    seedTraining(x);
    await x.ok("set_measurement_cadence", { member: "Hritvik", name: "waist", every_days: 7, source: { kind: "reading", metric: "waist_navel" }, message: "Waist is overdue." });
    await x.ok("set_measurement_cadence", { member: "Hritvik", name: "photos", every_days: 28, source: { kind: "manual" }, message: "No photos yet." });
    await x.ok("log_reading", { member: "Hritvik", date: "2026-09-20", metric: "waist_navel", value: 88, unit: "cm", body_state: "fasted" });

    const status = await cadenceStatus(agentCtx(x), x.h.hritvik, MONDAY);
    expect(status.map((s) => [s.cadence.name, s.last])).toEqual([["waist", "2026-09-20"], ["photos", null]]);
    const tool = await x.ok("staleness", { member: "Hritvik", date: MONDAY });
    expect(tool.cadences.map((c: { name: string; last: string | null }) => [c.name, c.last])).toEqual([["waist", "2026-09-20"], ["photos", null]]);
  });
});

describe("prescriptionState", () => {
  it("maps every verdict to the chip the app shows", () => {
    const base = { session_id: 1 };
    expect(prescriptionState({ ...base, verdict: "fired", reason: "rule_met", message: "m", nextLoad: 45, nextLoadUnit: "kg" }, "Lat pulldown stack"))
      .toEqual({ kind: "ready", next_load: { value: 45, unit: "kg", plates: null } });
    expect(prescriptionState({ ...base, verdict: "fired", reason: "rule_met", message: "m", nextLoad: 45, nextLoadUnit: "kg", unverified: true, offer: { if_exists: {} } }, "Row stack"))
      .toEqual({ kind: "check_at_gym", question: "Is there a 45 kg on the Row stack?", next_load: { value: 45, unit: "kg", plates: null }, offer: { if_exists: {} } });
    expect(prescriptionState({ ...base, verdict: "needs_confirmation", reason: "reps_inferred", message: "m", inferredSets: [2], confirm_set_ids: [9], nextLoad: 45, nextLoadUnit: "kg" }, null))
      .toEqual({ kind: "needs_confirmation", set_ids: [9], next_load: { value: 45, unit: "kg", plates: null } });
    expect(prescriptionState({ ...base, verdict: "not_yet", reason: "ground_out", message: "a set was ground out", autoregulation: null }, null))
      .toEqual({ kind: "holding", reason: "a set was ground out" });
    expect(prescriptionState({ ...base, verdict: "never", reason: "no_rule", message: "this prescription has no progression rule" }, null))
      .toEqual({ kind: "cant_move", reason: "this prescription has no progression rule" });
  });

  it("progressionOf is check_progression plus the state", async () => {
    const x = setup();
    const s = seedTraining(x);
    const p = seedProgramme(x, s);
    const session = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper A" })).session.id;
    for (let i = 0; i < 3; i++) await x.ok("log_set", { session_id: session, exercise: "lat pulldown", reps: 12, rir: { low: 1, high: 2 }, load: stack(s) });
    const ctx = agentCtx(x);
    const out = await progressionOf(ctx, await prescriptionById(ctx, p.pulldown));
    const tool = await x.ok("check_progression", { prescription_id: p.pulldown });
    expect(out.progression).toMatchObject({ verdict: tool.verdict, nextLoad: tool.nextLoad });
    expect(out.state).toEqual({ kind: "ready", next_load: { value: 45, unit: "kg", plates: null } });
  });
});
