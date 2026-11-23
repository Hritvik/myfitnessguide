import { describe, expect, it } from "vitest";
import { round1, roundHalfEven } from "../src/index";

// Expected values are what Python's round() returns, which is what gymcalc
// and therefore the Sheets-era derived values used.
describe("rounding matches Python round()", () => {
  it("sends exact binary ties to the even digit", () => {
    expect(round1(0.25)).toBe(0.2);
    expect(round1(0.75)).toBe(0.8);
    expect(round1(10.25)).toBe(10.2);
    expect(roundHalfEven(2.5, 0)).toBe(2);
  });

  it("rounds values that only look like ties on their exact binary value", () => {
    // 0.15 is stored as 0.1499999...; 0.35 as 0.34999...
    expect(round1(0.15)).toBe(0.1);
    expect(round1(0.35)).toBe(0.3);
    expect(round1(16.666666)).toBe(16.7);
  });

  it("handles negative values", () => {
    expect(round1(-0.25)).toBe(-0.2);
  });
});
