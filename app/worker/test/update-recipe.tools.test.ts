import { describe, expect, it } from "vitest";
import { toolWithinBudget } from "./budget";
import { setup } from "./harness";
import { seedCatalogue } from "./seed";

async function ready() {
  const x = setup();
  await seedCatalogue(x);
  const made = await x.ok("upsert_recipe", {
    name: "Curd rice",
    kind: "dish",
    servings: 2,
    meal_type: "lunch",
    lines: [
      { food: "FS002", value: 300, unit: "g" },
      { food: "FS004", value: 200, unit: "g" },
    ],
  });
  return { x, recipe: made.recipe };
}

describe("update_recipe", () => {
  it("atomically patches recipe metadata and applies add, replace, move and remove operations", async () => {
    const { x, recipe } = await ready();
    const rice = recipe.lines[0].id as number;
    const curd = recipe.lines[1].id as number;

    const body = await x.ok("update_recipe", {
      recipe: recipe.ref,
      patch: {
        name: "Tempered curd rice",
        servings: 4,
        meal_type: "dinner",
        method: "Fold together, then temper.",
      },
      operations: [
        { action: "replace", line_id: rice, line: { food: "FS002", value: 500, unit: "g", note: "cooked and cooled" } },
        { action: "add", line: { food: "FS005", value: 1, measure: "tsp" }, position: 2 },
        { action: "move", line_id: curd, position: 1 },
        { action: "remove", line_id: rice },
      ],
      reason: "updated after cooking the repeatable version",
    });

    expect(body).toMatchObject({ state: "confirmed", action: "updated" });
    expect(body.affected).toMatchObject({ recipe_id: recipe.id, removed_line_ids: [rice] });
    expect(body.affected.created_line_ids).toHaveLength(1);
    expect(body.recipe).toMatchObject({
      ref: recipe.ref,
      name: "Tempered curd rice",
      servings: 4,
      meal_type: "dinner",
      method: "Fold together, then temper.",
    });
    expect(body.recipe.lines.map((line: { ref: string; position: number }) => ({ ref: line.ref, position: line.position }))).toEqual([
      { ref: "FS004", position: 1 },
      { ref: "FS005", position: 2 },
    ]);
    expect(body.recipe.per_serving.kcal.value).toBeGreaterThan(0);
    expect(x.t.get("SELECT reason FROM write_log WHERE tool = 'update_recipe' ORDER BY id DESC LIMIT 1")).toEqual({
      reason: "updated after cooking the repeatable version",
    });
    expect(x.t.get("SELECT action FROM record_version WHERE table_name = 'recipe_line' AND record_id = ? ORDER BY version DESC LIMIT 1", rice)).toEqual({ action: "delete" });
  });

  it("uses public amount shapes when replacing a line and returns recomputed nutrition", async () => {
    const { x, recipe } = await ready();
    const before = recipe.per_serving.kcal.value as number;
    const curd = recipe.lines[1].id as number;

    const body = await x.ok("update_recipe", {
      recipe: recipe.ref,
      operations: [{ action: "replace", line_id: curd, line: { food: "FS005", value: 2, measure: "tsp", link_status: "confirmed" } }],
      reason: "the saved version uses oil instead of curd",
    });

    expect(body.recipe.lines[1]).toMatchObject({ id: curd, ref: "FS005", amount_value: 2, amount_unit: "measure", measure: "tsp", link_status: "confirmed", note: null });
    expect(body.recipe.per_serving.kcal.value).not.toBe(before);
  });

  it("selects by exact name or alias and switches explicitly between manual and derived nutrition", async () => {
    const { x, recipe } = await ready();
    await x.ok("learn_alias", { alias: "comfort bowl", kind: "recipe", target: recipe.ref, reason: "household wording" });

    const manual = await x.ok("update_recipe", {
      recipe: "comfort bowl",
      patch: { manual_macros: { mode: "manual", kcal: 410, protein_g: 14, carbs_g: 62, fat_g: 11, reason: "complete restaurant nutrition label" } },
      reason: "use the complete label instead of ingredient estimates",
    });
    expect(manual.recipe).toMatchObject({ derived: false, manual_macros_reason: "complete restaurant nutrition label" });
    expect(manual.recipe.per_serving).toMatchObject({ kcal: { value: 410 }, protein: { value: 14 }, carbs: { value: 62 }, fat: { value: 11 } });

    const derived = await x.ok("update_recipe", {
      recipe: "Curd rice",
      patch: { manual_macros: { mode: "derived" }, source_assumptions: "household recipe weighed raw" },
      reason: "ingredients are now complete enough to derive nutrition",
    });
    expect(derived.recipe).toMatchObject({ derived: true, manual_macros_reason: null, source_assumptions: "household recipe weighed raw" });
    expect(derived.recipe.per_serving.kcal.value).not.toBe(410);
  });

  it("validates the final recipe and leaves every row unchanged when an operation is invalid", async () => {
    const { x, recipe } = await ready();
    const first = recipe.lines[0].id as number;
    const second = recipe.lines[1].id as number;

    const reply = await x.call("update_recipe", {
      recipe: recipe.ref,
      patch: { name: "This must roll back" },
      operations: [
        { action: "remove", line_id: first },
        { action: "remove", line_id: second },
      ],
      reason: "testing final validation",
    });

    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "no_lines" });
    const lookup = await x.ok("catalogue_lookup", { refs: [recipe.ref] });
    expect(lookup.recipes[0]).toMatchObject({ name: "Curd rice" });
    expect(lookup.recipes[0].lines.map((line: { id: number }) => line.id)).toEqual([first, second]);
  });

  it("requires a reason and refuses line ids belonging to another recipe", async () => {
    const { x, recipe } = await ready();
    const noReason = await x.call("update_recipe", { recipe: recipe.ref, patch: { servings: 3 } });
    expect(noReason.body).toMatchObject({ status: "needs_clarification", reason: "reason_needed" });

    const other = await x.ok("upsert_recipe", {
      name: "Plain peas",
      kind: "dish",
      servings: 1,
      lines: [{ food: "FS004", value: 100, unit: "g" }],
    });
    const reply = await x.call("update_recipe", {
      recipe: recipe.ref,
      operations: [{ action: "move", line_id: other.recipe.lines[0].id, position: 1 }],
      reason: "invalid cross-recipe edit",
    });
    expect(reply.http).toBe(404);
  });

  it("keeps a maximum-size edit within the D1 statement budget", async () => {
    const x = setup();
    await seedCatalogue(x);
    const made = await x.ok("upsert_recipe", {
      name: "Large batch recipe",
      kind: "dish",
      servings: 10,
      lines: Array.from({ length: 50 }, (_, index) => ({ food: "FS002", value: index + 1, unit: "g", note: `original ${index + 1}` })),
    });
    const operations = [
      ...made.recipe.lines.map((line: { id: number }, index: number) => ({
        action: "replace",
        line_id: line.id,
        line: { food: "FS004", value: index + 1, unit: "g", link_status: "assumed", note: `replacement ${index + 1}` },
      })),
      ...Array.from({ length: 50 }, (_, index) => ({
        action: "add",
        line: { food: "FS005", value: index + 1, unit: "ml", note: `addition ${index + 1}` },
      })),
    ];

    const run = await toolWithinBudget(x, "update_recipe", {
      recipe: made.recipe.ref,
      operations,
      reason: "bulk update from a complete recipe discussion",
    });
    expect(run.body.recipe.lines).toHaveLength(100);
    expect(run.body.recipe.lines[0]).toMatchObject({ link_status: "assumed", note: "replacement 1" });
    expect(run.body.recipe.lines[99]).toMatchObject({ note: "addition 50" });
  });

  it("keeps lookup-only aliases out of recipe version snapshots", async () => {
    const { x, recipe } = await ready();
    await x.ok("learn_alias", { alias: "rice bowl", kind: "recipe", target: recipe.ref, reason: "household wording" });
    await x.ok("update_recipe", { recipe: "rice bowl", patch: { servings: 3 }, reason: "the batch makes three servings" });

    const version = x.t.get("SELECT data FROM record_version WHERE table_name = 'recipe' AND record_id = ? ORDER BY version DESC LIMIT 1", recipe.id) as { data: string };
    expect(JSON.parse(version.data)).not.toHaveProperty("aliases");
  });
});
