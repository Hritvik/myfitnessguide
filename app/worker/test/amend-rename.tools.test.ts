// A rename onto another record's name asks (plan review #5), as the
// upserts do, instead of failing on the UNIQUE name. Invented data only.
import { describe, expect, it } from "vitest";
import { toolWithinBudget } from "./budget";
import { setup, type Harness } from "./harness";
import { seedCatalogue } from "./seed";

const idOf = (x: Harness, table: string, ref: string) => (x.t.get(`SELECT id FROM ${table} WHERE ref = ?`, ref) as { id: number }).id;
const rename = (x: Harness, table: string, id: number, name: string) => x.call("amend", { record: { table, id }, changes: { name }, reason: "a clearer name" }, "hritvik");

describe("amend: a rename onto another record's name", () => {
  it("asks for a food in the same state, naming the other food, and writes nothing", async () => {
    const x = setup();
    await seedCatalogue(x);
    const other = await x.ok("upsert_food_source", { name: "Invented rice", state: "dry", reference_amount: 100, reference_unit: "g", kcal: 350, protein_g: 7, carbs_g: 77, fat_g: 1 });
    const rice = idOf(x, "food_source", "FS001");
    const reply = await rename(x, "food_source", rice, "invented RICE");
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "duplicate_food_source", options: [other.food_source.ref], path: ["changes", "name"] });
    expect(x.t.get("SELECT name FROM food_source WHERE id = ?", rice)).toEqual({ name: "Rice" });
  });

  it("lets a food take a name another state of a food has, and its own name in another case", async () => {
    const x = setup();
    await seedCatalogue(x);
    expect((await rename(x, "food_source", idOf(x, "food_source", "FS003"), "Rice")).http).toBe(200);
    expect((await rename(x, "food_source", idOf(x, "food_source", "FS001"), "rice")).http).toBe(200);
  });

  it("asks for a recipe with another recipe's name", async () => {
    const x = setup();
    await seedCatalogue(x);
    const a = await x.ok("upsert_recipe", { name: "Invented dal", kind: "dish", servings: 2, lines: [{ food: "peas", value: 200, unit: "g" }] });
    const b = await x.ok("upsert_recipe", { name: "Invented curry", kind: "dish", servings: 2, lines: [{ food: "peas", value: 200, unit: "g" }] });
    const reply = await rename(x, "recipe", b.recipe.id, "Invented Dal");
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "duplicate_recipe", options: [a.recipe.ref] });
  });

  it("stays within the budget", async () => {
    const x = setup();
    await seedCatalogue(x);
    await toolWithinBudget(x, "amend", { record: { table: "food_source", id: idOf(x, "food_source", "FS003") }, changes: { name: "Invented egg" }, reason: "a clearer name" }, "hritvik");
  });
});
