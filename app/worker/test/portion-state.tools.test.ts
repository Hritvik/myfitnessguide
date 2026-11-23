// A portion and its intake item carry state separately in the schema, but
// they are one thing to a member: confirming, amending, rejecting or
// retracting one moves the other in the same write, so the cook's split and
// the day never disagree.
import { describe, expect, it } from "vitest";
import { autoConfirm } from "../src/autoconfirm";
import { setup, type As, type Harness } from "./harness";
import { seedCatalogue } from "./seed";

const DAY = "2026-10-05";

async function ready() {
  const x = setup();
  await seedCatalogue(x);
  return x;
}

/** Asha logs a pot from the app; Hritvik's portion is a draft about him. */
async function potWithDraft(x: Harness, as: As = "asha") {
  const meal = await x.ok("household_meal", {
    date: DAY, meal_slot: "lunch",
    cooks: [{ name: "Dal", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [
      { member: "Asha", fraction: 0.3, provenance: "estimated" },
      { member: "Hritvik", fraction: 0.4, provenance: "estimated" },
    ] }],
  }, as);
  const portion = meal.cooks[0].portions.find((p: { member: string }) => p.member === "Hritvik");
  const item = await itemOf(x, portion.id);
  return { portion: portion.id as number, item: item.id as number };
}

async function itemOf(x: Harness, portionId: number) {
  const body = await x.ok("day_meals", { member: "Hritvik", date: DAY }, "hritvik");
  const lunch = body.slots.find((s: { slot: string }) => s.slot === "lunch");
  return lunch.items.find((i: { portion_id: number | null }) => i.portion_id === portionId);
}

async function shareOf(x: Harness, portionId: number) {
  const body = await x.ok("day_cooks", { member: "Hritvik", date: DAY }, "hritvik");
  return body.cooks[0]?.components[0].shares.find((s: { portion_id: number }) => s.portion_id === portionId);
}

describe("confirm keeps a portion and its intake item together", () => {
  it("confirming the portion confirms its intake item in the same write", async () => {
    const x = await ready();
    const { portion, item } = await potWithDraft(x);
    const body = await x.ok("confirm", { records: [{ table: "portion", id: portion }] }, "hritvik");
    expect(body.confirmed).toEqual([{ table: "portion", id: portion }, { table: "intake_item", id: item }]);
    expect((await itemOf(x, portion)).state).toBe("confirmed");
    expect((await shareOf(x, portion)).state).toBe("confirmed");
    const history = await x.ok("history", { table: "intake_item", id: item });
    expect(history.versions.map((v: { action: string }) => v.action)).toEqual(["create", "confirm"]);
    expect(history.versions[1].write_id).toBe(body.write_id);
  });

  it("naming both, as older app builds do, confirms each once", async () => {
    const x = await ready();
    const { portion, item } = await potWithDraft(x);
    const body = await x.ok("confirm", { records: [{ table: "portion", id: portion }, { table: "intake_item", id: item }] }, "hritvik");
    expect(body.confirmed).toEqual([{ table: "portion", id: portion }, { table: "intake_item", id: item }]);
    const history = await x.ok("history", { table: "intake_item", id: item });
    expect(history.versions.map((v: { action: string }) => v.action)).toEqual(["create", "confirm"]);
  });

  it("confirming a portion's intake item confirms the portion too", async () => {
    const x = await ready();
    const { portion, item } = await potWithDraft(x);
    const body = await x.ok("confirm", { records: [{ table: "intake_item", id: item }] }, "hritvik");
    expect(body.confirmed).toEqual([{ table: "intake_item", id: item }, { table: "portion", id: portion }]);
    expect((await shareOf(x, portion)).state).toBe("confirmed");
  });

  it("someone else still can't confirm it", async () => {
    const x = await ready();
    const { portion } = await potWithDraft(x);
    const reply = await x.call("confirm", { records: [{ table: "portion", id: portion }] }, "asha");
    expect([reply.http, reply.body.error.code]).toEqual([403, "not_yours_to_decide"]);
  });
});

describe("amend keeps a portion and its intake item together", () => {
  it("the member's own change of share confirms the portion and its intake item in one write", async () => {
    const x = await ready();
    const { portion, item } = await potWithDraft(x);
    const body = await x.ok("amend", { record: { table: "portion", id: portion }, changes: { fraction: 0.5 }, reason: "had more" }, "hritvik");
    expect(body.after.state).toBe("confirmed");
    expect(body.computed.linked).toEqual({ table: "intake_item", id: item, state: "confirmed" });
    expect((await itemOf(x, portion)).state).toBe("confirmed");
    const history = await x.ok("history", { table: "intake_item", id: item });
    expect(history.versions.at(-1)).toMatchObject({ action: "confirm", write_id: body.write_id });
  });

  it("someone else's edit keeps both drafts", async () => {
    const x = await ready();
    const { portion } = await potWithDraft(x);
    const body = await x.ok("amend", { record: { table: "portion", id: portion }, changes: { fraction: 0.35 }, reason: "smaller bowl" }, "asha");
    expect(body.after.state).toBe("draft");
    expect(body.computed.linked).toBeUndefined();
    expect((await itemOf(x, portion)).state).toBe("draft");
  });
});

describe("reject and retract take the pair together", () => {
  it("rejecting a portion's intake item on its own is refused, pointing at the portion", async () => {
    const x = await ready();
    const { portion, item } = await potWithDraft(x);
    const reply = await x.call("reject", { records: [{ table: "intake_item", id: item }], reason: "wasn't there" }, "hritvik");
    expect([reply.http, reply.body.error.code]).toEqual([400, "reject_the_portion"]);
    const body = await x.ok("reject", { records: [{ table: "portion", id: portion }], reason: "wasn't there" }, "hritvik");
    expect(body.rejected).toEqual([{ table: "portion", id: portion }]);
    expect(await itemOf(x, portion)).toBeUndefined();
  });
});

describe("auto-confirm keeps the pair together", () => {
  it("an intake item waits for its portion when someone's edit restarted the portion's 48 h", async () => {
    const x = await ready();
    const { portion, item } = await potWithDraft(x);
    x.advanceHours(24);
    await x.ok("amend", { record: { table: "portion", id: portion }, changes: { fraction: 0.35 }, reason: "smaller bowl" }, "asha");
    x.advanceHours(25);
    const first = await autoConfirm(x.db, x.clock.now);
    expect(first.confirmed).not.toContainEqual({ table: "intake_item", id: item });
    expect((await itemOf(x, portion)).state).toBe("draft");
    x.advanceHours(24);
    const second = await autoConfirm(x.db, x.clock.now);
    expect(second.confirmed).toEqual(expect.arrayContaining([{ table: "portion", id: portion }, { table: "intake_item", id: item }]));
    expect((await itemOf(x, portion)).state).toBe("confirmed");
  });
});
