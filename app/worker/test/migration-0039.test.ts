import { describe, expect, it } from "vitest";
import { NOW, TestDb } from "./db";

function world() {
  const t = new TestDb();
  const household = t.insert("household", { name: "H", created_at: NOW });
  const recipe = t.insert("recipe", { household_id: household, ref: "R001", name: "Dal", kind: "dish", servings: 1 });
  const plan = t.insert("meal_plan", {
    household_id: household, name: "Week", status: "draft", revision: 1,
    effective_from: "2026-11-23", effective_to: "2026-11-29",
    canonical_json: "{}", preview_json: "{}", change_reason: "test", created_at: NOW,
  });
  return { t, household, recipe, plan };
}

const task = (t: TestDb, household: number, plan: number, over: Record<string, unknown> = {}) =>
  t.insert("prep_task", {
    household_id: household, meal_plan_id: plan, task_key: "k1", action: "Soak", who: "anyone",
    status: "pending", due_on: "2026-11-25", window_start: "2026-11-25T08:00", window_end: "2026-11-25T12:00",
    canonical_json: "{}", created_at: NOW, ...over,
  });

describe("migration 0039", () => {
  it("lets a task's state change but not its content, and never deletes it", () => {
    const { t, household, plan } = world();
    const id = task(t, household, plan);
    t.run("UPDATE prep_task SET status = 'done', settled_on = '2026-11-25', settled_reason = 'done' WHERE id = ?", id);
    expect(t.get("SELECT status, settled_on FROM prep_task WHERE id = ?", id)).toEqual({ status: "done", settled_on: "2026-11-25" });
    expect(() => t.run("UPDATE prep_task SET action = 'Cook' WHERE id = ?", id)).toThrow(/prep_task_is_immutable/);
    expect(() => t.run("DELETE FROM prep_task WHERE id = ?", id)).toThrow(/prep_task_is_immutable/);
  });

  it("refuses a duplicate task key in one plan, a reversed window and a malformed one", () => {
    const { t, household, plan } = world();
    task(t, household, plan);
    expect(() => task(t, household, plan)).toThrow(/UNIQUE/i);
    expect(() => task(t, household, plan, { task_key: "k2", window_start: "2026-11-25T12:00", window_end: "2026-11-25T08:00" })).toThrow(/CHECK/i);
    expect(() => task(t, household, plan, { task_key: "k3", window_start: "2026-11-25 08:00" })).toThrow(/CHECK/i);
  });

  it("keeps a prep step's lead window ordered and its amount paired", () => {
    const { t, recipe } = world();
    const step = (over: Record<string, unknown> = {}) => t.insert("recipe_prep_step", {
      recipe_id: recipe, position: 1, action: "Soak", lead: "hours_before", lead_min_h: 8, lead_max_h: 12,
      who: "anyone", batchable: 1, keeps_days: 1, ...over,
    });
    expect(step()).toBeGreaterThan(0);
    expect(() => step({ position: 2, lead_min_h: 14, lead_max_h: 12 })).toThrow(/CHECK/i);
    expect(() => step({ position: 3, amount_value: 100 })).toThrow(/CHECK/i);
    expect(() => step({ position: 4, lead: "sometime" })).toThrow(/CHECK/i);
  });
});
