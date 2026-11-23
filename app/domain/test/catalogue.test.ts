import { describe, expect, it } from "vitest";
import { catalogueProblems } from "../src/index";

// Ported from shared/test_catalogue_integrity.py (gymcalc.catalogue_problems).
// A SUMIF over missing ingredient lines returns 0 rather than an error, so a
// derived recipe with no lines reads as a real 0 kcal food.
describe("catalogueProblems (gymcalc port)", () => {
  it("a derived recipe with no lines is an error", () => {
    const problems = catalogueProblems([{ ref: "R036", derivation: "derived", lines: 0 }], [], {});
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("R036");
  });

  it("a stored recipe with no lines is fine", () => {
    expect(catalogueProblems([{ ref: "R004", derivation: "stored", lines: 0 }], [], {})).toEqual([]);
  });

  it("a dangling food id is an error", () => {
    const problems = catalogueProblems([], [{ recipe: "R036", foodId: "FS999" }], { FS025: {} });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("FS999");
  });

  it("a recipe referencing a recipe is an error", () => {
    const problems = catalogueProblems([], [{ recipe: "R036", foodId: "R012" }], {});
    expect(problems.some((p) => p.includes("R012"))).toBe(true);
  });

  it("a food source with no food id is an error", () => {
    const problems = catalogueProblems([], [], { "": { name: "Fulka" } });
    expect(problems.some((p) => p.includes("Fulka"))).toBe(true);
  });

  it("a clean catalogue has no problems", () => {
    expect(
      catalogueProblems(
        [{ ref: "R036", derivation: "derived", lines: 1 }],
        [{ recipe: "R036", foodId: "FS025" }],
        { FS025: {} },
      ),
    ).toEqual([]);
  });

  it("every problem names the thing that is wrong", () => {
    const problems = catalogueProblems(
      [{ ref: "R036", derivation: "derived", lines: 0 }],
      [{ recipe: "R040", foodId: "FS999" }],
      {},
    );
    expect(problems).toHaveLength(2);
    for (const p of problems) expect(p.trim()).not.toBe("");
  });
});
