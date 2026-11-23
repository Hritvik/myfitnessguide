import { describe, expect, it } from "vitest";
import { setup } from "./harness";
import { seedCatalogue, seedTraining } from "./seed";

const DAY = "2026-10-05";
const rice = (value: number) => ({ source: "food", food: "FS002", value, unit: "g", provenance: "weighed", confidence: "high" });

async function ready() {
  const x = setup();
  await seedCatalogue(x);
  return x;
}

describe("retract removes an entry that should not exist", () => {
  it("normalizes the plural intake_items compatibility name", async () => {
    const x = await ready();
    const logged = await x.ok("log_intake", { member: "Hritvik", date: DAY, meal_slot: "lunch", items: [rice(150)] });
    const id = logged.items[0].id;

    expect((await x.ok("retract", { records: [{ table: "intake_items", id }], reason: "compatibility client" }, "hritvik")).retracted)
      .toEqual([{ table: "intake_item", id }]);
  });

  it("deletes a confirmed intake item, keeps its last content with the reason, and returns the day's totals", async () => {
    const x = await ready();
    await x.ok("log_intake", { member: "Hritvik", date: DAY, meal_slot: "lunch", items: [rice(100)] });
    const dup = (await x.ok("log_intake", { member: "Hritvik", date: DAY, meal_slot: "lunch", items: [rice(100)] })).items[0].id;
    const body = await x.ok("retract", { records: [{ table: "intake_item", id: dup }], reason: "logged twice" });
    expect(body.retracted).toEqual([{ table: "intake_item", id: dup }]);
    expect(body.computed.day_totals).toEqual([expect.objectContaining({ member: "Hritvik", date: DAY, item_count: 1 })]);
    expect(body.computed.day_totals[0].so_far.kcal.value).toBeCloseTo(120, 9);
    expect((await x.ok("day_items", { member: "Hritvik", date: DAY })).items).toHaveLength(1);
    const history = await x.ok("history", { table: "intake_item", id: dup });
    expect(history.versions.at(-1)).toMatchObject({ action: "retract", reason: "logged twice", tool: "retract", data: { amount_value: 100 } });
  });

  it("only the member the entry is about may retract it, in the app or with the agent talking with them", async () => {
    const x = await ready();
    const id = (await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "lunch", items: [rice(100)] }, "asha")).items[0].id;
    const record = { table: "intake_item", id };
    const byAgentForOther = await x.call("retract", { records: [record], reason: "dup", speaker: "Hritvik" });
    expect([byAgentForOther.http, byAgentForOther.body.error.code]).toEqual([403, "not_yours_to_retract"]);
    const byOtherMember = await x.call("retract", { records: [record], reason: "dup" }, "hritvik");
    expect(byOtherMember.http).toBe(403);
    const byInbox = await x.call("retract", { records: [record], reason: "dup", origin: "inbox" });
    expect(byInbox.http).toBe(403);
    expect((await x.ok("retract", { records: [record], reason: "dup", speaker: "Asha" })).retracted).toEqual([record]);
  });

  it("the member retracts their own entry through the app", async () => {
    const x = await ready();
    const id = (await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "lunch", items: [rice(100)] }, "asha")).items[0].id;
    await x.ok("retract", { records: [{ table: "intake_item", id }], reason: "wrong day" }, "asha");
    expect((await x.ok("day_totals", { member: "Asha", date: DAY })).source).toBe("empty");
  });

  it("requires a reason", async () => {
    const x = await ready();
    const id = (await x.ok("log_intake", { member: "Hritvik", date: DAY, meal_slot: "lunch", items: [rice(100)] })).items[0].id;
    expect((await x.call("retract", { records: [{ table: "intake_item", id }] })).http).toBe(400);
  });

  it("refuses a table it does not support", async () => {
    const x = await ready();
    const reply = await x.call("retract", { records: [{ table: "food_source", id: 1 }], reason: "dup" });
    expect([reply.http, reply.body.error.code]).toEqual([400, "not_retractable"]);
  });

  it("retracting a confirmed portion retracts its intake item in the same write", async () => {
    const x = await ready();
    const meal = await x.ok("household_meal", {
      date: DAY, meal_slot: "dinner",
      cooks: [{ name: "Dal", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [
        { member: "Hritvik", fraction: 0.5, provenance: "estimated" },
        { member: "Asha", fraction: 0.5, provenance: "estimated" },
      ] }],
    });
    const mine = meal.cooks[0].portions[0].id;
    const item = (await x.ok("day_items", { member: "Hritvik", date: DAY })).items[0];
    expect(item.state).toBe("confirmed");
    const direct = await x.call("retract", { records: [{ table: "intake_item", id: item.id }], reason: "dup" });
    expect([direct.http, direct.body.error.code]).toEqual([400, "retract_the_portion"]);
    const body = await x.ok("retract", { records: [{ table: "portion", id: mine }], reason: "logged twice" });
    expect(body.retracted).toEqual([{ table: "intake_item", id: item.id }, { table: "portion", id: mine }]);
    expect(body.computed.day_totals[0]).toMatchObject({ member: "Hritvik", source: "empty", item_count: 0 });
    expect((await x.ok("history", { table: "intake_item", id: item.id })).versions.at(-1).action).toBe("retract");
    expect((await x.ok("day_totals", { member: "Asha", date: DAY })).item_count).toBe(1);
  });

  it("retracting a session's last set leaves the session and returns its totals", async () => {
    const x = setup();
    const s = seedTraining(x);
    const session = (await x.ok("start_session", { member: "Hritvik", date: DAY, session_type: "strength" })).session.id;
    const set = (await x.ok("log_set", { session_id: session, exercise: "lat pulldown", reps: 10, rir: { low: 1, high: 2 }, load: { value: 40, unit: "kg", basis: "total", implement: s.stack } })).set.id;
    const dup = (await x.ok("log_set", { session_id: session, exercise: "lat pulldown", reps: 10, rir: { low: 1, high: 2 }, load: { value: 40, unit: "kg", basis: "total", implement: s.stack } })).set.id;
    const first = await x.ok("retract", { records: [{ table: "session_set", id: dup }], reason: "logged twice" });
    expect(first.computed.sessions).toEqual([{ session_id: session, sets: 1, cardio_blocks: 0, volume_kg: 400 }]);
    const last = await x.ok("retract", { records: [{ table: "session_set", id: set }], reason: "wrong day" });
    expect(last.computed.sessions).toEqual([{ session_id: session, sets: 0, cardio_blocks: 0, volume_kg: 0 }]);
    expect((await x.ok("history", { table: "session", id: session })).versions.map((v: { action: string }) => v.action)).toEqual(["create"]);
  });

  it("retracts a reading, which stays visible only to its member", async () => {
    const x = setup();
    const id = (await x.ok("log_reading", { member: "Hritvik", date: DAY, metric: "weight", value: 80, unit: "kg", body_state: "fasted" })).reading.id;
    expect((await x.call("retract", { records: [{ table: "reading", id }], reason: "dup" }, "asha")).http).toBe(403);
    expect((await x.ok("retract", { records: [{ table: "reading", id }], reason: "dup" }, "hritvik")).retracted).toEqual([{ table: "reading", id }]);
  });
});

describe("retracting a session (review of click test P2-20)", () => {
  it("removes your own session once it has no sets, with any blocks left in it; never one with sets, or another member's", async () => {
    const x = setup();
    seedTraining(x);
    const cardio = await x.ok("log_cardio", { member: "Hritvik", date: "2026-10-05", session_type: "cardio", blocks: [{ kind: "steady", activity: "walk", duration_s: 600 }] }, "hritvik");
    const sessionId = cardio.session.id as number;
    const gone = await x.ok("retract", { records: [{ table: "session", id: sessionId }], reason: "Removed in the app" }, "hritvik");
    expect(gone.retracted).toEqual(expect.arrayContaining([{ table: "session", id: sessionId }]));
    expect(x.t.get("SELECT count(*) AS n FROM session WHERE id = ?", sessionId)).toEqual({ n: 0 });
    expect(x.t.get("SELECT count(*) AS n FROM cardio_block WHERE session_id = ?", sessionId)).toEqual({ n: 0 });

    const lifted = await x.ok("log_set", { member: "Hritvik", date: "2026-10-05", exercise: "pushups", reps: 10, rir: 2, load: "none" }, "hritvik");
    const withSets = await x.call("retract", { records: [{ table: "session", id: lifted.set.session_id }], reason: "x" }, "hritvik");
    expect(withSets.http).toBe(400);
    expect(withSets.body.error.code).toBe("session_has_sets");
    const notYours = await x.call("retract", { records: [{ table: "session", id: lifted.set.session_id }], reason: "x" }, "asha");
    expect(notYours.http).toBeGreaterThanOrEqual(400);
  });
});
