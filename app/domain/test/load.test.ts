import { describe, expect, it } from "vitest";
import { setDerived, totalLoad } from "../src/index";
import type { Implement, Load } from "../src/index";

const BENCH: Implement = { id: "bench-bar", unit: "lb", barKg: 20 };
const CABLE: Implement = { id: "low-row", unit: "kg" };
const LB_DUMBBELLS: Implement = { id: "db-lb", unit: "lb" };
const LEG_PRESS: Implement = { id: "leg-press", unit: "kg" };
const ASSISTED_PULLUP: Implement = { id: "assist", unit: "kg", assisted: true };

describe("totalLoad: load as entered to exact total kg", () => {
  it("a bar plus pound plates per side: the 12 Aug bench is 31.3398 kg", () => {
    const load: Load = { value: 12.5, unit: "lb", basis: "per_side", implement: BENCH };
    expect(totalLoad(load).kg).toBeCloseTo(31.3398, 4);
  });

  it("a total load in kg is itself", () => {
    expect(totalLoad({ value: 30, unit: "kg", basis: "total", implement: CABLE }).kg).toBe(30);
  });

  it("a total load in lb converts exactly", () => {
    expect(totalLoad({ value: 10, unit: "lb", basis: "total", implement: LB_DUMBBELLS }).kg).toBeCloseTo(4.5359237, 7);
  });

  it("per hand counts both hands", () => {
    // 7.5 lb dumbbell in each hand.
    expect(totalLoad({ value: 7.5, unit: "lb", basis: "per_hand", implement: LB_DUMBBELLS }).kg).toBeCloseTo(6.80389, 5);
  });

  it("per hand on a one-arm set counts one hand", () => {
    const load: Load = { value: 10, unit: "kg", basis: "per_hand", implement: CABLE, unilateral: true };
    expect(totalLoad(load).kg).toBe(10);
  });

  it("per leg counts both legs unless unilateral", () => {
    expect(totalLoad({ value: 15, unit: "kg", basis: "per_leg", implement: CABLE }).kg).toBe(30);
    expect(totalLoad({ value: 15, unit: "kg", basis: "per_leg", implement: CABLE, unilateral: true }).kg).toBe(15);
  });

  it("plates-only counts both sides of plates, no sled, and is not comparable across machines", () => {
    const got = totalLoad({ value: 25, unit: "kg", basis: "plates_only", implement: LEG_PRESS });
    expect(got.kg).toBe(50);
    expect(got.comparableAcrossImplements).toBe(false);
  });

  it("per side with no bar on the implement adds no bar", () => {
    expect(totalLoad({ value: 20, unit: "kg", basis: "per_side", implement: LEG_PRESS }).kg).toBe(40);
  });

  it("an assisted implement makes the load negative", () => {
    const got = totalLoad({ value: 56, unit: "kg", basis: "total", implement: ASSISTED_PULLUP });
    expect(got.kg).toBe(-56);
    expect(got.assisted).toBe(true);
  });
});

describe("setDerived: volume and e1RM from the same exact load", () => {
  const bench: Load = { value: 12.5, unit: "lb", basis: "per_side", implement: BENCH };

  it("volume is total x reps, unrounded", () => {
    expect(setDerived({ load: bench, reps: 8, rir: { low: 1, high: 2 } }).volumeKg).toBeCloseTo(250.71847, 4);
  });

  it("e1RM is computed for a RIR-0 set of 12 reps or fewer", () => {
    const barbell: Load = { value: 30, unit: "kg", basis: "total", implement: CABLE };
    expect(setDerived({ load: barbell, reps: 8, rir: { low: 0, high: 0 } }).e1rmKg).toBeCloseTo(38, 6);
    expect(setDerived({ load: barbell, reps: 12, rir: { low: 0, high: 0 } }).e1rmKg).toBeCloseTo(42, 6);
  });

  it("no e1RM for a set with reps in reserve", () => {
    expect(setDerived({ load: bench, reps: 8, rir: { low: 0, high: 1 } }).e1rmKg).toBeNull();
    expect(setDerived({ load: bench, reps: 8, rir: { low: 2, high: 2 } }).e1rmKg).toBeNull();
  });

  it("no e1RM on a bodyweight-dominant exercise, where the external load is a fraction of what moves; volume stays", () => {
    // A goblet squat with a 10 kg dumbbell at RIR 0: an e1RM of 12.7 kg would be a fiction.
    const goblet: Load = { value: 10, unit: "kg", basis: "total", implement: CABLE };
    const got = setDerived({ load: goblet, reps: 8, rir: { low: 0, high: 0 }, bodyweightDominant: true });
    expect(got.e1rmKg).toBeNull();
    expect(got.volumeKg).toBe(80);
    expect(setDerived({ load: goblet, reps: 8, rir: { low: 0, high: 0 }, bodyweightDominant: false }).e1rmKg).toBeCloseTo(12.6667, 4);
  });

  it("no e1RM above 12 reps", () => {
    expect(setDerived({ load: bench, reps: 13, rir: { low: 0, high: 0 } }).e1rmKg).toBeNull();
  });

  it("no e1RM when RIR is not recorded or blank", () => {
    expect(setDerived({ load: bench, reps: 8, rir: "not_recorded" }).e1rmKg).toBeNull();
    expect(setDerived({ load: bench, reps: 8, rir: null }).e1rmKg).toBeNull();
  });

  it("assisted sets have neither volume nor e1RM", () => {
    const load: Load = { value: 56, unit: "kg", basis: "total", implement: ASSISTED_PULLUP };
    const got = setDerived({ load, reps: 8, rir: { low: 0, high: 0 } });
    expect(got.totalKg).toBe(-56);
    expect(got.volumeKg).toBeNull();
    expect(got.e1rmKg).toBeNull();
  });

  it("missing reps give no volume and no e1RM", () => {
    const got = setDerived({ load: bench, reps: null, rir: { low: 0, high: 0 } });
    expect(got.volumeKg).toBeNull();
    expect(got.e1rmKg).toBeNull();
  });
});

