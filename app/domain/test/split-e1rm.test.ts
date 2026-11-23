import { describe, expect, it } from "vitest";
import { implementsSharing, setDerived } from "../src/index";
import type { Implement, Load } from "../src/index";

// The split e1RM convention: a total for barbells and plate-loaded machines,
// per hand / per side / per leg for dumbbells and cables. Volume always
// counts every limb.
const atFailure = { low: 0, high: 0 };
const BARBELL: Implement = { id: "bar", unit: "lb", kind: "barbell", barKg: 20 };
const SLED: Implement = { id: "sled", unit: "kg", kind: "plate_loaded" };
const CABLE: Implement = { id: "cable", unit: "kg", kind: "cable" };
const DUMBBELLS: Implement = { id: "db", unit: "kg", kind: "dumbbell" };
const STACK: Implement = { id: "stack", unit: "kg", kind: "machine" };

const derived = (load: Load, reps: number) => setDerived({ load, reps, rir: atFailure });

describe("setDerived: e1RM is a total on barbells and plate-loaded machines", () => {
  it("a bar with plates per side: e1RM on the whole bar", () => {
    // 12.5 lb a side on a 20 kg bar is 31.3398 kg; 8 reps.
    const got = derived({ value: 12.5, unit: "lb", basis: "per_side", implement: BARBELL }, 8);
    expect(got.totalKg).toBeCloseTo(31.3398, 4);
    expect(got.e1rmKg).toBeCloseTo(39.6971, 4);
  });

  it("plates on a sled of unknown weight: e1RM on both sides' plates", () => {
    const got = derived({ value: 25, unit: "kg", basis: "plates_only", implement: SLED }, 6);
    expect(got.volumeKg).toBe(300);
    expect(got.e1rmKg).toBeCloseTo(60, 6);
  });

  it("per side on a plate-loaded machine is a total too", () => {
    expect(derived({ value: 20, unit: "kg", basis: "per_side", implement: SLED }, 6).e1rmKg).toBeCloseTo(48, 6);
  });
});

describe("setDerived: e1RM is per hand, side or leg on dumbbells and cables", () => {
  it("per hand: one dumbbell's e1RM, both dumbbells' volume", () => {
    const got = derived({ value: 6, unit: "kg", basis: "per_hand", implement: DUMBBELLS }, 9);
    expect(got.totalKg).toBe(12);
    expect(got.volumeKg).toBe(108);
    expect(got.e1rmKg).toBeCloseTo(7.8, 6);
  });

  it("per side on a cable: one side's stack", () => {
    const got = derived({ value: 9, unit: "kg", basis: "per_side", implement: CABLE }, 6);
    expect(got.volumeKg).toBe(108);
    expect(got.e1rmKg).toBeCloseTo(10.8, 6);
  });

  it("per leg: a single-leg set covers both legs; e1RM is one leg's", () => {
    const got = derived({ value: 8, unit: "kg", basis: "per_leg", implement: DUMBBELLS }, 9);
    expect(got.volumeKg).toBe(144);
    expect(got.e1rmKg).toBeCloseTo(10.4, 6);
  });

  it("a unilateral set is one limb: volume once, e1RM the same limb's", () => {
    const got = derived({ value: 10, unit: "kg", basis: "per_hand", implement: DUMBBELLS, unilateral: true }, 12);
    expect(got.volumeKg).toBe(120);
    expect(got.e1rmKg).toBeCloseTo(14, 6);
  });

  it("a total on a stack is the total", () => {
    expect(derived({ value: 30, unit: "kg", basis: "total", implement: STACK }, 6).e1rmKg).toBeCloseTo(36, 6);
  });
});

describe("implementsSharing: how many shares the e1RM is split into", () => {
  const cases: [Load, number][] = [
    [{ value: 1, unit: "kg", basis: "total", implement: STACK }, 1],
    [{ value: 1, unit: "kg", basis: "per_hand", implement: DUMBBELLS }, 2],
    [{ value: 1, unit: "kg", basis: "per_hand", implement: DUMBBELLS, unilateral: true }, 1],
    [{ value: 1, unit: "kg", basis: "per_leg", implement: STACK }, 2],
    [{ value: 1, unit: "kg", basis: "per_side", implement: CABLE }, 2],
    [{ value: 1, unit: "kg", basis: "per_side", implement: BARBELL }, 1],
    [{ value: 1, unit: "kg", basis: "per_side", implement: SLED }, 1],
    [{ value: 1, unit: "kg", basis: "plates_only", implement: SLED }, 1],
    // Per side on an implement of unknown kind: only a cable splits by side.
    [{ value: 1, unit: "kg", basis: "per_side", implement: { id: "x", unit: "kg" } }, 1],
  ];
  it.each(cases)("%o shares %i", (load, n) => {
    expect(implementsSharing(load)).toBe(n);
  });
});
