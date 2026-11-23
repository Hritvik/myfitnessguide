// 0028 is additive: the ratio unit and the waist_to_height metric, on a
// database that already holds readings and goal points.
import { describe, expect, it } from "vitest";
import { TestDb } from "./db";
import { household } from "./fixtures";

describe("migration 0028", () => {
  it("adds the metric and the unit, keeps every row, and moves goal points to their week's Sunday", () => {
    const t = new TestDb({ through: "0027" });
    const h = household(t);
    t.insert("reading", { member_id: h.hritvik, metric: "waist_navel", measured_on: "2026-10-01", value: 90, unit: "cm", body_state: "fasted", measurer: "self", suspect: 0, state: "confirmed", confirmed_at: "2026-10-01T03:00:00Z" });
    t.insert("goal_point", { member_id: h.hritvik, metric: "waist_navel", week_of: "2026-09-27", tier: "planned", basis: "absolute", value_low: 89, value_high: 89, unit: "cm" });
    // An imported goal on the sheet's Monday.
    t.insert("goal_point", { member_id: h.hritvik, metric: "weight", week_of: "2026-08-03", tier: "planned", basis: "absolute", value_low: 75, value_high: 75, unit: "kg" });
    t.migrateAfter("0027");
    expect(t.get("SELECT label, dimension FROM metric WHERE code = 'waist_to_height'")).toEqual({ label: "Waist to height", dimension: "score" });
    expect(t.get("SELECT dimension FROM unit WHERE code = 'ratio'")).toEqual({ dimension: "score" });
    expect(t.all("SELECT metric, value FROM reading")).toEqual([{ metric: "waist_navel", value: 90 }]);
    // Every goal point now sits on its week's Sunday: the Sunday one unchanged, the Monday one moved back a day.
    expect(t.all("SELECT metric, week_of, value_low FROM goal_point ORDER BY id")).toEqual([
      { metric: "waist_navel", week_of: "2026-09-27", value_low: 89 },
      { metric: "weight", week_of: "2026-08-02", value_low: 75 },
    ]);
    // A goal point can now be stored against the ratio.
    t.insert("goal_point", { member_id: h.hritvik, metric: "waist_to_height", week_of: "2027-03-28", tier: "planned", basis: "absolute", value_low: 0.5, value_high: 0.5, unit: "ratio" });
    expect(t.get("SELECT count(*) AS n FROM goal_point WHERE metric = 'waist_to_height'")).toEqual({ n: 1 });
  });
});
