// Leftover servings: a remainder marked leftover is later eaten (a serving dated the day it is eaten,
// by any member, even one who had a portion) or discarded. Today is Mon 5 Oct; the pot was cooked Sat 3 Oct.
import { describe, expect, it } from "vitest";
import { setup, type Harness } from "./harness";
import { seedCatalogue } from "./seed";

const COOKED = "2026-10-03";
const MONDAY = "2026-10-05";

/** Rajma on Saturday: Hritvik 0.5 (324 kcal pot, so 162 kcal), the rest marked leftover. */
async function leftover(x: Harness) {
  await seedCatalogue(x);
  const meal = await x.ok("household_meal", {
    date: COOKED, meal_slot: "lunch",
    cooks: [{ name: "Rajma", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }] }],
  }, "hritvik");
  const componentId = meal.cooks[0].components[0].id as number;
  await x.ok("mark_remainder", { component_id: componentId, disposition: "leftover", provenance: "estimated", date: COOKED }, "hritvik");
  return componentId;
}

const remainder = async (x: Harness) => (await x.ok("day_cooks", { member: "Hritvik", date: COOKED }, "hritvik")).cooks[0].components[0].remainder;
const kcal = async (x: Harness, date: string) => (await x.ok("day_totals", { member: "Hritvik", date }, "hritvik")).so_far.kcal?.value ?? null;

describe("eating a leftover", () => {
  it("a member with a Saturday portion eats Monday's leftover: a serving dated Monday, in Monday's totals, and the pot adds up", async () => {
    const x = setup();
    const componentId = await leftover(x);
    const body = await x.ok("mark_remainder", { component_id: componentId, disposition: "eaten", member: "Hritvik", meal_slot: "dinner", provenance: "estimated" }, "hritvik");
    expect(body.serving).toMatchObject({ member: "Hritvik", fraction: 0.5, eaten_on: MONDAY, state: "confirmed" });
    expect(body.serving.nutrients.kcal.value).toBeCloseTo(162, 9);
    expect(x.t.get("SELECT eaten_on, meal_slot, household_meal_id, leftover_serving_id FROM intake_item WHERE id = ?", body.serving.intake_item_id)).toEqual({
      eaten_on: MONDAY, meal_slot: "dinner", household_meal_id: null, leftover_serving_id: body.serving.id,
    });
    expect(await kcal(x, MONDAY)).toBeCloseTo(162, 9);
    expect(await kcal(x, COOKED)).toBeCloseTo(162, 9);
    // Portions + servings account for the whole pot; Hritvik still has one portion.
    expect(await remainder(x)).toBeNull();
    expect(x.t.get("SELECT count(*) AS n FROM portion WHERE member_id = ?", x.h.hritvik)).toEqual({ n: 1 });
    // Eaten up: the leftover is settled, so the household's open-leftover query skips it.
    expect(x.t.all("SELECT settled_on FROM remainder_disposition WHERE component_id = ?", componentId)).toEqual([{ settled_on: MONDAY }]);
  });

  it("day_meals names a leftover helping's serving, so the app removes it as the serving (ticket 61)", async () => {
    const x = setup();
    const componentId = await leftover(x);
    const body = await x.ok("mark_remainder", { component_id: componentId, disposition: "eaten", member: "Hritvik", meal_slot: "dinner", provenance: "estimated" }, "hritvik");
    const day = await x.ok("day_meals", { member: "Hritvik", date: MONDAY }, "hritvik");
    const items = day.slots.flatMap((s: { items: { id: number; leftover_serving_id: number | null }[] }) => s.items);
    expect(items.find((i: { id: number }) => i.id === body.serving.intake_item_id)).toMatchObject({ leftover_serving_id: body.serving.id, portion_id: null });
    const sat = await x.ok("day_meals", { member: "Hritvik", date: COOKED }, "hritvik");
    expect(sat.slots.flatMap((s: { items: unknown[] }) => s.items)[0]).toMatchObject({ leftover_serving_id: null });
  });

  it("eaten in part, on a given date: the rest stays leftover and open", async () => {
    const x = setup();
    const componentId = await leftover(x);
    const body = await x.ok("mark_remainder", { component_id: componentId, disposition: "eaten", member: "Asha", meal_slot: "lunch", fraction: 0.2, provenance: "estimated", date: "2026-10-04" }, "asha");
    expect(x.t.get("SELECT eaten_on FROM intake_item WHERE id = ?", body.serving.intake_item_id)).toEqual({ eaten_on: "2026-10-04" });
    const rest = await remainder(x);
    expect(rest.status).toBe("leftover");
    expect(rest.fraction).toBeCloseTo(0.3, 9);
    expect(x.t.get("SELECT settled_on FROM remainder_disposition WHERE component_id = ?", componentId)).toEqual({ settled_on: null });
  });

  it("asks for the meal a leftover was eaten at", async () => {
    const x = setup();
    const componentId = await leftover(x);
    const reply = await x.call("mark_remainder", { component_id: componentId, disposition: "eaten", member: "Asha", provenance: "estimated" }, "asha");
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "meal_slot_needed" });
  });

  it("a second tap after the leftover is gone asks instead of writing another serving; a retry with the same key replays", async () => {
    const x = setup();
    const componentId = await leftover(x);
    const input = { component_id: componentId, disposition: "eaten", member: "Asha", meal_slot: "dinner", provenance: "estimated", idempotency_key: "tap-1" };
    const first = await x.ok("mark_remainder", input, "asha");
    const replay = await x.ok("mark_remainder", input, "asha");
    expect(replay.serving.id).toBe(first.serving.id);
    const again = await x.call("mark_remainder", { ...input, idempotency_key: "tap-2" }, "asha");
    expect(again.body).toMatchObject({ status: "needs_clarification", reason: "nothing_unaccounted" });
    expect(x.t.get("SELECT count(*) AS n FROM leftover_serving")).toEqual({ n: 1 });
  });

  it("a serving logged for someone else is a draft that moves with its item: confirmed together, rejected together", async () => {
    const x = setup();
    const componentId = await leftover(x);
    // The agent, talking with Hritvik, logs Asha's helping: a draft about her.
    const body = await x.ok("mark_remainder", { component_id: componentId, disposition: "eaten", member: "Asha", meal_slot: "dinner", fraction: 0.25, provenance: "estimated" });
    expect(body.serving.state).toBe("draft");
    await x.ok("confirm", { records: [{ table: "leftover_serving", id: body.serving.id }] }, "asha");
    expect(x.t.get("SELECT state FROM intake_item WHERE id = ?", body.serving.intake_item_id)).toEqual({ state: "confirmed" });

    const second = await x.ok("mark_remainder", { component_id: componentId, disposition: "eaten", member: "Asha", meal_slot: "snack", fraction: 0.1, provenance: "estimated" });
    const refused = await x.call("reject", { records: [{ table: "intake_item", id: second.serving.intake_item_id }], reason: "not eaten" }, "asha");
    expect(refused.body.error.code).toBe("reject_the_serving");
    await x.ok("reject", { records: [{ table: "leftover_serving", id: second.serving.id }], reason: "not eaten" }, "asha");
    expect(x.t.get("SELECT count(*) AS n FROM intake_item WHERE leftover_serving_id = ?", second.serving.id)).toEqual({ n: 0 });
  });
});

describe("discarding a leftover", () => {
  it("turns the whole leftover discarded and settled today, keeping when it went into the fridge", async () => {
    const x = setup();
    const componentId = await leftover(x);
    await x.ok("mark_remainder", { component_id: componentId, disposition: "discarded", provenance: "estimated" }, "hritvik");
    expect((await remainder(x)).status).toBe("discarded");
    expect(x.t.all("SELECT disposition, recorded_on, settled_on FROM remainder_disposition WHERE component_id = ?", componentId)).toEqual([
      { disposition: "discarded", recorded_on: COOKED, settled_on: MONDAY },
    ]);
    expect((await x.call("mark_remainder", { component_id: componentId, disposition: "discarded", provenance: "estimated" }, "hritvik")).body).toMatchObject({ reason: "nothing_unaccounted" });
  });

  it("refuses to discard part of a leftover, and to mark a leftover leftover again", async () => {
    const x = setup();
    const componentId = await leftover(x);
    expect((await x.call("mark_remainder", { component_id: componentId, disposition: "discarded", fraction: 0.2, provenance: "estimated" }, "hritvik")).body).toMatchObject({ reason: "discard_all" });
    expect((await x.call("mark_remainder", { component_id: componentId, disposition: "leftover", provenance: "estimated" }, "hritvik")).body).toMatchObject({ reason: "already_leftover" });
  });
});

describe("a leftover that comes back", () => {
  it("eaten up by a draft serving that is then rejected: open again and discardable", async () => {
    const x = setup();
    const componentId = await leftover(x);
    // The agent, talking with Hritvik, logs Asha eating the rest: a draft that settles the leftover.
    const eaten = await x.ok("mark_remainder", { component_id: componentId, disposition: "eaten", member: "Asha", meal_slot: "dinner", provenance: "estimated" });
    expect(x.t.get("SELECT settled_on FROM remainder_disposition WHERE component_id = ?", componentId)).toEqual({ settled_on: MONDAY });
    expect(await remainder(x)).toBeNull();
    await x.ok("reject", { records: [{ table: "leftover_serving", id: eaten.serving.id }], reason: "she didn't eat it" }, "asha");
    expect(x.t.get("SELECT settled_on FROM remainder_disposition WHERE component_id = ?", componentId)).toEqual({ settled_on: null });
    // The re-opened mark is versioned in the same write: its full row, settled_on cleared.
    const reopened = x.t.get(
      "SELECT v.action, v.data, v.write_id = (SELECT max(write_id) FROM record_version WHERE table_name = 'leftover_serving') AS same_write FROM record_version v JOIN remainder_disposition d ON d.id = v.record_id WHERE v.table_name = 'remainder_disposition' AND d.component_id = ? ORDER BY v.version DESC LIMIT 1",
      componentId,
    );
    expect(reopened).toMatchObject({ action: "amend", same_write: 1 });
    expect(JSON.parse(reopened?.data as string)).toMatchObject({ component_id: componentId, disposition: "leftover", amount_kind: "rest", recorded_on: COOKED, settled_on: null });
    expect(await remainder(x)).toMatchObject({ status: "leftover", fraction: 0.5 });
    await x.ok("mark_remainder", { component_id: componentId, disposition: "discarded", provenance: "estimated" }, "hritvik");
    expect(x.t.get("SELECT disposition, settled_on FROM remainder_disposition WHERE component_id = ?", componentId)).toEqual({ disposition: "discarded", settled_on: MONDAY });
  });

  it("a portion amended down re-opens a leftover that a serving had eaten up", async () => {
    const x = setup();
    const componentId = await leftover(x);
    await x.ok("mark_remainder", { component_id: componentId, disposition: "eaten", member: "Asha", meal_slot: "dinner", provenance: "estimated" }, "asha");
    const portion = x.t.get("SELECT id FROM portion WHERE component_id = ?", componentId)?.id as number;
    await x.ok("amend", { record: { table: "portion", id: portion }, changes: { fraction: 0.3 }, reason: "smaller helping" }, "hritvik");
    expect(x.t.get("SELECT settled_on FROM remainder_disposition WHERE component_id = ?", componentId)).toEqual({ settled_on: null });
    const left = await remainder(x);
    expect(left.status).toBe("leftover");
    expect(left.fraction).toBeCloseTo(0.2, 9);
  });
});

describe("a serving's item is changed through its serving", () => {
  it("refuses to amend the item, pointing to a retract and a new serving", async () => {
    const x = setup();
    const componentId = await leftover(x);
    const body = await x.ok("mark_remainder", { component_id: componentId, disposition: "eaten", member: "Hritvik", meal_slot: "dinner", fraction: 0.2, provenance: "estimated" }, "hritvik");
    const reply = await x.call("amend", { record: { table: "intake_item", id: body.serving.intake_item_id }, changes: { label: "a bowl" }, reason: "label" }, "hritvik");
    expect(reply.http).toBe(400);
    expect(reply.body.error.code).toBe("amend_the_serving");
  });
});

describe("the unaccounted remainder, as before", () => {
  it("eaten later is a portion dated the meal's day, and a member with a portion is told to amend it", async () => {
    const x = setup();
    await seedCatalogue(x);
    const meal = await x.ok("household_meal", {
      date: COOKED, meal_slot: "lunch",
      cooks: [{ name: "Rajma", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }] }],
    }, "hritvik");
    const componentId = meal.cooks[0].components[0].id;
    const body = await x.ok("mark_remainder", { component_id: componentId, disposition: "eaten", member: "Asha", fraction: 0.2, provenance: "estimated" }, "asha");
    expect(x.t.get("SELECT eaten_on, meal_slot FROM intake_item WHERE id = ?", body.portion.intake_item_id)).toEqual({ eaten_on: COOKED, meal_slot: "lunch" });
    expect((await x.call("mark_remainder", { component_id: componentId, disposition: "eaten", member: "Hritvik", provenance: "estimated" }, "hritvik")).body).toMatchObject({ reason: "duplicate_portion" });
  });
});

describe("the pot card shows a leftover someone has eaten (click test P1-7)", () => {
  it("day_cooks lists each eaten leftover helping per component, with who, how much and when, beside the shares", async () => {
    const x = setup();
    const componentId = await leftover(x);
    const body = await x.ok("mark_remainder", { component_id: componentId, disposition: "eaten", member: "Asha", meal_slot: "lunch", fraction: 0.2, provenance: "estimated", date: "2026-10-04" }, "asha");
    const component = (await x.ok("day_cooks", { member: "Hritvik", date: COOKED }, "hritvik")).cooks[0].components[0];
    expect(component.leftovers).toEqual([{ serving_id: body.serving.id, member: "Asha", you: false, fraction: 0.2, eaten_on: "2026-10-04" }]);
    expect(component.remainder).toMatchObject({ status: "leftover" });
    await x.ok("mark_remainder", { component_id: componentId, disposition: "eaten", member: "Hritvik", meal_slot: "dinner", provenance: "estimated" }, "hritvik");
    const after = (await x.ok("day_cooks", { member: "Hritvik", date: COOKED }, "hritvik")).cooks[0].components[0];
    expect(after.remainder).toBeNull();
    expect(after.leftovers.map((l: { member: string; you: boolean; fraction: number }) => [l.member, l.you, Math.round(l.fraction * 100)])).toEqual([["Asha", false, 20], ["Hritvik", true, 30]]);
  });

  it("a share change that would make the pot more than whole names every share, the eaten leftover included", async () => {
    const x = setup();
    await seedCatalogue(x);
    const meal = await x.ok("household_meal", {
      date: COOKED, meal_slot: "lunch",
      cooks: [{ name: "Rajma", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [
        { member: "Hritvik", fraction: 0.4, provenance: "estimated" }, { member: "Asha", fraction: 0.3, provenance: "estimated" },
      ] }],
    }, "hritvik");
    const componentId = meal.cooks[0].components[0].id as number;
    const ashas = meal.cooks[0].portions.find((p: { member: string }) => p.member === "Asha").id as number;
    await x.ok("mark_remainder", { component_id: componentId, disposition: "leftover", provenance: "estimated", date: COOKED }, "hritvik");
    await x.ok("mark_remainder", { component_id: componentId, disposition: "eaten", member: "Hritvik", meal_slot: "dinner", provenance: "estimated" }, "hritvik");
    const asked = await x.call("amend", { record: { table: "portion", id: ashas }, changes: { fraction: 0.35 }, reason: "Changed my share in the app" }, "asha");
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "portions_exceed_whole" });
    expect(asked.body.question).toBe("portions of whole add up to 1.05, more than the whole cook; shares: Hritvik 40%, Asha 35%, leftover eaten by Hritvik 30%. What is right?");
  });
});
