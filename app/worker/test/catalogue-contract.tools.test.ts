// The catalogue screens and "Waiting on you" (app/web/src/catalogue.ts,
// waiting.ts) fed the real tools' answers, and the plans they build sent to
// the real write tools: the contract checked end to end, as the free-text
// contract test does. Pure functions only; no DOM. Invented data only.
import { describe, expect, it } from "vitest";
import {
  addLinePlan, addMeasurePlan, addWorkoutLinePlan, addYieldPlan, barPlan, createdHref, editPlan, FOOD_FIELDS, foodRows, foodView, forgetWordPlan,
  implementRows, lineAmountPlan, loadsPlan, plateRows, workoutLineText, newFoodPlan, newRecipePlan, recipeView, recordPlatesPlan, removeLinePlan, removeWorkoutLinePlan, startFields,
  teachWordPlan, usedBy,
} from "../../web/src/catalogue";
import type { CatalogueListFood, CatalogueRecords, Dependents, FoodRecord, HouseholdOverview, Inventory, Learned, WorkoutOut } from "../../web/src/types";
import { afterRefusal, confirmTickedPlan, waitingRows } from "../../web/src/waiting";
import { plainQuestion, type Plan } from "../../web/src/writes";
import { setup, type Harness } from "./harness";
import { seedCatalogue, seedTraining } from "./seed";

const TZ = "Asia/Kolkata";

/** Send a plan's one step as Hritvik, through the app's own seam. */
const send = (x: Harness, plan: Plan | { error: string } | null) => {
  if (plan === null) throw new Error("no plan: nothing ticked");
  if ("error" in plan) throw new Error(plan.error);
  const step = plan.steps[0] as Plan["steps"][number];
  return x.call(step.tool, step.input, "hritvik");
};
const lookup = async (x: Harness, ref: string) => (await x.ok("catalogue_lookup", { refs: [ref] }, "hritvik")) as unknown as CatalogueRecords;
const foodOf = async (x: Harness, ref: string) => (await lookup(x, ref)).food_sources[0] as FoodRecord;

describe("the catalogue's plans against the real tools", () => {
  it("lists foods in words and links them by ref", async () => {
    const x = setup();
    await seedCatalogue(x);
    const page = await x.ok("catalogue_list", { kind: "food_source" }, "hritvik");
    const rows = foodRows(page.items as CatalogueListFood[]);
    // The default reference (100 g, 100 ml) goes unsaid: the row reads "food".
    expect(rows.find((r) => r.label === "Rice (dry)")).toMatchObject({ hint: "food", href: "/catalogue/food/FS001" });
    expect(rows.map((r) => r.label).join(" ")).not.toMatch(/FS0/);
  });

  it("stores an emptied micronutrient as null and changes only the fields the member changed", async () => {
    const x = setup();
    await seedCatalogue(x);
    const rice = await foodOf(x, "FS001");
    expect(foodView(rice, []).micros.find((m) => m.key === "iron_mg")?.value).toBe("0.8 mg");
    const start = startFields(FOOD_FIELDS, rice);
    const reply = await send(x, editPlan(FOOD_FIELDS, { table: "food_source", id: rice.id }, { start, fields: { ...start, protein_g: "7.5", iron_mg: "" }, reason: "new pack label", override: null }, false));
    expect(reply.http).toBe(200);
    expect(Object.keys(reply.body.after).filter((k) => JSON.stringify(reply.body.after[k]) !== JSON.stringify(reply.body.before[k])).sort()).toEqual(["iron_mg", "protein_g"]);
    expect(x.t.get("SELECT protein_g, iron_mg, kcal, name FROM food_source WHERE id = ?", rice.id)).toEqual({ protein_g: 7.5, iron_mg: null, kcal: 360, name: "Rice" });
    expect(foodView(await foodOf(x, "FS001"), []).micros.find((m) => m.key === "iron_mg")?.value).toBe("unknown");
  });

  it("asks about macros that don't reconcile, and keeps them with the member's override reason", async () => {
    const x = setup();
    await seedCatalogue(x);
    const rice = await foodOf(x, "FS001");
    const start = startFields(FOOD_FIELDS, rice);
    const draft = { start, fields: { ...start, kcal: "500" }, reason: "label reprint", override: null };
    const asked = await send(x, editPlan(FOOD_FIELDS, { table: "food_source", id: rice.id }, draft, false));
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "energy_mismatch" });
    expect((await send(x, editPlan(FOOD_FIELDS, { table: "food_source", id: rice.id }, { ...draft, override: "the label really says 500" }, true))).http).toBe(200);
    expect(x.t.get("SELECT kcal, energy_override_reason FROM food_source WHERE id = ?", rice.id)).toEqual({ kcal: 500, energy_override_reason: "the label really says 500" });
  });

  it("refuses a rename to a learned word with its question", async () => {
    const x = setup();
    await seedCatalogue(x);
    await send(x, teachWordPlan("food_source", "FS004", { word: "dahi" }, "what we call curd", false));
    const rice = await foodOf(x, "FS001");
    const start = startFields(FOOD_FIELDS, rice);
    const reply = await send(x, editPlan(FOOD_FIELDS, { table: "food_source", id: rice.id }, { start, fields: { ...start, name: "dahi" }, reason: "x", override: null }, false));
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "name_is_an_alias" });
  });

  // Plan reviews #4 and #5, end to end.
  it("keeps someone else's change made while an edit is open, and asks before a rename onto another food's name", async () => {
    const x = setup();
    await seedCatalogue(x);
    const rice = await foodOf(x, "FS001");
    const start = startFields(FOOD_FIELDS, rice);
    // Another device changes protein while this edit is open, and the record re-reads quietly.
    await x.ok("amend", { record: { table: "food_source", id: rice.id }, changes: { protein_g: 7.2 }, reason: "the other device" }, "asha");
    const reread = await foodOf(x, "FS001");
    expect(reread.protein_g).toBe(7.2);
    // Saving the open edit sends only what this member changed.
    const reply = await send(x, editPlan(FOOD_FIELDS, { table: "food_source", id: rice.id }, { start, fields: { ...start, tags: "staple" }, reason: "tagging", override: null }, false));
    expect(Object.keys(reply.body.after).filter((k) => JSON.stringify(reply.body.after[k]) !== JSON.stringify(reply.body.before[k]))).toEqual(["tags"]);
    expect(x.t.get("SELECT protein_g, tags FROM food_source WHERE id = ?", rice.id)).toEqual({ protein_g: 7.2, tags: "staple" });
    // A rename onto another food's name in the same state asks, in plain words without the other food's ref.
    await send(x, newFoodPlan({ name: "Invented oats", state: "dry", reference_amount: "100", reference_unit: "g", kcal: "380", protein_g: "13", carbs_g: "67", fat_g: "7" }, "a new pack", null));
    const now = startFields(FOOD_FIELDS, await foodOf(x, "FS001"));
    const clash = await send(x, editPlan(FOOD_FIELDS, { table: "food_source", id: rice.id }, { start: now, fields: { ...now, name: "invented OATS" }, reason: "x", override: null }, false));
    expect(clash.body).toMatchObject({ status: "needs_clarification", reason: "duplicate_food_source" });
    expect(plainQuestion(clash.body.reason, clash.body.question)).not.toMatch(/FS\d/);
  });

  it("adds a food (the API allocates the ref), a measure and a yield from its other state", async () => {
    const x = setup();
    await seedCatalogue(x);
    const base = { reference_amount: "100", reference_unit: "g", protein_g: "13", carbs_g: "67", fat_g: "7" };
    const dry = await send(x, newFoodPlan({ ...base, name: "Invented oats", state: "dry", kcal: "380" }, "a new pack", null));
    expect(createdHref("food", dry.body)).toBe("/catalogue/food/FS007");
    const cooked = await send(x, newFoodPlan({ ...base, name: "Invented oats", state: "cooked", kcal: "95", protein_g: "3.3", carbs_g: "16.8", fat_g: "1.8" }, "porridge", null));
    const cookedRef = cooked.body.food_source.ref as string;
    expect((await send(x, addMeasurePlan(cookedRef, { name: "bowl", amount: "250" }, "weighed one"))).http).toBe(200);
    expect((await send(x, addYieldPlan(cookedRef, { from: "FS007", factor: "4", discarded: "" }, "weighed after cooking"))).http).toBe(200);
    const view = foodView(await foodOf(x, cookedRef), []);
    expect([view.measures, view.yields]).toEqual([["1 bowl = 250 g"], ["From dry: × 4"]]);
  });

  it("teaches a word, asks before taking one that means something else, replaces it only when asked, and forgets it with a reason", async () => {
    const x = setup();
    await seedCatalogue(x);
    expect((await send(x, teachWordPlan("food_source", "FS004", { word: "dahi" }, "what we call it", false))).http).toBe(200);
    const taken = await send(x, teachWordPlan("food_source", "FS003", { word: "dahi" }, "x", false));
    expect(taken.body).toMatchObject({ status: "needs_clarification", reason: "alias_taken" });
    expect((await send(x, teachWordPlan("food_source", "FS003", { word: "dahi" }, "it means egg here", true))).body.replaced).toMatchObject({ kind: "food_source" });
    const words = (await x.ok("learned", {}, "hritvik")) as unknown as Learned;
    const dahi = words.aliases.find((a) => a.alias === "dahi") as Learned["aliases"][number];
    expect((await send(x, forgetWordPlan(dahi.id, "dahi", "nobody says it"))).http).toBe(200);
    expect(x.t.get("SELECT count(*) AS n FROM alias WHERE alias = 'dahi'")).toEqual({ n: 0 });
  });

  it("makes a recipe, shows its meal type and totals, and changes, adds and removes its lines", async () => {
    const x = setup();
    await seedCatalogue(x);
    const made = await send(x, newRecipePlan({ name: "Invented pea curry", servings: "2", meal_type: "dinner", lines: "1", "line-0-food": "peas", "line-0-value": "300", "line-0-unit": "g" }, "how we make it"));
    const ref = made.body.recipe.ref as string;
    const recipe = (await lookup(x, ref)).recipes[0] as CatalogueRecords["recipes"][number];
    const view = recipeView(recipe);
    expect(view.facts).toBe("2 servings · dinner");
    expect(view.perServing).toMatch(/^Per serving: \d+ kcal/);
    const line = view.lines[0] as (typeof view.lines)[number];
    expect((await send(x, lineAmountPlan(line.id, "250", line.value, "less peas"))).http).toBe(200);
    const recipeNow = async () => recipeView((await lookup(x, ref)).recipes[0] as CatalogueRecords["recipes"][number]);
    expect((await recipeNow()).lines.find((l) => l.id === line.id)?.amount).toBe("250 g");
    expect((await send(x, addLinePlan(ref, { food: "curd", value: "100", unit: "g" }, "always has it"))).http).toBe(200);
    // Rice exists in two states: an ambiguous food asks, and nothing is written.
    const ambiguous = await send(x, addLinePlan(ref, { food: "rice", value: "100", unit: "g" }, "x"));
    expect(ambiguous.body.status).toBe("needs_clarification");
    // The member's answer (the add-line form's state) settles it.
    expect((await send(x, addLinePlan(ref, { food: "rice", value: "100", unit: "g", state: "dry" }, "x"))).http).toBe(200);
    expect((await send(x, removeLinePlan(ref, line.id, "Peas (raw)", "no peas this time"))).http).toBe(200);
    const left = (await recipeNow()).lines;
    expect(left.some((l) => l.id === line.id)).toBe(false);
    expect(left.map((l) => l.food)).toEqual(["Curd (as sold)", "Rice (dry)"]);
  });

  it("says what a food's change reaches, with the logged items' dates", async () => {
    const x = setup();
    await seedCatalogue(x);
    for (const date of ["2026-09-01", "2026-10-04"]) {
      await x.ok("log_intake", { member: "Hritvik", date, meal_slot: "lunch", items: [{ source: "food", food: "curd", value: 100, unit: "g", provenance: "weighed", confidence: "high" }] }, "hritvik");
    }
    const deps = (await x.ok("catalogue_dependents", { ref: "FS004" }, "hritvik")) as unknown as Dependents;
    expect(usedBy(deps).lines).toEqual(["2 logged items, Tue 1 Sep to Sun 4 Oct"]);
  });

  it("adds and removes a workout's line", async () => {
    const x = setup();
    seedTraining(x);
    const w = await x.ok("create_workout", { name: "Invented hotel legs", reason: "for travel", lines: [{ exercise: "Push-up", sets: 2, reps: { low: 10, high: 15 }, load: "none" }] }, "hritvik");
    const added = await send(x, addWorkoutLinePlan(w.workout.id, { exercise: "db curl", sets: "3", low: "10", high: "12" }, "no rack in the hotel"));
    expect(added.body.line).toMatchObject({ position: 2 });
    const linesOf = async () => ((await x.ok("workouts", {}, "hritvik")).workouts as WorkoutOut[]).find((o) => o.id === w.workout.id)?.lines ?? [];
    expect((await linesOf()).map(workoutLineText)).toHaveLength(2);
    expect((await send(x, removeWorkoutLinePlan(added.body.line.id, "Dumbbell curl", "too long"))).http).toBe(200);
    const kept = await linesOf();
    expect(kept.map((l) => l.id)).not.toContain(added.body.line.id);
    expect(kept.map((l) => l.exercise)).toEqual(["Push-up"]);
  });

  it("changes a gym's loads, plates and a bar's weight", async () => {
    const x = setup();
    const s = seedTraining(x);
    const inv = (await x.ok("inventory", { gym: s.gym }, "hritvik")) as unknown as Inventory;
    expect(implementRows(inv).find((i) => i.id === s.dumbbells)?.loads).toBe("2.5, 5, 7.5, 10, 12.5, 15, 17.5, 20 kg");
    expect((await send(x, loadsPlan("remove_implement_load", s.dumbbells, "kg", "15", "not at the gym"))).http).toBe(200);
    expect((await send(x, loadsPlan("add_implement_load", s.dumbbells, "kg", "22.5", "seen today"))).http).toBe(200);
    expect((await send(x, recordPlatesPlan(s.gym, "kg", "1.25, 2.5, 5", "0.5", "checked the rack"))).http).toBe(200);
    expect((await send(x, barPlan(s.barbell, "15", "kg", "it's a 15 kg bar"))).http).toBe(200);
    const after = (await x.ok("inventory", { gym: s.gym }, "hritvik")) as unknown as Inventory;
    expect(implementRows(after).find((i) => i.id === s.dumbbells)?.note).toBe("Not here: 15 kg.");
    expect(implementRows(after).find((i) => i.id === s.barbell)?.bar).toBe("Bar 15 kg");
    expect(plateRows(after).find((p) => p.startsWith("kg:"))).toBe("kg: 1.25, 2.5, 5; no 0.5. May be missing some.");
  });
});

describe("Waiting on you against the real tools", () => {
  it("confirms the ticked drafts in one write, and after a draft settled meanwhile, keeps the other tick for a new plan", async () => {
    const x = setup();
    await seedCatalogue(x);
    const logged = await x.ok("log_intake", { speaker: "Asha", member: "Hritvik", date: "2026-10-05", meal_slot: "lunch", items: [50, 60, 70].map((value) => ({ source: "food", food: "curd", value, unit: "g", provenance: "weighed", confidence: "high" })) });
    const read = async () => waitingRows((await x.ok("household_overview", {}, "hritvik")) as unknown as HouseholdOverview, [], TZ).rows;
    const rows = await read();
    expect(rows.map((r) => r.text)).toEqual(["Food: Curd", "Food: Curd", "Food: Curd"]);
    const [a, b, c] = rows.map((r) => r.key) as [string, string, string];
    // Another device confirms the first meanwhile.
    expect((await x.call("confirm", { records: [{ table: "intake_item", id: logged.items[0].id }] }, "hritvik")).http).toBe(200);
    const refused = await send(x, confirmTickedPlan(rows, new Set([a, b])));
    expect([refused.http, refused.body.error.code, refused.body.error.index]).toEqual([409, "not_draft", 0]);
    const after = afterRefusal(new Set([a, b]), await read());
    expect(after).toEqual({ ticked: new Set([b]), gone: [a] });
    // A new plan (a new key) with what is still ticked, then the rest.
    expect((await send(x, confirmTickedPlan(await read(), after.ticked))).http).toBe(200);
    expect((await read()).map((r) => r.key)).toEqual([c]);
  });
});
