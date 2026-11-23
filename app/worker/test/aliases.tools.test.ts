// One alias store: a word learned once works in every reader, means one
// thing across kinds, and is never taken silently.
import { describe, expect, it } from "vitest";
import { importWrite } from "../src/importing";
import { routerSince } from "../src/tools/aliases";
import { toolWithinBudget } from "./budget";
import { writeLog } from "./fixtures";
import { setup } from "./harness";
import { busyInput, MONDAY, seedUpperA } from "./input-seed";
import { seedCatalogue, seedTraining } from "./seed";

async function ready() {
  const x = setup();
  await seedCatalogue(x);
  const s = seedTraining(x);
  seedUpperA(x, s);
  await x.ok("upsert_recipe", { name: "Paneer bhurji", kind: "dish", servings: 1, lines: [{ food: "FS004", value: 150, unit: "g" }, { food: "FS005", value: 5, unit: "ml" }] });
  x.t.insert("workout", { household_id: x.h.id, name: "Hotel legs", created_at: "2026-10-01T00:00:00Z" });
  return { x, s };
}

const learn = (alias: string, kind: string, target: string | number, more: Record<string, unknown> = {}) => ({ alias, kind, target, reason: "what we call it", ...more });

describe("learn_alias", () => {
  it("teaches a word for each kind, and every reader then knows it", async () => {
    const { x } = await ready();
    await x.ok("learn_alias", learn("dahi", "food_source", "FS004"), "asha");
    await x.ok("learn_alias", learn("pb", "recipe", "R001"), "asha");
    await x.ok("learn_alias", learn("lpd", "exercise", "Cable lat pulldown"), "asha");
    await x.ok("learn_alias", learn("travel", "workout", "Hotel legs"), "asha");

    const food = await x.ok("log_intake", { member: "Hritvik", date: MONDAY, meal_slot: "lunch", items: [{ source: "food", food: "dahi", value: 100, unit: "g", provenance: "weighed", confidence: "high" }] });
    expect(food.items[0]).toMatchObject({ ref: "FS004" });
    const recipe = await x.ok("what_if", { member: "Hritvik", date: MONDAY, items: [{ source: "recipe", recipe: "pb", servings: 1, provenance: "estimated", confidence: "medium" }] });
    expect(recipe.items[0]).toMatchObject({ source_kind: "recipe", ref: "R001" });
    const meal = await x.ok("household_meal", { date: MONDAY, meal_slot: "dinner", cooks: [{ name: "Bhurji", recipe: "pb", portions: [{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }] }] });
    expect(meal.cooks[0].lines.map((l: { ref: string }) => l.ref)).toEqual(["FS004", "FS005"]);
    const set = await x.ok("log_set", { member: "Hritvik", date: MONDAY, exercise: "lpd", reps: 12, rir: 2, load: { value: 40, unit: "kg", basis: "total" } });
    expect(set.set.exercise).toBe("Cable lat pulldown");
    const workout = await x.ok("log_workout", { member: "Asha", date: MONDAY, source: { kind: "workout", workout: "travel" }, sets: [{ exercise: "pushups", reps: 10, load: "none" }] }, "asha");
    expect(workout.session.workout).toBe("Hotel legs");
    for (const [q, kind] of [["dahi", "food_source"], ["pb", "recipe"], ["lpd", "exercise"], ["travel", "workout"]]) {
      const hits = (await x.ok("catalogue_search", { query: q as string })).results;
      expect(hits[0]).toMatchObject({ kind, aliases: expect.arrayContaining([q]) });
    }
  });

  it("asks before taking a word that already means something else, then replaces it as a versioned delete and insert", async () => {
    const { x } = await ready();
    const first = await x.ok("learn_alias", learn("pb", "food_source", "FS004"));
    const reply = await x.call("learn_alias", learn("pb", "recipe", "R001"));
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "alias_taken", options: ["replace", "keep"], path: ["replace"] });
    expect(x.t.all("SELECT kind FROM alias WHERE alias = 'pb'")).toEqual([{ kind: "food_source" }]);
    const replaced = await x.ok("learn_alias", learn("pb", "recipe", "R001", { replace: true }));
    expect(replaced.replaced).toMatchObject({ id: first.alias.id, kind: "food_source" });
    expect(x.t.all("SELECT kind, target_id FROM alias WHERE alias = 'pb'")).toEqual([{ kind: "recipe", target_id: 1 }]);
    expect(x.t.get("SELECT action FROM record_version WHERE table_name = 'alias' AND record_id = ? ORDER BY version DESC LIMIT 1", first.alias.id)).toEqual({ action: "delete" });
  });

  it("is unchanged when the word already means that target", async () => {
    const { x } = await ready();
    await x.ok("learn_alias", learn("dahi", "food_source", "FS004"));
    expect((await x.ok("learn_alias", learn("DAHI", "food_source", "FS004"))).unchanged).toBe(true);
    expect(x.t.get("SELECT count(*) AS n FROM alias WHERE alias = 'dahi'")).toEqual({ n: 1 });
  });

  it("never makes a name into another thing's alias", async () => {
    const { x } = await ready();
    expect((await x.call("learn_alias", learn("Curd", "recipe", "R001"))).body).toMatchObject({ reason: "alias_is_a_name" });
    expect((await x.call("learn_alias", learn("Paneer bhurji", "recipe", "R001"))).body).toMatchObject({ reason: "alias_is_the_name" });
  });

  it("asks which state when the target names a food in several", async () => {
    const { x } = await ready();
    const reply = await x.call("learn_alias", learn("chawal", "food_source", "rice"));
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "target_ambiguous", options: ["FS001 (dry)", "FS002 (cooked)"] });
  });

  it("needs a reason", async () => {
    const { x } = await ready();
    expect((await x.call("learn_alias", { alias: "dahi", kind: "food_source", target: "FS004" })).body).toMatchObject({ reason: "reason_needed" });
  });
});

describe("a learned word can't become a new name", () => {
  it("asks when a new food source, recipe or workout takes a learned word as its name", async () => {
    const { x } = await ready();
    await x.ok("learn_alias", learn("pb", "recipe", "R001"));
    const food = await x.call("upsert_food_source", { name: "PB", state: "as_sold", reference_amount: 100, reference_unit: "g", kcal: 588, protein_g: 25, carbs_g: 20, fat_g: 50 });
    expect(food.body).toMatchObject({ status: "needs_clarification", reason: "name_is_an_alias", path: ["name"] });
    expect((await x.call("upsert_recipe", { name: "pb", kind: "dish", servings: 1, lines: [{ food: "FS004", value: 100, unit: "g" }] })).body).toMatchObject({ reason: "name_is_an_alias" });
    expect((await x.call("create_workout", { name: "Pb", reason: "r", lines: [{ exercise: "pushups", sets: 1, reps: { low: 10, high: 10 } }] })).body).toMatchObject({ reason: "name_is_an_alias" });
  });

  it("asks when a rename through amend, or a new exercise, takes a learned word", async () => {
    const { x } = await ready();
    await x.ok("learn_alias", learn("pb", "recipe", "R001"));
    await x.ok("learn_alias", learn("lpd", "exercise", "Cable lat pulldown"));
    const curd = x.t.get("SELECT id FROM food_source WHERE ref = 'FS004'")?.id as number;
    const legs = x.t.get("SELECT id FROM workout WHERE name = 'Hotel legs'")?.id as number;
    const rename = (table: string, id: number, name: string) => x.call("amend", { record: { table, id }, changes: { name }, reason: "renamed" });
    expect((await rename("food_source", curd, "PB")).body).toMatchObject({ status: "needs_clarification", reason: "name_is_an_alias", path: ["changes", "name"] });
    expect((await rename("recipe", 1, "lpd")).body).toMatchObject({ reason: "name_is_an_alias" });
    expect((await rename("workout", legs, "pb")).body).toMatchObject({ reason: "name_is_an_alias" });
    // A change of case only is not a new name.
    expect((await x.ok("amend", { record: { table: "recipe", id: 1 }, changes: { name: "PANEER BHURJI" }, reason: "case" })).after.name).toBe("PANEER BHURJI");
    const made = await importWrite(x.db, "create_exercise", { name: "PB", implement_kind: "barbell" }, { at: "2026-10-05T07:30:00Z", origin: { file: "base", tab: "Exercises", row: 1 } });
    expect(made).toMatchObject({ status: "needs_clarification", reason: "name_is_an_alias" });
  });
});

describe("recipe lookups through one RecipeBook (unchanged or fewer statements)", () => {
  const lookups = (run: { log: string[] }) => run.log.filter((sql) => sql.includes("AS _lines")).length;
  const recipe = (ref: string) => ({ source: "recipe", recipe: ref, servings: 1, provenance: "estimated", confidence: "medium" });
  const food = { source: "food", food: "FS004", value: 100, unit: "g", provenance: "weighed", confidence: "high" };

  it("log_intake and what_if read every recipe item with one statement (was two per item), and none without one", async () => {
    const { x } = await ready();
    await x.ok("learn_alias", learn("pb", "recipe", "R001"));
    const intake = (date: string, items: object[]) => x.counted("log_intake", { member: "Hritvik", date, meal_slot: "lunch", items });
    expect(lookups(await intake("2026-10-01", [food, food]))).toBe(0);
    expect(lookups(await intake("2026-10-02", [food, recipe("pb")]))).toBe(1);
    expect(lookups(await intake("2026-10-03", [recipe("R001"), recipe("Paneer bhurji"), recipe("pb")]))).toBe(1);
    expect(lookups(await x.counted("what_if", { member: "Hritvik", date: MONDAY, items: [recipe("pb"), recipe("R001")] }))).toBe(1);
  });

  it("household_meal reads its cooks' and items' recipes with one statement, and none without one", async () => {
    const { x } = await ready();
    await x.ok("learn_alias", learn("pb", "recipe", "R001"));
    const fromRecipes = await x.counted("household_meal", {
      date: MONDAY, meal_slot: "dinner",
      cooks: [
        { name: "Bhurji", recipe: "pb", portions: [{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }] },
        { name: "More bhurji", recipe: "R001", portions: [{ member: "Asha", fraction: 0.5, provenance: "estimated" }] },
      ],
      items: [{ member: "Kabir", ...recipe("Paneer bhurji") }],
    });
    expect(lookups(fromRecipes)).toBe(1);
    const fromLines = await x.counted("household_meal", {
      date: MONDAY, meal_slot: "lunch",
      cooks: [{ name: "Peas", lines: [{ food: "peas", value: 200, unit: "g", provenance: "weighed" }], portions: [{ member: "Hritvik", fraction: 1, provenance: "estimated" }] }],
    });
    expect(lookups(fromLines)).toBe(0);
  });
});

describe("forget_alias and learned", () => {
  it("forgets a word as a versioned delete, and lists every word with who taught it and when", async () => {
    const { x } = await ready();
    const dahi = await x.ok("learn_alias", learn("dahi", "food_source", "FS004"), "asha");
    await x.ok("learn_alias", learn("lpd", "exercise", "Cable lat pulldown"));
    const listed = await x.ok("learned", {}, "hritvik");
    expect(listed.aliases.map((a: { alias: string; kind: string; target: string; created_by: string | null }) => [a.alias, a.kind, a.target, a.created_by])).toEqual(
      expect.arrayContaining([["dahi", "food_source", "Curd (as_sold, FS004)", "Asha"], ["lpd", "exercise", "Cable lat pulldown", "Hritvik"], ["bench", "exercise", "Barbell bench press", null]]),
    );
    expect((await x.ok("learned", { member: "Asha" }, "hritvik")).aliases.map((a: { alias: string }) => a.alias)).toEqual(["dahi"]);
    await x.ok("forget_alias", { id: dahi.alias.id, reason: "we say curd" }, "asha");
    expect(x.t.get("SELECT count(*) AS n FROM alias WHERE alias = 'dahi'")).toEqual({ n: 0 });
    expect(x.t.get("SELECT action FROM record_version WHERE table_name = 'alias' AND record_id = ? ORDER BY version DESC LIMIT 1", dahi.alias.id)).toEqual({ action: "delete" });
  });

  it("gives the share of pieces saved unedited without Claude, per member per week", async () => {
    const { x } = await ready();
    const w = writeLog(x.t, { resolver: "member", origin: "app", actor_member_id: x.h.hritvik, tool: "commit_route" });
    x.t.insert("route_stat", { member_id: x.h.hritvik, write_id: w, recorded_on: "2026-10-05", unedited: 3, edited: 1, inbox: 0 });
    x.t.insert("route_stat", { member_id: x.h.hritvik, write_id: w, recorded_on: "2026-10-07", unedited: 0, edited: 0, inbox: 4 });
    x.t.insert("route_stat", { member_id: x.h.hritvik, write_id: w, recorded_on: "2026-09-30", unedited: 1, edited: 1, inbox: 0 });
    // Sunday weeks (the domain's weekStart): Sunday 4 Oct opens the week of Mon 5 and Wed 7; Sat 3 Oct closes the week before.
    x.t.insert("route_stat", { member_id: x.h.hritvik, write_id: w, recorded_on: "2026-10-04", unedited: 2, edited: 0, inbox: 0 });
    x.t.insert("route_stat", { member_id: x.h.hritvik, write_id: w, recorded_on: "2026-10-03", unedited: 0, edited: 2, inbox: 0 });
    const body = await x.ok("learned", { member: "Hritvik" }, "hritvik");
    expect(body.router).toEqual([
      { member: "Hritvik", week_of: "2026-10-04", unedited: 5, edited: 1, inbox: 4, pieces: 10, share_unedited: 0.5 },
      { member: "Hritvik", week_of: "2026-09-27", unedited: 1, edited: 3, inbox: 0, pieces: 4, share_unedited: 0.25 },
    ]);
  });
});

describe("alias budgets", () => {
  it("learn_alias, learned and catalogue_search stay within the budget at 40 implements", async () => {
    const { x } = await busyInput(40);
    await toolWithinBudget(x, "learn_alias", learn("lpd", "exercise", "Cable lat pulldown"));
    await toolWithinBudget(x, "learned", {}, "hritvik");
    await toolWithinBudget(x, "catalogue_search", { query: "lpd" });
  });

  it("forget_alias stays within the budget at 40 implements", async () => {
    const { x } = await busyInput(40);
    const taught = await x.ok("learn_alias", learn("lpd", "exercise", "Cable lat pulldown"));
    const run = await toolWithinBudget(x, "forget_alias", { id: taught.alias.id, reason: "not ours any more" });
    expect(run.body.forgotten).toMatchObject({ alias: "lpd", kind: "exercise" });
  });

  it("upsert_recipe writes its lines in a constant number of statements: 20 and 40 lines within the budget", async () => {
    const { x } = await busyInput(40);
    const foods = ["FS001", "FS002", "FS003", "FS004", "FS005", "FS006"];
    const counts: number[] = [];
    for (const n of [20, 40]) {
      const lines = Array.from({ length: n }, (_, i) => ({ food: foods[i % foods.length] as string, value: 10 + i, unit: i % foods.length === 4 ? "ml" : "g" }));
      const run = await toolWithinBudget(x, "upsert_recipe", { name: `Invented stew ${n}`, kind: "dish", servings: 4, lines });
      expect(run.body.recipe.lines).toHaveLength(n);
      expect(x.t.get("SELECT count(*) AS n FROM record_version WHERE table_name = 'recipe_line' AND record_id IN (SELECT id FROM recipe_line WHERE recipe_id = ?)", run.body.recipe.id)?.n).toBe(n);
      counts.push(run.statements);
    }
    expect(counts[1]).toBe(counts[0]);
  });

  it("upsert_food_source stays within the budget with measures and a yield", async () => {
    const { x } = await busyInput(40);
    const measures = Array.from({ length: 12 }, (_, i) => ({ name: `invented scoop ${i + 1}`, amount: 5 + i }));
    const run = await toolWithinBudget(x, "upsert_food_source", {
      name: "Rice", state: "soaked", reference_amount: 100, reference_unit: "g", kcal: 150, protein_g: 3, carbs_g: 33, fat_g: 0.3,
      measures, yields_from: [{ from: "FS001", factor: 1.5 }],
    });
    expect(run.body.food_source.measures).toHaveLength(12);
    expect(x.t.get("SELECT count(*) AS n FROM measure WHERE food_source_id = ?", run.body.food_source.id)?.n).toBe(12);
  });
});

describe("fix round 1", () => {
  it("catalogue_lookup resolves food refs and learned words in a constant number of statements (100 refs)", async () => {
    const { x } = await ready();
    await x.ok("learn_alias", learn("Dahi", "food_source", "FS004"));
    const one = await x.ok("catalogue_lookup", { refs: ["dahi", "FS002", "R001", "nope"] });
    expect(one.food_sources.map((f: { ref: string }) => f.ref)).toEqual(["FS004", "FS002"]);
    expect(one.food_sources[1].yields_from).toEqual([expect.objectContaining({ from_ref: "FS001", factor: 3 })]);
    expect(one.recipes.map((r: { ref: string }) => r.ref)).toEqual(["R001"]);
    expect(one.missing).toEqual(["nope"]);
    const pool = ["FS001", "FS002", "FS003", "FS004", "FS005", "FS006", "dahi", "R001"];
    const refs = Array.from({ length: 100 }, (_, i) => (i % 10 === 9 ? `missing${i}` : (pool[i % pool.length] as string)));
    const run = await toolWithinBudget(x, "catalogue_lookup", { refs });
    expect(run.body.food_sources.length + run.body.recipes.length + run.body.missing.length).toBe(100);
  });

  it("create_exercise refuses an alias that is another thing's name or word", async () => {
    const { x } = await ready();
    await x.ok("learn_alias", learn("pb", "recipe", "R001"));
    const at = { at: "2026-10-05T07:30:00Z", origin: { file: "base", tab: "Exercises", row: 1 } };
    expect(await importWrite(x.db, "create_exercise", { name: "Goblet squat", implement_kind: "dumbbell", aliases: ["gs", "Curd"] }, at)).toMatchObject({
      status: "needs_clarification", reason: "alias_is_a_name", path: ["aliases", 1],
    });
    expect(await importWrite(x.db, "create_exercise", { name: "Goblet squat", implement_kind: "dumbbell", aliases: ["PB"] }, at)).toMatchObject({
      status: "needs_clarification", reason: "alias_taken", path: ["aliases", 0],
    });
    expect(x.t.get("SELECT count(*) AS n FROM exercise WHERE name = 'Goblet squat'")).toEqual({ n: 0 });
  });

  it("returns a learned word as it was stored", async () => {
    const { x } = await ready();
    await x.ok("learn_alias", learn("Dahi", "food_source", "FS004"));
    expect((await x.ok("learn_alias", learn("DAHI", "food_source", "FS004"))).alias.alias).toBe("Dahi");
    expect((await x.ok("catalogue_search", { query: "dahi" })).results[0].aliases).toEqual(["Dahi"]);
  });

  it("learned's router rows cover the last 26 weeks", async () => {
    const { x } = await ready();
    const w = writeLog(x.t, { resolver: "member", origin: "app", actor_member_id: x.h.hritvik, tool: "commit_route" });
    // Today is Monday 2026-10-05, in the week of Sunday 2026-10-04; 26 weeks back starts Sunday 2026-04-12 (this week and the 25 before it).
    expect(routerSince("2026-10-05")).toBe("2026-04-12");
    expect(routerSince("2026-10-04")).toBe("2026-04-12");
    expect(routerSince("2026-10-10")).toBe("2026-04-12");
    x.t.insert("route_stat", { member_id: x.h.hritvik, write_id: w, recorded_on: "2026-04-11", unedited: 5, edited: 0, inbox: 0 });
    x.t.insert("route_stat", { member_id: x.h.hritvik, write_id: w, recorded_on: "2026-04-12", unedited: 1, edited: 0, inbox: 0 });
    const body = await x.ok("learned", {}, "hritvik");
    expect(body.router.map((r: { week_of: string }) => r.week_of)).toEqual(["2026-04-12"]);
  });

  it("catalogue_search stays within the budget with 500 recipes", async () => {
    const { x } = await ready();
    for (let i = 1; i <= 500; i++) {
      const id = x.t.insert("recipe", { household_id: x.h.id, ref: `RX${String(i).padStart(3, "0")}`, name: `Invented dish ${i}`, kind: "dish", servings: 2 });
      for (let p = 1; p <= 4; p++) x.t.insert("recipe_line", { recipe_id: id, position: p, food_source_id: p, amount_value: 50 * p, amount_unit: "g" });
    }
    const started = performance.now();
    const run = await toolWithinBudget(x, "catalogue_search", { query: "invented dish 250" });
    console.log(`catalogue_search over 500 recipes: ${(performance.now() - started).toFixed(1)} ms, ${run.statements} statements`);
    expect(run.body.results[0]).toMatchObject({ kind: "recipe", name: "Invented dish 250" });
  });
});
