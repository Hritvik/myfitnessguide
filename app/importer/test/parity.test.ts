// The parity report: computed values vs what Sheets rendered, classified
// within tolerance, explained by a ruling (with a cause), or unexplained.
import { describe, expect, it } from "vitest";
import { rehearse } from "../src/rehearse";
import type { Ruling } from "../src/rulings";
import { basePeople, DAILY_HEADER, f, food, FOOD_HEADER, intake, LOG_HEADER, members, NUTRITION_HEADER, recipe, RECIPES_HEADER, RI_HEADER, line, set, snapshot } from "./fixture";

const D1 = 46240; // 2026-08-06
const whey = { ref: "FS001", name: "Test whey", serving: "1 scoop (30 g)", kcal: 120, protein: 24, carbs: 3, fat: 1, priceMin: 100, priceMax: 120 };

function build(nutrition: unknown[][], daily: unknown[][] = [DAILY_HEADER], extra: Record<string, unknown[][]> = {}, baseExtra: Record<string, unknown[][]> = {}) {
  return snapshot({
    base: { People: basePeople(), "Food Sources": [FOOD_HEADER, food({ ...whey, derived: { D: f("=..", 4.17), E: f("=..", 5), M: f("=..", 104.17), N: f("=..", 125), C: f("=..", 5), L: f("=..", 20), O: f("=..", 125), P: f("=..", 1.04), Q: f("=..", 1.04) } })], ...baseExtra },
    hritvik: { Nutrition: [NUTRITION_HEADER, ...nutrition], "Daily Nutrition": daily, ...extra },
  } as never);
}

const row = (macros: unknown[], qty = 1) =>
  intake({ date: D1, meal: "Breakfast", item: "Whey", person: "Hritvik", ref: "FS001", qty, macros: macros.map((m) => f("=IF(..)", m as string)) });

describe("parity classification", () => {
  it("passes a ref'd row and its day within tolerance", async () => {
    const r = await rehearse({ snapshot: build([row([120.4, 24, 3, 1])], [DAILY_HEADER, [D1, "Hritvik", 120.4, 24, 3, 1, 1]]), members: members() });
    const group = r.parity.groups.find((g) => g.group === "Nutrition rows");
    expect(group).toMatchObject({ compared: 4, within: 4, unexplained: 0 });
    expect(r.parity.groups.find((g) => g.group === "Day totals")).toMatchObject({ compared: 4, within: 4 });
    expect(r.parity.groups.find((g) => g.group === "Food Source derived columns")).toMatchObject({ compared: 9, within: 9 });
  });

  it("calls a difference with no ruling unexplained, and fails the gate", async () => {
    const r = await rehearse({ snapshot: build([row([130, 24, 3, 1])]), members: members() });
    const d = r.parity.differences.find((x) => x.id === "hritvik/Nutrition!2/parity/kcal");
    expect(d).toMatchObject({ status: "unexplained", sheet: 130, app: 120 });
    expect(r.parity.gate).toBe("FAIL");
  });

  it("explains a ref'd row that rendered blank as missing-formula (mechanical), listing the day", async () => {
    const r = await rehearse({ snapshot: build([row(["", "", "", ""])]), members: members() });
    const d = r.parity.differences.find((x) => x.id === "hritvik/Nutrition!2/parity/kcal");
    expect(d).toMatchObject({ status: "explained", cause: "missing-formula", decision: "accepted", day: "2026-08-06" });
    expect(r.rulings.find((x) => x.id === "hritvik/Nutrition!2/parity/kcal")).toMatchObject({ kind: "mechanical", cause: "missing-formula", day: "2026-08-06" });
  });

  it("explains a hand-made ruling with a cause, by id", async () => {
    const first = await rehearse({ snapshot: build([row([130, 24, 3, 1])]), members: members() });
    const hand: Ruling = {
      id: "hritvik/Nutrition!2/parity/kcal", origin: { file: "hritvik", tab: "Nutrition", row: 2 }, code: "parity", kind: "semantic", cause: "typed-error",
      problem: "typed", proposed_fix: "accept the app", proposal: "typed-error", decision: "accepted", decided_by: "Hritvik", override: null, day: null, row: {}, note: null,
    };
    const second = await rehearse({ snapshot: build([row([130, 24, 3, 1])]), members: members(), previousRulings: [...first.rulings, hand] });
    expect(second.parity.differences.find((x) => x.id === hand.id)).toMatchObject({ status: "explained", cause: "typed-error", decision: "accepted" });
  });

  it("explains a Food Sources cell with no formula as a sheet-bug", async () => {
    const snap = snapshot({ base: { People: basePeople(), "Food Sources": [FOOD_HEADER, food({ ...whey, derived: { C: f("=..", 5), L: f("=..", 20), O: f("=..", 125), P: f("=..", 1.04), Q: f("=..", 1.04), M: f("=..", 104.17), N: f("=..", 125) } })] } } as never);
    const r = await rehearse({ snapshot: snap, members: members() });
    expect(r.parity.differences.find((x) => x.id === "base/Food Sources!2/parity/cost_min_per_g_protein")).toMatchObject({ status: "explained", cause: "sheet-bug" });
  });

  it("compares derived recipes and leaves stored ones as inputs", async () => {
    const snap = build([], [DAILY_HEADER], {}, {
      Recipes: [RECIPES_HEADER, recipe({ ref: "R001", name: "Whey bowl", macros: [f("=..", 240), f("=..", 48), f("=..", 6), f("=..", 2)], derivation: "derived" }), recipe({ ref: "R002", name: "Stored", macros: [1, 1, 1, 1], derivation: "stored" })],
      "Recipe Ingredients": [RI_HEADER, line("Whey bowl", "FS001", 2, "R001")],
    });
    const r = await rehearse({ snapshot: snap, members: members() });
    expect(r.parity.groups.find((g) => g.group === "Derived recipes")).toMatchObject({ compared: 4, within: 4, not_compared: 1 });
  });

  it("turns Log typed differences into rulings: rounding mechanical, typed-error semantic", async () => {
    const snap = build([], [DAILY_HEADER], {
      Log: [
        LOG_HEADER,
        // 20 kg bar + 10 lb per side = 29.0718 kg; typed volume from the rounded 29.1: 232.8.
        set({ date: D1, session: "Upper A", exercise: "Bench Press", set: 1, reps: 8, rir: 1, weight: 29.0718, total: 29.1, volume: 232.8 }),
        set({ date: D1, session: "Upper A", exercise: "Bench Press", set: 2, reps: 8, rir: 1, weight: 30, total: 30, volume: 300 }),
      ],
    });
    const r = await rehearse({ snapshot: snap, members: members() });
    const vol1 = r.parity.differences.find((x) => x.id === "hritvik/Log!2/parity/volume_kg");
    const vol2 = r.parity.differences.find((x) => x.id === "hritvik/Log!3/parity/volume_kg");
    expect(vol1 ?? { status: "within" }).toMatchObject({ status: "within" });
    expect(vol2).toMatchObject({ status: "explained", cause: "typed-error", decision: "pending" });
    expect(r.parity.gate).toBe("FAIL");
  });

  it("compares a typed e1RM on the per-implement load, and calls one typed on the whole total a typed-error, not rounding", async () => {
    const snap = build([], [DAILY_HEADER], {
      Log: [
        LOG_HEADER,
        // 5 lb a hand (2.26796 kg) to failure at 9 reps: e1RM 2.948; Sheets rounded the hand to 2.3: 2.99.
        set({ date: D1, session: "Upper A", exercise: "Lateral Raise", set: 1, reps: 9, rir: 0, weight: 2.26796, basis: "per hand", total: 4.5, volume: 40.8, e1rm: 2.99 }),
        // The same set with e1RM typed on both hands (5.9): not the convention.
        set({ date: D1, session: "Upper A", exercise: "Lateral Raise", set: 2, reps: 9, rir: 0, weight: 2.26796, basis: "per hand", total: 4.5, volume: 40.8, e1rm: 5.9 }),
      ],
    });
    const r = await rehearse({ snapshot: snap, members: members() });
    expect(r.parity.differences.find((x) => x.id === "hritvik/Log!2/parity/e1rm_kg")).toBeUndefined();
    expect(r.parity.differences.find((x) => x.id === "hritvik/Log!3/parity/e1rm_kg")).toMatchObject({ status: "explained", cause: "typed-error", decision: "pending" });
  });

  it("compares Chart Data rollups, ruling a SUMIF that reads 0 for unknown as a sheet-bug", async () => {
    const chart = [["Date", "Weight AM", "7-day Avg", "Calories", "Cal Target", "Protein", "Protein Target", "Carbs", "Carbs Target", "Fat", "Fat Target", "Fibre (g)"], ["6 Aug", "", "", 120, 1800, 24, 120, 3, 200, 1, 55, 0]];
    const r = await rehearse({ snapshot: build([row([120, 24, 3, 1])], [DAILY_HEADER], { "Chart Data": chart }), members: members() });
    expect(r.parity.groups.find((g) => g.group === "Day totals (Chart Data rollups)")).toMatchObject({ compared: 5, within: 4, explained: 1 });
    expect(r.parity.differences.find((x) => x.id === "hritvik/Chart Data!2/parity/fibre_g")).toMatchObject({ status: "explained", cause: "sheet-bug", decision: "accepted" });
  });

  it("passes the gate when everything is within tolerance and nothing is pending", async () => {
    const snap = build([row([120, 24, 3, 1])], [DAILY_HEADER, [D1, "Hritvik", 120, 24, 3, 1, 1]]);
    const first = await rehearse({ snapshot: snap, members: members() });
    expect(first.parity.gate).toBe("FAIL"); // the targets' dates are pending
    const decided = first.rulings.map((x) => ({ ...x, decision: "accepted" as const, decided_by: "Hritvik" }));
    const r = await rehearse({ snapshot: snap, members: members(), previousRulings: decided });
    expect(r.parity.summary).toMatchObject({ unexplained: 0, pending_rulings: 0 });
    expect(r.parity.gate).toBe("PASS");
    expect(r.parityMd).toContain("**Gate: PASS**");
  });
});
