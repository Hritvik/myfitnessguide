// household_overview's waiting_on_you (spec 2026-10-07 §4): every draft
// about the signed-in member, oldest first, from the drafts the call
// already loads, so the member table's count and the list are one
// snapshot. Health drafts stay owner-only. Invented data only.
import { describe, expect, it } from "vitest";
import { seedGym, toolWithinBudget } from "./budget";
import { setup, type Harness } from "./harness";
import { seedCatalogue } from "./seed";

const DAY = "2026-10-05";
const curd = (value: number) => ({ source: "food", food: "curd", value, unit: "g", provenance: "weighed", confidence: "high" });

/** The agent, talking with Asha, logs food about Hritvik: his drafts, logged by Asha. */
const aboutHritvik = (x: Harness, items: number) =>
  x.ok("log_intake", { speaker: "Asha", member: "Hritvik", date: DAY, meal_slot: "lunch", items: Array.from({ length: items }, (_, i) => curd(50 + i)) });

async function ready() {
  const x = setup();
  await seedCatalogue(x);
  return x;
}

describe("household_overview: waiting_on_you", () => {
  it("lists every draft about the signed-in member, oldest first, with who logged it, when, and when it confirms by itself", async () => {
    const x = await ready();
    const food = await aboutHritvik(x, 1);
    x.advanceHours(1);
    const reading = (await x.ok("log_reading", { speaker: "Asha", member: "Hritvik", date: DAY, metric: "weight", value: 80.1, unit: "kg", body_state: "fasted" })).reading;
    x.advanceHours(1);
    // A draft about Asha (the agent, talking with Hritvik): not his.
    await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "lunch", items: [curd(80)] });
    const body = await x.ok("household_overview", {}, "hritvik");
    expect(body.waiting_on_you).toEqual({
      drafts: [
        { table: "intake_item", id: food.items[0].id, summary: "Curd", logged_by: "Asha", logged_at: "2026-10-05T07:30:00Z", deadline: "2026-10-07T07:30:00Z", waits: null },
        { table: "reading", id: reading.id, summary: "weight", logged_by: "Asha", logged_at: "2026-10-05T08:30:00Z", deadline: "2026-10-07T08:30:00Z", waits: null },
      ],
      truncated: false,
    });
    // One snapshot: the member table counts what the list shows.
    expect(body.members[0]).toMatchObject({ member: "Hritvik", you: true, drafts: { count: 2 } });
  });

  it("keeps health drafts owner-only: another member's draft reading is never in your list, and is in theirs", async () => {
    const x = await ready();
    const reading = (await x.ok("log_reading", { member: "Asha", date: DAY, metric: "weight", value: 61.2, unit: "kg", body_state: "fasted" })).reading;
    const his = await x.ok("household_overview", {}, "hritvik");
    expect(his.waiting_on_you.drafts).toEqual([]);
    const hers = await x.ok("household_overview", {}, "asha");
    expect(hers.waiting_on_you.drafts).toEqual([expect.objectContaining({ table: "reading", id: reading.id, logged_by: "Hritvik" })]);
  });

  it("is empty for the agent, which has no member of its own", async () => {
    const x = await ready();
    await aboutHritvik(x, 2);
    expect((await x.ok("household_overview", {})).waiting_on_you).toEqual({ drafts: [], truncated: false });
  });

  it("shows the oldest 100 and says there are more", async () => {
    const x = await ready();
    const logged = await aboutHritvik(x, 105);
    const body = await x.ok("household_overview", {}, "hritvik");
    expect(body.waiting_on_you.truncated).toBe(true);
    expect(body.waiting_on_you.drafts.map((d: { id: number }) => d.id)).toEqual(logged.items.slice(0, 100).map((i: { id: number }) => i.id));
    expect(body.members[0].drafts.count).toBe(105);
  });

  it("adds no statement: the same count with one draft waiting and with 105, within the read budget", async () => {
    const one = await ready();
    seedGym(one, 40);
    await aboutHritvik(one, 1);
    const base = await toolWithinBudget(one, "household_overview", {}, "hritvik");
    const many = await ready();
    seedGym(many, 40);
    await aboutHritvik(many, 105);
    const run = await toolWithinBudget(many, "household_overview", {}, "hritvik");
    expect(run.statements).toBe(base.statements);
  });
});
