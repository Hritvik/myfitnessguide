// Correcting a logged intake item atomically (correct_intake), and the
// catalogue-first rule for manual entries (the 27 Oct 2026 breakfast
// incident: a known product logged as hand-typed macros).
import { describe, expect, it } from "vitest";
import { setup } from "./harness";
import { seedCatalogue } from "./seed";

const DAY = "2026-10-05";

async function ready() {
  const x = setup();
  await seedCatalogue(x);
  return x;
}

const food = (f: string, value: number, more: Record<string, unknown> = {}) => ({
  source: "food",
  food: f,
  value,
  unit: "g",
  provenance: "weighed",
  confidence: "high",
  ...more,
});

describe("correct_intake", () => {
  it("replaces the food and every computed nutrient in one versioned write", async () => {
    const x = await ready();
    const logged = await x.ok("log_intake", {
      member: "Hritvik",
      date: DAY,
      meal_slot: "breakfast",
      items: [food("rice", 100, { state: "cooked" })],
    });
    const id = logged.items[0].id as number;
    expect(logged.items[0]).toMatchObject({ ref: "FS002", amount_value: 100 });
    expect(logged.items[0].nutrients.kcal.value).toBeCloseTo(120, 9);

    const corrected = await x.ok("correct_intake", {
      item_id: id,
      expected_version: 1,
      reason: "it was curd, not rice",
      replacement: food("curd", 100),
    });
    expect(corrected.item).toMatchObject({ id, ref: "FS004", source_kind: "food_source", amount_value: 100, state: "confirmed" });
    expect(corrected.item.nutrients.kcal.value).toBeCloseTo(60, 9);
    expect(corrected.previous).toMatchObject({ source_kind: "food_source" });
    expect(corrected.previous.nutrients.kcal.value).toBeCloseTo(120, 9);
    expect(corrected.day.so_far.kcal.value).toBeCloseTo(60, 9);

    const history = await x.ok("history", { table: "intake_items", id });
    expect(history.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    expect(history.versions[0].data.food_source_id).toBe(2);
    expect(history.versions[1].data.food_source_id).toBe(4);
    expect(history.versions[1].reason).toBe("it was curd, not rice");
  });

  it("refuses a correction made against a stale version", async () => {
    const x = await ready();
    const logged = await x.ok("log_intake", {
      member: "Hritvik",
      date: DAY,
      meal_slot: "breakfast",
      items: [food("rice", 100, { state: "cooked" })],
    });
    const id = logged.items[0].id as number;
    await x.ok("correct_intake", { item_id: id, expected_version: 1, reason: "first", replacement: food("curd", 100) });
    const stale = await x.call("correct_intake", {
      item_id: id,
      expected_version: 1,
      reason: "second",
      replacement: food("egg", 50),
    });
    expect(stale.http).toBe(409);
    expect(stale.body.error.code).toBe("intake_version_conflict");
    expect(stale.body.error.current_version).toBe(2);
  });

  it("moves the corrected item to another meal slot", async () => {
    const x = await ready();
    const logged = await x.ok("log_intake", {
      member: "Hritvik",
      date: DAY,
      meal_slot: "breakfast",
      items: [food("curd", 100)],
    });
    const corrected = await x.ok("correct_intake", {
      item_id: logged.items[0].id,
      reason: "it was lunch",
      meal_slot: "lunch",
      replacement: food("curd", 100),
    });
    expect(corrected.item.meal_slot).toBe("lunch");
  });
});

describe("catalogue-first manual entries", () => {
  it("refuses hand-typed macros for a food the catalogue knows, and names the match", async () => {
    const x = await ready();
    const reply = await x.call("log_intake", {
      member: "Hritvik",
      date: DAY,
      meal_slot: "breakfast",
      items: [
        {
          source: "manual",
          kcal: 120,
          protein_g: 2.4,
          carbs_g: 26,
          fat_g: 0.2,
          reason: "hand-typed",
          name: "rice",
          provenance: "estimated",
          confidence: "low",
        },
      ],
    });
    expect(reply.http).toBe(409);
    expect(reply.body.error.code).toBe("CATALOG_MATCH_REQUIRES_CONFIRMATION");
    expect(reply.body.error.candidates[0]).toMatchObject({ name: "Rice" });
    expect(reply.body.error.suggested_next_action).toContain("log_intake");
    const items = await x.ok("day_items", { member: "Hritvik", date: DAY });
    expect(items.items).toEqual([]);
  });

  it("accepts the manual entry with an explicit override reason, recorded on the item", async () => {
    const x = await ready();
    const body = await x.ok("log_intake", {
      member: "Hritvik",
      date: DAY,
      meal_slot: "breakfast",
      items: [
        {
          source: "manual",
          kcal: 120,
          protein_g: 2.4,
          carbs_g: 26,
          fat_g: 0.2,
          reason: "label read at home",
          name: "rice",
          override_reason: "the packet's label differs from the cooked-rice row",
          provenance: "label",
          confidence: "high",
        },
      ],
    });
    expect(body.items[0]).toMatchObject({ source_kind: "manual", manual_reason: expect.stringContaining("override") });
  });

  it("logs a manual entry with no catalogue name without asking", async () => {
    const x = await ready();
    const body = await x.ok("log_intake", {
      member: "Hritvik",
      date: DAY,
      meal_slot: "snack",
      items: [
        {
          source: "manual",
          kcal: 200,
          protein_g: 5,
          carbs_g: 30,
          fat_g: 6,
          reason: "homemade bar",
          provenance: "estimated",
          confidence: "medium",
        },
      ],
    });
    expect(body.items[0]).toMatchObject({ source_kind: "manual", state: "confirmed" });
  });
});
