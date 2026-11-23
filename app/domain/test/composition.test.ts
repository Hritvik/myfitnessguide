import { describe, expect, it } from "vitest";
import { setDerived, totalLoad } from "../src/index";
import type { Implement, Load } from "../src/index";

// One set may mix units: a kg bar with kg and lb plates on each side.
describe("totalLoad: a composition of plates in mixed units", () => {
  const BAR: Implement = { id: "bar", unit: "kg", kind: "barbell", barKg: 20 };
  const SLED: Implement = { id: "sled", unit: "kg", kind: "plate_loaded" };

  it("a 20 kg bar with 10 kg + 5 lb per side", () => {
    const load: Load = {
      value: 0,
      unit: "kg",
      basis: "per_side",
      implement: BAR,
      plates: [
        { value: 10, unit: "kg", count: 1 },
        { value: 5, unit: "lb", count: 1 },
      ],
    };
    expect(totalLoad(load).kg).toBeCloseTo(44.5359237, 9);
  });

  it("plates on a sled of unknown weight count both sides' plates only", () => {
    const load: Load = {
      value: 0,
      unit: "kg",
      basis: "plates_only",
      implement: SLED,
      plates: [
        { value: 20, unit: "kg", count: 1 },
        { value: 5, unit: "lb", count: 1 },
      ],
    };
    expect(totalLoad(load).kg).toBeCloseTo(44.5359237, 9);
    expect(totalLoad(load).comparableAcrossImplements).toBe(false);
  });

  it("counts each group's plates", () => {
    const load: Load = { value: 0, unit: "kg", basis: "per_side", implement: BAR, plates: [{ value: 2.5, unit: "lb", count: 3 }] };
    expect(totalLoad(load).kg).toBeCloseTo(20 + 2 * 7.5 * 0.45359237, 9);
  });

  it("e1RM on a composition is the total (the split convention)", () => {
    const load: Load = { value: 0, unit: "kg", basis: "per_side", implement: BAR, plates: [{ value: 10, unit: "kg", count: 1 }] };
    expect(setDerived({ load, reps: 6, rir: { low: 0, high: 0 } }).e1rmKg).toBeCloseTo(48, 9);
  });
});
