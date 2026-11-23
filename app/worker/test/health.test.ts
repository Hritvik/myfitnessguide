import { describe, expect, it } from "vitest";
import { NOW, TestDb } from "./db";
import { exercise, household, reading } from "./fixtures";

describe("readings", () => {
  it("one measurement of one metric, with its unit, side, state and measurer", () => {
    const t = new TestDb();
    const h = household(t);
    const id = reading(t, h.hritvik, {
      metric: "arm", value: 34.5, unit: "cm", side: "right", body_state: "fasted", resolution: 0.5, measurer: "self",
    });
    expect(t.get("SELECT metric, unit, side FROM reading WHERE id = ?", id)).toEqual({ metric: "arm", unit: "cm", side: "right" });
  });

  it("reject a bare number without a unit, an unknown metric, or a unit that does not fit the metric", () => {
    const t = new TestDb();
    const h = household(t);
    expect(() => reading(t, h.hritvik, { unit: null })).toThrow(/NOT NULL/);
    expect(() => reading(t, h.hritvik, { metric: "vibes" })).toThrow(/FOREIGN KEY/);
    expect(() => reading(t, h.hritvik, { metric: "weight", unit: "cm" })).toThrow(/unit does not fit metric/);
    expect(() => reading(t, h.hritvik, { metric: "weight", unit: "stone" })).toThrow(/FOREIGN KEY/);
    expect(reading(t, h.hritvik, { metric: "weight", unit: "lb", value: 160 })).toBeGreaterThan(0);
  });

  it("also check the unit on update", () => {
    const t = new TestDb();
    const h = household(t);
    const id = reading(t, h.hritvik);
    expect(() => t.run("UPDATE reading SET unit = 'cm' WHERE id = ?", id)).toThrow(/unit does not fit metric/);
  });

  it("keep a not-recorded state and measurer explicit", () => {
    const t = new TestDb();
    const h = household(t);
    expect(reading(t, h.hritvik, { body_state: "not_recorded", measurer: "not_recorded" })).toBeGreaterThan(0);
    expect(() => reading(t, h.hritvik, { body_state: "hungry" })).toThrow(/CHECK/);
    expect(() => reading(t, h.hritvik, { measurer: "member" })).toThrow(/CHECK/);
    expect(reading(t, h.asha, { measurer: "member", measurer_member_id: h.hritvik })).toBeGreaterThan(0);
  });

  it("a suspect reading carries its reason", () => {
    const t = new TestDb();
    const h = household(t);
    expect(() => reading(t, h.hritvik, { suspect: 1 })).toThrow(/CHECK/);
    expect(reading(t, h.hritvik, { suspect: 1, suspect_reason: "scale on carpet" })).toBeGreaterThan(0);
  });

  it("reject a non-positive resolution or an unknown side", () => {
    const t = new TestDb();
    const h = household(t);
    expect(() => reading(t, h.hritvik, { resolution: 0 })).toThrow(/CHECK/);
    expect(() => reading(t, h.hritvik, { side: "middle" })).toThrow(/CHECK/);
  });
});

describe("method changes", () => {
  it("mark a metric or an exercise, never both", () => {
    const t = new TestDb();
    const h = household(t);
    const e = exercise(t, h);
    const m = { member_id: h.hritvik, changed_on: "2026-09-01", note: "new scale" };
    expect(t.insert("method_change", { ...m, metric: "weight" })).toBeGreaterThan(0);
    expect(t.insert("method_change", { ...m, exercise_id: e })).toBeGreaterThan(0);
    expect(() => t.insert("method_change", m)).toThrow(/CHECK/);
    expect(() => t.insert("method_change", { ...m, metric: "weight", exercise_id: e })).toThrow(/CHECK/);
    expect(() => t.insert("method_change", { ...m, metric: "weight", note: "" })).toThrow(/CHECK/);
  });
});

describe("heart-rate zones", () => {
  it("are provisional until tested, with low not above high", () => {
    const t = new TestDb();
    const h = household(t);
    const z = { member_id: h.hritvik, zone: 2, low_bpm: 120, high_bpm: 135, set_on: "2026-09-01" };
    expect(t.insert("hr_zone", { ...z, status: "provisional" })).toBeGreaterThan(0);
    expect(() => t.insert("hr_zone", { ...z, status: "guessed" })).toThrow(/CHECK/);
    expect(() => t.insert("hr_zone", { ...z, status: "tested", low_bpm: 140 })).toThrow(/CHECK/);
    expect(() => t.insert("hr_zone", { ...z, status: "tested", zone: 6 })).toThrow(/CHECK/);
  });
});

describe("bloods", () => {
  it("a draw holds lab results with that lab's reference range", () => {
    const t = new TestDb();
    const h = household(t);
    const draw = t.insert("blood_draw", { member_id: h.hritvik, drawn_on: "2026-09-10", lab: "Thyrocare", state: "draft" });
    const r = { draw_id: draw, marker: "TSH", value: 6.2, unit: "uIU/mL", ref_low: 0.4, ref_high: 4.5 };
    expect(t.insert("lab_result", r)).toBeGreaterThan(0);
    expect(() => t.insert("lab_result", r)).toThrow(/UNIQUE/);
    expect(() => t.insert("lab_result", { ...r, marker: "ALT", unit: null })).toThrow(/CHECK/);
    expect(() => t.insert("lab_result", { ...r, marker: "ALT", ref_low: 50, ref_high: 10 })).toThrow(/CHECK/);
    expect(() => t.insert("lab_result", { draw_id: draw, marker: "Blank" })).toThrow(/CHECK/);
    expect(t.insert("lab_result", { draw_id: draw, marker: "HBsAg", value_text: "Non-reactive" })).toBeGreaterThan(0);
    expect(t.insert("lab_result", { draw_id: draw, marker: "CRP", value: 0.5, comparator: "<", unit: "mg/L" })).toBeGreaterThan(0);
    expect(() => t.insert("lab_result", { draw_id: draw, marker: "X", value_text: "high", comparator: ">" })).toThrow(/CHECK/);
  });
});

describe("flags", () => {
  it("have a subtype, an optional due date, and are open or resolved", () => {
    const t = new TestDb();
    const h = household(t);
    const f = { member_id: h.hritvik, subject: "TSH follow-up", raised_on: "2026-09-20", subtype: "health_watch" };
    expect(t.insert("flag", { ...f, status: "open", due_on: "2026-10-12" })).toBeGreaterThan(0);
    expect(() => t.insert("flag", { ...f, status: "pending" })).toThrow(/CHECK/);
    expect(() => t.insert("flag", { ...f, status: "open", subtype: "alert" })).toThrow(/CHECK/);
    expect(() => t.insert("flag", { ...f, status: "resolved" })).toThrow(/CHECK/);
    expect(() => t.insert("flag", { ...f, status: "open", resolved_on: "2026-10-01" })).toThrow(/CHECK/);
    expect(() => t.insert("flag", { ...f, status: "open", due_on: "2026-09-01" })).toThrow(/CHECK/);
    expect(t.insert("flag", { ...f, status: "resolved", resolved_on: "2026-10-01", resolution: "retested" })).toBeGreaterThan(0);
  });
});

describe("targets", () => {
  it("are dated, with values, floors and remainders, provenance and reasoning", () => {
    const t = new TestDb();
    const h = household(t);
    const tg = t.insert("target", {
      member_id: h.asha, effective_from: "2026-09-01", provenance: "agent", reasoning: "Mifflin x 1.4 minus 300", created_at: NOW,
    });
    t.insert("target_value", { target_id: tg, nutrient: "kcal", kind: "target", value: 1488 });
    t.insert("target_value", { target_id: tg, nutrient: "protein_g", kind: "floor", value: 112 });
    t.insert("target_value", { target_id: tg, nutrient: "carbs_g", kind: "remainder", value: null });
    expect(() => t.insert("target_value", { target_id: tg, nutrient: "fat_g", kind: "remainder", value: 50 })).toThrow(/CHECK/);
    expect(() => t.insert("target_value", { target_id: tg, nutrient: "fat_g", kind: "target", value: null })).toThrow(/CHECK/);
    expect(() => t.insert("target_value", { target_id: tg, nutrient: "joy", kind: "target", value: 1 })).toThrow(/CHECK/);
    expect(() => t.insert("target_value", { target_id: tg, nutrient: "kcal", kind: "target", value: 1500 })).toThrow(/UNIQUE|PRIMARY/);
  });

  it("need reasoning and a known provenance, one per member per date", () => {
    const t = new TestDb();
    const h = household(t);
    const tg = { member_id: h.asha, effective_from: "2026-09-01", provenance: "agent", reasoning: "x", created_at: NOW };
    expect(() => t.insert("target", { ...tg, reasoning: " " })).toThrow(/CHECK/);
    expect(() => t.insert("target", { ...tg, provenance: "vibes" })).toThrow(/CHECK/);
    t.insert("target", tg);
    expect(() => t.insert("target", tg)).toThrow(/UNIQUE/);
  });
});

describe("goal points", () => {
  it("are dated values for a metric or an exercise, planned or stretch, absolute or bodyweight-relative", () => {
    const t = new TestDb();
    const h = household(t);
    const e = exercise(t, h);
    const g = { member_id: h.hritvik, week_of: "2026-10-04", tier: "planned", basis: "absolute", headline: 0 };
    expect(t.insert("goal_point", { ...g, metric: "waist_navel", value_low: 88, value_high: 88, unit: "cm", headline: 1 })).toBeGreaterThan(0);
    expect(t.insert("goal_point", { ...g, exercise_id: e, basis: "bodyweight_multiple", value_low: 1, value_high: 1.25 })).toBeGreaterThan(0);
    expect(() => t.insert("goal_point", { ...g, metric: "weight", value_low: 80, value_high: 78, unit: "kg" })).toThrow(/CHECK/);
    expect(() => t.insert("goal_point", { ...g, metric: "weight", value_low: 80, value_high: 80 })).toThrow(/CHECK/);
    expect(() => t.insert("goal_point", { ...g, value_low: 80, value_high: 80, unit: "kg" })).toThrow(/CHECK/);
    expect(() => t.insert("goal_point", { ...g, metric: "weight", tier: "dream", value_low: 80, value_high: 80, unit: "kg" })).toThrow(/CHECK/);
  });
});
