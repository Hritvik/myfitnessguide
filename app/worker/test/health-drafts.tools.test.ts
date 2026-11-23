// Drafts about a member's body and blood (spec addendum 7 Oct 2026, C):
// listed for their member to confirm or reject in the app; rejecting a
// draw takes its results in a few statements. Invented data only.
import { describe, expect, it } from "vitest";
import { autoConfirm } from "../src/autoconfirm";
import { seedGym, toolWithinBudget } from "./budget";
import { setup, type Harness } from "./harness";

/** The agent, talking with Hritvik, logs about Asha: her drafts. */
async function ashasDrafts(x: Harness) {
  const reading = (await x.ok("log_reading", { member: "Asha", date: "2026-10-04", metric: "weight", value: 61.2, unit: "kg", body_state: "fasted" })).reading;
  const draw = (
    await x.ok("log_blood_draw", {
      member: "Asha", date: "2026-10-01", lab: "Orange",
      results: [
        { marker: "Ferritin", value: 18, unit: "ng/mL", ref_low: 30, ref_high: 400 },
        { marker: "TSH", value: 2.1, unit: "mIU/L", ref_low: 0.4, ref_high: 4 },
      ],
    })
  ).draw;
  return { reading, draw };
}

describe("health_drafts", () => {
  it("lists a member's draft readings and blood draws with their ids, who logged them and when they confirm by themselves", async () => {
    const x = setup();
    const { reading, draw } = await ashasDrafts(x);
    const body = await x.ok("health_drafts", { member: "Asha" }, "asha");
    expect(body.member).toBe("Asha");
    expect(body.readings).toEqual([
      { id: reading.id, metric: "weight", label: "Body weight", date: "2026-10-04", value: 61.2, unit: "kg", side: null, body_state: "fasted", logged_by: "Hritvik", deadline: "2026-10-07T07:30:00Z" },
    ]);
    expect(body.draws).toEqual([{ id: draw.id, drawn_on: "2026-10-01", lab: "Orange", fasting: null, results: 2, logged_by: "Hritvik", deadline: "2026-10-07T07:30:00Z" }]);
  });

  it("is owner-only, and a confirmed draft leaves the list", async () => {
    const x = setup();
    const { reading, draw } = await ashasDrafts(x);
    expect((await x.call("health_drafts", { member: "Asha" }, "hritvik")).body.error.code).toBe("not_visible");
    expect((await x.call("confirm", { records: [{ table: "reading", id: reading.id }] }, "hritvik")).body.error.code).toBe("not_visible");
    await x.ok("confirm", { records: [{ table: "reading", id: reading.id }] }, "asha");
    await x.ok("confirm", { records: [{ table: "blood_draw", id: draw.id }] }, "asha");
    expect(await x.ok("health_drafts", { member: "Asha" }, "asha")).toMatchObject({ readings: [], draws: [] });
  });

  it("a draft that confirmed itself while shown: confirm and reject answer not_draft (409), and its history says the auto-confirm did it", async () => {
    const x = setup();
    const { reading } = await ashasDrafts(x);
    x.advanceHours(49);
    await autoConfirm(x.db, x.clock.now);
    const confirmed = await x.call("confirm", { records: [{ table: "reading", id: reading.id }] }, "asha");
    expect([confirmed.http, confirmed.body.error.code]).toEqual([409, "not_draft"]);
    const rejected = await x.call("reject", { records: [{ table: "reading", id: reading.id }], reason: "Rejected in the app: not my reading" }, "asha");
    expect([rejected.http, rejected.body.error.code]).toEqual([409, "not_draft"]);
    // What the app reads to say so (settledNote): the last version is the system's confirm.
    const history = await x.ok("history", { table: "reading", id: reading.id }, "asha");
    expect(history.versions.at(-1)).toMatchObject({ action: "confirm", resolver: "system", data: { state: "confirmed" } });
    expect((await x.ok("health_drafts", { member: "Asha" }, "asha")).readings).toEqual([]);
  });
});

describe("reject of a draft blood draw", () => {
  it("removes the draw and its results, keeping each as a version", async () => {
    const x = setup();
    const { draw } = await ashasDrafts(x);
    await x.ok("reject", { records: [{ table: "blood_draw", id: draw.id }], reason: "Rejected in the app: not my blood draw" }, "asha");
    expect(x.t.get("SELECT count(*) AS n FROM blood_draw WHERE id = ?", draw.id)).toEqual({ n: 0 });
    expect(x.t.get("SELECT count(*) AS n FROM lab_result WHERE draw_id = ?", draw.id)).toEqual({ n: 0 });
    expect(x.t.get("SELECT count(*) AS n FROM record_version WHERE table_name = 'lab_result' AND action = 'reject'")).toEqual({ n: 2 });
    expect((await x.ok("health_drafts", { member: "Asha" }, "asha")).draws).toEqual([]);
  });

  it("stays within the budget: the list over many drafts, a confirm, and rejecting a 40-result draw", async () => {
    const x = setup();
    seedGym(x, 40);
    for (let d = 1; d <= 30; d++) {
      x.t.insert("reading", { member_id: x.h.asha, metric: "weight", measured_on: `2026-09-${String(d).padStart(2, "0")}`, value: 61, unit: "kg", body_state: "fasted", measurer: "self", suspect: 0, state: "draft" });
    }
    const draw = x.t.insert("blood_draw", { member_id: x.h.asha, drawn_on: "2026-10-01", lab: "Orange", state: "draft" });
    for (let i = 1; i <= 40; i++) x.t.insert("lab_result", { draw_id: draw, marker: `Invented marker ${i}`, value: i, unit: "mg/dL" });
    await toolWithinBudget(x, "health_drafts", { member: "Asha" }, "asha");
    const first = x.t.get("SELECT id FROM reading WHERE member_id = ? ORDER BY id LIMIT 1", x.h.asha) as { id: number };
    await toolWithinBudget(x, "confirm", { records: [{ table: "reading", id: first.id }] }, "asha");
    await toolWithinBudget(x, "reject", { records: [{ table: "blood_draw", id: draw }], reason: "Rejected in the app: not my blood draw" }, "asha");
  });
});
