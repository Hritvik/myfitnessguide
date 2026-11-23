// catalogue_list (spec 2026-10-07 §5, §8.3): the household's catalogue by
// name, 200 a page, each row with its hint, in one statement. And a
// recipe's meal type and method in catalogue_lookup. Invented data only.
import { describe, expect, it } from "vitest";
import { toolWithinBudget } from "./budget";
import { NOW } from "./db";
import { exercise, foodSource, gym, implement, recipe, session, set } from "./fixtures";
import { setup } from "./harness";

const pad = (i: number) => String(i).padStart(3, "0");
// The harness clock is NOW; this is its date (the test fails if the household zone differs).
const TODAY = NOW.slice(0, 10);

describe("catalogue_list", () => {
  it("lists food sources by name with their state and reference amount, 200 a page, and only this household's", async () => {
    const x = setup();
    for (let i = 0; i < 450; i++) foodSource(x.t, x.h, { name: `Invented food ${pad(i)}`, ...(i === 7 ? { reference_amount: 1, reference_unit: "piece" } : {}) });
    const other = x.t.insert("household", { name: "Invented elsewhere", created_at: NOW });
    x.t.insert("food_source", { household_id: other, ref: "FS9999", name: "Invented food 000", state: "as_sold", reference_amount: 100, reference_unit: "g", kcal: 1, protein_g: 0, carbs_g: 0, fat_g: 0 });
    const first = await x.ok("catalogue_list", { kind: "food_source" }, "hritvik");
    expect(first).toMatchObject({ kind: "food_source", offset: 0, truncated: true, next_offset: 200 });
    expect(first.items).toHaveLength(200);
    expect(first.items[0]).toEqual({ id: expect.any(Number), ref: expect.any(String), name: "Invented food 000", state: "as_sold", reference_amount: 100, reference_unit: "g" });
    expect(first.items[7]).toMatchObject({ name: "Invented food 007", reference_amount: 1, reference_unit: "piece" });
    const second = await x.ok("catalogue_list", { kind: "food_source", offset: 200 }, "hritvik");
    expect(second.items[0].name).toBe("Invented food 200");
    const third = await x.ok("catalogue_list", { kind: "food_source", offset: 400 }, "hritvik");
    expect(third).toMatchObject({ offset: 400, truncated: false, next_offset: null });
    expect(third.items.map((f: { name: string }) => f.name)).toEqual(Array.from({ length: 50 }, (_, i) => `Invented food ${pad(400 + i)}`));
  });

  it("orders without case, then by state", async () => {
    const x = setup();
    foodSource(x.t, x.h, { name: "invented rice", state: "dry" });
    foodSource(x.t, x.h, { name: "Invented Rice", state: "cooked" });
    foodSource(x.t, x.h, { name: "Invented oats" });
    const body = await x.ok("catalogue_list", { kind: "food_source" }, "hritvik");
    expect(body.items.map((f: { name: string; state: string }) => [f.name, f.state])).toEqual([["Invented oats", "as_sold"], ["Invented Rice", "cooked"], ["invented rice", "dry"]]);
  });

  it("gives a recipe its line count", async () => {
    const x = setup();
    const food = foodSource(x.t, x.h);
    const dal = recipe(x.t, x.h, { name: "Invented dal", servings: 4 });
    for (let p = 1; p <= 6; p++) x.t.insert("recipe_line", { recipe_id: dal, position: p, food_source_id: food, amount_value: 50, amount_unit: "g" });
    recipe(x.t, x.h, { name: "Invented idea", kind: "idea" });
    const body = await x.ok("catalogue_list", { kind: "recipe" }, "hritvik");
    expect(body.items).toEqual([
      { id: dal, ref: expect.any(String), name: "Invented dal", kind: "dish", servings: 4, lines: 6 },
      { id: expect.any(Number), ref: expect.any(String), name: "Invented idea", kind: "idea", servings: 1, lines: 0 },
    ]);
  });

  it("gives an exercise its implement kind and when the caller last did it (the household's last, for the agent)", async () => {
    const x = setup();
    const g = gym(x.t, x.h);
    const row = exercise(x.t, x.h, { name: "Invented row", implement_kind: "cable" });
    const press = exercise(x.t, x.h, { name: "Invented press", implement_kind: "dumbbell" });
    const done = { state: "confirmed", confirmed_at: NOW };
    const setDone = { ...done, rir_status: "not_recorded" };
    set(x.t, session(x.t, x.h.hritvik, g, { performed_on: "2026-09-30", ...done }), row, setDone);
    set(x.t, session(x.t, x.h.asha, g, { performed_on: "2026-10-03", ...done }), row, setDone);
    const mine = await x.ok("catalogue_list", { kind: "exercise" }, "hritvik");
    expect(mine.items).toEqual([
      { id: press, name: "Invented press", implement_kind: "dumbbell", last_done: null },
      { id: row, name: "Invented row", implement_kind: "cable", last_done: "2026-09-30" },
    ]);
    const agent = await x.ok("catalogue_list", { kind: "exercise" });
    expect(agent.items[1]).toMatchObject({ name: "Invented row", last_done: "2026-10-03" });
  });

  it("counts only confirmed sets in confirmed sessions, not after today, as an exercise's last_done", async () => {
    const x = setup();
    const g = gym(x.t, x.h);
    const conf = { state: "confirmed", confirmed_at: NOW };
    const draftSet = { state: "draft", rir_status: "not_recorded" };
    const confSet = { ...conf, rir_status: "not_recorded" };
    // One exercise per case, each with one earlier confirmed day, so a wrongly counted row shows as a later date.
    const cases = {
      draftBoth: { date: "2026-10-04", session: { state: "draft" }, set: draftSet, last: "2026-09-30" },
      draftSetInConfirmedSession: { date: "2026-10-04", session: conf, set: draftSet, last: "2026-09-30" },
      confirmedSetInDraftSession: { date: "2026-10-04", session: { state: "draft" }, set: confSet, last: "2026-09-30" },
      future: { date: "2099-01-01", session: conf, set: confSet, last: "2026-09-30" },
      today: { date: TODAY, session: conf, set: confSet, last: TODAY },
    };
    for (const [name, c] of Object.entries(cases)) {
      const ex = exercise(x.t, x.h, { name: `Invented ${name}`, implement_kind: "cable" });
      set(x.t, session(x.t, x.h.hritvik, g, { performed_on: "2026-09-30", ...conf }), ex, confSet);
      set(x.t, session(x.t, x.h.hritvik, g, { performed_on: c.date, ...c.session }), ex, c.set);
    }
    for (const who of ["hritvik", undefined] as const) {
      const body = await x.ok("catalogue_list", { kind: "exercise" }, who);
      for (const [name, c] of Object.entries(cases)) {
        expect(body.items.find((i: { name: string }) => i.name === `Invented ${name}`).last_done, name).toBe(c.last);
      }
    }
  });

  it("pages at exactly 200 rows (not truncated) and at 201 (truncated, next_offset 200)", async () => {
    const x = setup();
    for (let i = 0; i < 200; i++) gym(x.t, x.h, { name: `Invented gym ${pad(i)}` });
    const exact = await x.ok("catalogue_list", { kind: "gym" }, "hritvik");
    expect(exact.items).toHaveLength(200);
    expect(exact).toMatchObject({ truncated: false, next_offset: null });
    gym(x.t, x.h, { name: "Invented gym 200" });
    const over = await x.ok("catalogue_list", { kind: "gym" }, "hritvik");
    expect(over.items).toHaveLength(200);
    expect(over).toMatchObject({ truncated: true, next_offset: 200 });
    const rest = await x.ok("catalogue_list", { kind: "gym", offset: 200 }, "hritvik");
    expect(rest.items).toHaveLength(1);
    expect(rest).toMatchObject({ truncated: false, next_offset: null });
  });

  it("gives a gym its equipment count", async () => {
    const x = setup();
    const g = gym(x.t, x.h, { name: "Invented gym" });
    implement(x.t, g);
    implement(x.t, g);
    gym(x.t, x.h, { name: "Invented annex" });
    const body = await x.ok("catalogue_list", { kind: "gym" }, "hritvik");
    expect(body.items).toEqual([
      { id: expect.any(Number), name: "Invented annex", equipment: 0 },
      { id: g, name: "Invented gym", equipment: 2 },
    ]);
  });

  it("refuses an unknown kind and a negative offset", async () => {
    const x = setup();
    expect((await x.call("catalogue_list", { kind: "workout" }, "hritvik")).body.status).toBe("invalid");
    expect((await x.call("catalogue_list", { kind: "gym", offset: -1 }, "hritvik")).body.status).toBe("invalid");
  });

  it("stays within the budget: 500 foods, and each other kind, in one statement after the caller", async () => {
    const x = setup();
    for (let i = 0; i < 500; i++) foodSource(x.t, x.h, { name: `Invented food ${pad(i)}` });
    const g = gym(x.t, x.h);
    const ex = exercise(x.t, x.h);
    for (let d = 1; d <= 28; d++) for (let s = 0; s < 10; s++) set(x.t, session(x.t, x.h.hritvik, g, { performed_on: `2026-09-${String(d).padStart(2, "0")}`, state: "confirmed", confirmed_at: NOW }), ex, { state: "confirmed", confirmed_at: NOW, rir_status: "not_recorded" });
    for (const kind of ["food_source", "recipe", "exercise", "gym"]) {
      const run = await toolWithinBudget(x, "catalogue_list", { kind }, "hritvik");
      expect(run.statements, kind).toBe(2);
    }
  });
});

describe("catalogue_lookup: a recipe's own fields", () => {
  it("gives a recipe's meal type, prep type and method", async () => {
    const x = setup();
    await x.ok("upsert_food_source", { name: "Invented lentils", state: "dry", reference_amount: 100, reference_unit: "g", kcal: 350, protein_g: 24, carbs_g: 60, fat_g: 1.5 });
    const made = await x.ok("upsert_recipe", { name: "Invented dal", kind: "dish", servings: 4, meal_type: "lunch", method: "Boil, then temper.", lines: [{ food: "Invented lentils", value: 200, unit: "g" }] });
    const body = await x.ok("catalogue_lookup", { refs: [made.recipe.ref] }, "hritvik");
    expect(body.recipes[0]).toMatchObject({ name: "Invented dal", meal_type: "lunch", prep_type: null, method: "Boil, then temper." });
    expect(made.recipe).toMatchObject({ meal_type: "lunch", method: "Boil, then temper." });
  });
});
