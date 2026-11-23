// Changing a recipe's ingredient lines and adding a yield to an existing
// food source: the paths "upserts only create" left without a tool. Each
// write keeps its reason in the write log.
import { describe, expect, it } from "vitest";
import { setup } from "./harness";
import { seedCatalogue } from "./seed";

async function ready() {
  const x = setup();
  const cat = await seedCatalogue(x);
  const recipe = await x.ok("upsert_recipe", {
    name: "Curd rice", kind: "dish", servings: 2,
    lines: [{ food: "FS002", value: 300, unit: "g" }, { food: "FS004", value: 200, unit: "g" }],
  });
  return { x, cat, recipe: recipe.recipe };
}

const reasonOf = (x: ReturnType<typeof setup>, tool: string) => x.t.get("SELECT reason FROM write_log WHERE tool = ? ORDER BY id DESC LIMIT 1", tool)?.reason;

describe("add_recipe_line and remove_recipe_line", () => {
  it("adds a line at the end and returns the recomputed recipe, with the reason in the write log", async () => {
    const { x, recipe } = await ready();
    const before = recipe.per_serving.kcal.value as number;
    const body = await x.ok("add_recipe_line", { recipe: recipe.ref, line: { food: "FS005", value: 1, measure: "tsp" }, reason: "the tempering uses a teaspoon of oil" });
    expect(body.line).toMatchObject({ position: 3, food: "FS005" });
    expect(body.recipe.lines).toHaveLength(3);
    expect(body.recipe.per_serving.kcal.value).toBeCloseTo(before + (4.5 * 884) / 100 / 2, 6);
    expect(reasonOf(x, "add_recipe_line")).toBe("the tempering uses a teaspoon of oil");
  });

  it("removes a line, keeping its last content as a delete version", async () => {
    const { x, recipe } = await ready();
    const line = recipe.lines[1].id as number;
    const body = await x.ok("remove_recipe_line", { recipe: recipe.ref, line_id: line, reason: "no curd in this version" });
    expect(body.recipe.lines.map((l: { id: number }) => l.id)).toEqual([recipe.lines[0].id]);
    expect(x.t.get("SELECT count(*) AS n FROM recipe_line WHERE id = ?", line)).toEqual({ n: 0 });
    expect(x.t.get("SELECT action FROM record_version WHERE table_name = 'recipe_line' AND record_id = ? ORDER BY version DESC LIMIT 1", line)).toEqual({ action: "delete" });
    expect(reasonOf(x, "remove_recipe_line")).toBe("no curd in this version");
  });

  it("asks for a reason, refuses a line of another recipe, and won't leave a dish with nothing in it", async () => {
    const { x, recipe } = await ready();
    const noReason = await x.call("add_recipe_line", { recipe: recipe.ref, line: { food: "FS005", value: 1, measure: "tsp" } });
    expect(noReason.body).toMatchObject({ status: "needs_clarification", reason: "reason_needed" });
    const other = await x.ok("upsert_recipe", { name: "Plain rice", kind: "dish", servings: 1, lines: [{ food: "FS002", value: 200, unit: "g" }] });
    const wrong = await x.call("remove_recipe_line", { recipe: recipe.ref, line_id: other.recipe.lines[0].id, reason: "x" });
    expect(wrong.http).toBe(404);
    const last = await x.call("remove_recipe_line", { recipe: other.recipe.ref, line_id: other.recipe.lines[0].id, reason: "x" });
    expect(last.body).toMatchObject({ status: "needs_clarification", reason: "no_lines" });
  });
});

describe("add_yield", () => {
  it("adds a yield to an existing source from another state of the same food", async () => {
    const x = setup();
    await seedCatalogue(x);
    const soaked = await x.ok("upsert_food_source", { name: "Rice", state: "soaked", reference_amount: 100, reference_unit: "g", kcal: 250, protein_g: 5, carbs_g: 55, fat_g: 0.4 });
    const body = await x.ok("add_yield", { food: soaked.food_source.ref, from: "FS001", factor: 1.4, reason: "soaked rice weighed against dry" });
    expect(body.yield).toMatchObject({ from: "FS001", to: soaked.food_source.ref, factor: 1.4, discarded_fraction: 0 });
    const lookup = await x.ok("catalogue_lookup", { refs: [soaked.food_source.ref] });
    expect(lookup.food_sources[0].yields_from).toEqual([expect.objectContaining({ from_ref: "FS001", factor: 1.4 })]);
    expect(reasonOf(x, "add_yield")).toBe("soaked rice weighed against dry");
  });

  it("changes an existing yield with amend", async () => {
    const x = setup();
    await seedCatalogue(x);
    const y = x.t.get("SELECT id FROM yield")!.id as number;
    const body = await x.ok("amend", { record: { table: "yield", id: y }, changes: { factor: 2.8 }, reason: "weighed a batch" });
    expect(body.after).toMatchObject({ factor: 2.8 });
  });

  it("refuses a yield across foods and a second yield for the same pair", async () => {
    const x = setup();
    await seedCatalogue(x);
    const across = await x.call("add_yield", { food: "FS003", from: "FS001", factor: 2, reason: "x" });
    expect(across.http).toBe(400);
    const again = await x.call("add_yield", { food: "FS002", from: "FS001", factor: 2.8, reason: "x" });
    expect(again.http).toBe(409);
  });
});
