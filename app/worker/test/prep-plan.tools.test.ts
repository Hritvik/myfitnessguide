import { describe, expect, it } from "vitest";
import { NOW } from "./db";
import { setup, type Harness } from "./harness";
import { READ_BUDGET, withinBudget } from "./budget";

const MON = "2026-11-23";
const TUE = "2026-11-24";
const WED = "2026-11-25";
const THU = "2026-11-26";
const SUN = "2026-11-29";

async function food(x: Harness, name: string): Promise<string> {
  const reply = await x.ok("upsert_food_source", {
    name, state: "dry", reference_amount: 100, reference_unit: "g",
    kcal: 120, protein_g: 8, carbs_g: 18, fat_g: 2, protein_band: "partial",
  });
  return reply.food_source.ref;
}

const lineOf = (ref: string) => ({ food: ref, value: 100, unit: "g" });
const cookLineOf = (ref: string) => ({ ...lineOf(ref), provenance: "weighed" });

async function recipe(x: Harness, name: string, ref: string, prep_steps: Record<string, unknown>[]): Promise<string> {
  const reply = await x.ok("upsert_recipe", {
    name, kind: "dish", servings: 1, lines: [lineOf(ref)], prep_steps,
  });
  return reply.recipe.ref;
}

const soak = (foodName: string, amount: number, group: string, batchDays: number) => ({
  action: "Soak", lead: "hours_before", lead_min_h: 8, lead_max_h: 12,
  who: "anyone", batchable: true, keeps_days: 1, batch_group: group, batch_days: batchDays,
  storage: "fridge", food: foodName, amount_value: amount, amount_unit: "g",
});

const pressureCook = (foodName: string, amount: number) => ({
  action: "Pressure-cook", lead: "day_before", who: "cook", batchable: true,
  keeps_days: 3, batch_group: "wed-pulses", storage: "fridge", freezer_ok: true,
  food: foodName, amount_value: amount, amount_unit: "g",
});

interface Catalogue {
  oats: string;
  bhurji: string;
  chole: string;
  penne: string;
  kala: string;
  lobia: string;
  keema: string;
  capsicum: string;
}

async function catalogue(x: Harness): Promise<Catalogue> {
  const kalaFood = await food(x, "kala chana");
  const chanaFood = await food(x, "kabuli chana");
  const lobiaFood = await food(x, "lobia");
  const oatsFood = await food(x, "oats");
  const eggFood = await food(x, "egg");
  const penneFood = await food(x, "penne");
  const soyaFood = await food(x, "soya");
  const capsicumFood = await food(x, "capsicum");
  const masala = {
    action: "Make the onion-tomato-garlic masala base", lead: "same_meal", who: "cook",
    batchable: true, keeps_days: 5, batch_group: "masala", storage: "fridge",
  };
  return {
    oats: await recipe(x, "Overnight protein oats", oatsFood, [
      { action: "Assemble overnight oats", lead: "evening_before", who: "eater", keeps_days: 1, storage: "fridge" },
    ]),
    bhurji: await recipe(x, "Egg bhurji on toast", eggFood, []),
    chole: await recipe(x, "Chole-sprout paneer bowl", chanaFood, [soak("kabuli chana", 80, "wed-pulses", 4), pressureCook("kabuli chana", 80)]),
    penne: await recipe(x, "Protein penne", penneFood, [
      { action: "Chop onion and capsicum", lead: "evening_before", who: "eater", keeps_days: 2, storage: "fridge" },
    ]),
    kala: await recipe(x, "Kala chana palak", kalaFood, [soak("kala chana", 140, "wed-pulses", 4), {
      action: "Pressure-cook", lead: "same_meal", who: "cook", batchable: true,
      keeps_days: 3, batch_group: "wed-pulses", storage: "fridge", freezer_ok: true,
      food: "kala chana", amount_value: 140, amount_unit: "g",
    }]),
    lobia: await recipe(x, "Lobia masala", lobiaFood, [soak("lobia", 140, "fri-lobia", 1), masala]),
    keema: await recipe(x, "Soya keema matar", soyaFood, [masala]),
    capsicum: await recipe(x, "Soya-stuffed capsicum", capsicumFood, [masala]),
  };
}

const meal = (date: string, meal_slot: string, recipeRef: string) => ({
  date, meal_slot,
  cooks: [{ name: recipeRef, recipe: recipeRef, portions: [{ member: "Hritvik", fraction: 1, provenance: "estimated" }] }],
  items: [],
});

function planOne(c: Catalogue) {
  return [
    meal(TUE, "breakfast", c.oats), meal(THU, "breakfast", c.oats), meal("2026-11-28", "breakfast", c.oats),
    meal(WED, "breakfast", c.bhurji), meal("2026-11-27", "breakfast", c.bhurji), meal(SUN, "breakfast", c.bhurji),
    meal(THU, "lunch", c.chole), meal(SUN, "lunch", c.chole),
    meal(TUE, "lunch", c.penne), meal(WED, "lunch", c.penne), meal("2026-11-27", "lunch", c.penne), meal("2026-11-28", "lunch", c.penne),
    meal(MON, "dinner", c.keema), meal("2026-11-28", "dinner", c.keema),
    meal(TUE, "dinner", c.capsicum), meal(SUN, "dinner", c.capsicum),
    meal(WED, "dinner", c.kala), meal(THU, "dinner", c.capsicum), meal("2026-11-27", "dinner", c.lobia),
  ];
}

describe("recipe prep steps", () => {
  it("creates, reads and amends steps while a recipe without steps is unchanged", async () => {
    const x = setup();
    const c = await catalogue(x);
    const read = await x.ok("catalogue_lookup", { refs: [c.kala, c.bhurji] });
    const kala = read.recipes.find((r: any) => r.ref === c.kala);
    const bhurji = read.recipes.find((r: any) => r.ref === c.bhurji);
    expect(kala.prep_steps.map((s: any) => s.action)).toEqual(["Soak", "Pressure-cook"]);
    expect(kala.prep_steps[0]).toMatchObject({ lead: "hours_before", lead_min_h: 8, lead_max_h: 12, who: "anyone", batchable: true, food: { ref: expect.any(String) } });
    expect(bhurji.prep_steps).toEqual([]);
    expect(bhurji.per_serving).toBeTruthy();

    const amended = await x.ok("update_recipe", {
      recipe: c.kala, change_reason: "Soak longer in winter",
      patch: { prep_steps: [{ ...soak("kala chana", 140, "wed-pulses", 4), lead_max_h: 14 }] },
    });
    expect(amended.recipe.prep_steps).toHaveLength(1);
    expect(amended.recipe.prep_steps[0].lead_max_h).toBe(14);
    const versions = x.t.all("SELECT count(*) AS n FROM record_version WHERE table_name = 'recipe_prep_step'")[0]!.n;
    expect(Number(versions)).toBeGreaterThanOrEqual(3);
  });
});

describe("plan prep schedule", () => {
  it("returns the worked plan's schedule: merged soak, split batch, thaw, batched masala", async () => {
    const x = setup({ now: "2026-11-24T15:00:00Z" });
    const c = await catalogue(x);
    const reply = await x.ok("preview_meal_plan", { entries: planOne(c), batch_day: 1 });
    const schedule: any[] = reply.prep_schedule;

    const soaks = schedule.filter((t) => t.action === "Soak");
    expect(soaks.length).toBeGreaterThan(0);
    const merged = soaks.find((t) => t.quantity.some((q: any) => q.food === "kala chana"));
    expect(merged.quantity.map((q: any) => q.food).sort()).toEqual(["kabuli chana", "kala chana"]);
    expect(merged.for.map((f: any) => `${f.date} ${f.meal_slot}`).sort()).toEqual([
      `${WED} dinner`, `${THU} lunch`, `${SUN} lunch`,
    ]);

    const cook = schedule.find((t) => t.action === "Pressure-cook")!;
    expect(cook.who).toBe("cook");
    expect(cook.parts.map((p: any) => p.storage)).toEqual(["fridge", "freezer"]);
    expect(cook.parts.find((p: any) => p.storage === "freezer").for).toEqual([{ date: SUN, meal_slot: "lunch", meal: c.chole }]);
    const thaw = schedule.find((t) => t.action.startsWith("Move the frozen"))!;
    expect(thaw).toMatchObject({ who: "eater", assignees: ["Hritvik"], for: [{ date: SUN }] });

    expect(schedule.filter((t) => t.action === "Assemble overnight oats")).toHaveLength(3);
    expect(schedule.filter((t) => t.action === "Chop onion and capsicum")).toHaveLength(4);
    const masala = schedule.find((t) => t.action.startsWith("Make the onion"))!;
    expect(masala.window_start.slice(0, 10)).toBe(MON);
  });

  it("gives the cook a sheet with the pressure-cook and the planned dinners", async () => {
    const x = setup({ now: "2026-11-24T15:00:00Z" });
    const c = await catalogue(x);
    await x.ok("save_meal_plan", { name: "Week", status: "active", entries: planOne(c), batch_day: 1, change_reason: "plan" });
    const sheet = await x.ok("cook_sheet", { date: WED });
    expect(sheet.tasks.map((t: any) => t.action)).toContain("Pressure-cook");
    expect(sheet.tasks.every((t: any) => t.who === "cook")).toBe(true);
    expect(sheet.meals.find((m: any) => m.meal_slot === "dinner").dishes).toEqual([c.kala]);
    expect(sheet.meals.flatMap((m: any) => m.dishes)).not.toContain("Assemble overnight oats");
  });

  it("returns no schedule when no planned recipe has steps, and identical totals", async () => {
    const x = setup();
    const c = await catalogue(x);
    const entries = [meal(MON, "lunch", c.bhurji), meal(MON, "dinner", c.bhurji)];
    const reply = await x.ok("preview_meal_plan", { entries });
    expect(reply.prep_schedule).toEqual([]);
    expect(reply.meals).toHaveLength(2);
  });

  it("persists the schedule, keeps a settled task done across a revision, and fills prepared batches", async () => {
    const x = setup({ now: "2026-11-24T15:00:00Z" });
    const c = await catalogue(x);
    const entries = planOne(c);
    const saved = await x.ok("save_meal_plan", { name: "Hritvik fat-loss week 23-29 Nov 2026", status: "active", entries, batch_day: 1, change_reason: "plan the week" });
    const planId = saved.plan.id;
    const read = await x.ok("meal_plan", { plan_id: planId });
    expect(read.prep_tasks.length).toBe(saved.preview.prep_schedule.length);

    const soakTask = read.prep_tasks.find((t: any) => t.action === "Soak");
    const settled = await x.ok("settle_prep_task", { task_id: soakTask.id, status: "done" }, "hritvik");
    expect(settled.task.status).toBe("done");

    const revised = await x.ok("save_meal_plan", {
      plan_id: planId, expected_revision: 1, name: "Hritvik fat-loss week 23-29 Nov 2026",
      status: "active", entries, batch_day: 1, change_reason: "keep the plan",
    });
    const after = await x.ok("meal_plan", { plan_id: revised.plan.id });
    expect(after.prep_tasks.find((t: any) => t.task_key === soakTask.task_key).status).toBe("done");

    // A pot cooked with shares not decided is an open batch.
    await x.ok("household_meal", { date: TUE, meal_slot: "dinner", cooks: [{ name: "Dal", lines: [cookLineOf(await food(x, "masoor"))], portions: [] }], items: [] });
    const context = await x.ok("household_planning_context", { from: TUE, to: TUE });
    expect(context.prepared_batches).toEqual([expect.objectContaining({ cook: "Dal", fraction: expect.any(Number) })]);
  });
});

describe("next prep after a logged meal", () => {
  it("returns the soak and the chopping for tonight, and not the oats for a breakfast that needs none", async () => {
    const x = setup({ now: "2026-11-24T15:00:00Z" });
    const c = await catalogue(x);
    await x.ok("save_meal_plan", { name: "Week", status: "active", entries: planOne(c), batch_day: 1, change_reason: "plan" });
    const logged = await x.ok("household_meal", { date: TUE, meal_slot: "dinner", cooks: [{ name: "Soya-stuffed capsicum", recipe: c.capsicum, portions: [{ member: "Hritvik", fraction: 1, provenance: "estimated" }] }], items: [] });
    const actions = logged.next_prep.map((t: any) => t.action);
    expect(actions).toContain("Soak");
    expect(actions).toContain("Chop onion and capsicum");
    expect(actions.some((a: string) => a.startsWith("Assemble overnight oats"))).toBe(false);
    const soak = logged.next_prep.find((t: any) => t.action === "Soak");
    expect(soak.quantity.map((q: any) => q.food).sort()).toEqual(["kabuli chana", "kala chana"]);
  });
});

describe("prep budgets", () => {
  it("preview, day_prep, needs_you and waiting stay within the D1 statement budget", async () => {
    const x = setup({ now: "2026-11-24T15:00:00Z" });
    const c = await catalogue(x);
    await x.ok("save_meal_plan", { name: "Week", status: "active", entries: planOne(c), batch_day: 1, change_reason: "plan" });
    withinBudget(await x.counted("day_prep", { member: "Hritvik", date: TUE }), READ_BUDGET);
    withinBudget(await x.counted("needs_you", { member: "Hritvik", date: TUE }, "hritvik"), READ_BUDGET);
    withinBudget(await x.counted("waiting", { member: "Hritvik", date: TUE }, "hritvik"), READ_BUDGET);
    withinBudget(await x.counted("household_planning_context", { from: TUE, to: TUE }), READ_BUDGET);
  });
});
