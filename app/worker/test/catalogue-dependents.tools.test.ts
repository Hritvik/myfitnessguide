// catalogue_dependents gives the first and last day of the logged items
// that use a food or recipe (spec 2026-10-07 §5, §8.4), in the statement
// that counts them. Invented data only.
import { describe, expect, it } from "vitest";
import { toolWithinBudget } from "./budget";
import { setup } from "./harness";
import { seedCatalogue } from "./seed";

const curd = (date: string) => ({ member: "Hritvik", date, meal_slot: "lunch", items: [{ source: "food", food: "curd", value: 100, unit: "g", provenance: "weighed", confidence: "high" }] });

describe("catalogue_dependents: the logged items' dates", () => {
  it("gives a food's first and last logged day beside the count", async () => {
    const x = setup();
    const { curd: source } = await seedCatalogue(x);
    for (const date of ["2026-09-12", "2026-08-12", "2026-10-04"]) await x.ok("log_intake", curd(date), "hritvik");
    const body = await x.ok("catalogue_dependents", { ref: source.food_source.ref }, "hritvik");
    expect(body).toMatchObject({ kind: "food_source", intake_items: 3, intake_dates: { first: "2026-08-12", last: "2026-10-04" } });
  });

  it("gives null when nothing logged uses it, and a recipe's dates the same way", async () => {
    const x = setup();
    const { peas } = await seedCatalogue(x);
    expect((await x.ok("catalogue_dependents", { ref: peas.food_source.ref }, "hritvik")).intake_dates).toBeNull();
    const made = await x.ok("upsert_recipe", { name: "Invented pea curry", kind: "dish", servings: 2, lines: [{ food: peas.food_source.ref, value: 200, unit: "g" }] });
    for (const date of ["2026-10-01", "2026-09-20"]) {
      await x.ok("log_intake", { member: "Hritvik", date, meal_slot: "dinner", items: [{ source: "recipe", recipe: made.recipe.ref, servings: 1, provenance: "estimated", confidence: "medium" }] }, "hritvik");
    }
    expect(await x.ok("catalogue_dependents", { ref: made.recipe.ref }, "hritvik")).toMatchObject({ kind: "recipe", intake_items: 2, intake_dates: { first: "2026-09-20", last: "2026-10-01" } });
  });

  it("stays within the budget, with no statement added", async () => {
    const x = setup();
    const { curd: source } = await seedCatalogue(x);
    for (let d = 1; d <= 28; d++) await x.ok("log_intake", curd(`2026-09-${String(d).padStart(2, "0")}`), "hritvik");
    const run = await toolWithinBudget(x, "catalogue_dependents", { ref: source.food_source.ref }, "hritvik");
    expect(run.statements).toBe(6);
  });
});
