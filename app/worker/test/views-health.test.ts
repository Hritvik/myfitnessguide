import { describe, expect, it } from "vitest";
import { NOW, TestDb } from "./db";
import { alias, exercise, household, reading, writeLog } from "./fixtures";

describe("v_reading", () => {
  it("converts to the metric's canonical unit and marks the method segment", () => {
    const t = new TestDb();
    const h = household(t);
    t.insert("method_change", { member_id: h.hritvik, metric: "weight", changed_on: "2026-10-03", note: "new scale" });
    const before = reading(t, h.hritvik, { measured_on: "2026-10-01", value: 172, unit: "lb" });
    const after = reading(t, h.hritvik, { measured_on: "2026-10-04", value: 78 });
    const waist = reading(t, h.hritvik, { metric: "waist_navel", value: 35, unit: "in" });
    const row = (id: number) => t.get("SELECT value_canonical, canonical_unit, segment_start FROM v_reading WHERE id = ?", id);
    expect(row(before)).toEqual({ value_canonical: expect.closeTo(78.01788764, 6), canonical_unit: "kg", segment_start: null });
    expect(row(after)).toEqual({ value_canonical: 78, canonical_unit: "kg", segment_start: "2026-10-03" });
    expect(row(waist)).toEqual({ value_canonical: expect.closeTo(88.9, 10), canonical_unit: "cm", segment_start: null });
  });
});

describe("v_weight_7d", () => {
  it("averages fasted weights from date-6 to date, never across a method change", () => {
    const t = new TestDb();
    const h = household(t);
    reading(t, h.hritvik, { measured_on: "2026-09-28", value: 80 });
    reading(t, h.hritvik, { measured_on: "2026-10-01", value: 78 });
    reading(t, h.hritvik, { measured_on: "2026-10-03", value: 78.4 });
    reading(t, h.hritvik, { measured_on: "2026-10-04", value: 79.5, body_state: "fed" });
    reading(t, h.hritvik, { measured_on: "2026-10-05", value: 77.9 });
    const avg = () =>
      t.get("SELECT avg_kg, reading_count FROM v_weight_7d WHERE member_id = ? AND day = '2026-10-05'", h.hritvik);
    expect(avg()).toEqual({ avg_kg: expect.closeTo(78.1, 10), reading_count: 3 });
    t.insert("method_change", { member_id: h.hritvik, metric: "weight", changed_on: "2026-10-03", note: "new scale" });
    expect(avg()).toEqual({ avg_kg: expect.closeTo(78.15, 10), reading_count: 2 });
  });
});

describe("v_lab_result", () => {
  it("computes status against that lab's range", () => {
    const t = new TestDb();
    const h = household(t);
    const draw = t.insert("blood_draw", { member_id: h.hritvik, drawn_on: "2026-09-10", lab: "Lab", state: "draft" });
    const result = (marker: string, value: number) =>
      t.insert("lab_result", { draw_id: draw, marker, value, unit: "u", ref_low: 0.4, ref_high: 4.5 });
    const status = (id: number) => t.get("SELECT status FROM v_lab_result WHERE id = ?", id)!.status;
    expect(status(result("TSH", 6.2))).toBe("above");
    expect(status(result("T4", 2))).toBe("within");
    expect(status(result("T3", 0.1))).toBe("below");
    expect(status(t.insert("lab_result", { draw_id: draw, marker: "HBsAg", value_text: "Non-reactive" }))).toBeNull();
  });
});

describe("v_target", () => {
  it("lists each target value with the date the target was superseded", () => {
    const t = new TestDb();
    const h = household(t);
    const t1 = t.insert("target", { member_id: h.asha, effective_from: "2026-08-01", provenance: "import", reasoning: "old", created_at: NOW });
    const t2 = t.insert("target", { member_id: h.asha, effective_from: "2026-09-01", provenance: "agent", reasoning: "new", created_at: NOW });
    t.insert("target_value", { target_id: t1, nutrient: "kcal", kind: "target", value: 1600 });
    t.insert("target_value", { target_id: t2, nutrient: "kcal", kind: "target", value: 1488 });
    expect(t.all("SELECT effective_from, effective_to, value FROM v_target WHERE member_id = ? ORDER BY effective_from", h.asha))
      .toEqual([
        { effective_from: "2026-08-01", effective_to: "2026-09-01", value: 1600 },
        { effective_from: "2026-09-01", effective_to: null, value: 1488 },
      ]);
  });
});

describe("v_member_note", () => {
  it("shows the latest version of each note", () => {
    const t = new TestDb();
    const h = household(t);
    const note = t.insert("member_note", { household_id: h.id, member_id: h.asha, topic: "back", created_at: NOW });
    const w = writeLog(t);
    t.insert("member_note_version", { note_id: note, version: 1, body: "one", write_id: w, created_at: NOW });
    t.insert("member_note_version", { note_id: note, version: 2, body: "two", write_id: w, created_at: NOW });
    expect(t.all("SELECT topic, version, body FROM v_member_note")).toEqual([{ topic: "back", version: 2, body: "two" }]);
  });
});

describe("v_exercise", () => {
  it("lists aliases and tags with each exercise", () => {
    const t = new TestDb();
    const h = household(t);
    const e = exercise(t, h, { name: "Cable lat pulldown" });
    alias(t, h, "exercise", e, "Lat Pulldown");
    t.insert("exercise_tag", { exercise_id: e, kind: "movement_pattern", tag: "vertical_pull" });
    t.insert("exercise_tag", { exercise_id: e, kind: "stimulus", tag: "lats" });
    expect(t.get("SELECT name, aliases, movement_patterns, stimulus_tags FROM v_exercise WHERE id = ?", e))
      .toEqual({ name: "Cable lat pulldown", aliases: "Lat Pulldown", movement_patterns: "vertical_pull", stimulus_tags: "lats" });
  });
});

describe("the query surface", () => {
  it("offers a curated view for every area the agent reads", () => {
    const t = new TestDb();
    const views = t.all("SELECT name FROM sqlite_schema WHERE type = 'view' ORDER BY name").map((r) => r.name);
    expect(views).toEqual(expect.arrayContaining([
      "v_set", "v_session", "v_prescription", "v_cardio_block", "v_intake_item", "v_day_intake", "v_component",
      "v_recipe", "v_recipe_line", "v_cook_line", "v_food_source", "v_reading", "v_weight_7d", "v_lab_result",
      "v_flag", "v_target", "v_goal_point", "v_member_note", "v_exercise", "v_phase",
    ]));
  });
});
