import { describe, expect, it } from "vitest";
import { NOW, TestDb } from "./db";

function through0039() {
  const t = new TestDb({ through: "0039" });
  const household = t.insert("household", { name: "H", created_at: NOW });
  const plan = t.insert("meal_plan", {
    household_id: household, name: "Week", status: "draft", revision: 1,
    effective_from: "2026-11-23", effective_to: "2026-11-29",
    canonical_json: "{}", preview_json: "{}", change_reason: "test", created_at: NOW,
  });
  return { t, household, plan };
}

const task = (t: TestDb, household: number, plan: number, over: Record<string, unknown> = {}) =>
  t.insert("prep_task", {
    household_id: household, meal_plan_id: plan, task_key: "k1", action: "Soak", who: "anyone",
    status: "pending", due_on: "2026-11-25", window_start: "2026-11-25T08:00", window_end: "2026-11-25T12:00",
    canonical_json: "{}", created_at: NOW, ...over,
  });

describe("migration 0040", () => {
  it("rebuilds prep_task without the long GLOB checks and keeps its rows", () => {
    const { t, household, plan } = through0039();
    const id = task(t, household, plan);
    t.migrateAfter("0039");
    expect(t.get("SELECT id, action, status, window_start, window_end FROM prep_task WHERE id = ?", id)).toEqual({
      id, action: "Soak", status: "pending", window_start: "2026-11-25T08:00", window_end: "2026-11-25T12:00",
    });
    const sql = String(t.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'prep_task'")?.sql);
    expect(sql).not.toMatch(/GLOB/i);
  });

  it("keeps the format and order checks, and recreates indexes and triggers", () => {
    const { t, household, plan } = through0039();
    t.migrateAfter("0039");
    expect(() => task(t, household, plan, { task_key: "space", window_start: "2026-11-25 08:00" })).toThrow(/CHECK/i);
    expect(() => task(t, household, plan, { task_key: "short", window_start: "2026-11-25T8:00" })).toThrow(/CHECK/i);
    expect(() => task(t, household, plan, { task_key: "reversed", window_start: "2026-11-25T12:00", window_end: "2026-11-25T08:00" })).toThrow(/CHECK/i);
    const triggers = t.all("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'prep_task' ORDER BY name").map((r) => r.name);
    expect(triggers).toEqual(["prep_task_content_is_immutable", "prep_task_is_not_deleted", "prep_task_same_household"]);
    const indexes = t.all("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'prep_task' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
    expect(indexes).toEqual(["prep_task_by_household_due", "prep_task_by_plan_status"]);
  });
});
