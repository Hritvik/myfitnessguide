import { describe, expect, it } from "vitest";
import { NORMAL_STEP, progressionCheck } from "../src/index";
import type { Implement, ProgressionRule, ProgressionSet } from "../src/index";

const done = (reps: number): ProgressionSet => ({ reps, rir: { low: 2, high: 2 }, repsConfirmed: true });
const three = (reps: number) => [done(reps), done(reps), done(reps)];

// When a list's top is unknown, the next step above it is proposed, marked
// unverified ("check it exists"), instead of "never".
describe("progressionCheck: an implement whose top is unknown", () => {
  const SMALLEST: ProgressionRule = { targetSets: 3, repTop: 12, rirTarget: 2, increment: "smallest_step" };

  it("at the top of a pound rack, the next normal dumbbell step, unverified", () => {
    const rack: Implement = { id: "db", unit: "lb", kind: "dumbbell", loads: [5, 10, 15, 20], maxUnknown: true };
    const got = progressionCheck(three(12), SMALLEST, { currentLoad: 20, implement: rack });
    expect(got).toMatchObject({ verdict: "fired", nextLoad: 25, nextLoadUnit: "lb", unverified: true });
  });

  it("below the top it moves on the list and is verified", () => {
    const rack: Implement = { id: "db", unit: "lb", kind: "dumbbell", loads: [5, 10, 15, 20], maxUnknown: true };
    const got = progressionCheck(three(12), SMALLEST, { currentLoad: 15, implement: rack });
    expect(got).toMatchObject({ verdict: "fired", nextLoad: 20, nextLoadUnit: "lb" });
    expect(got).not.toHaveProperty("unverified");
  });

  it("a complete list is still never at its top", () => {
    const rack: Implement = { id: "db", unit: "lb", kind: "dumbbell", loads: [5, 10, 15, 20] };
    expect(progressionCheck(three(12), SMALLEST, { currentLoad: 20, implement: rack })).toMatchObject({ verdict: "never", reason: "at_highest_load" });
  });

  it("an increment above the known top proposes the current load plus the increment", () => {
    const stack: Implement = { id: "row", unit: "kg", kind: "machine", loads: [25, 30, 35], maxUnknown: true };
    const rule: ProgressionRule = { targetSets: 3, repTop: 12, rirTarget: 2, increment: { min: 5 } };
    expect(progressionCheck(three(12), rule, { currentLoad: 35, implement: stack })).toMatchObject({
      verdict: "fired",
      nextLoad: 40,
      nextLoadUnit: "kg",
      unverified: true,
    });
  });

  it("a gap inside the known list is still never", () => {
    const stack: Implement = { id: "row", unit: "kg", kind: "machine", loads: [25, 30, 40], maxUnknown: true };
    const rule: ProgressionRule = { targetSets: 3, repTop: 12, rirTarget: 2, increment: { min: 2.5, max: 5 } };
    expect(progressionCheck(three(12), rule, { currentLoad: 30, implement: stack })).toMatchObject({
      verdict: "never",
      reason: "increment_not_on_implement",
    });
  });

  it("never proposes a load known not to exist", () => {
    const rack: Implement = {
      id: "db",
      unit: "kg",
      kind: "dumbbell",
      loads: [6, 8, 10],
      absent: [{ value: 12, unit: "kg" }],
      maxUnknown: true,
    };
    expect(progressionCheck(three(12), SMALLEST, { currentLoad: 10, implement: rack })).toMatchObject({
      nextLoad: 14,
      nextLoadUnit: "kg",
      unverified: true,
    });
  });

  it("the step follows the unit of the current load on a mixed list", () => {
    const stack: Implement = { id: "stack", unit: "lb", kind: "machine", loads: [{ value: 10, unit: "kg" }, 40, 50, 60], maxUnknown: true };
    expect(progressionCheck(three(12), SMALLEST, { currentLoad: { value: 60, unit: "lb" }, implement: stack })).toMatchObject({
      nextLoad: 60 + NORMAL_STEP.machine.lb,
      nextLoadUnit: "lb",
      unverified: true,
    });
  });

  it("inferred reps still ask first, carrying the unverified step", () => {
    const rack: Implement = { id: "db", unit: "lb", kind: "dumbbell", loads: [5, 10], maxUnknown: true };
    const sets = [done(12), done(12), { ...done(12), repsConfirmed: false }];
    expect(progressionCheck(sets, SMALLEST, { currentLoad: 10, implement: rack })).toMatchObject({
      verdict: "needs_confirmation",
      nextLoad: 15,
      unverified: true,
    });
  });
});

describe("progressionCheck: across units", () => {
  it("the next load may be in the other unit when it is the lightest in the window", () => {
    // A stack of kg plates with a pound starter weight on top.
    const stack: Implement = { id: "x", unit: "kg", kind: "machine", loads: [10, 12.5, { value: 25, unit: "lb" }] };
    const rule: ProgressionRule = { targetSets: 3, repTop: 12, rirTarget: 2, increment: "smallest_step" };
    expect(progressionCheck(three(12), rule, { currentLoad: 10, implement: stack })).toMatchObject({
      nextLoad: 25,
      nextLoadUnit: "lb",
    });
  });

  it("plate-loaded kit moves to the lightest plate combination in the window", () => {
    const sled: Implement = {
      id: "sled",
      unit: "kg",
      kind: "plate_loaded",
      plates: { available: [{ value: 20, unit: "kg" }, { value: 5, unit: "lb" }], absent: [{ value: 2.5, unit: "kg" }], complete: true },
    };
    const rule: ProgressionRule = { targetSets: 3, repTop: 12, rirTarget: 2, increment: { min: 2, max: 3 } };
    const got = progressionCheck(three(12), rule, { currentLoad: 20, implement: sled });
    expect(got).toMatchObject({
      verdict: "fired",
      nextLoadUnit: "kg",
      nextLoadPlates: [
        { value: 20, unit: "kg", count: 1 },
        { value: 5, unit: "lb", count: 1 },
      ],
    });
  });

  it("with plates not all known and no combination in the window, the normal step, unverified", () => {
    const sled: Implement = { id: "hack", unit: "lb", kind: "plate_loaded", plates: { available: [{ value: 45, unit: "lb" }], complete: false } };
    const rule: ProgressionRule = { targetSets: 3, repTop: 12, rirTarget: 2, increment: "smallest_step" };
    expect(progressionCheck(three(12), rule, { currentLoad: 45, implement: sled })).toMatchObject({
      nextLoad: 45 + NORMAL_STEP.plate_loaded.lb,
      nextLoadUnit: "lb",
      unverified: true,
    });
  });
});
