import { describe, expect, it } from "vitest";
import { Catalogue } from "../src/catalogue";
import { Ctx } from "../src/context";
import { loadCooks } from "../src/nutrition";
import { CountingDb } from "./counting";
import { NOW } from "./db";
import { foodSource } from "./fixtures";
import { setup, type Harness } from "./harness";

function context(x: Harness, db = x.counter) {
  return new Ctx(db, { kind: "member", memberId: x.h.hritvik, householdId: x.h.id, name: "Hritvik" }, () => x.clock.now, "Asia/Kolkata");
}

function addCook(x: Harness, name: string) {
  return x.t.insert("cook", { household_id: x.h.id, cooked_on: "2026-10-05", name, state: "confirmed", confirmed_at: NOW });
}

describe("loadCooks grouping", () => {
  it("keeps the query's cook order and each row's order while assigning mixed rows through their component", async () => {
    const x = setup();
    const rice = foodSource(x.t, x.h, { name: "Rice", kcal: 120, protein_g: 2.4, carbs_g: 26, fat_g: 0.2 });
    const dal = foodSource(x.t, x.h, { name: "Dal", kcal: 116, protein_g: 6.8, carbs_g: 20, fat_g: 0.4 });
    const first = addCook(x, "First");
    const second = addCook(x, "Second");
    const firstMain = x.t.insert("component", { cook_id: first, position: 2, name: "first-main", cooked_weight_g: 500, cooked_weight_provenance: "weighed" });
    const firstSide = x.t.insert("component", { cook_id: first, position: 1, name: "first-side" });
    const secondMain = x.t.insert("component", { cook_id: second, position: 1, name: "second-main" });
    const line = (component_id: number, position: number, food_source_id: number, amount_value: number) =>
      x.t.insert("cook_line", { component_id, position, food_source_id, amount_value, amount_unit: "g", provenance: "weighed" });
    line(firstMain, 2, dal, 200);
    line(secondMain, 1, rice, 300);
    line(firstSide, 1, rice, 100);
    line(firstMain, 1, rice, 250);
    x.t.insert("portion", { component_id: firstMain, member_id: x.h.hritvik, kind: "fraction", fraction: 0.25, provenance: "estimated", state: "confirmed", confirmed_at: NOW });
    x.t.insert("portion", { component_id: secondMain, member_id: x.h.asha, kind: "fraction", fraction: 0.5, provenance: "estimated", state: "confirmed", confirmed_at: NOW });
    x.t.insert("leftover_serving", { component_id: firstSide, member_id: x.h.kabir, kind: "fraction", fraction: 0.2, eaten_on: "2026-10-06", provenance: "estimated", state: "confirmed", confirmed_at: NOW });
    x.t.insert("leftover_serving", { component_id: secondMain, member_id: x.h.hritvik, kind: "fraction", fraction: 0.1, eaten_on: "2026-10-06", provenance: "estimated", state: "confirmed", confirmed_at: NOW });
    x.t.insert("remainder_disposition", { component_id: firstSide, disposition: "leftover", amount_kind: "rest", recorded_on: "2026-10-05", provenance: "estimated" });
    x.t.insert("remainder_disposition", { component_id: secondMain, disposition: "discarded", amount_kind: "rest", recorded_on: "2026-10-05", provenance: "estimated" });

    const ctx = context(x);
    const loaded = await loadCooks(ctx, await Catalogue.load(ctx), [second, first]);
    const view = [...loaded].map(([id, cook]) => ({
      id,
      componentNames: cook.components.map((row) => row.name),
      lineIds: cook.lines.map((row) => row.id),
      portionIds: cook.portions.map((row) => row.id),
      servingIds: cook.servings.map((row) => row.id),
      marks: cook.marks,
      result: cook.result,
    }));

    expect(JSON.stringify(view)).toMatchInlineSnapshot(`"[{"id":1,"componentNames":["first-side","first-main"],"lineIds":[3,4,1],"portionIds":[1],"servingIds":[1],"marks":[{"component_id":2,"disposition":"leftover"}],"result":{"components":[{"name":"first-side","cookedWeightG":null,"totals":{"kcal":{"value":120,"known":1,"of":1},"protein":{"value":2.4,"known":1,"of":1},"carbs":{"value":26,"known":1,"of":1},"fat":{"value":0.2,"known":1,"of":1},"sodium_mg":{"value":0,"known":0,"of":1},"fibre_g":{"value":0,"known":0,"of":1},"iron_mg":{"value":0,"known":0,"of":1},"b12_ug":{"value":0,"known":0,"of":1},"calcium_mg":{"value":0,"known":0,"of":1},"magnesium_mg":{"value":0,"known":0,"of":1},"potassium_mg":{"value":0,"known":0,"of":1},"sat_fat_g":{"value":0,"known":0,"of":1},"total_sugars_g":{"value":0,"known":0,"of":1},"vitamin_c_mg":{"value":0,"known":0,"of":1},"cost_min_inr":{"value":0,"known":0,"of":1},"cost_max_inr":{"value":0,"known":0,"of":1},"protein_complete":{"value":0,"known":0,"of":1},"protein_partial":{"value":0,"known":0,"of":1},"protein_incomplete":{"value":0,"known":0,"of":1},"protein_negligible":{"value":0,"known":0,"of":1}}},{"name":"first-main","cookedWeightG":500,"totals":{"kcal":{"value":532,"known":2,"of":2},"protein":{"value":19.6,"known":2,"of":2},"carbs":{"value":105,"known":2,"of":2},"fat":{"value":1.3,"known":2,"of":2},"sodium_mg":{"value":0,"known":0,"of":2},"fibre_g":{"value":0,"known":0,"of":2},"iron_mg":{"value":0,"known":0,"of":2},"b12_ug":{"value":0,"known":0,"of":2},"calcium_mg":{"value":0,"known":0,"of":2},"magnesium_mg":{"value":0,"known":0,"of":2},"potassium_mg":{"value":0,"known":0,"of":2},"sat_fat_g":{"value":0,"known":0,"of":2},"total_sugars_g":{"value":0,"known":0,"of":2},"vitamin_c_mg":{"value":0,"known":0,"of":2},"cost_min_inr":{"value":0,"known":0,"of":2},"cost_max_inr":{"value":0,"known":0,"of":2},"protein_complete":{"value":0,"known":0,"of":2},"protein_partial":{"value":0,"known":0,"of":2},"protein_incomplete":{"value":0,"known":0,"of":2},"protein_negligible":{"value":0,"known":0,"of":2}}}],"totals":{"kcal":{"value":652,"known":3,"of":3},"protein":{"value":22,"known":3,"of":3},"carbs":{"value":131,"known":3,"of":3},"fat":{"value":1.5,"known":3,"of":3},"sodium_mg":{"value":0,"known":0,"of":3},"fibre_g":{"value":0,"known":0,"of":3},"iron_mg":{"value":0,"known":0,"of":3},"b12_ug":{"value":0,"known":0,"of":3},"calcium_mg":{"value":0,"known":0,"of":3},"magnesium_mg":{"value":0,"known":0,"of":3},"potassium_mg":{"value":0,"known":0,"of":3},"sat_fat_g":{"value":0,"known":0,"of":3},"total_sugars_g":{"value":0,"known":0,"of":3},"vitamin_c_mg":{"value":0,"known":0,"of":3},"cost_min_inr":{"value":0,"known":0,"of":3},"cost_max_inr":{"value":0,"known":0,"of":3},"protein_complete":{"value":0,"known":0,"of":3},"protein_partial":{"value":0,"known":0,"of":3},"protein_incomplete":{"value":0,"known":0,"of":3},"protein_negligible":{"value":0,"known":0,"of":3}},"portions":[{"member":"portion:1","component":"first-main","fraction":0.25,"nutrients":{"kcal":{"value":133,"known":2,"of":2},"protein":{"value":4.9,"known":2,"of":2},"carbs":{"value":26.25,"known":2,"of":2},"fat":{"value":0.325,"known":2,"of":2},"sodium_mg":{"value":0,"known":0,"of":2},"fibre_g":{"value":0,"known":0,"of":2},"iron_mg":{"value":0,"known":0,"of":2},"b12_ug":{"value":0,"known":0,"of":2},"calcium_mg":{"value":0,"known":0,"of":2},"magnesium_mg":{"value":0,"known":0,"of":2},"potassium_mg":{"value":0,"known":0,"of":2},"sat_fat_g":{"value":0,"known":0,"of":2},"total_sugars_g":{"value":0,"known":0,"of":2},"vitamin_c_mg":{"value":0,"known":0,"of":2},"cost_min_inr":{"value":0,"known":0,"of":2},"cost_max_inr":{"value":0,"known":0,"of":2},"protein_complete":{"value":0,"known":0,"of":2},"protein_partial":{"value":0,"known":0,"of":2},"protein_incomplete":{"value":0,"known":0,"of":2},"protein_negligible":{"value":0,"known":0,"of":2}}},{"member":"serving:1","component":"first-side","fraction":0.2,"nutrients":{"kcal":{"value":24,"known":1,"of":1},"protein":{"value":0.48,"known":1,"of":1},"carbs":{"value":5.2,"known":1,"of":1},"fat":{"value":0.04000000000000001,"known":1,"of":1},"sodium_mg":{"value":0,"known":0,"of":1},"fibre_g":{"value":0,"known":0,"of":1},"iron_mg":{"value":0,"known":0,"of":1},"b12_ug":{"value":0,"known":0,"of":1},"calcium_mg":{"value":0,"known":0,"of":1},"magnesium_mg":{"value":0,"known":0,"of":1},"potassium_mg":{"value":0,"known":0,"of":1},"sat_fat_g":{"value":0,"known":0,"of":1},"total_sugars_g":{"value":0,"known":0,"of":1},"vitamin_c_mg":{"value":0,"known":0,"of":1},"cost_min_inr":{"value":0,"known":0,"of":1},"cost_max_inr":{"value":0,"known":0,"of":1},"protein_complete":{"value":0,"known":0,"of":1},"protein_partial":{"value":0,"known":0,"of":1},"protein_incomplete":{"value":0,"known":0,"of":1},"protein_negligible":{"value":0,"known":0,"of":1}}}],"remainder":[{"component":"first-side","fraction":0.8,"status":"leftover","nutrients":{"kcal":{"value":96,"known":1,"of":1},"protein":{"value":1.92,"known":1,"of":1},"carbs":{"value":20.8,"known":1,"of":1},"fat":{"value":0.16000000000000003,"known":1,"of":1},"sodium_mg":{"value":0,"known":0,"of":1},"fibre_g":{"value":0,"known":0,"of":1},"iron_mg":{"value":0,"known":0,"of":1},"b12_ug":{"value":0,"known":0,"of":1},"calcium_mg":{"value":0,"known":0,"of":1},"magnesium_mg":{"value":0,"known":0,"of":1},"potassium_mg":{"value":0,"known":0,"of":1},"sat_fat_g":{"value":0,"known":0,"of":1},"total_sugars_g":{"value":0,"known":0,"of":1},"vitamin_c_mg":{"value":0,"known":0,"of":1},"cost_min_inr":{"value":0,"known":0,"of":1},"cost_max_inr":{"value":0,"known":0,"of":1},"protein_complete":{"value":0,"known":0,"of":1},"protein_partial":{"value":0,"known":0,"of":1},"protein_incomplete":{"value":0,"known":0,"of":1},"protein_negligible":{"value":0,"known":0,"of":1}}},{"component":"first-main","fraction":0.75,"status":"unaccounted","nutrients":{"kcal":{"value":399,"known":2,"of":2},"protein":{"value":14.700000000000001,"known":2,"of":2},"carbs":{"value":78.75,"known":2,"of":2},"fat":{"value":0.9750000000000001,"known":2,"of":2},"sodium_mg":{"value":0,"known":0,"of":2},"fibre_g":{"value":0,"known":0,"of":2},"iron_mg":{"value":0,"known":0,"of":2},"b12_ug":{"value":0,"known":0,"of":2},"calcium_mg":{"value":0,"known":0,"of":2},"magnesium_mg":{"value":0,"known":0,"of":2},"potassium_mg":{"value":0,"known":0,"of":2},"sat_fat_g":{"value":0,"known":0,"of":2},"total_sugars_g":{"value":0,"known":0,"of":2},"vitamin_c_mg":{"value":0,"known":0,"of":2},"cost_min_inr":{"value":0,"known":0,"of":2},"cost_max_inr":{"value":0,"known":0,"of":2},"protein_complete":{"value":0,"known":0,"of":2},"protein_partial":{"value":0,"known":0,"of":2},"protein_incomplete":{"value":0,"known":0,"of":2},"protein_negligible":{"value":0,"known":0,"of":2}}}],"problems":[]}},{"id":2,"componentNames":["second-main"],"lineIds":[2],"portionIds":[2],"servingIds":[2],"marks":[{"component_id":3,"disposition":"discarded"}],"result":{"components":[{"name":"second-main","cookedWeightG":null,"totals":{"kcal":{"value":360,"known":1,"of":1},"protein":{"value":7.199999999999999,"known":1,"of":1},"carbs":{"value":78,"known":1,"of":1},"fat":{"value":0.6000000000000001,"known":1,"of":1},"sodium_mg":{"value":0,"known":0,"of":1},"fibre_g":{"value":0,"known":0,"of":1},"iron_mg":{"value":0,"known":0,"of":1},"b12_ug":{"value":0,"known":0,"of":1},"calcium_mg":{"value":0,"known":0,"of":1},"magnesium_mg":{"value":0,"known":0,"of":1},"potassium_mg":{"value":0,"known":0,"of":1},"sat_fat_g":{"value":0,"known":0,"of":1},"total_sugars_g":{"value":0,"known":0,"of":1},"vitamin_c_mg":{"value":0,"known":0,"of":1},"cost_min_inr":{"value":0,"known":0,"of":1},"cost_max_inr":{"value":0,"known":0,"of":1},"protein_complete":{"value":0,"known":0,"of":1},"protein_partial":{"value":0,"known":0,"of":1},"protein_incomplete":{"value":0,"known":0,"of":1},"protein_negligible":{"value":0,"known":0,"of":1}}}],"totals":{"kcal":{"value":360,"known":1,"of":1},"protein":{"value":7.199999999999999,"known":1,"of":1},"carbs":{"value":78,"known":1,"of":1},"fat":{"value":0.6000000000000001,"known":1,"of":1},"sodium_mg":{"value":0,"known":0,"of":1},"fibre_g":{"value":0,"known":0,"of":1},"iron_mg":{"value":0,"known":0,"of":1},"b12_ug":{"value":0,"known":0,"of":1},"calcium_mg":{"value":0,"known":0,"of":1},"magnesium_mg":{"value":0,"known":0,"of":1},"potassium_mg":{"value":0,"known":0,"of":1},"sat_fat_g":{"value":0,"known":0,"of":1},"total_sugars_g":{"value":0,"known":0,"of":1},"vitamin_c_mg":{"value":0,"known":0,"of":1},"cost_min_inr":{"value":0,"known":0,"of":1},"cost_max_inr":{"value":0,"known":0,"of":1},"protein_complete":{"value":0,"known":0,"of":1},"protein_partial":{"value":0,"known":0,"of":1},"protein_incomplete":{"value":0,"known":0,"of":1},"protein_negligible":{"value":0,"known":0,"of":1}},"portions":[{"member":"portion:2","component":"second-main","fraction":0.5,"nutrients":{"kcal":{"value":180,"known":1,"of":1},"protein":{"value":3.5999999999999996,"known":1,"of":1},"carbs":{"value":39,"known":1,"of":1},"fat":{"value":0.30000000000000004,"known":1,"of":1},"sodium_mg":{"value":0,"known":0,"of":1},"fibre_g":{"value":0,"known":0,"of":1},"iron_mg":{"value":0,"known":0,"of":1},"b12_ug":{"value":0,"known":0,"of":1},"calcium_mg":{"value":0,"known":0,"of":1},"magnesium_mg":{"value":0,"known":0,"of":1},"potassium_mg":{"value":0,"known":0,"of":1},"sat_fat_g":{"value":0,"known":0,"of":1},"total_sugars_g":{"value":0,"known":0,"of":1},"vitamin_c_mg":{"value":0,"known":0,"of":1},"cost_min_inr":{"value":0,"known":0,"of":1},"cost_max_inr":{"value":0,"known":0,"of":1},"protein_complete":{"value":0,"known":0,"of":1},"protein_partial":{"value":0,"known":0,"of":1},"protein_incomplete":{"value":0,"known":0,"of":1},"protein_negligible":{"value":0,"known":0,"of":1}}},{"member":"serving:2","component":"second-main","fraction":0.1,"nutrients":{"kcal":{"value":36,"known":1,"of":1},"protein":{"value":0.72,"known":1,"of":1},"carbs":{"value":7.800000000000001,"known":1,"of":1},"fat":{"value":0.06000000000000001,"known":1,"of":1},"sodium_mg":{"value":0,"known":0,"of":1},"fibre_g":{"value":0,"known":0,"of":1},"iron_mg":{"value":0,"known":0,"of":1},"b12_ug":{"value":0,"known":0,"of":1},"calcium_mg":{"value":0,"known":0,"of":1},"magnesium_mg":{"value":0,"known":0,"of":1},"potassium_mg":{"value":0,"known":0,"of":1},"sat_fat_g":{"value":0,"known":0,"of":1},"total_sugars_g":{"value":0,"known":0,"of":1},"vitamin_c_mg":{"value":0,"known":0,"of":1},"cost_min_inr":{"value":0,"known":0,"of":1},"cost_max_inr":{"value":0,"known":0,"of":1},"protein_complete":{"value":0,"known":0,"of":1},"protein_partial":{"value":0,"known":0,"of":1},"protein_incomplete":{"value":0,"known":0,"of":1},"protein_negligible":{"value":0,"known":0,"of":1}}}],"remainder":[{"component":"second-main","fraction":0.4,"status":"discarded","nutrients":{"kcal":{"value":144,"known":1,"of":1},"protein":{"value":2.88,"known":1,"of":1},"carbs":{"value":31.200000000000003,"known":1,"of":1},"fat":{"value":0.24000000000000005,"known":1,"of":1},"sodium_mg":{"value":0,"known":0,"of":1},"fibre_g":{"value":0,"known":0,"of":1},"iron_mg":{"value":0,"known":0,"of":1},"b12_ug":{"value":0,"known":0,"of":1},"calcium_mg":{"value":0,"known":0,"of":1},"magnesium_mg":{"value":0,"known":0,"of":1},"potassium_mg":{"value":0,"known":0,"of":1},"sat_fat_g":{"value":0,"known":0,"of":1},"total_sugars_g":{"value":0,"known":0,"of":1},"vitamin_c_mg":{"value":0,"known":0,"of":1},"cost_min_inr":{"value":0,"known":0,"of":1},"cost_max_inr":{"value":0,"known":0,"of":1},"protein_complete":{"value":0,"known":0,"of":1},"protein_partial":{"value":0,"known":0,"of":1},"protein_incomplete":{"value":0,"known":0,"of":1},"protein_negligible":{"value":0,"known":0,"of":1}}}],"problems":[]}}]"`);
  });

  it("leaves missing and foreign-household ids out, including around unsorted duplicate ids", async () => {
    const x = setup();
    const ownA = addCook(x, "Own A");
    const ownB = addCook(x, "Own B");
    const foreignHousehold = x.t.insert("household", { name: "Elsewhere", created_at: NOW });
    const foreign = x.t.insert("cook", { household_id: foreignHousehold, cooked_on: "2026-10-05", name: "Foreign", state: "confirmed", confirmed_at: NOW });
    const ctx = context(x);

    const loaded = await loadCooks(ctx, await Catalogue.load(ctx), [ownB, 999_999, foreign, ownA, ownB]);

    expect([...loaded.keys()]).toEqual([ownA, ownB]);
    expect(loaded.get(999_999)).toBeUndefined();
    expect(loaded.get(foreign)).toBeUndefined();
  });

  it("retains the existing statement chunking above 100 cooks and creates empty buckets", async () => {
    const x = setup();
    const ids = Array.from({ length: 101 }, (_, index) => addCook(x, `Cook ${index + 1}`));
    const counted = new CountingDb(x.db);
    const ctx = context(x, counted);
    const cat = await Catalogue.load(ctx);
    counted.reset();

    const loaded = await loadCooks(ctx, cat, [...ids].reverse());

    expect(loaded.size).toBe(101);
    expect([...loaded.values()].every((cook) => cook.components.length === 0 && cook.lines.length === 0 && cook.portions.length === 0 && cook.servings.length === 0 && cook.marks.length === 0)).toBe(true);
    expect(counted.count).toBe(10);
  });
});
