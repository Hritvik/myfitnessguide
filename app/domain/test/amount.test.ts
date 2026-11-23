import { describe, expect, it } from "vitest";
import { resolveAmount } from "../src/index";
import type { FoodSource, Yield } from "../src/index";

const RICE_DRY: FoodSource = {
  id: "FS010",
  food: "rice",
  state: "dry",
  referenceAmount: { value: 100, unit: "g" },
  nutrients: { kcal: 360 },
};
const RICE_COOKED: FoodSource = {
  id: "FS011",
  food: "rice",
  state: "cooked",
  referenceAmount: { value: 100, unit: "g" },
  nutrients: { kcal: 120 },
};
const GHEE: FoodSource = {
  id: "FS020",
  food: "ghee",
  state: "as sold",
  referenceAmount: { value: 100, unit: "g" },
  measures: [{ name: "tsp", amount: 4.5 }],
  nutrients: { kcal: 900 },
};
const MILK: FoodSource = {
  id: "FS030",
  food: "milk",
  state: "as sold",
  referenceAmount: { value: 250, unit: "ml" },
  nutrients: { kcal: 220 },
};
const EGG_WHITE: FoodSource = {
  id: "FS040",
  food: "egg",
  state: "white",
  referenceAmount: { value: 100, unit: "g" },
  nutrients: { kcal: 52 },
};
const SOURCES = [RICE_DRY, RICE_COOKED, GHEE, MILK, EGG_WHITE];

const YIELDS: Yield[] = [
  { food: "rice", fromState: "dry", toState: "cooked", factor: 3 },
  // Boil whole eggs and discard the yolks: about a third of the shelled weight.
  { food: "egg", fromState: "whole, shelled", toState: "white", factor: 1, discardedFraction: 0.33 },
];

describe("resolveAmount: amount + measure/unit/state to the reference amount", () => {
  it("grams of a single-state food", () => {
    expect(resolveAmount({ food: "ghee", value: 9, unit: "g" }, SOURCES, YIELDS)).toEqual({
      kind: "resolved",
      sourceId: "FS020",
      amount: 9,
      multiples: 0.09,
      yieldApplied: null,
    });
  });

  it("a named measure converts to the reference unit", () => {
    expect(resolveAmount({ food: "ghee", value: 2, measure: "tsp" }, SOURCES, YIELDS)).toMatchObject({
      kind: "resolved",
      amount: 9,
      multiples: 0.09,
    });
  });

  it("units in the same dimension convert (kg to g, l to ml)", () => {
    expect(resolveAmount({ food: "ghee", value: 0.05, unit: "kg" }, SOURCES, YIELDS)).toMatchObject({ amount: 50 });
    expect(resolveAmount({ food: "milk", value: 0.5, unit: "l" }, SOURCES, YIELDS)).toMatchObject({
      amount: 500,
      multiples: 2,
    });
  });

  it("refuses to guess between states and asks instead", () => {
    const got = resolveAmount({ food: "rice", value: 150, unit: "g" }, SOURCES, YIELDS);
    expect(got.kind).toBe("clarify");
    if (got.kind !== "clarify") throw new Error("unreachable");
    expect(got.reason).toBe("ambiguous_state");
    expect(got.options).toEqual(["cooked", "dry"]);
  });

  it("a stated state picks that source", () => {
    expect(resolveAmount({ food: "rice", value: 150, unit: "g", state: "cooked" }, SOURCES, YIELDS)).toMatchObject({
      kind: "resolved",
      sourceId: "FS011",
      multiples: 1.5,
    });
  });

  it("a state with no source of its own converts through a yield", () => {
    const wholeEggs = { food: "egg", value: 600, unit: "g" as const, state: "whole, shelled" };
    const got = resolveAmount(wholeEggs, SOURCES, YIELDS);
    expect(got).toMatchObject({ kind: "resolved", sourceId: "FS040" });
    if (got.kind !== "resolved") throw new Error("unreachable");
    // 600 g shelled, a third discarded as yolk, the rest is white.
    expect(got.amount).toBeCloseTo(402, 6);
    expect(got.yieldApplied).toEqual({ fromState: "whole, shelled", toState: "white", factor: 1,discardedFraction: 0.33 });
  });

  it("a yield's factor multiplies the kept amount", () => {
    const yields: Yield[] = [{ food: "rice", fromState: "raw", toState: "cooked", factor: 3 }];
    expect(resolveAmount({ food: "rice", value: 50, unit: "g", state: "raw" }, SOURCES, yields)).toMatchObject({
      sourceId: "FS011",
      amount: 150,
    });
  });

  it("a state with neither a source nor a yield asks", () => {
    expect(resolveAmount({ food: "rice", value: 100, unit: "g", state: "fried" }, SOURCES, YIELDS)).toMatchObject({
      kind: "clarify",
      reason: "unknown_state",
      options: ["cooked", "dry"],
    });
  });

  it("an unknown food asks", () => {
    expect(resolveAmount({ food: "quinoa", value: 100, unit: "g" }, SOURCES, YIELDS)).toMatchObject({
      kind: "clarify",
      reason: "unknown_food",
    });
  });

  it("an unknown measure asks, listing the measures there are", () => {
    expect(resolveAmount({ food: "ghee", value: 1, measure: "tbsp" }, SOURCES, YIELDS)).toMatchObject({
      kind: "clarify",
      reason: "unknown_measure",
      options: ["tsp"],
    });
  });

  it("a unit in the wrong dimension asks rather than assuming a density", () => {
    expect(resolveAmount({ food: "milk", value: 250, unit: "g" }, SOURCES, YIELDS)).toMatchObject({
      kind: "clarify",
      reason: "unit_mismatch",
    });
  });

  it("an amount with neither a unit nor a measure asks", () => {
    expect(resolveAmount({ food: "ghee", value: 2 }, SOURCES, YIELDS)).toMatchObject({
      kind: "clarify",
      reason: "no_unit",
    });
  });

  it("a measure that only one state has settles the state", () => {
    const eggShelled: FoodSource = {
      id: "FS041",
      food: "egg",
      state: "whole, shelled",
      referenceAmount: { value: 100, unit: "g" },
      measures: [{ name: "egg", amount: 50 }],
      nutrients: { kcal: 143 },
    };
    expect(resolveAmount({ food: "egg", value: 2, measure: "egg" }, [...SOURCES, eggShelled], YIELDS)).toMatchObject({
      kind: "resolved",
      sourceId: "FS041",
      amount: 100,
    });
  });
});
