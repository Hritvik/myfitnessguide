import { describe, expect, it } from "vitest";
import { assertPersistedPlanPayload } from "../src/tools/meal-planning";
import { setup } from "./harness";
import { seedCatalogue } from "./seed";

const DAY = "2026-10-20";

function proposal(date = DAY) {
  return [{
    date,
    meal_slot: "dinner",
    note: "family dinner",
    cooks: [{
      name: "Curd bowl",
      lines: [{ food: "Curd", value: 200, unit: "g", provenance: "estimated" }],
      portions: [{ member: "Hritvik", fraction: 0.6, provenance: "estimated" }, { member: "Asha", fraction: 0.4, provenance: "estimated" }],
    }],
  }];
}

describe("durable meal-plan lifecycle", () => {
  it("saves a resolved draft without creating consumption records, and reads it household-wide", async () => {
    const x = setup({ now: "2026-10-20T07:30:00Z" });
    await seedCatalogue(x);
    const before = Object.fromEntries(["cook", "component", "cook_line", "portion", "intake_item", "household_meal"].map((table) => [table, x.t.get(`SELECT count(*) AS n FROM ${table}`)?.n]));
    const saved = await x.ok("save_meal_plan", { name: "Week one", status: "draft", entries: proposal(), change_reason: "first family draft" }, "hritvik");

    expect(saved).toMatchObject({ action: "created", plan: { name: "Week one", status: "draft", revision: 1, effective_from: DAY, effective_to: DAY } });
    expect(saved.preview.meals).toHaveLength(1);
    expect(await x.ok("meal_plan", { plan_id: saved.plan.id }, "asha")).toMatchObject({ plan: { id: saved.plan.id, revision: 1 }, preview: saved.preview });
    expect(Object.fromEntries(["cook", "component", "cook_line", "portion", "intake_item", "household_meal"].map((table) => [table, x.t.get(`SELECT count(*) AS n FROM ${table}`)?.n]))).toEqual(before);
    expect(x.t.get("SELECT count(*) AS n FROM meal_plan_entry WHERE meal_plan_id = ?", saved.plan.id)).toEqual({ n: 1 });
    expect(x.t.get("SELECT count(*) AS n FROM meal_plan_component WHERE meal_plan_entry_id IN (SELECT id FROM meal_plan_entry WHERE meal_plan_id = ?)", saved.plan.id)).toEqual({ n: 1 });
    expect(x.t.get("SELECT count(*) AS n FROM meal_plan_ingredient_snapshot")).toEqual({ n: 1 });
    expect(x.t.get("SELECT count(*) AS n FROM meal_plan_allocation")).toEqual({ n: 2 });
  });

  it("creates an immutable successor, preserves the old graph, and refuses a stale revision", async () => {
    const x = setup({ now: "2026-10-20T07:30:00Z" });
    await seedCatalogue(x);
    const first = await x.ok("save_meal_plan", { name: "Week one", status: "draft", entries: proposal(), change_reason: "first" }, "hritvik");
    const next = await x.ok("save_meal_plan", {
      plan_id: first.plan.id,
      expected_revision: 1,
      name: "Week one revised",
      status: "draft",
      entries: proposal("2026-10-21"),
      change_reason: "move dinner",
    }, "hritvik");

    expect(next).toMatchObject({ action: "revised", plan: { revision: 2, supersedes_meal_plan_id: first.plan.id } });
    expect(x.t.get("SELECT superseded_at, superseded_reason FROM meal_plan WHERE id = ?", first.plan.id)).toEqual({ superseded_at: "2026-10-20T07:30:00Z", superseded_reason: "move dinner" });
    expect(x.t.get("SELECT count(*) AS n FROM meal_plan_entry WHERE meal_plan_id = ?", first.plan.id)).toEqual({ n: 1 });
    const stale = await x.call("save_meal_plan", {
      plan_id: first.plan.id, expected_revision: 1, name: "stale", status: "draft", entries: proposal(), change_reason: "stale tab",
    }, "hritvik");
    expect(stale.body.error.code).toBe("stale_meal_plan_revision");
    expect(await x.ok("meal_plan", { plan_id: first.plan.id }, "asha")).toMatchObject({
      plan: { superseded_at: "2026-10-20T07:30:00Z", superseded_by_meal_plan_id: next.plan.id, current_meal_plan_id: next.plan.id },
    });
  });

  it("rejects overlapping active plans but allows overlapping drafts", async () => {
    const x = setup({ now: "2026-10-20T07:30:00Z" });
    await seedCatalogue(x);
    const active = await x.ok("save_meal_plan", { name: "Active", status: "active", entries: proposal(), change_reason: "agreed" }, "hritvik");
    expect(await x.ok("household_planning_context", { from: DAY, to: DAY }, "asha")).toMatchObject({ active_plan: { id: active.plan.id, status: "active" } });
    await expect(x.ok("save_meal_plan", { name: "Alternative", status: "draft", entries: proposal(), change_reason: "compare" }, "hritvik")).resolves.toBeTruthy();
    const overlap = await x.call("save_meal_plan", { name: "Second active", status: "active", entries: proposal(), change_reason: "conflict" }, "hritvik");
    expect(overlap.body.error.code).toBe("meal_plan_overlap");
  });

  it("archives and restores only by creating successors", async () => {
    const x = setup({ now: "2026-10-20T07:30:00Z" });
    await seedCatalogue(x);
    const first = await x.ok("save_meal_plan", { name: "Active", status: "active", entries: proposal(), change_reason: "agreed" }, "hritvik");
    const original = x.t.get("SELECT canonical_json, preview_json FROM meal_plan WHERE id = ?", first.plan.id)!;
    const originalGraph = x.t.all(
      `SELECT e.canonical_json AS entry_json, c.canonical_json AS component_json, i.canonical_json AS ingredient_json, a.canonical_json AS allocation_json
       FROM meal_plan_entry e JOIN meal_plan_component c ON c.meal_plan_entry_id = e.id
       JOIN meal_plan_ingredient_snapshot i ON i.meal_plan_component_id = c.id
       JOIN meal_plan_allocation a ON a.meal_plan_component_id = c.id
       WHERE e.meal_plan_id = ? ORDER BY e.position, c.position, i.position, a.position`, first.plan.id,
    );
    x.t.run("UPDATE food_source SET kcal = 999 WHERE name = 'Curd'");
    const archived = await x.ok("set_meal_plan_archived", { plan_id: first.plan.id, expected_revision: 1, archived: true, change_reason: "travelling" }, "hritvik");
    expect(archived).toMatchObject({ action: "archived_as_successor", plan: { revision: 2, archived: true, supersedes_meal_plan_id: first.plan.id } });
    expect(x.t.get("SELECT canonical_json, preview_json FROM meal_plan WHERE id = ?", archived.plan.id)).toEqual(original);
    expect(x.t.all(
      `SELECT e.canonical_json AS entry_json, c.canonical_json AS component_json, i.canonical_json AS ingredient_json, a.canonical_json AS allocation_json
       FROM meal_plan_entry e JOIN meal_plan_component c ON c.meal_plan_entry_id = e.id
       JOIN meal_plan_ingredient_snapshot i ON i.meal_plan_component_id = c.id
       JOIN meal_plan_allocation a ON a.meal_plan_component_id = c.id
       WHERE e.meal_plan_id = ? ORDER BY e.position, c.position, i.position, a.position`, archived.plan.id,
    )).toEqual(originalGraph);
    const restored = await x.ok("set_meal_plan_archived", { plan_id: archived.plan.id, expected_revision: 2, archived: false, change_reason: "home again" }, "asha");
    expect(restored).toMatchObject({ action: "restored_as_successor", plan: { revision: 3, archived: false, status: "active", supersedes_meal_plan_id: archived.plan.id } });
    expect(x.t.get("SELECT count(*) AS n FROM meal_plan")).toEqual({ n: 3 });
    expect(x.t.get("SELECT canonical_json, preview_json FROM meal_plan WHERE id = ?", restored.plan.id)).toEqual(original);
    expect(JSON.stringify(await x.ok("meal_plan", { plan_id: archived.plan.id }, "hritvik"))).not.toContain("travelling");
  });

  it("is idempotent and does not duplicate a saved graph", async () => {
    const x = setup({ now: "2026-10-20T07:30:00Z" });
    await seedCatalogue(x);
    const replay = await x.call("save_meal_plan", { name: "Bad", status: "active", entries: proposal(), change_reason: "test", idempotency_key: "replay-plan" }, "hritvik");
    const replayAgain = await x.call("save_meal_plan", { name: "Bad", status: "active", entries: proposal(), change_reason: "test", idempotency_key: "replay-plan" }, "hritvik");
    expect(replayAgain.body).toEqual(replay.body);
    expect(x.t.get("SELECT count(*) AS n FROM meal_plan")).toEqual({ n: 1 });
    expect(x.t.get("SELECT count(*) AS n FROM meal_plan_entry")).toEqual({ n: 1 });
  });

  it("rejects duplicate member allocations before writing and enforces immutable saved rows", async () => {
    const x = setup({ now: "2026-10-20T07:30:00Z" });
    await seedCatalogue(x);
    const duplicate = proposal();
    duplicate[0]!.cooks[0]!.portions = [
      { member: "Hritvik", fraction: 0.5, provenance: "estimated" },
      { member: "Hritvik", fraction: 0.5, provenance: "estimated" },
    ];
    const refused = await x.call("save_meal_plan", { name: "Duplicate", status: "draft", entries: duplicate, change_reason: "test" }, "hritvik");
    expect(refused.body.error.code).toBe("duplicate_allocation");
    expect(x.t.get("SELECT count(*) AS n FROM meal_plan")).toEqual({ n: 0 });

    const saved = await x.ok("save_meal_plan", { name: "Immutable", status: "draft", entries: proposal(), change_reason: "test" }, "hritvik");
    expect(() => x.t.run("UPDATE meal_plan SET name = 'rewritten' WHERE id = ?", saved.plan.id)).toThrow(/meal_plan_is_immutable/);
    expect(() => x.t.run("UPDATE meal_plan_entry SET note = 'rewritten' WHERE meal_plan_id = ?", saved.plan.id)).toThrow(/meal_plan_graph_is_immutable/);
  });

  it("normalizes reversed entries once so the persisted graph matches the sorted preview", async () => {
    const x = setup({ now: "2026-10-20T07:30:00Z" });
    await seedCatalogue(x);
    const later = proposal("2026-10-21")[0]!;
    later.cooks[0]!.name = "Pea bowl";
    later.cooks[0]!.lines[0]!.food = "Peas";
    const earlier = proposal(DAY)[0]!;
    const saved = await x.ok("save_meal_plan", { name: "Sorted", status: "draft", entries: [later, earlier], change_reason: "sort it" }, "hritvik");
    const read = await x.ok("meal_plan", { plan_id: saved.plan.id }, "hritvik");
    expect(read.proposal.entries.map((entry: { date: string }) => entry.date)).toEqual([DAY, "2026-10-21"]);
    expect(read.preview.meals.map((meal: { date: string }) => meal.date)).toEqual([DAY, "2026-10-21"]);
    expect(x.t.all("SELECT planned_on FROM meal_plan_entry WHERE meal_plan_id = ? ORDER BY position", saved.plan.id)).toEqual([
      { planned_on: DAY }, { planned_on: "2026-10-21" },
    ]);
    expect(x.t.all(
      `SELECT json_extract(i.canonical_json, '$.name') AS name FROM meal_plan_ingredient_snapshot i
       JOIN meal_plan_component c ON c.id = i.meal_plan_component_id JOIN meal_plan_entry e ON e.id = c.meal_plan_entry_id
       WHERE e.meal_plan_id = ? ORDER BY e.position, c.position, i.position`, saved.plan.id,
    )).toEqual([{ name: "Curd" }, { name: "Peas" }]);
  });

  it("rejects a combined canonical and preview payload above the D1-safe ceiling", () => {
    expect(() => assertPersistedPlanPayload("x".repeat(750_000), "y".repeat(750_000))).toThrowError(expect.objectContaining({ code: "meal_plan_too_large" }));
    expect(() => assertPersistedPlanPayload("x".repeat(700_000), "y".repeat(700_000))).not.toThrow();
    expect(() => assertPersistedPlanPayload('"'.repeat(400_000), '"'.repeat(400_000))).toThrowError(expect.objectContaining({ code: "meal_plan_too_large" }));
  });

  it("hides another household's plan from read, revise and archive without writing", async () => {
    const x = setup({ now: "2026-10-20T07:30:00Z" });
    await seedCatalogue(x);
    const otherHousehold = x.t.insert("household", { name: "Other", created_at: "2026-10-20T07:30:00Z" });
    const otherPlan = x.t.insert("meal_plan", {
      household_id: otherHousehold, name: "Private", status: "draft", revision: 1,
      effective_from: DAY, effective_to: DAY, canonical_json: JSON.stringify({ entries: proposal() }),
      preview_json: JSON.stringify({ from: DAY, to: DAY, meals: [], members: [], issues: [] }),
      change_reason: "private", created_at: "2026-10-20T07:30:00Z",
    });
    const before = x.t.get("SELECT count(*) AS n FROM write_log");
    expect((await x.call("meal_plan", { plan_id: otherPlan }, "hritvik")).body.error.code).toBe("meal_plan_not_found");
    expect((await x.call("save_meal_plan", {
      plan_id: otherPlan, expected_revision: 1, name: "steal", status: "draft", entries: proposal(), change_reason: "no",
    }, "hritvik")).body.error.code).toBe("meal_plan_not_found");
    expect((await x.call("set_meal_plan_archived", {
      plan_id: otherPlan, expected_revision: 1, archived: true, change_reason: "no",
    }, "hritvik")).body.error.code).toBe("meal_plan_not_found");
    expect(x.t.get("SELECT count(*) AS n FROM write_log")).toEqual(before);
  });
});
