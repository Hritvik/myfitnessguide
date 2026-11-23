import { describe, expect, it } from "vitest";
import { dayTotals, recipeIntake, totalsFrom } from "../src/index";
import type { FoodSource } from "../src/index";

const OATS: FoodSource = {
  id: "FS010",
  food: "oats",
  state: "dry",
  referenceAmount: { value: 100, unit: "g" },
  nutrients: { kcal: 380, protein: 13, iron: 4 },
};
const MILK: FoodSource = {
  id: "FS011",
  food: "milk",
  state: "as sold",
  referenceAmount: { value: 100, unit: "ml" },
  nutrients: { kcal: 60, protein: 3.2, iron: null },
};

describe("recipeIntake: a recipe eaten by servings (schema decision 30)", () => {
  // 80 g oats + 300 ml milk, making 2 servings: 484 kcal, 20 g protein in the pot.
  const PORRIDGE = {
    servings: 2,
    lines: [
      { source: OATS, multiples: 0.8 },
      { source: MILK, multiples: 3 },
    ],
  };

  it("derives the nutrients from the lines, per serving, times the servings eaten", () => {
    const got = recipeIntake(PORRIDGE, 1.5);
    expect(got.kcal?.value).toBeCloseTo(363, 9);
    expect(got.protein?.value).toBeCloseTo(15, 9);
    expect(got.kcal).toMatchObject({ known: 2, of: 2 });
  });

  it("keeps micronutrient coverage from the lines: unknown milk iron stays unknown", () => {
    const got = recipeIntake(PORRIDGE, 1);
    expect(got.iron).toEqual({ value: 1.6, known: 1, of: 2 });
  });

  it("uses manual per-serving macros when the recipe is not derived (R049)", () => {
    const got = recipeIntake({ servings: 4, manualPerServing: { kcal: 250, protein: 9, carbs: 30, fat: 10 } }, 2);
    expect(got).toEqual({
      kcal: { value: 500, known: 1, of: 1 },
      protein: { value: 18, known: 1, of: 1 },
      carbs: { value: 60, known: 1, of: 1 },
      fat: { value: 20, known: 1, of: 1 },
    });
  });

  it("manual macros win over lines, since lines are kept only for reference until derived", () => {
    const got = recipeIntake({ ...PORRIDGE, manualPerServing: { kcal: 300, protein: 12, carbs: 40, fat: 8 } }, 1);
    expect(got.kcal?.value).toBe(300);
  });

  it("a recipe with no lines and no manual macros counts as unknown, never as 0 kcal", () => {
    const got = recipeIntake({ servings: 1, lines: [] }, 1);
    expect(got).toEqual({});
    const day = dayTotals([{ nutrients: got }, { nutrients: totalsFrom({ kcal: 200 }) }]);
    expect(day.totals.kcal).toEqual({ value: 200, known: 1, of: 2 });
  });

  it("rejects servings that are not positive", () => {
    expect(() => recipeIntake(PORRIDGE, 0)).toThrow(RangeError);
    expect(() => recipeIntake({ ...PORRIDGE, servings: 0 }, 1)).toThrow(RangeError);
  });
});
