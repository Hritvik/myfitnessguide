import { describe, expect, it } from "vitest";
import { belowBmr, dayTotals, leftToday, resolveTarget, totalsFrom } from "../src/index";
import type { Target } from "../src/index";

// Guide 32-35: 1900 kcal, protein 130 g, fat 55 g never below ~45 g, carbs
// "whatever is left".
const HRITVIK: Target = {
  kcal: 1900,
  protein: { goal: 130 },
  fat: { goal: 55, floor: 45 },
  carbs: { remainder: true },
};

describe("dayTotals", () => {
  it("sums a day's intake items with micros coverage", () => {
    const got = dayTotals([
      { nutrients: totalsFrom({ kcal: 400, protein: 30, sodium: 300 }) },
      { nutrients: totalsFrom({ kcal: 250, protein: 10, sodium: null }) },
    ]);
    expect(got.source).toBe("items");
    expect(got.totals.kcal).toEqual({ value: 650, known: 2, of: 2 });
    expect(got.totals.sodium).toEqual({ value: 300, known: 1, of: 2 });
  });

  it("a legacy manual day total is used only on a day with no items", () => {
    const got = dayTotals([], { kcal: 1700, protein: 90 });
    expect(got.source).toBe("manual_day_total");
    expect(got.totals.kcal?.value).toBe(1700);
  });

  it("a day with both items and a manual total uses the items and flags the conflict", () => {
    const got = dayTotals([{ nutrients: totalsFrom({ kcal: 400 }) }], { kcal: 1700 });
    expect(got.source).toBe("items");
    expect(got.conflict).toBe(true);
    expect(got.totals.kcal?.value).toBe(400);
  });

  it("an empty day is empty, not zero", () => {
    expect(dayTotals([])).toEqual({ source: "empty", totals: {}, conflict: false });
  });
});

describe("resolveTarget: floors and remainder targets", () => {
  it("a remainder macro gets what the kcal target leaves (Atwater 4/4/9)", () => {
    const got = resolveTarget(HRITVIK);
    // (1900 - 130*4 - 55*9) / 4 = 221.25
    expect(got.carbs).toEqual({ goal: 221.25, floor: null });
    expect(got.fat).toEqual({ goal: 55, floor: 45 });
    expect(got.protein).toEqual({ goal: 130, floor: null });
  });

  it("only one macro can be the remainder", () => {
    expect(() =>
      resolveTarget({ kcal: 2000, protein: { goal: 130 }, fat: { remainder: true }, carbs: { remainder: true } }),
    ).toThrow(RangeError);
  });

  it("a remainder that comes out negative is an error, not a negative target", () => {
    expect(() =>
      resolveTarget({ kcal: 800, protein: { goal: 150 }, fat: { goal: 60 }, carbs: { remainder: true } }),
    ).toThrow(RangeError);
  });

  it("fat can be the remainder too", () => {
    const got = resolveTarget({ kcal: 2000, protein: { goal: 150 }, fat: { remainder: true }, carbs: { goal: 200 } });
    expect(got.fat.goal).toBeCloseTo((2000 - 600 - 800) / 9, 9);
  });
});

describe("leftToday", () => {
  it("what is left of each target, and how far below each floor", () => {
    const totals = totalsFrom({ kcal: 1200, protein: 80, fat: 30, carbs: 150 });
    const got = leftToday(HRITVIK, totals);
    expect(got.kcal).toMatchObject({ goal: 1900, consumed: 1200, left: 700, floor: null, floorLeft: null });
    expect(got.protein).toMatchObject({ left: 50 });
    expect(got.fat).toMatchObject({ goal: 55, consumed: 30, left: 25, floor: 45, floorLeft: 15 });
    expect(got.carbs).toMatchObject({ goal: 221.25, left: 71.25 });
  });

  it("left goes negative when over; floorLeft stops at zero", () => {
    const got = leftToday(HRITVIK, totalsFrom({ kcal: 2000, protein: 140, fat: 60, carbs: 230 }));
    expect(got.kcal.left).toBe(-100);
    expect(got.fat.floorLeft).toBe(0);
  });

  it("carries coverage so a partial count is never read as a low day", () => {
    const totals = dayTotals([
      { nutrients: totalsFrom({ kcal: 500, protein: 20 }) },
      { nutrients: totalsFrom({ kcal: null, protein: null }) },
    ]).totals;
    expect(leftToday(HRITVIK, totals).kcal.coverage).toEqual({ known: 1, of: 2 });
  });

  it("nothing logged means nothing consumed, with zero coverage", () => {
    const got = leftToday(HRITVIK, {});
    expect(got.protein).toMatchObject({ consumed: 0, left: 130, coverage: { known: 0, of: 0 } });
  });
});

describe("belowBmr", () => {
  it("warns when a kcal target sits below BMR, by how much", () => {
    // Kabir: user-supplied targets 232 kcal below BMR.
    expect(belowBmr(1150, 1382)).toEqual({ below: true, by: 232 });
  });

  it("no warning at or above BMR", () => {
    expect(belowBmr(1900, 1550)).toEqual({ below: false, by: 0 });
    expect(belowBmr(1550, 1550)).toEqual({ below: false, by: 0 });
  });
});
