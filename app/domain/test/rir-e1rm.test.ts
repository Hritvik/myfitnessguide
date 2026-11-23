import { describe, expect, it } from "vitest";
import { E1RM_MAX_REPS, rirAdjustedE1rm, setDerived } from "../src/index";
import type { Implement, Load } from "../src/index";

const STACK: Implement = { id: "stack", unit: "kg", kind: "machine" };
const BARBELL: Implement = { id: "bar", unit: "kg", kind: "barbell", barKg: 20 };
const CABLE: Implement = { id: "cable", unit: "kg", kind: "cable" };
const DUMBBELLS: Implement = { id: "dumbbells", unit: "kg", kind: "dumbbell" };
const SLED: Implement = { id: "sled", unit: "kg", kind: "plate_loaded" };
const ASSISTED: Implement = { id: "assisted", unit: "kg", kind: "machine", assisted: true };

const load = (overrides: Partial<Load> = {}): Load => ({
  value: 30,
  unit: "kg",
  basis: "total",
  implement: STACK,
  ...overrides,
});

describe("rirAdjustedE1rm", () => {
  it("uses reps plus the low end of the RIR range in Epley", () => {
    expect(rirAdjustedE1rm({ load: load(), reps: 8, rir: { low: 2, high: 4 }, repsConfirmed: true })).toEqual({
      e1rmKg: 40,
      repsSource: "reported",
    });
  });

  it("matches the strict RIR-0 calculation for every comparable split convention", () => {
    const loads: Load[] = [
      load(),
      load({ value: 10, basis: "per_side", implement: BARBELL }),
      load({ value: 10, basis: "per_side", implement: CABLE }),
      load({ value: 10, basis: "per_hand", implement: DUMBBELLS }),
      load({ value: 10, basis: "per_leg", implement: STACK, unilateral: true }),
    ];

    for (const candidate of loads) {
      const strict = setDerived({ load: candidate, reps: 8, rir: { low: 0, high: 0 } }).e1rmKg;
      expect(rirAdjustedE1rm({ load: candidate, reps: 8, rir: { low: 0, high: 0 }, repsConfirmed: true })?.e1rmKg).toBeCloseTo(
        strict as number,
        12,
      );
    }
  });

  it("marks a value based on inferred reps without suppressing it", () => {
    expect(rirAdjustedE1rm({ load: load(), reps: 8, rir: { low: 1, high: 1 }, repsConfirmed: false })).toEqual({
      e1rmKg: 39,
      repsSource: "inferred",
    });
  });

  it("exports and applies the 12-effective-rep cap", () => {
    expect(E1RM_MAX_REPS).toBe(12);
    expect(rirAdjustedE1rm({ load: load(), reps: 10, rir: { low: 2, high: 3 } })).toEqual({
      e1rmKg: 42,
      repsSource: "reported",
    });
    expect(rirAdjustedE1rm({ load: load(), reps: 10, rir: { low: 3, high: 3 } })).toBeNull();
  });

  it.each([
    ["missing load", { load: null, reps: 8, rir: { low: 1, high: 1 } }],
    ["missing reps", { load: load(), reps: null, rir: { low: 1, high: 1 } }],
    ["blank RIR", { load: load(), reps: 8, rir: null }],
    ["unrecorded RIR", { load: load(), reps: 8, rir: "not_recorded" }],
    ["zero reps", { load: load(), reps: 0, rir: { low: 1, high: 1 } }],
    ["assistance", { load: load({ implement: ASSISTED }), reps: 8, rir: { low: 1, high: 1 } }],
    ["bodyweight-dominant movement", { load: load(), reps: 8, rir: { low: 1, high: 1 }, bodyweightDominant: true }],
    ["plates-only load", { load: load({ basis: "plates_only", implement: SLED }), reps: 8, rir: { low: 1, high: 1 } }],
  ] as const)("returns null for %s", (_name, input) => {
    expect(rirAdjustedE1rm(input)).toBeNull();
  });
});
