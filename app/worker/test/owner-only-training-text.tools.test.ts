// The free text on training records is household data (Worker decision 167,
// superseding 137), except a schedule swap's reason, a prescription's coach
// notes and phases, which stay their member's alone (decision 135). Another
// member sees the sets, loads, reps, sessions, dates, templates and cardio
// numbers, and now also the session, set, cardio and load-change text. The
// owner and the agent see everything. Invented data only.
import { describe, expect, it } from "vitest";
import { importWrite } from "../src/importing";
import { memberRefusal } from "../src/tools/query";
import { setup, type Harness } from "./harness";
import { seedCatalogue, seedTraining } from "./seed";

const SECRET = "Post blood-draw session, HR 150";
const DAY = "2026-10-05";

async function hritviksTraining(x: Harness) {
  const s = seedTraining(x);
  const r = await importWrite(x.db, "create_programme", {
    member: "Hritvik", name: "Programme", schedule_kind: "weekday", started_on: "2026-09-01",
    templates: [{ name: "Upper", session_type: "strength", prescriptions: [
      { exercise: "Cable lat pulldown", sets: 3, rep_low: 8, rep_high: 12, rir_target_low: 1, rir_target_high: 2, load: { value: 40, unit: "kg", basis: "total", implement: "Lat pulldown stack" } },
    ] }],
    slots: [{ weekday: 1, template: "Upper" }, { weekday: 5, template: "Upper" }],
  }, { at: "2026-10-05T07:00:00Z", origin: { file: "hritvik", tab: "Program", row: 1 } });
  expect(r.status).toBe("ok");
  const prescription = (x.t.get("SELECT id FROM prescription") as { id: number }).id;
  x.t.insert("prescription_fallback", { prescription_id: prescription, exercise_id: s.dbBench, rank: 1, note: `Fallback. ${SECRET}` });
  const set = await x.ok("log_set", { member: "Hritvik", date: DAY, exercise: "Cable lat pulldown", reps: 10, load: { value: 40, unit: "kg", basis: "total" }, rir: 2, note: `Set. ${SECRET}`, reason: `Write reason. ${SECRET}` }, "hritvik");
  const setId = set.set.id as number;
  const sessionId = (x.t.get("SELECT session_id AS s FROM session_set WHERE id = ?", setId) as { s: number }).s;
  await x.ok("amend", { record: { table: "session", id: sessionId }, changes: { note: `Session. ${SECRET}` }, reason: `Amend reason. ${SECRET}` }, "hritvik");
  const cardio = await x.ok("log_cardio", { member: "Hritvik", date: "2026-10-04", session_type: "cardio", note: `Cardio session. ${SECRET}`, blocks: [{ kind: "steady", activity: "walk", duration_s: 1200, avg_hr: 150, note: `Block. ${SECRET}` }] }, "hritvik");
  const block = cardio.blocks[0].id as number;
  const cardioSession = cardio.session.id as number;
  const load = (await x.ok("programme_change", { member: "Hritvik", change: { kind: "load_change", prescription_id: prescription, date: DAY, load: { value: 45, unit: "kg", basis: "total" }, reason: `Load. ${SECRET}` } })).load_change.id as number;
  await x.ok("programme_change", { member: "Hritvik", change: { kind: "swap", date: "2026-10-09", template: null, reason: `Swap. ${SECRET}` } });
  const swap = (x.t.get("SELECT id FROM schedule_swap") as { id: number }).id;
  await x.ok("upsert_phase", { member: "Hritvik", name: "Cut after the blood draw", starts_on: "2026-09-01", ends_on: null, energy_stance: "deficit", intent: SECRET, change_reason: "start cut" });
  return { prescription, setId, sessionId, block, cardioSession, load, swap };
}

const leaks = (body: unknown) => /blood-draw|blood draw|HR 150/.test(JSON.stringify(body));

describe("the free text on Hritvik's training is household data, except the swap reason and coach notes", () => {
  it("history of his session, set, cardio block and load change now carries the text; the swap reason and write reasons stay private", async () => {
    const x = setup();
    const ids = await hritviksTraining(x);
    // Session, set, cardio block and load change: another member now sees the text.
    for (const [table, id] of [["session", ids.sessionId], ["session_set", ids.setId], ["session", ids.cardioSession], ["cardio_block", ids.block], ["load_change", ids.load]] as const) {
      expect([table, leaks(await x.ok("history", { table, id }, "asha"))]).toEqual([table, true]);
    }
    // A write's reason on another member's record is still withheld (decision 137's non-free-text clause).
    for (const [table, id] of [["session", ids.sessionId], ["session_set", ids.setId], ["cardio_block", ids.block], ["load_change", ids.load], ["schedule_swap", ids.swap]] as const) {
      const hers = await x.ok("history", { table, id }, "asha");
      for (const v of hers.versions) {
        expect(v.reason).toBeNull();
        expect(v).toHaveProperty("action");
        expect(v).toHaveProperty("created_at");
      }
    }
    // The swap's own reason stays its member's alone.
    expect(leaks(await x.ok("history", { table: "schedule_swap", id: ids.swap }, "asha"))).toBe(false);
    // What changed stays: the set's reps and load, the block's numbers, and now their text.
    const set = await x.ok("history", { table: "session_set", id: ids.setId }, "asha");
    expect(set.versions[0].data).toMatchObject({ reps: 10, load_value: 40, note: expect.stringContaining(SECRET) });
    const block = await x.ok("history", { table: "cardio_block", id: ids.block }, "asha");
    expect(block.versions[0].data).toMatchObject({ duration_s: 1200, avg_hr: 150, note: expect.stringContaining(SECRET) });
    const session = await x.ok("history", { table: "session", id: ids.sessionId }, "asha");
    expect(session.versions.map((v: { action: string; actor: string | null }) => [v.action, v.actor])).toEqual([["create", "Hritvik"], ["amend", "Hritvik"]]);
    for (const as of ["hritvik", "agent"] as const) expect([as, leaks(await x.ok("history", { table: "session", id: ids.sessionId }, as))]).toEqual([as, true]);
  });

  it("a write's reason stays on household records, and on your own", async () => {
    const x = setup();
    await hritviksTraining(x);
    await seedCatalogue(x);
    const cook = (await x.ok("household_meal", { date: DAY, meal_slot: "lunch", reason: "Household reason", cooks: [{ name: "Invented dal", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }] }] }, "hritvik")).cooks[0].id as number;
    expect((await x.ok("history", { table: "cook", id: cook }, "asha")).versions[0].reason).toBe("Household reason");
    const mine = await x.ok("log_set", { member: "Asha", date: DAY, exercise: "Dumbbell curl", reps: 12, load: { value: 5, unit: "kg", basis: "total" }, rir: 2, reason: "Her own reason" }, "asha");
    expect((await x.ok("history", { table: "session_set", id: mine.set.id }, "asha")).versions[0].reason).toBe("Her own reason");
  });

  it("amend of his session shows before and after with his note now (household data)", async () => {
    const x = setup();
    const ids = await hritviksTraining(x);
    const r = await x.ok("amend", { record: { table: "session", id: ids.sessionId }, changes: { energy_kcal: 300 }, reason: "invented" }, "asha");
    expect(r.before.note).toContain(SECRET);
    expect(r.after).toMatchObject({ energy_kcal: 300, note: expect.stringContaining(SECRET) });
    expect(x.t.get("SELECT note FROM session WHERE id = ?", ids.sessionId)).toEqual({ note: `Session. ${SECRET}` });
  });

  it("programme keeps swap reasons, phases and coach notes for their member alone, and now returns the load-change reason", async () => {
    const x = setup();
    const ids = await hritviksTraining(x);
    const hers = await x.ok("programme", { member: "Hritvik", date: DAY }, "asha");
    expect(hers.swaps).toEqual([{ date: "2026-10-09", template: null, reason: null }]);
    expect(hers.phases).toEqual([]);
    expect(hers.current_phase).toBeNull();
    expect(hers.templates[0].prescriptions[0].exercise).toBe("Cable lat pulldown");
    // A coach note stays its member's alone (decision 135); the load-change reason is household data now (167).
    expect(hers.templates[0].prescriptions[0]).toMatchObject({ cue: null, fallback_note: null });
    expect(hers.templates[0].prescriptions[0].load_history[0]).toMatchObject({ reason: expect.stringContaining(SECRET) });
    expect(leaks(hers)).toBe(true);
    const sub = await x.ok("substitute", { prescription_id: ids.prescription }, "asha");
    expect(sub.options[0]).toMatchObject({ exercise: "Dumbbell bench press", source: "fallback", note: null });
    expect(leaks(sub)).toBe(false);
    const his = await x.ok("programme", { member: "Hritvik", date: DAY }, "hritvik");
    expect(his.swaps[0].reason).toContain(SECRET);
    expect(his.current_phase.name).toBe("Cut after the blood draw");
    expect(his.templates[0].prescriptions[0].load_history[0].reason).toContain(SECRET);
    expect((await x.ok("substitute", { prescription_id: ids.prescription }, "hritvik")).options[0].note).toContain(SECRET);
  });

  it("query refuses v_session (phase names) and v_cardio_block (notes) to members; the agent reads them", async () => {
    const x = setup();
    await hritviksTraining(x);
    for (const view of ["v_session", "v_cardio_block"]) {
      const r = await x.call("query", { sql: `SELECT * FROM ${view}` }, "asha");
      expect([view, r.http, r.body.error?.code]).toEqual([view, 403, "not_visible"]);
      expect(leaks((await x.ok("query", { sql: `SELECT * FROM ${view}` })).rows)).toBe(true);
    }
    // v_set has no text (members are refused query altogether, decision 136).
    expect(leaks((await x.ok("query", { sql: "SELECT * FROM v_set" })).rows)).toBe(false);
    expect((await x.ok("query", { sql: "SELECT reps, load_value FROM v_set" })).rows).toContainEqual({ reps: 10, load_value: 40 });
    // The gate a member-facing query would pass names both views.
    expect(memberRefusal("SELECT * FROM v_session JOIN v_cardio_block USING (id)", ["v_session", "v_cardio_block"], new Set())).toEqual(["v_session", "v_cardio_block"]);
  });

  it("the screens' reads carry his training, and now its text where it belongs", async () => {
    const x = setup();
    await hritviksTraining(x);
    // The summary reads stay names, dates and numbers (no free text).
    const summaries: [string, Record<string, unknown>][] = [
      ["last_trained", { member: "Hritvik" }],
      ["household_overview", { date: DAY }],
      ["needs_you", { member: "Hritvik", date: DAY }],
      ["next_prescription", { member: "Hritvik", date: DAY }],
    ];
    for (const [tool, input] of summaries) expect([tool, leaks(await x.ok(tool, input, "asha"))]).toEqual([tool, false]);
    // lift_history lists each set as log_set describes it, so it carries the set note to another member now (167).
    expect(leaks(await x.ok("lift_history", { member: "Hritvik", pattern: "pulldown" }, "asha"))).toBe(true);
    // sessions now returns the training's text to another member (decision 167).
    const sessions = await x.ok("sessions", { member: "Hritvik", from: "2026-09-01", to: DAY }, "asha");
    expect(sessions.sessions.map((s: { date: string }) => s.date)).toEqual([DAY, "2026-10-04"]);
    expect(sessions.sessions[0].sets[0]).toMatchObject({ reps: 10, load_value: 40, note: expect.stringContaining(SECRET) });
    // The cardio block's note among the block ids (block_ids, decision 145, are ids, not text).
    expect(sessions.sessions[1].cardio).toMatchObject({ blocks: 1, duration_s: 1200, block_ids: [expect.any(Number)] });
    expect(sessions.sessions[1].cardio.notes[0]).toContain(SECRET);
    expect(leaks(sessions)).toBe(true);
    expect((await x.call("week_summary", { member: "Hritvik" }, "asha")).http).toBe(403);
  });
});
