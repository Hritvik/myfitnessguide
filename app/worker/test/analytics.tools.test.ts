import { describe, expect, it } from "vitest";
import { setup, type Harness } from "./harness";
import { exercise, gym, recipe, session, set } from "./fixtures";

const manual = (x: Harness, over: Record<string, unknown>) =>
  x.t.insert("intake_item", {
    member_id: x.h.hritvik, eaten_on: "2026-10-05", meal_slot: "breakfast", source_kind: "manual",
    manual_kcal: 0, manual_protein_g: 0, manual_carbs_g: 0, manual_fat_g: 0,
    manual_reason: "test", provenance: "estimated", confidence: "medium", state: "confirmed", confirmed_at: "2026-10-05T07:00:00Z", ...over,
  });

const unknownRecipe = (x: Harness, over: Record<string, unknown> = {}) => {
  const id = recipe(x.t, x.h);
  return x.t.insert("intake_item", {
    member_id: x.h.hritvik, eaten_on: "2026-10-05", meal_slot: "breakfast", source_kind: "recipe",
    recipe_id: id, recipe_servings: 1, provenance: "estimated", confidence: "medium", state: "confirmed",
    confirmed_at: "2026-10-05T07:00:00Z", ...over,
  });
};

describe("analytics", () => {
  it("reports truthful nutrition coverage by day and meal, chronologically", async () => {
    const x = setup();
    manual(x, { manual_kcal: 200, manual_protein_g: 20, manual_carbs_g: 10, manual_fat_g: 8 });
    unknownRecipe(x, { eaten_on: "2026-10-04", meal_slot: "dinner" });

    const days = await x.ok("analytics", { dataset: "nutrition", member: "Hritvik", metric: "protein_g", group_by: "day", from: "2026-10-01", to: "2026-10-05" }, "asha");
    expect(days.rows).toEqual([
      { period: "2026-10-04", value: null, value_known: 0, value_total: 1, value_coverage: 0, value_complete: false, reason: "no items have known protein_g" },
      { period: "2026-10-05", value: 20, value_known: 1, value_total: 1, value_coverage: 1, value_complete: true, reason: null },
    ]);

    const meals = await x.ok("analytics", { dataset: "nutrition", member: "Hritvik", metric: "kcal", group_by: "meal_slot", from: "2026-10-01", to: "2026-10-05" });
    expect(meals.rows.map((r: any) => [r.meal_slot, r.value])).toEqual([
      ["breakfast", 200], ["dinner", null],
    ]);
  });

  it("uses Sunday weeks and counts items without pretending missing macros are zero", async () => {
    const x = setup();
    manual(x, { eaten_on: "2026-10-04", manual_kcal: 300 });
    unknownRecipe(x, { eaten_on: "2026-10-05" });
    const result = await x.ok("analytics", { dataset: "nutrition", member: "Hritvik", metric: "item_count", group_by: "week", from: "2026-10-04", to: "2026-10-05" });
    expect(result.rows).toEqual([{ period: "2026-10-04", value: 2, value_known: 2, value_total: 2, value_coverage: 1, value_complete: true, reason: null }]);
  });

  it("aggregates training with warm-ups excluded and null rather than zero", async () => {
    const x = setup();
    const ex = exercise(x.t, x.h, { name: "Bench press", implement_kind: "barbell" });
    const gymId = gym(x.t, x.h);
    const se = session(x.t, x.h.hritvik, gymId, { performed_on: "2026-10-05", state: "confirmed", confirmed_at: "2026-10-05T07:00:00Z" });
    set(x.t, se, ex, { set_type: "warm_up", load_status: "entered", load_value: 20, load_unit: "kg", load_basis: "total", reps: 10, rir_status: "recorded", rir_low: 0, rir_high: 0, state: "confirmed", confirmed_at: "2026-10-05T07:00:00Z" });
    set(x.t, se, ex, { load_status: "entered", load_value: 40, load_unit: "kg", load_basis: "total", reps: 10, rir_status: "recorded", rir_low: 0, rir_high: 0, state: "confirmed", confirmed_at: "2026-10-05T07:00:00Z" });
    set(x.t, se, ex, { load_status: "none", reps: 8, rir_status: "not_recorded", state: "confirmed", confirmed_at: "2026-10-05T07:00:00Z" });

    const volume = await x.ok("analytics", { dataset: "training", member: "Hritvik", metric: "volume_kg", group_by: "exercise", from: "2026-10-01", to: "2026-10-10" }, "asha");
    expect(volume.rows).toEqual([{ exercise_id: ex, exercise: "Bench press", value: 400, value_known: 1, value_total: 2, value_coverage: 0.5, value_complete: false, reason: null }]);
    const top = await x.ok("analytics", { dataset: "training", member: "Hritvik", metric: "best_top_set_kg", group_by: "week", from: "2026-10-01", to: "2026-10-10" });
    expect(top.rows).toEqual([{ period: "2026-10-04", value: 40, value_known: 1, value_total: 2, value_coverage: 0.5, value_complete: false, reason: null }]);
    const e1rm = await x.ok("analytics", { dataset: "training", member: "Hritvik", metric: "best_e1rm_kg", group_by: "exercise", from: "2026-10-01", to: "2026-10-10" });
    expect(e1rm.rows[0]).toMatchObject({ exercise: "Bench press", value_known: 1, value_total: 2, value_complete: false });
    expect(e1rm.rows[0].value).toBeCloseTo(40 * (1 + 10 / 30), 8);
  });

  it("returns evidence-backed empty and unavailable reasons", async () => {
    const x = setup();
    const empty = await x.ok("analytics", { dataset: "training", member: "Hritvik", metric: "sessions", group_by: "week" });
    expect(empty).toMatchObject({ rows: [], empty_reason: "no training sessions in the selected period" });

    unknownRecipe(x);
    const unknown = await x.ok("analytics", { dataset: "nutrition", member: "Hritvik", metric: "kcal", group_by: "day" });
    expect(unknown.rows[0]).toMatchObject({ value: null, value_known: 0, value_total: 1, reason: "no items have known kcal" });
  });

  it("validates combinations and bounds the date range and rows", async () => {
    const x = setup();
    for (const input of [
      { dataset: "nutrition", member: "Hritvik", metric: "volume_kg", group_by: "day" },
      { dataset: "training", member: "Hritvik", metric: "sessions", group_by: "meal_slot" },
      { dataset: "nutrition", member: "Hritvik", metric: "kcal", group_by: "day", from: "2025-01-01", to: "2026-10-05" },
      { dataset: "nutrition", member: "Hritvik", metric: "kcal", group_by: "day", from: "2026-10-06", to: "2026-10-05" },
      { dataset: "nutrition", member: "Hritvik", metric: "kcal", group_by: "day", limit: 101 },
    ]) expect((await x.call("analytics", input)).http).toBe(400);
  });

  it("excludes drafts and open training from household-visible aggregates", async () => {
    const x = setup();
    manual(x, { manual_kcal: 200, state: "draft", confirmed_at: null });
    const ex = exercise(x.t, x.h, { name: "Private draft press", implement_kind: "barbell" });
    const gymId = gym(x.t, x.h);
    const draftSession = session(x.t, x.h.hritvik, gymId, { performed_on: "2026-10-05", state: "draft", confirmed_at: null });
    set(x.t, draftSession, ex, { load_status: "entered", load_value: 40, load_unit: "kg", load_basis: "total", reps: 10, rir_status: "recorded", rir_low: 2, rir_high: 2, state: "confirmed", confirmed_at: "2026-10-05T07:00:00Z" });
    const confirmedSession = session(x.t, x.h.hritvik, gymId, { performed_on: "2026-10-05", state: "confirmed", confirmed_at: "2026-10-05T07:00:00Z" });
    set(x.t, confirmedSession, ex, { load_status: "entered", load_value: 40, load_unit: "kg", load_basis: "total", reps: 10, state: "draft", confirmed_at: null });

    expect((await x.ok("analytics", { dataset: "nutrition", member: "Hritvik", metric: "kcal", group_by: "day" }, "asha")).rows).toEqual([]);
    expect((await x.ok("analytics", { dataset: "training", member: "Hritvik", metric: "sessions", group_by: "week" }, "asha")).rows).toMatchObject([{ value: 1 }]);
    expect((await x.ok("analytics", { dataset: "training", member: "Hritvik", metric: "working_sets", group_by: "exercise" }, "asha")).rows).toEqual([]);
  });

  it("caps the response and reports truncation truthfully", async () => {
    const x = setup();
    manual(x, { eaten_on: "2026-10-04", manual_kcal: 100 });
    manual(x, { eaten_on: "2026-10-05", manual_kcal: 200 });
    const result = await x.ok("analytics", { dataset: "nutrition", member: "Hritvik", metric: "kcal", group_by: "day", from: "2026-10-01", to: "2026-10-05", limit: 1 });
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("defaults to 28 nutrition days and 12 Sunday-anchored training weeks", async () => {
    const x = setup();
    const nutrition = await x.ok("analytics", { dataset: "nutrition", member: "Hritvik", metric: "kcal", group_by: "day" });
    expect(nutrition).toMatchObject({ from: "2026-09-08", to: "2026-10-05" });
    const training = await x.ok("analytics", { dataset: "training", member: "Hritvik", metric: "sessions", group_by: "week" });
    expect(training).toMatchObject({ from: "2026-07-19", to: "2026-10-05" });
  });

  it("is household-visible, rejects outsiders, and stays within 30 statements", async () => {
    const x = setup();
    manual(x, { manual_kcal: 200 });
    expect((await x.call("analytics", { dataset: "nutrition", member: "Hritvik", metric: "kcal", group_by: "day" }, "asha")).http).toBe(200);
    expect((await x.call("analytics", { dataset: "nutrition", member: "Hritvik", metric: "kcal", group_by: "day" }, "stranger")).http).toBe(403);
    const counted = await x.counted("analytics", { dataset: "nutrition", member: "Hritvik", metric: "kcal", group_by: "day" });
    expect(counted.statements).toBeLessThanOrEqual(30);
  });
});
