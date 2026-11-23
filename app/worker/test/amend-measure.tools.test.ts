// Click test P2-8 (ticket 68): amend changes a food item's measure in place.
// The new amount (value with a measure, or value with a unit) is resolved
// exactly as log_intake resolves one, so the stored columns and the
// nutrients are what logging it afresh would give. Invented data only.
import { describe, expect, it } from "vitest";
import { setup, type Harness } from "./harness";
import { seedCatalogue } from "./seed";

const DAY = "2026-10-05";

async function logged(x: Harness, item: Record<string, unknown>): Promise<number> {
  const r = await x.ok("log_intake", { member: "Hritvik", date: DAY, meal_slot: "breakfast", items: [{ source: "food", provenance: "weighed", confidence: "high", ...item }] }, "hritvik");
  return r.items[0].id as number;
}

const amend = (x: Harness, id: number, changes: Record<string, unknown>) =>
  x.call("amend", { record: { table: "intake_item", id }, changes, reason: "Corrected in the app" }, "hritvik");

const stored = (x: Harness, id: number) => x.t.get("SELECT amount_value, amount_unit, measure_id FROM intake_item WHERE id = ?", id) as { amount_value: number; amount_unit: string; measure_id: number | null };

const kcalOf = async (x: Harness, item: Record<string, unknown>): Promise<number> => {
  const w = await x.ok("what_if", { member: "Hritvik", date: DAY, items: [{ source: "food", provenance: "weighed", confidence: "high", ...item }] }, "hritvik");
  return w.items[0].nutrients.kcal.value as number;
};

describe("amend: an intake item's measure (click test P2-8)", () => {
  it("takes a value with a measure: stored as the measure, nutrients as log_intake would compute them", async () => {
    const x = setup();
    await seedCatalogue(x);
    const id = await logged(x, { food: "egg", value: 100, unit: "g" });
    const reply = await amend(x, id, { amount_value: 3, measure: "egg" });
    expect(reply.body.status).toBe("ok");
    const measureId = (x.t.get("SELECT id FROM measure WHERE name = 'egg'") as { id: number }).id;
    expect(stored(x, id)).toEqual({ amount_value: 3, amount_unit: "measure", measure_id: measureId });
    expect(reply.body.computed.nutrients.kcal.value).toBeCloseTo(await kcalOf(x, { food: "egg", value: 3, measure: "egg" }), 6);
    expect(reply.body.computed.nutrients.kcal.value).toBeCloseTo(214.5, 6);
    // Every version is kept: the 100 g original is the first.
    const versions = x.t.all("SELECT version FROM record_version WHERE table_name = 'intake_item' AND record_id = ? ORDER BY version", id) as { version: number }[];
    expect(versions.length).toBe(2);
    expect(reply.body.before).toMatchObject({ amount_value: 100, amount_unit: "g", measure_id: null });
    expect(reply.body.after).toMatchObject({ amount_value: 3, amount_unit: "measure", measure_id: measureId });
  });

  it("takes a value with a unit, converted to the food's reference unit as log_intake converts it", async () => {
    const x = setup();
    await seedCatalogue(x);
    const id = await logged(x, { food: "mustard oil", value: 2, measure: "tsp" });
    const reply = await amend(x, id, { amount_value: 0.01, unit: "l" });
    expect(reply.body.status).toBe("ok");
    expect(stored(x, id)).toEqual({ amount_value: 10, amount_unit: "ml", measure_id: null });
    expect(reply.body.computed.nutrients.kcal.value).toBeCloseTo(await kcalOf(x, { food: "mustard oil", value: 10, unit: "ml" }), 6);
  });

  it("asks for the amount when only the measure is given", async () => {
    const x = setup();
    await seedCatalogue(x);
    const id = await logged(x, { food: "egg", value: 100, unit: "g" });
    const reply = await amend(x, id, { measure: "egg" });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "amount_needed", path: ["changes", "amount_value"] });
    expect(stored(x, id)).toMatchObject({ amount_value: 100, amount_unit: "g" });
  });

  it("asks as log_intake asks: an unknown measure, or a unit the food isn't measured in", async () => {
    const x = setup();
    await seedCatalogue(x);
    const id = await logged(x, { food: "egg", value: 100, unit: "g" });
    const unknown = await amend(x, id, { amount_value: 2, measure: "cup" });
    expect(unknown.body).toMatchObject({ status: "needs_clarification", reason: "unknown_measure", path: ["changes", "measure"] });
    const mismatch = await amend(x, id, { amount_value: 200, unit: "ml" });
    expect(mismatch.body).toMatchObject({ status: "needs_clarification", reason: "unit_mismatch", path: ["changes", "unit"] });
    expect(stored(x, id)).toMatchObject({ amount_value: 100, amount_unit: "g", measure_id: null });
  });

  it("refuses a measure and a unit together, a bad unit, and a measure on an item that isn't a food", async () => {
    const x = setup();
    await seedCatalogue(x);
    const id = await logged(x, { food: "egg", value: 100, unit: "g" });
    expect((await amend(x, id, { amount_value: 2, measure: "egg", unit: "g" })).body).toMatchObject({ status: "error", error: { code: "measure_or_unit" } });
    expect((await amend(x, id, { amount_value: 2, unit: "cups" })).body).toMatchObject({ status: "error", error: { code: "invalid_unit" } });
    const manual = await x.ok("log_intake", {
      member: "Hritvik", date: DAY, meal_slot: "lunch",
      items: [{ source: "manual", kcal: 300, protein_g: 10, carbs_g: 40, fat_g: 10, reason: "restaurant thali", provenance: "estimated", confidence: "low" }],
    }, "hritvik");
    expect((await amend(x, manual.items[0].id, { measure: "egg", amount_value: 1 })).body).toMatchObject({ status: "error", error: { code: "not_amendable" } });
  });

  it("an amount_value alone on a measure item still counts the same measure", async () => {
    const x = setup();
    await seedCatalogue(x);
    const id = await logged(x, { food: "egg", value: 2, measure: "egg" });
    const reply = await amend(x, id, { amount_value: 1 });
    expect(reply.body.status).toBe("ok");
    expect(stored(x, id)).toMatchObject({ amount_value: 1, amount_unit: "measure" });
    expect(reply.body.computed.nutrients.kcal.value).toBeCloseTo(71.5, 6);
  });
});
