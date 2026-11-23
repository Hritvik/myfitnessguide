import { describe, expect, it } from "vitest";
import { recomputeCook, sumNutrients, totalsFrom } from "../src/index";
import type { Cook, FoodSource } from "../src/index";

const RAJMA: FoodSource = {
  id: "FS050",
  food: "rajma",
  state: "dry",
  referenceAmount: { value: 100, unit: "g" },
  nutrients: { kcal: 330, protein: 22, iron: 8.2, sodium: 0 },
};
const GHEE: FoodSource = {
  id: "FS020",
  food: "ghee",
  state: "as sold",
  referenceAmount: { value: 100, unit: "g" },
  nutrients: { kcal: 900, protein: 0, iron: null },
};
const CURD: FoodSource = {
  id: "FS060",
  food: "curd",
  state: "as sold",
  referenceAmount: { value: 100, unit: "g" },
  nutrients: { kcal: 60, protein: 3.5 },
};

describe("nutrient totals keep coverage: empty is unknown, 0 is measured zero", () => {
  it("a flat nutrient record becomes totals with one contribution each", () => {
    expect(totalsFrom({ kcal: 100, iron: null, sodium: 0 })).toEqual({
      kcal: { value: 100, known: 1, of: 1 },
      iron: { value: 0, known: 0, of: 1 },
      sodium: { value: 0, known: 1, of: 1 },
    });
  });

  it("summing counts a nutrient missing from one contribution as unknown there", () => {
    const got = sumNutrients([totalsFrom({ kcal: 100, iron: 2 }), totalsFrom({ kcal: 50 })]);
    expect(got).toEqual({
      kcal: { value: 150, known: 2, of: 2 },
      iron: { value: 2, known: 1, of: 2 },
    });
  });
});

describe("recomputeCook: a cook's nutrients from its lines, and each portion's share", () => {
  const DAL: Cook = {
    lines: [
      { source: RAJMA, multiples: 1.5 },
      { source: GHEE, multiples: 0.1 },
    ],
    cookedWeightG: 1000,
  };

  it("totals come from the lines, with micros coverage", () => {
    const got = recomputeCook(DAL, []);
    expect(got.totals.kcal).toEqual({ value: 585, known: 2, of: 2 });
    expect(got.totals.protein).toEqual({ value: 33, known: 2, of: 2 });
    expect(got.totals.iron?.known).toBe(1);
    expect(got.totals.iron?.of).toBe(2);
    expect(got.totals.iron?.value).toBeCloseTo(12.3, 9);
  });

  it("a fractional portion gets that share of every nutrient", () => {
    const got = recomputeCook(DAL, [{ member: "hritvik", share: { fraction: 0.4 } }]);
    const portion = got.portions[0];
    expect(portion?.fraction).toBe(0.4);
    expect(portion?.nutrients?.kcal?.value).toBeCloseTo(234, 9);
    expect(portion?.nutrients?.iron).toMatchObject({ known: 1, of: 2 });
  });

  it("a weighed portion is its share of the cooked weight", () => {
    const got = recomputeCook(DAL, [{ member: "kabir", share: { weighedG: 250 } }]);
    expect(got.portions[0]?.fraction).toBe(0.25);
    expect(got.portions[0]?.nutrients?.kcal?.value).toBeCloseTo(146.25, 9);
  });

  it("the part no portion accounts for is an unaccounted remainder", () => {
    const got = recomputeCook(DAL, [
      { member: "hritvik", share: { fraction: 0.4 } },
      { member: "asha", share: { fraction: 0.35 } },
    ]);
    expect(got.remainder).toHaveLength(1);
    expect(got.remainder[0]?.component).toBe("main");
    expect(got.remainder[0]?.fraction).toBeCloseTo(0.25, 9);
    expect(got.remainder[0]?.status).toBe("unaccounted");
    expect(got.remainder[0]?.nutrients.kcal?.value).toBeCloseTo(146.25, 9);
  });

  it("a remainder marked leftover, eaten or discarded says so", () => {
    const got = recomputeCook(DAL, [{ member: "hritvik", share: { fraction: 0.5 } }], [
      { component: "main", disposition: "leftover" },
    ]);
    expect(got.remainder[0]?.status).toBe("leftover");
  });

  it("a fully shared cook has no remainder", () => {
    const got = recomputeCook(DAL, [
      { member: "hritvik", share: { fraction: 0.5 } },
      { member: "asha", share: { weighedG: 500 } },
    ]);
    expect(got.remainder).toEqual([]);
    expect(got.problems).toEqual([]);
  });

  it("portions adding up to more than the cook are a problem", () => {
    const got = recomputeCook(DAL, [
      { member: "hritvik", share: { fraction: 0.6 } },
      { member: "asha", share: { fraction: 0.5 } },
    ]);
    expect(got.problems).toHaveLength(1);
    expect(got.problems[0]).toContain("main");
    // Each share named, so the member sees what makes it more than whole (click test P1-7).
    expect(got.problems[0]).toMatch(/; shares: hritvik 60%, asha 50%$/);
    expect(got.remainder).toEqual([]);
  });

  it("a weighed portion without a cooked weight has no share and is a problem", () => {
    const got = recomputeCook({ lines: DAL.lines }, [{ member: "hritvik", share: { weighedG: 300 } }]);
    expect(got.portions[0]).toMatchObject({ fraction: null, nutrients: null });
    expect(got.problems[0]).toContain("cooked weight");
  });

  it("components are shared separately, each with its own shares and cooked weight", () => {
    // Dinner: dal + raita, H 40 / S 35 / Hz 25 of the dal, raita split differently.
    const dinner: Cook = {
      lines: [
        { component: "dal", source: RAJMA, multiples: 1.5 },
        { component: "raita", source: CURD, multiples: 4 },
      ],
      components: [
        { name: "dal", cookedWeightG: 1000 },
        { name: "raita", cookedWeightG: 400 },
      ],
    };
    const got = recomputeCook(dinner, [
      { member: "hritvik", component: "dal", share: { fraction: 0.4 } },
      { member: "asha", component: "dal", share: { fraction: 0.35 } },
      { member: "kabir", component: "dal", share: { fraction: 0.25 } },
      { member: "hritvik", component: "raita", share: { weighedG: 200 } },
    ]);
    expect(got.components.map((c) => c.name)).toEqual(["dal", "raita"]);
    expect(got.components[1]?.totals.kcal?.value).toBeCloseTo(240, 9);
    expect(got.portions[3]?.nutrients?.kcal?.value).toBeCloseTo(120, 9);
    expect(got.remainder.map((r) => r.component)).toEqual(["raita"]);
    expect(got.remainder[0]?.fraction).toBeCloseTo(0.5, 9);
  });
});
