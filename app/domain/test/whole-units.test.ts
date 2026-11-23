import { describe, expect, it } from "vitest";
import { wholeUnits } from "../src/index";

// Ported from shared/test_gymcalc.py TestWholeUnits (R13). Fixtures are real
// Program and Log loads. gymcalc's ("kg", n) tuples become { unit, value }.
describe("wholeUnits (gymcalc port)", () => {
  it("stack machines are whole kg", () => {
    expect(wholeUnits(30)).toEqual({ unit: "kg", value: 30 });
    expect(wholeUnits(15)).toEqual({ unit: "kg", value: 15 });
    expect(wholeUnits(10)).toEqual({ unit: "kg", value: 10 });
    expect(wholeUnits(56)).toEqual({ unit: "kg", value: 56 });
  });

  it("lateral raise is five pounds", () => {
    expect(wholeUnits(2.3)).toEqual({ unit: "lb", value: 5 });
  });

  it("hammer curl is ten pounds", () => {
    expect(wholeUnits(4.5)).toEqual({ unit: "lb", value: 10 });
  });

  it("DB shoulder press is genuinely kg (7.5 kg is 16.5 lb)", () => {
    expect(wholeUnits(7.5)).toEqual({ unit: "kg", value: 7.5 });
  });

  it("progressed stack loads keep half kg", () => {
    expect(wholeUnits(32.5)).toEqual({ unit: "kg", value: 32.5 });
    expect(wholeUnits(17.5)).toEqual({ unit: "kg", value: 17.5 });
    expect(wholeUnits(12.5)).toEqual({ unit: "kg", value: 12.5 });
  });

  it("progressed dumbbells are half pounds", () => {
    expect(wholeUnits(3.4)).toEqual({ unit: "lb", value: 7.5 });
    expect(wholeUnits(5.7)).toEqual({ unit: "lb", value: 12.5 });
  });

  it("incline press is a combination", () => {
    expect(wholeUnits(29.1, { context: "barbell" })).toEqual({
      unit: "combination",
      description: "20 kg bar + 10 lb per side",
    });
  });

  it("bench press is a combination", () => {
    expect(wholeUnits(33.6, { context: "barbell" })).toEqual({
      unit: "combination",
      description: "20 kg bar + 15 lb per side",
    });
  });

  it("bench press with half-pound plates", () => {
    expect(wholeUnits(31.3, { context: "barbell" })).toEqual({
      unit: "combination",
      description: "20 kg bar + 12.5 lb per side",
    });
  });

  it("an empty bar is not a combination", () => {
    expect(wholeUnits(20, { context: "barbell" })).toEqual({ unit: "kg", value: 20 });
  });

  it("null passes through", () => {
    expect(wholeUnits(null)).toBeNull();
  });
});
