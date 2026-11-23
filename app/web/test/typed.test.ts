import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { foodItem } from "../src/food";
import { readingInput } from "../src/reading";
import { cardioPlan, loadInput, setInput } from "../src/setEntry";
import { typedNumber } from "../src/typed";
import { leftoverShare } from "../src/writes";

describe("typedNumber: a number as a member types it (ticket 67, B1)", () => {
  it("reads digits with at most one point, spaces around ignored", () => {
    expect(typedNumber(" 118 ")).toBe(118);
    expect(typedNumber("7.")).toBe(7);
    expect(typedNumber(".5")).toBe(0.5);
    expect(typedNumber("0050")).toBe(50);
    expect(typedNumber("9".repeat(300))).toBe(Number("9".repeat(300)));
  });

  it("refuses what JavaScript's Number would take but nobody means: hex, octal, binary, exponents, a plus sign, Infinity, too many digits", () => {
    for (const t of ["0x32", "5e1", "+50", "0b110010", "0o62", "1e400", "Infinity", "-Infinity", "9".repeat(400), "", "  "]) expect(typedNumber(t), t).toBeNaN();
  });

  it("refuses a comma, a unit, a minus (unless signed) and a % (unless a percent)", () => {
    for (const t of ["2,5", "1,000", "120g", "-5", "50%", "½", "１２"]) expect(typedNumber(t), t).toBeNaN();
    expect(typedNumber("-12.5", { signed: true })).toBe(-12.5);
    expect(typedNumber("50%", { percent: true })).toBe(50);
    expect(typedNumber("50 %", { percent: true })).toBe(50);
    expect(typedNumber("%", { percent: true })).toBeNaN();
  });

  it("any text is NaN or exactly the plain decimal typed", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: "grapheme", maxLength: 20 }), fc.stringMatching(/^\s?-?\d{0,6}(\.\d{0,3})?\s?$/)), fc.boolean(), (t, signed) => {
        const v = typedNumber(t, { signed });
        if (Number.isNaN(v)) return;
        expect(t.trim()).toMatch(signed ? /^-?(\d+(\.\d*)?|\.\d+)$/ : /^(\d+(\.\d*)?|\.\d+)$/);
        expect(v).toBe(Number(t.trim()));
        expect(Number.isFinite(v)).toBe(true);
      }),
    );
  });
});

describe("the forms refuse a non-decimal notation (regression, ticket 67 B1)", () => {
  it.each(["0x32", "5e1", "+50", "0b110010", "0o62", "1e400"])("%j", (t) => {
    expect(foodItem({ kind: "food", ref: "FS900", name: "Test rice", state: "dry", usual: null }, { value: t, unit: "g", measure: null, provenance: "weighed", uncertainty: "", uncertaintyKcal: "" })).toEqual({ error: "Enter how much." });
    expect(setInput("Asha", "2026-10-08", { exercise: "Test row", setType: "working", reps: t, rir: "2", load: { kind: "none" } }, "prescribed")).toEqual({ error: "Enter the reps." });
    expect(loadInput({ kind: "value", value: t, unit: "kg", basis: "total" })).toEqual({ error: "Enter the load." });
    expect(cardioPlan("Asha", "2026-10-08", { activity: "", minutes: t, km: "", avgHr: "" })).toEqual({ error: "Enter how long." });
    expect(readingInput("Asha", "2026-10-08", { metric: "weight", value: t, unit: "kg", bodyState: "fasted", side: null }, { code: "weight", label: "Body weight", dimension: "mass", units: ["kg"], sides: [], last: null })).toEqual({ error: "Enter the reading as a number above 0." });
    expect(leftoverShare(t, 0.8)).toHaveProperty("error");
  });
});
