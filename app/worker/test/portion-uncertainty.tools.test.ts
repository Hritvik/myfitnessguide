// A portion's ± (its dominant uncertainty in kcal, with what it is), stored
// on the portion by household_meal, so the pot ask can show it.
import { describe, expect, it } from "vitest";
import { TestDb } from "./db";
import { household } from "./fixtures";
import { setup } from "./harness";
import { seedCatalogue } from "./seed";

const DAY = "2026-10-05";

async function ready() {
  const x = setup();
  await seedCatalogue(x);
  return x;
}

// 400 g of peas at 81 kcal / 100 g: 324 kcal in the pot.
const dal = (portions: unknown[]) => ({
  date: DAY, meal_slot: "lunch",
  cooks: [{ name: "Masoor dal", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions }],
});

describe("a ± on a portion", () => {
  it("household_meal stores it per portion and returns it", async () => {
    const x = await ready();
    const body = await x.ok("household_meal", dal([
      { member: "Hritvik", fraction: 0.4, provenance: "estimated", dominant_uncertainty: { description: "ladle size", kcal: 35 } },
      { member: "Asha", fraction: 0.3, provenance: "estimated" },
    ]), "asha");
    const [hritvik, asha] = body.cooks[0].portions;
    expect(hritvik.dominant_uncertainty).toEqual({ description: "ladle size", kcal: 35 });
    expect(asha.dominant_uncertainty).toBeNull();
  });

  it("the pot ask and the day's meals show it, and the day's estimate counts it", async () => {
    const x = await ready();
    await x.ok("household_meal", dal([
      { member: "Hritvik", fraction: 0.4, provenance: "estimated", dominant_uncertainty: { description: "ladle size", kcal: 35 } },
    ]), "asha");
    const cooks = await x.ok("day_cooks", { member: "Hritvik", date: DAY }, "hritvik");
    expect(cooks.cooks[0].ask).toMatchObject({ plus_minus_kcal: 35, uncertainty: "ladle size" });
    const meals = await x.ok("day_meals", { member: "Hritvik", date: DAY }, "hritvik");
    const lunch = meals.slots.find((s: { slot: string }) => s.slot === "lunch");
    expect(lunch.items[0]).toMatchObject({ source_kind: "portion", plus_minus_kcal: 35, uncertainty: "ladle size" });
    expect(meals.estimate).toMatchObject({ plus_minus_kcal: 35, estimated_without_size: 0, dominant: { name: "Masoor dal", description: "ladle size", kcal: 35 } });
  });

  it("a portion without one says so", async () => {
    const x = await ready();
    await x.ok("household_meal", dal([{ member: "Hritvik", fraction: 0.4, provenance: "estimated" }]), "asha");
    const cooks = await x.ok("day_cooks", { member: "Hritvik", date: DAY }, "hritvik");
    expect(cooks.cooks[0].ask).toMatchObject({ plus_minus_kcal: null, uncertainty: null });
  });

  it("amend changes it; the description and the kcal go together", async () => {
    const x = await ready();
    const meal = await x.ok("household_meal", dal([{ member: "Hritvik", fraction: 0.4, provenance: "estimated" }]), "asha");
    const portion = meal.cooks[0].portions[0].id;
    const half = await x.call("amend", { record: { table: "portion", id: portion }, changes: { dominant_uncertainty_kcal: 20 }, reason: "sized it" }, "asha");
    expect([half.http, half.body.error.code]).toEqual([422, "constraint"]);
    await x.ok("amend", { record: { table: "portion", id: portion }, changes: { dominant_uncertainty: "bowl size", dominant_uncertainty_kcal: 20 }, reason: "sized it" }, "asha");
    const cooks = await x.ok("day_cooks", { member: "Hritvik", date: DAY }, "hritvik");
    expect(cooks.cooks[0].ask).toMatchObject({ plus_minus_kcal: 20, uncertainty: "bowl size" });
  });

  it("query's v_intake_item gives a portion item its portion's ±", async () => {
    const x = await ready();
    await x.ok("household_meal", dal([
      { member: "Hritvik", fraction: 0.4, provenance: "estimated", dominant_uncertainty: { description: "ladle size", kcal: 35 } },
    ]), "asha");
    const body = await x.ok("query", { sql: "SELECT dominant_uncertainty, dominant_uncertainty_kcal FROM v_intake_item WHERE portion_id IS NOT NULL" });
    expect(body.rows).toEqual([{ dominant_uncertainty: "ladle size", dominant_uncertainty_kcal: 35 }]);
  });
});

describe("the portion's ± columns", () => {
  it("are optional, never negative, and set together", () => {
    const t = new TestDb();
    const h = household(t);
    const cook = t.insert("cook", { household_id: h.id, cooked_on: DAY, name: "Pot", state: "draft" });
    const component = t.insert("component", { cook_id: cook, position: 1, name: "whole" });
    const base = { component_id: component, provenance: "estimated", state: "draft", kind: "fraction", fraction: 0.2 };
    expect(t.insert("portion", { ...base, member_id: h.hritvik })).toBeGreaterThan(0);
    expect(t.insert("portion", { ...base, member_id: h.asha, dominant_uncertainty: "ladle", dominant_uncertainty_kcal: 30 })).toBeGreaterThan(0);
    expect(() => t.insert("portion", { ...base, member_id: h.kabir, dominant_uncertainty_kcal: -1, dominant_uncertainty: "x" })).toThrow(/CHECK/);
    expect(() => t.insert("portion", { ...base, member_id: h.kabir, dominant_uncertainty_kcal: 30 })).toThrow(/CHECK/);
    expect(() => t.insert("portion", { ...base, member_id: h.kabir, dominant_uncertainty: " " , dominant_uncertainty_kcal: 30 })).toThrow(/CHECK/);
  });
});
