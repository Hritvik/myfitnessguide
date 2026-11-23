// preview_meal runs household_meal's own planning, so the live remainder
// and portions the app shows are what saving writes; planEatenPortion is
// the one rule for a later share of a pot, previewed or written.
import { describe, expect, it } from "vitest";
import { Catalogue } from "../src/catalogue";
import { Ctx } from "../src/context";
import { loadCooks, planEatenPortion, previewIds, type LoadedCook } from "../src/nutrition";
import { toolWithinBudget } from "./budget";
import { setup } from "./harness";
import { busyInput, MONDAY } from "./input-seed";
import { seedCatalogue } from "./seed";

async function ready() {
  const x = setup();
  await seedCatalogue(x);
  await x.ok("upsert_recipe", { name: "Ghugni", kind: "dish", servings: 4, lines: [{ food: "peas", value: 250, unit: "g" }, { food: "FS005", value: 10, unit: "ml" }] });
  return x;
}

const meal = (over: Record<string, unknown> = {}) => ({
  date: MONDAY,
  meal_slot: "dinner",
  cooks: [{
    name: "Ghugni", recipe: "Ghugni",
    // Adjusted from the recipe: more peas, and a tsp of oil instead of 10 ml.
    lines: [{ food: "peas", value: 300, unit: "g", provenance: "weighed" }, { food: "FS005", value: 1, measure: "tsp", provenance: "estimated" }],
    portions: [{ member: "Hritvik", fraction: 0.4, provenance: "estimated" }, { member: "Asha", fraction: 0.3, provenance: "estimated" }],
  }],
  items: [{ member: "Kabir", source: "food", food: "curd", value: 100, unit: "g", provenance: "weighed", confidence: "high" }],
  ...over,
});

const lineView = (l: Record<string, unknown>) => ({ component: l.component, ref: l.ref, amount_value: l.amount_value, amount_unit: l.amount_unit, measure_id: l.measure_id, provenance: l.provenance, nutrients: l.nutrients });
const portionView = (p: Record<string, unknown>) => ({ member: p.member, component: p.component, fraction: p.fraction, weighed_g: p.weighed_g, nutrients: p.nutrients });

describe("preview_meal", () => {
  it("equals what household_meal then writes: lines, portions, remainder, totals and each member's total", async () => {
    const x = await ready();
    const writes = () => x.t.get("SELECT count(*) AS n FROM write_log");
    const before = writes();
    const preview = await x.ok("preview_meal", meal(), "hritvik");
    expect(writes()).toEqual(before);
    const saved = await x.ok("household_meal", meal(), "hritvik");
    expect(preview.cooks[0].lines.map(lineView)).toEqual(saved.cooks[0].lines.map(lineView));
    expect(preview.cooks[0].portions.map(portionView)).toEqual(saved.cooks[0].portions.map(portionView));
    expect(preview.cooks[0].remainder).toEqual(saved.cooks[0].remainder);
    expect(preview.cooks[0].totals).toEqual(saved.cooks[0].totals);
    expect(preview.members).toEqual(saved.members);
    expect(preview.cooks[0].remainder).toEqual([expect.objectContaining({ component: "whole", status: "unaccounted" })]);
  });

  it("keeps an absent member absent: no portion, not a portion of 0", async () => {
    const x = await ready();
    const preview = await x.ok("preview_meal", meal({ items: [] }), "hritvik");
    expect(preview.cooks[0].portions.map((p: { member: string }) => p.member)).toEqual(["Hritvik", "Asha"]);
    expect(preview.members).not.toHaveProperty("Kabir");
  });

  it("asks what household_meal would ask", async () => {
    const x = await ready();
    const over = meal({ cooks: [{ ...meal().cooks[0], portions: [{ member: "Hritvik", fraction: 0.8, provenance: "estimated" }, { member: "Asha", fraction: 0.4, provenance: "estimated" }] }] });
    expect((await x.call("preview_meal", over, "hritvik")).body).toMatchObject({ status: "needs_clarification", reason: "portions_exceed_whole" });
  });

  it("stays within the budget at 40 implements", async () => {
    const { x } = await busyInput(40);
    await x.ok("upsert_recipe", { name: "Ghugni", kind: "dish", servings: 4, lines: [{ food: "peas", value: 250, unit: "g" }, { food: "FS005", value: 10, unit: "ml" }] });
    await toolWithinBudget(x, "preview_meal", meal(), "hritvik");
  });

  it("keeps household_meal, now through planMeal, and mark_remainder's eaten share within the budget at 40 implements", async () => {
    const { x } = await busyInput(40);
    await x.ok("upsert_recipe", { name: "Ghugni", kind: "dish", servings: 4, lines: [{ food: "peas", value: 250, unit: "g" }, { food: "FS005", value: 10, unit: "ml" }] });
    const run = await toolWithinBudget(x, "household_meal", meal(), "hritvik");
    const componentId = run.body.cooks[0].components[0].id as number;
    const eaten = await toolWithinBudget(x, "mark_remainder", { component_id: componentId, disposition: "eaten", member: "Kabir", provenance: "estimated" }, "hritvik");
    expect(eaten.body.portion).toMatchObject({ member: "Kabir", fraction: expect.closeTo(0.3, 9), state: "draft" });
    expect(eaten.body.remainder).toEqual([]);
  });

  it("writes a bigger meal in the same number of statements: rows go in per table, not per row", async () => {
    const { x } = await busyInput(40);
    await x.ok("upsert_recipe", { name: "Ghugni", kind: "dish", servings: 4, lines: [{ food: "peas", value: 250, unit: "g" }, { food: "FS005", value: 10, unit: "ml" }] });
    const small = await x.counted("household_meal", meal(), "hritvik");
    const big = await x.counted("household_meal", meal({
      date: "2026-10-06",
      cooks: [
        meal().cooks[0],
        {
          name: "Pulao", components: [
            { name: "rice", lines: [{ food: "FS001", value: 200, unit: "g", provenance: "weighed" }, { food: "peas", value: 50, unit: "g", provenance: "weighed" }, { food: "FS005", value: 2, measure: "tsp", provenance: "estimated" }] },
            { name: "raita", lines: [{ food: "curd", value: 300, unit: "g", provenance: "weighed" }] },
          ],
          portions: [
            { member: "Hritvik", component: "rice", fraction: 0.4, provenance: "estimated" }, { member: "Asha", component: "rice", fraction: 0.3, provenance: "estimated" },
            { member: "Kabir", component: "rice", fraction: 0.2, provenance: "estimated" }, { member: "Hritvik", component: "raita", fraction: 0.5, provenance: "estimated" },
          ],
        },
      ],
      items: [
        { member: "Kabir", source: "food", food: "curd", value: 100, unit: "g", provenance: "weighed", confidence: "high" },
        { member: "Asha", source: "food", food: "curd", value: 80, unit: "g", provenance: "weighed", confidence: "high" },
      ],
    }), "hritvik");
    expect(big.body.cooks).toHaveLength(2);
    expect(big.statements).toBe(small.statements);
  });
});

describe("planEatenPortion", () => {
  it("plans a member's share of a pot with preview ids, stages nothing, and asks for a second share", async () => {
    const x = await ready();
    const pot = await x.ok("household_meal", {
      date: MONDAY, meal_slot: "lunch",
      cooks: [{ name: "Ghugni", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Asha", fraction: 0.25, provenance: "estimated" }] }],
    }, "asha");
    const ctx = new Ctx(x.counter, { kind: "member", memberId: x.h.hritvik, householdId: x.h.id, name: "Hritvik" }, () => x.clock.now, "Asia/Kolkata");
    await ctx.previewWrite();
    const cat = await Catalogue.load(ctx);
    const cookId = pot.cooks[0].id as number;
    const loaded = (await loadCooks(ctx, cat, [cookId])).get(cookId) as LoadedCook;
    const component = { id: pot.cooks[0].components[0].id as number, name: "whole" };
    const member = await ctx.memberById(x.h.hritvik);
    const where = { eaten_on: MONDAY, meal_slot: "dinner", household_meal_id: null };
    const planned = await planEatenPortion(ctx, cat, loaded, component, member, { fraction: 0.5, weighed_g: null }, where, "estimated", [], previewIds());
    expect(planned.portion).toMatchObject({ component_id: component.id, fraction: 0.5, state: "confirmed" });
    expect(planned.portion.id).toBeLessThan(0);
    // 400 g of peas at 81 kcal per 100 g is 324 kcal; half is 162.
    expect(planned.nutrients?.kcal?.value).toBeCloseTo(162, 9);
    expect(x.t.get("SELECT count(*) AS n FROM portion")).toEqual({ n: 1 });
    await expect(planEatenPortion(ctx, cat, loaded, component, member, { fraction: 0.1, weighed_g: null }, where, "estimated", [], previewIds())).rejects.toMatchObject({ reason: "duplicate_portion" });
  });
});
