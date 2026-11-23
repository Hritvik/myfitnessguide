// 0029 is additive: the leftover_serving table, the item's link to it, and a leftover's settled date.
import { describe, expect, it } from "vitest";
import { TestDb } from "./db";
import { household } from "./fixtures";

describe("migration 0029", () => {
  it("adds leftover servings without touching existing items or dispositions", () => {
    const t = new TestDb({ through: "0028" });
    const h = household(t);
    t.insert("intake_item", { member_id: h.hritvik, eaten_on: "2026-10-01", meal_slot: "lunch", source_kind: "manual", manual_kcal: 100, manual_protein_g: 5, manual_carbs_g: 10, manual_fat_g: 4.4, manual_reason: "test", provenance: "estimated", confidence: "low", state: "confirmed", confirmed_at: "2026-10-01T03:00:00Z" });
    t.migrateAfter("0028");
    expect(t.get("SELECT leftover_serving_id FROM intake_item")).toEqual({ leftover_serving_id: null });
    expect(t.all("PRAGMA table_info(leftover_serving)").map((c) => c.name)).toEqual(["id", "component_id", "member_id", "kind", "fraction", "weighed_g", "eaten_on", "provenance", "state", "confirmed_at"]);
    expect(t.all("PRAGMA table_info(remainder_disposition)").map((c) => c.name)).toContain("settled_on");
  });
});
