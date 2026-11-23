// BIA body water (kg) and BIA BMR (kcal), seeded by migration so the
// readings the scale prints have a metric; BMR brings an energy dimension.
import { describe, expect, it } from "vitest";
import { setup } from "./harness";

describe("BIA body water and BMR", () => {
  it("logs body water in kg and BMR in kcal, with their canonical units", async () => {
    const x = setup();
    const water = await x.ok("log_reading", { member: "Hritvik", date: "2026-10-01", metric: "bia_body_water_kg", value: 31.2, unit: "kg", body_state: "not_recorded", measurer: "not_recorded" });
    expect(water.reading).toMatchObject({ metric: "bia_body_water_kg", canonical_unit: "kg" });
    const bmr = await x.ok("log_reading", { member: "Hritvik", date: "2026-10-01", metric: "bia_bmr_kcal", value: 1320, unit: "kcal", body_state: "not_recorded", measurer: "not_recorded" });
    expect(bmr.reading).toMatchObject({ metric: "bia_bmr_kcal", canonical_unit: "kcal", value_canonical: 1320 });
    expect(x.t.get("SELECT dimension, canonical_unit FROM v_reading WHERE metric = 'bia_bmr_kcal'")).toEqual({ dimension: "energy", canonical_unit: "kcal" });
  });

  it("set_target warns below the latest measured BMR when none is given", async () => {
    const x = setup();
    await x.ok("log_reading", { member: "Hritvik", date: "2026-09-20", metric: "bia_bmr_kcal", value: 1500, unit: "kcal", body_state: "not_recorded", measurer: "not_recorded" });
    await x.ok("log_reading", { member: "Hritvik", date: "2026-09-28", metric: "bia_bmr_kcal", value: 1450, unit: "kcal", body_state: "not_recorded", measurer: "not_recorded" });
    const set = await x.ok("set_target", {
      member: "Hritvik", effective_from: "2026-10-01", provenance: "agent", reasoning: "test",
      values: [{ nutrient: "kcal", kind: "target", value: 1400 }],
    });
    expect(set.below_bmr).toEqual({ below: true, by: 50, bmr_kcal: 1450, bmr_source: "reading" });
  });

  it("a draft BMR reading (the agent logging about Asha) does not move her target's BMR check", async () => {
    const x = setup();
    await x.ok("log_reading", { member: "Asha", date: "2026-09-20", metric: "bia_bmr_kcal", value: 1300, unit: "kcal", body_state: "not_recorded", measurer: "not_recorded" });
    expect(x.t.get("SELECT state FROM reading WHERE metric = 'bia_bmr_kcal'")).toEqual({ state: "draft" });
    const set = await x.ok("set_target", {
      member: "Asha", effective_from: "2026-10-01", provenance: "agent", reasoning: "test",
      values: [{ nutrient: "kcal", kind: "target", value: 1200 }],
    });
    expect(set.below_bmr).not.toMatchObject({ below: true });
    expect(set.below_bmr ?? null).toBeNull();
  });

  it("refuses BMR in a unit of another dimension", async () => {
    const x = setup();
    const r = await x.call("log_reading", { member: "Hritvik", date: "2026-10-01", metric: "bia_bmr_kcal", value: 1320, unit: "kg", body_state: "not_recorded", measurer: "not_recorded" });
    expect(r.body.status).not.toBe("ok");
  });
});
