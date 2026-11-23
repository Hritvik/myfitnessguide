import { describe, expect, it } from "vitest";
import { importWrite } from "../src/importing";
import { setup } from "./harness";
import { seedCatalogue, seedTraining } from "./seed";

/** Invented values; 4 x 5 + 4 x 15 + 9 x 0.5 = 84.5 kcal of macros against 82 stated. */
const PEAS = { name: "Peas", state: "raw", reference_amount: 100, reference_unit: "g", kcal: 82, protein_g: 5, carbs_g: 15, fat_g: 0.5 };

describe("upsert_food_source", () => {
  it("creates a source under the next free ref, confirmed on write, and returns what it computed", async () => {
    const x = setup();
    const body = await x.ok("upsert_food_source", {
      name: "Paneer", state: "as_sold", reference_amount: 100, reference_unit: "g",
      kcal: 265, protein_g: 18, carbs_g: 1.2, fat_g: 20.8, price_min_inr: 40, price_max_inr: 50,
      measures: [{ name: "cube", amount: 25 }],
    });
    expect(body.action).toBe("created");
    expect(body.food_source).toMatchObject({ ref: "FS001", name: "Paneer", state: "as_sold" });
    expect(body.food_source.measures).toEqual([{ name: "cube", amount: 25 }]);
    // 40-50 INR per 18 g protein: 55.56-69.44 INR per 25 g.
    expect(body.computed.cost_per_25g_protein_inr.min).toBeCloseTo(55.5556, 4);
    expect(body.computed.cost_per_25g_protein_inr.max).toBeCloseTo(69.4444, 4);
    expect(body.write_id).toEqual(expect.any(Number));
  });

  it("allocates the next free number after the highest ref, whoever made it", async () => {
    const x = setup();
    await importWrite(x.db, "upsert_food_source", { ref: "FS041", ...PEAS }, { at: "2026-10-05T19:07:21Z", origin: { file: "base", tab: "Food Sources", row: 2 } });
    const body = await x.ok("upsert_food_source", { ...PEAS, name: "Chickpeas" });
    expect(body.food_source.ref).toBe("FS042");
  });

  it("refuses an existing ref, pointing at amend, so a source is never replaced whole", async () => {
    const x = setup();
    const { curd } = await seedCatalogue(x);
    const reply = await x.call("upsert_food_source", {
      ref: "FS004", name: "Curd", state: "as_sold", reference_amount: 100, reference_unit: "g",
      kcal: 62, protein_g: 3.6, carbs_g: 4.7, fat_g: 3.1,
    });
    expect(reply.http).toBe(409);
    expect(reply.body.error).toMatchObject({ code: "ref_exists", use: "amend", record: { table: "food_source", id: curd.food_source.id } });
    // The change goes through amend, keeping the earlier version.
    const amended = await x.ok("amend", { record: { table: "food_source", id: curd.food_source.id }, changes: { kcal: 62, protein_g: 3.6 }, reason: "new label" });
    expect(amended.after).toMatchObject({ ref: "FS004", kcal: 62, calcium_mg: 120 });
    const history = await x.ok("history", { table: "food_source", id: curd.food_source.id });
    expect(history.versions.map((v: { action: string }) => v.action)).toEqual(["create", "amend"]);
  });

  it("refuses a ref the API didn't allocate: leave it out to create", async () => {
    const x = setup();
    const reply = await x.call("upsert_food_source", { ref: "FS777", ...PEAS });
    expect(reply.http).toBe(400);
    expect(reply.body.error.code).toBe("ref_not_allocated");
    expect(x.t.get("SELECT count(*) AS n FROM food_source")).toEqual({ n: 0 });
  });

  it("asks before creating a second source with the same name and state, pointing at amend", async () => {
    const x = setup();
    await seedCatalogue(x);
    const reply = await x.call("upsert_food_source", { ...PEAS, name: "peas", state: "raw" });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "duplicate_food_source", options: ["FS006"] });
    expect(reply.body.question).toMatch(/amend/);
  });

  it("links states of one food by a yield", async () => {
    const x = setup();
    const { rice_cooked } = await seedCatalogue(x);
    expect(rice_cooked.food_source.yields_from).toEqual([
      { from_ref: "FS001", from_state: "dry", factor: 3, discarded_fraction: 0 },
    ]);
  });

  it("refuses a yield between two different foods", async () => {
    const x = setup();
    await seedCatalogue(x);
    const reply = await x.call("upsert_food_source", {
      name: "Poha", state: "cooked", reference_amount: 100, reference_unit: "g",
      kcal: 130, protein_g: 2.5, carbs_g: 27, fat_g: 1, yields_from: [{ from: "FS001", factor: 2 }],
    });
    expect(reply.http).toBe(400);
    expect(reply.body.error.code).toBe("yield_across_foods");
  });
});

describe("add_measure", () => {
  it("adds a measure to an existing source, which intake can then use", async () => {
    const x = setup();
    await seedCatalogue(x);
    const body = await x.ok("add_measure", { food: "FS004", name: "katori", amount: 150 });
    expect(body.measure).toMatchObject({ food: "FS004", name: "katori", amount: 150, unit: "g" });
    const logged = await x.ok("log_intake", {
      member: "Hritvik", date: "2026-10-05", meal_slot: "lunch",
      items: [{ source: "food", food: "curd", value: 1, measure: "katori", provenance: "estimated", confidence: "medium" }],
    });
    expect(logged.items[0].nutrients.kcal.value).toBeCloseTo(90, 9);
  });

  it("refuses a measure the source already has, pointing at amend", async () => {
    const x = setup();
    await seedCatalogue(x);
    const reply = await x.call("add_measure", { food: "FS003", name: "Egg", amount: 55 });
    expect(reply.http).toBe(409);
    expect(reply.body.error).toMatchObject({ code: "measure_exists", use: "amend", record: { table: "measure" } });
  });
});

describe("amend on a recipe line", () => {
  it("changes one ingredient's amount, and the recipe follows", async () => {
    const x = setup();
    await seedCatalogue(x);
    const created = await x.ok("upsert_recipe", { name: "Curd rice", kind: "dish", servings: 1, lines: [{ food: "FS002", value: 200, unit: "g" }, { food: "FS004", value: 100, unit: "g" }] });
    const line = created.recipe.lines[1];
    await x.ok("amend", { record: { table: "recipe_line", id: line.id }, changes: { amount_value: 150 }, reason: "more curd now" });
    const looked = await x.ok("catalogue_lookup", { refs: [created.recipe.ref] });
    // 240 kcal of rice + 90 of curd.
    expect(looked.recipes[0].per_serving.kcal.value).toBeCloseTo(330, 9);
  });
});

describe("upsert_food_source: the label energy check", () => {
  // Invented label: 300 kcal stated; 4 x 20 + 4 x 30 + 9 x 10 = 290 by Atwater.
  const label = { name: "Trail mix", state: "as_sold", reference_amount: 50, reference_unit: "g", kcal: 300, protein_g: 20, carbs_g: 30, fat_g: 10 };

  it("returns the check with a label that reconciles", async () => {
    const x = setup();
    const body = await x.ok("upsert_food_source", { ...label });
    expect(body.energy_check).toEqual({ reconciles: true, atwater_kcal: 290, difference_kcal: -10, tolerance_kcal: 30, override_reason: null });
  });

  it("asks when the macros miss the stated energy by more than max(10%, 15 kcal), and writes nothing", async () => {
    const x = setup();
    const reply = await x.call("upsert_food_source", { ...label, fat_g: 0 });
    expect(reply.http).toBe(200);
    expect(reply.body).toMatchObject({
      status: "needs_clarification", reason: "energy_mismatch", path: ["kcal"],
      energy_check: { reconciles: false, atwater_kcal: 200, difference_kcal: -100, tolerance_kcal: 30 },
    });
    expect(reply.body.question).toMatch(/200 kcal/);
    expect(x.t.get("SELECT count(*) AS n FROM food_source")).toEqual({ n: 0 });
  });

  it("saves a mismatch when an override reason is given, and keeps the reason", async () => {
    const x = setup();
    const body = await x.ok("upsert_food_source", { ...label, fat_g: 0, energy_override_reason: "label prints energy including fibre at 2 kcal/g" });
    expect(body.energy_check).toMatchObject({ reconciles: false, override_reason: "label prints energy including fibre at 2 kcal/g" });
    expect(body.food_source.energy_override_reason).toBe("label prints energy including fibre at 2 kcal/g");
  });

  it("amend runs the same check on the corrected values", async () => {
    const x = setup();
    const created = await x.ok("upsert_food_source", { ...label });
    const record = { table: "food_source", id: created.food_source.id };
    const reply = await x.call("amend", { record, changes: { kcal: 400 }, reason: "label re-read" });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "energy_mismatch" });
    const fixed = await x.ok("amend", { record, changes: { kcal: 400, fat_g: 21 }, reason: "label re-read: fat was 21 g" });
    expect(fixed.computed.energy_check).toMatchObject({ reconciles: true, atwater_kcal: 389 });
    const forced = await x.ok("amend", { record, changes: { kcal: 500, energy_override_reason: "the label is wrong; kept as printed" }, reason: "as printed" });
    expect(forced.computed.energy_check).toMatchObject({ reconciles: false, override_reason: "the label is wrong; kept as printed" });
  });
});

describe("idempotency: every write carries a key", () => {
  it("a retry with the same key returns the original response and writes nothing new", async () => {
    const x = setup();
    const input = {
      idempotency_key: "paneer-1", name: "Paneer", state: "as_sold", reference_amount: 100,
      reference_unit: "g", kcal: 265, protein_g: 18, carbs_g: 1.2, fat_g: 20.8,
    };
    const first = await x.call("upsert_food_source", input);
    const batches = x.db.batches;
    const again = await x.call("upsert_food_source", input);
    expect(again.http).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(x.db.batches).toBe(batches);
  });

  it("the same key with a different request is a conflict", async () => {
    const x = setup();
    const input = {
      idempotency_key: "paneer-1", name: "Paneer", state: "as_sold", reference_amount: 100,
      reference_unit: "g", kcal: 265, protein_g: 18, carbs_g: 1.2, fat_g: 20.8,
    };
    await x.call("upsert_food_source", input);
    const reply = await x.call("upsert_food_source", { ...input, kcal: 300 });
    expect(reply.http).toBe(409);
    expect(reply.body.error.code).toBe("idempotency_key_reused");
  });

  it("a write without a key is invalid", async () => {
    const x = setup();
    const raw = await x.raw("/tools/upsert_food_source", {
      method: "POST",
      body: JSON.stringify({ name: "Paneer", state: "as_sold", reference_amount: 100, reference_unit: "g", kcal: 1, protein_g: 1, carbs_g: 1, fat_g: 1, speaker: "Hritvik" }),
    });
    expect(raw.http).toBe(400);
    expect(raw.body.issues.map((i: { path: string[] }) => i.path[0])).toContain("idempotency_key");
  });
});

describe("catalogue_search", () => {
  it("matches fuzzily across food sources, recipes and exercise aliases", async () => {
    const x = setup();
    await seedCatalogue(x);
    seedTraining(x);
    const typo = await x.ok("catalogue_search", { query: "musterd oil" });
    expect(typo.results[0]).toMatchObject({ kind: "food_source", ref: "FS005", name: "Mustard oil" });
    const alias = await x.ok("catalogue_search", { query: "pulldown", kinds: ["exercise"] });
    expect(alias.results[0]).toMatchObject({ kind: "exercise", name: "Cable lat pulldown" });
    const rice = await x.ok("catalogue_search", { query: "rice" });
    expect(rice.results.map((r: { ref: string }) => r.ref)).toEqual(["FS001", "FS002"]);
  });

  it("offers a near-spelling only when nothing matches better: \"rice\" doesn't find a whey's \"Rich\" (click test P2-4)", async () => {
    const x = setup();
    await seedCatalogue(x);
    await x.ok("upsert_food_source", { name: "Whey, Double Rich Chocolate", state: "as_sold", reference_amount: 100, reference_unit: "g", kcal: 380, protein_g: 75, carbs_g: 10, fat_g: 4 });
    const rice = await x.ok("catalogue_search", { query: "rice" });
    expect(rice.results.map((r: { name: string }) => r.name)).not.toContain("Whey, Double Rich Chocolate");
    const typo = await x.ok("catalogue_search", { query: "rich" });
    expect(typo.results[0]).toMatchObject({ name: "Whey, Double Rich Chocolate" });
    const onlyNear = await x.ok("catalogue_search", { query: "ryce" });
    expect(onlyNear.results.map((r: { ref: string }) => r.ref)).toEqual(["FS001", "FS002"]);
  });

  it("filters near-spellings per kind: a typo for a food still finds it when a recipe matches better (review of P2-4)", async () => {
    const x = setup();
    await seedCatalogue(x);
    const fruit = { state: "raw", reference_amount: 100, reference_unit: "g", kcal: 57, protein_g: 0.4, carbs_g: 15, fat_g: 0.1 };
    await x.ok("upsert_food_source", { name: "Pear", ...fruit });
    await x.ok("upsert_food_source", { name: "Pearl millet", ...fruit, state: "dry" });
    await x.ok("upsert_food_source", { name: "Lemon peel", ...fruit });
    await x.ok("upsert_food_source", { name: "Beer", ...fruit, state: "as_sold" });
    const pear = await x.ok("catalogue_search", { query: "pear" });
    expect(pear.results.map((r: { name: string }) => r.name)).toEqual(["Pear", "Pearl millet"]);
    await x.ok("upsert_recipe", { name: "Peer's chaat", kind: "dish", servings: 1, lines: [{ food: "Pear", value: 100, unit: "g" }] });
    // "peer" is a substring of the recipe; the foods it nearly spells (Pear, Beer, Lemon peel) stay below it, at most two.
    const peer = await x.ok("catalogue_search", { query: "peer", kinds: ["food_source", "recipe"] });
    const names = peer.results.map((r: { name: string }) => r.name);
    expect(names[0]).toBe("Peer's chaat");
    expect(names).toContain("Pear");
    expect(names.slice(1)).toHaveLength(2);
  });
});

describe("catalogue_search: near-spellings by closeness (ticket 68)", () => {
  const veg = { state: "raw", reference_amount: 100, reference_unit: "g", kcal: 20, protein_g: 1, carbs_g: 4, fat_g: 0.2 };

  it("ranks near-spellings by edit distance, not catalogue order", async () => {
    const x = setup();
    // "muton" is one letter off Mutton and two off Melon; Melon comes first in the catalogue.
    await x.ok("upsert_food_source", { name: "Melon", ...veg });
    await x.ok("upsert_food_source", { name: "Mutton", ...veg });
    const found = await x.ok("catalogue_search", { query: "muton" });
    expect(found.results.map((r: { name: string }) => r.name)).toEqual(["Mutton", "Melon"]);
    expect(found.results[0].score).toBeGreaterThan(found.results[1].score);
  });

  it("keeps the closest near-spelling when a prefix hit of the same kind exists: \"beat\" finds Beet beside Beaten egg", async () => {
    const x = setup();
    await x.ok("upsert_food_source", { name: "Beaten egg", ...veg, state: "as_sold" });
    await x.ok("upsert_food_source", { name: "Bean sprouts", ...veg });
    await x.ok("upsert_food_source", { name: "Beet", ...veg });
    await x.ok("upsert_food_source", { name: "Meat masala", ...veg, state: "as_sold" });
    const beat = await x.ok("catalogue_search", { query: "beat", kinds: ["food_source"] });
    const names = beat.results.map((r: { name: string }) => r.name);
    expect(names[0]).toBe("Beaten egg");
    expect(names).toContain("Beet");
    // Only the closest near-spelling of a kind that matched better: Beet (or one as close), never a list.
    expect(names).toHaveLength(2);
  });

  it("still drops a kind's near-spellings when the query is spelled out as a word of a better hit", async () => {
    const x = setup();
    await x.ok("upsert_food_source", { name: "Beet", ...veg });
    await x.ok("upsert_food_source", { name: "Beef mince", ...veg });
    const beet = await x.ok("catalogue_search", { query: "beet", kinds: ["food_source"] });
    expect(beet.results.map((r: { name: string }) => r.name)).toEqual(["Beet"]);
  });
});

describe("catalogue_lookup", () => {
  it("looks up many refs in one call and names the missing ones", async () => {
    const x = setup();
    await seedCatalogue(x);
    const body = await x.ok("catalogue_lookup", { refs: ["FS003", "FS999", "FS001"] });
    expect(body.food_sources.map((f: { ref: string }) => f.ref)).toEqual(["FS003", "FS001"]);
    expect(body.food_sources[0].measures).toEqual([{ name: "egg", amount: 50 }]);
    expect(body.missing).toEqual(["FS999"]);
  });
});

describe("upsert_recipe", () => {
  it("resolves every line and returns per-serving nutrients", async () => {
    const x = setup();
    await seedCatalogue(x);
    const body = await x.ok("upsert_recipe", {
      name: "Egg fried rice", kind: "dish", servings: 2,
      lines: [
        { food: "rice", state: "cooked", value: 300, unit: "g" },
        { food: "egg", value: 2, measure: "egg" },
        { food: "mustard oil", value: 2, measure: "tsp" },
      ],
    });
    // 360 + 143 + 79.56 kcal in the pot, over 2 servings.
    expect(body.recipe.per_serving.kcal.value).toBeCloseTo(291.28, 2);
    expect(body.recipe.lines).toHaveLength(3);
    expect(body.recipe.derived).toBe(true);
    expect(body.recipe.ref).toBe("R001");
  });

  it("refuses an existing ref (amend changes a recipe) and a ref the API didn't allocate", async () => {
    const x = setup();
    const thali = { name: "Office thali", kind: "dish", servings: 1, manual_macros: { kcal: 650, protein_g: 18, carbs_g: 90, fat_g: 22, reason: "canteen estimate" } };
    const created = await x.ok("upsert_recipe", thali);
    const existing = await x.call("upsert_recipe", { ...thali, ref: created.recipe.ref, servings: 2 });
    expect(existing.http).toBe(409);
    expect(existing.body.error).toMatchObject({ code: "ref_exists", use: "amend", record: { table: "recipe", id: created.recipe.id } });
    const invented = await x.call("upsert_recipe", { ...thali, name: "Other thali", ref: "R900" });
    expect(invented.body.error.code).toBe("ref_not_allocated");
  });

  it("asks which state when a line could be rice dry or cooked", async () => {
    const x = setup();
    await seedCatalogue(x);
    const reply = await x.call("upsert_recipe", {
      name: "Plain rice", kind: "dish", servings: 1, lines: [{ food: "rice", value: 100, unit: "g" }],
    });
    expect(reply.http).toBe(200);
    expect(reply.body).toMatchObject({
      status: "needs_clarification", reason: "ambiguous_state", options: ["cooked", "dry"], path: ["lines", 0],
    });
  });

  it("keeps manual per-serving macros with their reason", async () => {
    const x = setup();
    const body = await x.ok("upsert_recipe", {
      name: "Office thali", kind: "dish", servings: 1,
      manual_macros: { kcal: 650, protein_g: 18, carbs_g: 90, fat_g: 22, reason: "canteen estimate" },
    });
    expect(body.recipe.derived).toBe(false);
    expect(body.recipe.per_serving.kcal.value).toBe(650);
  });

  it("asks before creating a second recipe with the same name (dedupe)", async () => {
    const x = setup();
    await x.ok("upsert_recipe", {
      name: "Office thali", kind: "dish", servings: 1,
      manual_macros: { kcal: 650, protein_g: 18, carbs_g: 90, fat_g: 22, reason: "canteen estimate" },
    });
    const reply = await x.call("upsert_recipe", {
      name: "office thali", kind: "dish", servings: 1,
      manual_macros: { kcal: 600, protein_g: 18, carbs_g: 90, fat_g: 22, reason: "canteen estimate" },
    });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "duplicate_recipe", options: ["R001"] });
  });

  it("asks when a derived recipe has no lines rather than reading 0 kcal", async () => {
    const x = setup();
    const reply = await x.call("upsert_recipe", { name: "Mystery", kind: "dish", servings: 1 });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "no_lines" });
  });
});

describe("catalogue_dependents", () => {
  it("lists the recipes that use a food source", async () => {
    const x = setup();
    await seedCatalogue(x);
    await x.ok("upsert_recipe", {
      name: "Egg fried rice", kind: "dish", servings: 2,
      lines: [{ food: "FS002", value: 300, unit: "g" }, { food: "egg", value: 2, measure: "egg" }],
    });
    const body = await x.ok("catalogue_dependents", { ref: "FS003" });
    expect(body.recipes).toEqual([{ ref: "R001", name: "Egg fried rice" }]);
    expect(body.yields).toEqual([]);
    const rice = await x.ok("catalogue_dependents", { ref: "FS001" });
    expect(rice.yields).toEqual([{ to_ref: "FS002", to_state: "cooked", factor: 3 }]);
  });
});
