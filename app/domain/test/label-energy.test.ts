import { describe, expect, it } from "vitest";
import { labelEnergyCheck } from "../src/index";

// A label's macros should reconcile with its stated energy by Atwater
// (4 / 4 / 9 kcal per g), within max(10% of the stated kcal, 15 kcal).
describe("labelEnergyCheck", () => {
  it("a label whose macros reconcile passes, with the Atwater energy it computed", () => {
    // 4 x 20 + 4 x 30 + 9 x 10 = 290 against 300 stated.
    const got = labelEnergyCheck({ kcal: 300, protein: 20, carbs: 30, fat: 10 });
    expect(got).toEqual({ reconciles: true, atwaterKcal: 290, differenceKcal: -10, toleranceKcal: 30 });
  });

  it("a missing macro shows up as energy the macros don't account for", () => {
    // Fat left out: 4 x 20 + 4 x 30 = 200 against 300 stated.
    const got = labelEnergyCheck({ kcal: 300, protein: 20, carbs: 30, fat: 0 });
    expect(got).toMatchObject({ reconciles: false, atwaterKcal: 200, differenceKcal: -100, toleranceKcal: 30 });
  });

  it("the tolerance is 10% of the stated energy, or 15 kcal when that is larger", () => {
    // 50 kcal stated: 10% is 5, so 15 applies. 4 x 10 = 40 is 10 under: fine.
    expect(labelEnergyCheck({ kcal: 50, protein: 10, carbs: 0, fat: 0 })).toMatchObject({ reconciles: true, toleranceKcal: 15 });
    // 4 x 8 = 32 is 18 under: not fine.
    expect(labelEnergyCheck({ kcal: 50, protein: 8, carbs: 0, fat: 0 })).toMatchObject({ reconciles: false, differenceKcal: -18 });
  });

  it("exactly at the tolerance still reconciles; just past it doesn't", () => {
    // 1000 stated, tolerance 100: 1100 reconciles, 1104 doesn't.
    expect(labelEnergyCheck({ kcal: 1000, protein: 0, carbs: 275, fat: 0 }).reconciles).toBe(true);
    expect(labelEnergyCheck({ kcal: 1000, protein: 0, carbs: 276, fat: 0 }).reconciles).toBe(false);
  });

  it("macros over the stated energy are as suspect as under", () => {
    expect(labelEnergyCheck({ kcal: 100, protein: 10, carbs: 10, fat: 5 })).toMatchObject({ reconciles: false, atwaterKcal: 125, differenceKcal: 25 });
  });
});
