import { describe, expect, it } from "vitest";
import { autoConfirm } from "../src/autoconfirm";
import { toolWithinBudget } from "./budget";
import { setup, type Harness } from "./harness";
import { seedCatalogue, seedTraining } from "./seed";

const DAY = "2026-10-05";
const rice = (value: number) => ({ source: "food", food: "FS002", value, unit: "g", provenance: "weighed", confidence: "high" });

async function ready() {
  const x = setup();
  await seedCatalogue(x);
  return x;
}

const run = (x: Harness) => autoConfirm(x.db, x.clock.now);

describe("amend keeps every version", () => {
  it("accepts the plural intake_items compatibility name and returns the canonical table", async () => {
    const x = await ready();
    const logged = await x.ok("log_intake", { member: "Hritvik", date: DAY, meal_slot: "lunch", items: [rice(150)] });
    const id = logged.items[0].id;
    const amended = await x.ok("amend", { record: { table: "intake_items", id }, changes: { amount_value: 200 }, reason: "compatibility client" });
    const history = await x.ok("history", { table: "intake_items", id });

    expect(amended).toMatchObject({ record: { table: "intake_item", id }, after: { amount_value: 200 } });
    expect(history).toMatchObject({ table: "intake_item", id });
  });

  it("changes a record with a reason, returns what it recomputed, and keeps the history", async () => {
    const x = await ready();
    const logged = await x.ok("log_intake", { member: "Hritvik", date: DAY, meal_slot: "lunch", items: [rice(150)] });
    const id = logged.items[0].id;
    const body = await x.ok("amend", { record: { table: "intake_item", id }, changes: { amount_value: 200 }, reason: "weighed the bowl again" });
    expect(body).toMatchObject({ version: 2, after: { amount_value: 200 }, before: { amount_value: 150 } });
    expect(body.computed.nutrients.kcal.value).toBeCloseTo(240, 9);
    const history = await x.ok("history", { table: "intake_item", id });
    expect(history.versions.map((v: { action: string; reason: string }) => [v.action, v.reason])).toEqual([
      ["create", "log_intake (live)"],
      ["amend", "weighed the bowl again"],
    ]);
    expect(history.versions[0].data.amount_value).toBe(150);
  });

  it("refuses a field that isn't amendable", async () => {
    const x = await ready();
    const logged = await x.ok("log_intake", { member: "Hritvik", date: DAY, meal_slot: "lunch", items: [rice(150)] });
    const reply = await x.call("amend", { record: { table: "intake_item", id: logged.items[0].id }, changes: { member_id: 2 }, reason: "x" });
    expect(reply.http).toBe(400);
    expect(reply.body.error.code).toBe("not_amendable");
  });

  it("recomputes a set's total, volume and e1RM", async () => {
    const x = setup();
    const s = seedTraining(x);
    const session = (await x.ok("start_session", { member: "Hritvik", date: DAY, session_type: "strength" })).session.id;
    const set = await x.ok("log_set", { session_id: session, exercise: "lat pulldown", reps: 10, rir: { low: 1, high: 2 }, load: { value: 40, unit: "kg", basis: "total", implement: s.stack } });
    const body = await x.ok("amend", { record: { table: "session_set", id: set.set.id }, changes: { reps: 12 }, reason: "miscounted" });
    expect(body.computed).toMatchObject({ total_kg: 40, volume_kg: 480 });
  });

  it("asks when amended portions would add up to more than the whole", async () => {
    const x = await ready();
    const meal = await x.ok("household_meal", {
      date: DAY, meal_slot: "dinner",
      cooks: [{ name: "Dal", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [
        { member: "Hritvik", fraction: 0.5, provenance: "estimated" },
        { member: "Asha", fraction: 0.4, provenance: "estimated" },
      ] }],
    });
    const portion = meal.cooks[0].portions[0].id;
    const reply = await x.call("amend", { record: { table: "portion", id: portion }, changes: { fraction: 0.7 }, reason: "had seconds" });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "portions_exceed_whole" });
    const ok = await x.ok("amend", { record: { table: "portion", id: portion }, changes: { fraction: 0.6 }, reason: "had seconds" });
    expect(ok.computed.nutrients.kcal.value).toBeCloseTo(324 * 0.6, 9);
    expect(ok.computed.remainder).toEqual([]);
  });

  it("the member's own edit of a draft confirms it", async () => {
    const x = await ready();
    const logged = await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "lunch", items: [rice(150)] });
    expect(logged.items[0].state).toBe("draft");
    const body = await x.ok("amend", { record: { table: "intake_item", id: logged.items[0].id }, changes: { amount_value: 120 }, reason: "smaller bowl" }, "asha");
    expect(body.after.state).toBe("confirmed");
  });
});

describe("confirm and reject", () => {
  it("normalizes intake_items for confirm and reject", async () => {
    const x = await ready();
    const first = await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "lunch", items: [rice(150)] });
    const second = await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "dinner", items: [rice(100)] });

    expect((await x.ok("confirm", { records: [{ table: "intake_items", id: first.items[0].id }] }, "asha")).confirmed)
      .toEqual([{ table: "intake_item", id: first.items[0].id }]);
    expect((await x.ok("reject", { records: [{ table: "intake_items", id: second.items[0].id }], reason: "compatibility client" }, "asha")).rejected)
      .toEqual([{ table: "intake_item", id: second.items[0].id }]);
  });

  it("the member confirms a draft about them; nobody else can", async () => {
    const x = await ready();
    const logged = await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "lunch", items: [rice(150)] });
    const record = { table: "intake_item", id: logged.items[0].id };
    const refused = await x.call("confirm", { records: [record] }, "hritvik");
    expect(refused.http).toBe(403);
    const body = await x.ok("confirm", { records: [record] }, "asha");
    expect(body.confirmed).toEqual([record]);
    const items = await x.ok("day_items", { member: "Asha", date: DAY });
    expect(items.items[0].state).toBe("confirmed");
  });

  it("the agent confirms a draft while talking with that member", async () => {
    const x = await ready();
    const logged = await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "lunch", items: [rice(150)] });
    const body = await x.ok("confirm", { speaker: "Asha", records: [{ table: "intake_item", id: logged.items[0].id }] });
    expect(body.confirmed).toHaveLength(1);
  });

  it("rejecting a draft deletes it and keeps its last content as a version", async () => {
    const x = await ready();
    const logged = await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "lunch", items: [rice(150)] });
    const id = logged.items[0].id;
    const body = await x.ok("reject", { records: [{ table: "intake_item", id }], reason: "I didn't eat that" }, "asha");
    expect(body.rejected).toEqual([{ table: "intake_item", id }]);
    expect((await x.ok("day_items", { member: "Asha", date: DAY })).items).toEqual([]);
    const history = await x.ok("history", { table: "intake_item", id });
    expect(history.versions.at(-1)).toMatchObject({ action: "reject", reason: "I didn't eat that" });
  });

  it("rejecting a draft portion removes its intake item too", async () => {
    const x = await ready();
    const meal = await x.ok("household_meal", {
      date: DAY, meal_slot: "dinner",
      cooks: [{ name: "Dal", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [
        { member: "Hritvik", fraction: 0.5, provenance: "estimated" },
        { member: "Asha", fraction: 0.5, provenance: "estimated" },
      ] }],
    });
    const asha = meal.cooks[0].portions[1];
    await x.ok("reject", { records: [{ table: "portion", id: asha.id }], reason: "wasn't home" }, "asha");
    expect((await x.ok("day_totals", { member: "Asha", date: DAY })).source).toBe("empty");
  });

  it("a confirmed record cannot be rejected", async () => {
    const x = await ready();
    const logged = await x.ok("log_intake", { member: "Hritvik", date: DAY, meal_slot: "lunch", items: [rice(150)] });
    const reply = await x.call("reject", { records: [{ table: "intake_item", id: logged.items[0].id }], reason: "x" });
    expect(reply.http).toBe(409);
  });
});

describe("auto-confirm after 48 h (a Cron Trigger calls autoConfirm with its clock)", () => {
  it("confirms drafts older than 48 h, as the system with provenance inferred, and leaves newer ones", async () => {
    const x = await ready();
    const old = await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "lunch", items: [rice(150)] });
    x.advanceHours(24);
    const newer = await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "dinner", items: [rice(100)] });
    x.advanceHours(24);
    expect((await run(x)).confirmed).toEqual([{ table: "intake_item", id: old.items[0].id }]);
    const history = await x.ok("history", { table: "intake_item", id: old.items[0].id });
    expect(history.versions.at(-1)).toMatchObject({ action: "confirm", resolver: "system", origin: "auto_confirm", resolver_detail: "provenance: inferred" });
    x.advanceHours(24);
    expect((await run(x)).confirmed).toEqual([{ table: "intake_item", id: newer.items[0].id }]);
    expect((await run(x)).confirmed).toEqual([]);
  });

  it("does not run before 48 h have passed", async () => {
    const x = await ready();
    await x.ok("log_intake", { origin: "inbox", member: "Hritvik", date: DAY, meal_slot: "lunch", items: [rice(150)] });
    x.advanceHours(47.9);
    expect((await run(x)).confirmed).toEqual([]);
  });

  it("an edit restarts the 48 h", async () => {
    const x = await ready();
    const logged = await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "lunch", items: [rice(150)] });
    x.advanceHours(40);
    await x.ok("amend", { record: { table: "intake_item", id: logged.items[0].id }, changes: { amount_value: 120 }, reason: "Asha says less" });
    x.advanceHours(10);
    expect((await run(x)).confirmed).toEqual([]);
    x.advanceHours(40);
    expect((await run(x)).confirmed).toHaveLength(1);
  });

  it("never auto-confirms Coach-mode sets, which wait for end_session", async () => {
    const x = setup();
    const s = seedTraining(x);
    const session = (await x.ok("start_session", { origin: "coach", member: "Hritvik", date: DAY, session_type: "strength" })).session.id;
    await x.ok("log_set", { origin: "coach", session_id: session, exercise: "lat pulldown", reps: 10, rir: { low: 1, high: 2 }, load: { value: 40, unit: "kg", basis: "total", implement: s.stack } });
    x.advanceHours(100);
    expect((await run(x)).confirmed).toEqual([]);
  });

  it("a draft set without RIR is skipped, not confirmed blank", async () => {
    const x = setup();
    const s = seedTraining(x);
    const session = (await x.ok("start_session", { member: "Kabir", date: DAY, session_type: "strength", gym: s.gym })).session.id;
    const set = await x.ok("log_set", { session_id: session, exercise: "lat pulldown", reps: 10, load: { value: 40, unit: "kg", basis: "total", implement: s.stack } });
    x.advanceHours(49);
    const result = await run(x);
    expect(result.confirmed).toEqual([{ table: "session", id: session }]);
    expect(result.skipped).toEqual([{ table: "session_set", id: set.set.id, reason: "rir_blank" }]);
  });
});

describe("member_notes", () => {
  it("writes versioned notes and reads the latest; household documents are visible to all", async () => {
    const x = setup();
    const first = await x.ok("write_member_note", { member: "Kabir", topic: "knee", body: "No deep knee flexion under load." });
    expect(first.note).toMatchObject({ version: 1, topic: "knee", member: "Kabir" });
    const second = await x.ok("write_member_note", { member: "Kabir", topic: "knee", body: "No deep knee flexion under load; box squats OK." });
    expect(second.note).toMatchObject({ id: first.note.id, version: 2 });
    await x.ok("write_member_note", { member: null, topic: "Meal Prep", body: "Soak rajma overnight." });
    const read = await x.ok("member_notes", { member: "Kabir" });
    expect(read.notes).toEqual([expect.objectContaining({ topic: "knee", version: 2, body: "No deep knee flexion under load; box squats OK." })]);
    const versions = await x.ok("member_notes", { member: "Kabir", topic: "knee", include_versions: true });
    expect(versions.notes[0].versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    expect((await x.ok("member_notes", { member: null }, "asha")).notes[0].topic).toBe("Meal Prep");
  });

  it("a member's notes are visible only to that member and the agent", async () => {
    const x = setup();
    await x.ok("write_member_note", { member: "Kabir", topic: "knee", body: "No deep knee flexion under load." });
    expect((await x.call("member_notes", { member: "Kabir" }, "asha")).http).toBe(403);
    expect((await x.call("member_notes", { member: "Kabir" }, "kabir")).http).toBe(200);
    expect((await x.call("write_member_note", { member: "Kabir", topic: "x", body: "y" }, "asha")).http).toBe(403);
  });

  it("attaches a note to one of the member's records", async () => {
    const x = setup();
    const target = await x.ok("set_target", {
      member: "Hritvik", effective_from: "2026-10-01", provenance: "agent", reasoning: "cut",
      values: [{ nutrient: "kcal", kind: "target", value: 1900 }],
    });
    const note = await x.ok("write_member_note", { member: "Hritvik", topic: "why 1900", body: "BMR 1650 x 1.35, minus 300.", subject: { table: "target", id: target.target.id } });
    expect(note.note.subject).toEqual({ table: "target", id: target.target.id });
    const read = await x.ok("member_notes", { member: "Hritvik", subject: { table: "target", id: target.target.id } });
    expect(read.notes).toHaveLength(1);
  });
});

describe("programme", () => {
  function seedProgramme(x: Harness) {
    const s = seedTraining(x);
    const programme = x.t.insert("programme", { member_id: x.h.hritvik, name: "Base", schedule_kind: "weekday", active: 1, started_on: "2026-09-01" });
    const upper = x.t.insert("session_template", { programme_id: programme, name: "Upper A", session_type: "strength" });
    x.t.insert("schedule_slot", { programme_id: programme, weekday: 1, template_id: upper });
    const pulldown = x.t.insert("prescription", {
      template_id: upper, position: 1, exercise_id: s.pulldown, sets: 3, rep_low: 10, rep_high: 12, rir_target_low: 1, rir_target_high: 2,
      load_value: 40, load_unit: "kg", load_basis: "total", load_implement_id: s.stack,
      progression_rule: JSON.stringify({ kind: "rep_top", target_sets: 3, rep_top: 12, rir_floor: 1, increment: { min: 5 } }),
    });
    x.t.insert("phase", { member_id: x.h.hritvik, name: "Base", starts_on: "2026-07-26", ends_on: "2026-09-30", energy_stance: "maintenance", intent: "base" });
    return { s, programme, upper, pulldown };
  }

  it("reads the active programme with templates, schedule, prescriptions and phases", async () => {
    const x = setup();
    seedProgramme(x);
    const body = await x.ok("programme", { member: "Hritvik", date: DAY });
    expect(body.programme).toMatchObject({ name: "Base", schedule_kind: "weekday" });
    expect(body.templates[0]).toMatchObject({ name: "Upper A", weekdays: ["mon"] });
    expect(body.templates[0].prescriptions[0]).toMatchObject({ exercise: "Cable lat pulldown", current_load: { value: 40, unit: "kg", basis: "total" } });
    expect(body.current_phase).toBeNull();
    expect(body.phases).toHaveLength(1);
  });

  it("records a load change, refusing a load the implement can't produce", async () => {
    const x = setup();
    const { pulldown } = seedProgramme(x);
    const bad = await x.call("programme_change", { member: "Hritvik", change: { kind: "load_change", prescription_id: pulldown, date: DAY, load: { value: 42, unit: "kg", basis: "total" }, reason: "progression fired" } });
    expect(bad.body).toMatchObject({ status: "needs_clarification", reason: "load_not_producible", options: ["40 kg", "45 kg"] });
    const ok = await x.ok("programme_change", { member: "Hritvik", change: { kind: "load_change", prescription_id: pulldown, date: DAY, load: { value: 45, unit: "kg", basis: "total" }, reason: "progression fired" } });
    expect(ok.load_change).toMatchObject({ previous: { value: 40, unit: "kg" }, current: { value: 45, unit: "kg" } });
    const read = await x.ok("programme", { member: "Hritvik", date: DAY });
    expect(read.templates[0].prescriptions[0].current_load.value).toBe(45);
  });

  it("adds a phase, refusing one that overlaps another", async () => {
    const x = setup();
    seedProgramme(x);
    const overlap = await x.call("upsert_phase", { member: "Hritvik", name: "Cut", starts_on: "2026-09-15", ends_on: null, energy_stance: "deficit", intent: "lose 3 kg", change_reason: "begin cut" });
    expect(overlap.body).toMatchObject({ status: "needs_clarification", reason: "phase_overlap", options: ["Base"] });
    const ok = await x.ok("upsert_phase", { member: "Hritvik", name: "Cut", starts_on: "2026-10-01", ends_on: null, energy_stance: "deficit", intent: "lose 3 kg", change_reason: "begin cut" });
    expect(ok.phase).toMatchObject({ name: "Cut", starts_on: "2026-10-01" });
    expect((await x.ok("programme", { member: "Hritvik", date: DAY })).current_phase).toMatchObject({ name: "Cut" });
  });

  it("rejects the retired programme_change add_phase shape at the schema boundary", async () => {
    const x = setup();
    seedProgramme(x);
    const before = x.t.get("SELECT count(*) AS n FROM phase");
    const reply = await x.call("programme_change", {
      member: "Hritvik",
      change: { kind: "add_phase", name: "Bypass", starts_on: "2026-10-01", energy_stance: "deficit", intent: "skip dedicated validation" },
    });
    expect(reply.body).toMatchObject({ status: "invalid" });
    expect(x.t.get("SELECT count(*) AS n FROM phase")).toEqual(before);
  });

  it("swaps one day of a weekday plan", async () => {
    const x = setup();
    seedProgramme(x);
    await x.ok("programme_change", { member: "Hritvik", change: { kind: "swap", date: DAY, template: null, reason: "travelling" } });
    const next = await x.ok("next_prescription", { member: "Hritvik", date: DAY });
    expect(next).toMatchObject({ session: "Upper A", date: "2026-10-12" });
  });
});

describe("reject of a whole draft session (dependents in one statement per table)", () => {
  it("removes a coach session's 60 sets and 20 cardio blocks, each versioned v1 create to v2 reject with the row as it was, within budget", async () => {
    const x = setup();
    const s = seedTraining(x);
    const session = (await x.ok("start_session", { origin: "coach", member: "Hritvik", date: DAY, session_type: "strength" })).session.id;
    for (let i = 1; i <= 60; i++) {
      await x.ok("log_set", { origin: "coach", session_id: session, exercise: "lat pulldown", reps: 8 + (i % 5), rir: { low: 1, high: 2 }, load: { value: 40, unit: "kg", basis: "total", implement: s.stack } });
    }
    // Blocks on the same session, seeded with a create version (v1) as a write would leave them.
    const write = (x.t.get("SELECT write_id FROM record_version WHERE table_name = 'session' AND record_id = ?", session) as { write_id: number }).write_id;
    for (let i = 1; i <= 20; i++) {
      const id = x.t.insert("cardio_block", { session_id: session, position: i, kind: "interval", activity: "invented rower", duration_s: 60 + i });
      const row = x.t.get("SELECT * FROM cardio_block WHERE id = ?", id);
      x.t.insert("record_version", { write_id: write, table_name: "cardio_block", record_id: id, version: 1, action: "create", data: JSON.stringify(row), created_at: "2026-10-05T07:00:00Z" });
    }
    const before = {
      session_set: x.t.all("SELECT * FROM session_set WHERE session_id = ? ORDER BY id", session),
      cardio_block: x.t.all("SELECT * FROM cardio_block WHERE session_id = ? ORDER BY id", session),
    };
    expect([before.session_set.length, before.cardio_block.length]).toEqual([60, 20]);
    expect(x.t.get("SELECT state FROM session WHERE id = ?", session)).toEqual({ state: "draft" });

    await toolWithinBudget(x, "reject", { records: [{ table: "session", id: session }], reason: "Rejected in the app: not my session" }, "hritvik");

    expect(x.t.get("SELECT count(*) AS n FROM session WHERE id = ?", session)).toEqual({ n: 0 });
    for (const [table, rows] of Object.entries(before)) {
      expect(x.t.get(`SELECT count(*) AS n FROM ${table} WHERE session_id = ?`, session)).toEqual({ n: 0 });
      for (const row of rows) {
        const versions = x.t.all("SELECT version, action, data FROM record_version WHERE table_name = ? AND record_id = ? ORDER BY version", table, row.id) as { version: number; action: string; data: string }[];
        expect(versions.map((v) => [v.version, v.action])).toEqual([[1, "create"], [2, "reject"]]);
        expect(JSON.parse(versions[1]?.data ?? "null")).toEqual(row);
      }
    }
  });
});
