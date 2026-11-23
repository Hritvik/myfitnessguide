// needs_you: what needs a member, ranked server-side (spec §4), with its
// visibility boundary: flags and measurements only for the member and the agent.
import { describe, expect, it } from "vitest";
import { autoConfirmBlock, autoConfirmDeadline } from "../src/autoconfirm";
import { Ctx } from "../src/context";
import { householdDrafts } from "../src/drafts";
import { setup, type Harness } from "./harness";
import { seedCatalogue, seedTraining } from "./seed";

const TODAY = "2026-10-05";
const YESTERDAY = "2026-10-04";

const curd = (value: number) => ({ source: "food", food: "curd", value, unit: "g", provenance: "weighed", confidence: "high" });

/** A cable stack whose top is unknown, and Upper A on Mondays with a smallest-step rule on it. */
function rowProgramme(x: Harness, s: ReturnType<typeof seedTraining>) {
  const row = x.t.insert("implement", { gym_id: s.gym, name: "Row stack", kind: "cable", unit: "kg", loading: "total", load_list_complete: 0 });
  for (const load of [30, 35, 40]) x.t.insert("implement_load", { implement_id: row, load, unit: "kg" });
  const exercise = x.t.insert("exercise", { household_id: x.h.id, name: "Cable row", implement_kind: "cable" });
  const programme = x.t.insert("programme", { member_id: x.h.hritvik, name: "Base", schedule_kind: "weekday", active: 1, started_on: "2026-09-01" });
  const upper = x.t.insert("session_template", { programme_id: programme, name: "Upper A", session_type: "strength" });
  x.t.insert("schedule_slot", { programme_id: programme, weekday: 1, template_id: upper });
  x.t.insert("prescription", {
    template_id: upper, position: 1, exercise_id: exercise, sets: 3, rep_low: 10, rep_high: 12, rir_target_low: 1, rir_target_high: 2,
    load_value: 40, load_unit: "kg", load_basis: "total", load_implement_id: row,
    progression_rule: JSON.stringify({ kind: "rep_top", target_sets: 3, rep_top: 12, rir_floor: 1, increment: "smallest_step" }),
  });
  return row;
}

async function everyRule(x: Harness, s: ReturnType<typeof seedTraining> = seedTraining(x)) {
  await seedCatalogue(x);
  const row = rowProgramme(x, s);
  // 4: three top sets today, so next Monday's Upper A proposes an unverified 45 kg.
  const session = (await x.ok("start_session", { member: "Hritvik", date: TODAY, session_type: "strength", template: "Upper A" })).session.id;
  for (let i = 0; i < 3; i++) await x.ok("log_set", { session_id: session, exercise: "Cable row", reps: 12, rir: 2, load: { value: 40, unit: "kg", basis: "total", implement: row } });
  await x.ok("end_session", { session_id: session });
  // 1: Asha logs a curd for Hritvik from the app: a draft about him.
  await x.ok("log_intake", { member: "Hritvik", date: TODAY, meal_slot: "snack", items: [curd(100)] }, "asha");
  // 2: a pot Hritvik ate half of; the rest is unaccounted.
  await x.ok("household_meal", {
    date: TODAY, meal_slot: "dinner",
    cooks: [{ name: "Masoor dal", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }] }],
  }, "hritvik");
  // 3: something logged yesterday, and the day never closed.
  await x.ok("log_intake", { member: "Hritvik", date: YESTERDAY, meal_slot: "lunch", items: [curd(150)] });
  // 5: a flag due in four days.
  await x.ok("raise_flag", { member: "Hritvik", subtype: "health_watch", subject: "Repeat the thyroid panel", due_on: "2026-10-09" });
  // 6: a cadence never done.
  await x.ok("set_measurement_cadence", { member: "Hritvik", name: "waist", every_days: 7, source: { kind: "reading", metric: "waist_navel" }, message: "Waist is overdue." });
}

const rules = (cards: { rule: string }[]) => cards.map((c) => c.rule);

describe("needs_you", () => {
  it("ranks every rule in the spec's order, three cards and the rest in more", async () => {
    const x = setup();
    await everyRule(x);
    const body = await x.ok("needs_you", { member: "Hritvik" }, "hritvik");
    expect(body.date).toBe(TODAY);
    expect(rules(body.cards)).toEqual(["drafts", "remainder", "yesterday_open"]);
    expect(rules(body.more)).toEqual(["load", "flag", "measurement"]);
    const [drafts, remainder, yesterday] = body.cards;
    expect(drafts).toMatchObject({ count: 1, oldest: { table: "intake_item", deadline: "2026-10-07T07:30:00Z", waits: null } });
    expect(remainder).toMatchObject({ cook: "Masoor dal", component: null, fraction: 0.5 });
    expect(typeof remainder.component_id).toBe("number");
    expect(yesterday).toMatchObject({ date: YESTERDAY, items: 1 });
    const [load, flag, measurement] = body.more;
    expect(load).toMatchObject({ session: "Upper A", date: "2026-10-12", prescriptions: [{ exercise: "Cable row", state: { kind: "check_at_gym", next_load: { value: 45, unit: "kg" } } }] });
    expect(flag).toMatchObject({ subject: "Repeat the thyroid panel", due_on: "2026-10-09", more: 0 });
    expect(measurement).toMatchObject({ cadence: "waist", last: null, message: "Waist is overdue." });
  });

  it("is empty when nothing is due", async () => {
    const x = setup();
    const body = await x.ok("needs_you", { member: "Hritvik" }, "hritvik");
    expect(body).toMatchObject({ cards: [], more: [] });
  });

  it("never shows another member's flags or measurements; the agent sees them", async () => {
    const x = setup();
    await everyRule(x);
    const asAsha = await x.ok("needs_you", { member: "Hritvik" }, "asha");
    expect([...rules(asAsha.cards), ...rules(asAsha.more)]).toEqual(["drafts", "remainder", "yesterday_open", "load"]);
    const asAgent = await x.ok("needs_you", { member: "Hritvik" }, "agent");
    expect([...rules(asAgent.cards), ...rules(asAgent.more)]).toContain("flag");
  });

  it("closing yesterday clears that card; the remainder card is only for someone who ate from the pot", async () => {
    const x = setup();
    await everyRule(x);
    await x.ok("set_day_status", { member: "Hritvik", date: YESTERDAY, status: "complete" });
    const body = await x.ok("needs_you", { member: "Hritvik" }, "hritvik");
    expect([...rules(body.cards), ...rules(body.more)]).not.toContain("yesterday_open");
    const asha = await x.ok("needs_you", { member: "Asha" }, "asha");
    expect([...rules(asha.cards), ...rules(asha.more)]).not.toContain("remainder");
  });
});

describe("needs_you drafts and owner-only records", () => {
  it("never counts another member's owner-only drafts (a reading, a blood draw) for someone who may not see them", async () => {
    const x = setup();
    await seedCatalogue(x);
    await x.ok("log_intake", { member: "Hritvik", date: TODAY, meal_slot: "snack", items: [curd(100)] }, "asha");
    // The agent, talking with Asha, logs a weight and a blood draw about Hritvik: owner-only drafts about him.
    await x.ok("log_reading", { member: "Hritvik", date: TODAY, metric: "weight", value: 78.2, unit: "kg", body_state: "fasted", speaker: "Asha" });
    await x.ok("log_blood_draw", { member: "Hritvik", date: TODAY, lab: "Thyrocare", results: [{ marker: "TSH", value: 2.1, unit: "mIU/L" }], speaker: "Asha" });
    const asAsha = await x.ok("needs_you", { member: "Hritvik" }, "asha");
    expect(asAsha.cards[0]).toMatchObject({ rule: "drafts", count: 1, oldest: { table: "intake_item" } });
    const asHritvik = await x.ok("needs_you", { member: "Hritvik" }, "hritvik");
    expect(asHritvik.cards[0]).toMatchObject({ rule: "drafts", count: 3 });
    expect((await x.ok("needs_you", { member: "Hritvik" }, "agent")).cards[0]).toMatchObject({ rule: "drafts", count: 3 });
  });
});

describe("the auto-confirm rule, shared with the cron", () => {
  it("blocks Coach-mode drafts and sets with blank RIR, and dates every other draft 48 h after its latest version", () => {
    expect(autoConfirmBlock("session_set", { rir_status: null }, "coach")).toBe("coach_until_end_session");
    expect(autoConfirmBlock("session_set", { rir_status: null }, "live")).toBe("rir_blank");
    expect(autoConfirmBlock("session_set", { rir_status: "recorded" }, "live")).toBeNull();
    expect(autoConfirmBlock("intake_item", {}, "inbox")).toBeNull();
    expect(autoConfirmDeadline("2026-10-05T07:30:00Z")).toBe("2026-10-07T07:30:00Z");
  });
});

describe("householdDrafts", () => {
  function agentCtx(x: Harness): Ctx {
    return new Ctx(x.db, { kind: "agent", resolver: "claude_code", householdId: x.h.id, clientId: "test" }, () => x.clock.now, "Asia/Kolkata");
  }

  it("gives a Coach-mode draft and a set with blank RIR no deadline, with the reason; others 48 h after their latest version", async () => {
    const x = setup();
    const s = seedTraining(x);
    await seedCatalogue(x);
    const coach = (await x.ok("start_session", { origin: "coach", member: "Hritvik", date: TODAY, session_type: "strength" })).session.id;
    await x.ok("log_set", { origin: "coach", session_id: coach, exercise: "lat pulldown", reps: 10, load: { value: 40, unit: "kg", basis: "total", implement: s.stack } });
    x.advanceHours(1);
    // The agent talking with Asha logs a set about Hritvik with no RIR: a live draft that needs RIR.
    const live = (await x.ok("start_session", { member: "Hritvik", date: TODAY, session_type: "strength", speaker: "Asha", start_new: true })).session.id;
    await x.ok("log_set", { session_id: live, exercise: "lat pulldown", reps: 10, load: { value: 40, unit: "kg", basis: "total", implement: s.stack }, speaker: "Asha" });
    x.advanceHours(1);
    await x.ok("log_intake", { member: "Hritvik", date: TODAY, meal_slot: "lunch", items: [curd(100)] }, "asha");

    const drafts = await householdDrafts(agentCtx(x));
    expect(drafts.map((d) => [d.table, d.waits, d.deadline])).toEqual([
      ["session", "end_of_session", null],
      ["session_set", "end_of_session", null],
      ["session", null, "2026-10-07T08:30:00Z"],
      ["session_set", "rir_needed", null],
      ["intake_item", null, "2026-10-07T09:30:00Z"],
    ]);
    expect(drafts.every((d) => d.owner === x.h.hritvik)).toBe(true);
    expect(drafts.at(-1)?.loggedBy).toBe(x.h.asha);
    // The oldest of Hritvik's drafts never auto-confirms, so the card carries its reason.
    const body = await x.ok("needs_you", { member: "Hritvik" }, "hritvik");
    expect(body.cards[0]).toMatchObject({ rule: "drafts", count: 5, oldest: { table: "session", deadline: null, waits: "end_of_session" } });
  });
});

describe("the drafts card's wording (regression for 8cfa066)", () => {
  it("says 'needs RIR' only for a set waiting on RIR; a draft reading with no deadline waits for them", async () => {
    const x = setup();
    const s = seedTraining(x);
    // A confirmed session, then the agent talking with Asha logs a set about Hritvik with no RIR: it needs RIR.
    const session = x.t.insert("session", { member_id: x.h.hritvik, performed_on: TODAY, gym_id: s.gym, session_type: "strength", state: "confirmed", confirmed_at: "2026-10-05T00:00:00Z" });
    await x.ok("log_set", { session_id: session, exercise: "lat pulldown", reps: 10, load: { value: 40, unit: "kg", basis: "total", implement: s.stack }, speaker: "Asha" });
    const set = await x.ok("needs_you", { member: "Hritvik" }, "hritvik");
    expect(set.cards[0]).toMatchObject({ rule: "drafts", count: 1, oldest: { table: "session_set", deadline: null, waits: "rir_needed" } });
    expect(set.cards[0].message).toBe("1 draft about Hritvik; the oldest needs RIR.");

    // A draft reading with no version yet (no deadline, no wait reason) is the oldest: never "needs RIR".
    const y = setup();
    y.t.insert("reading", { member_id: y.h.hritvik, metric: "weight", measured_on: TODAY, value: 78, unit: "kg", body_state: "fasted", measurer: "self", suspect: 0, state: "draft" });
    const reading = await y.ok("needs_you", { member: "Hritvik" }, "hritvik");
    expect(reading.cards[0]).toMatchObject({ rule: "drafts", count: 1, oldest: { table: "reading", deadline: null, waits: null } });
    expect(reading.cards[0].message).toBe("1 draft about Hritvik; the oldest waits for them.");
    expect(reading.cards[0].message).not.toMatch(/RIR/);
  });
});
