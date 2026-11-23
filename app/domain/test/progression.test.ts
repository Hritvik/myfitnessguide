import { describe, expect, it } from "vitest";
import { progressionCheck } from "../src/index";
import type { Implement, ProgressionRule, ProgressionSet } from "../src/index";

const done = (reps: number, high = 2): ProgressionSet => ({ reps, rir: { low: high, high }, repsConfirmed: true });

const LB_RACK: Implement = { id: "db-lb", unit: "lb", loads: [5, 10, 15, 20] };
const KG_STACK: Implement = { id: "low-row", unit: "kg", loads: [25, 30, 32.5, 35, 40] };
const FIXED_BARS: Implement = { id: "fixed-bars", unit: "kg", loads: [10, 15, 20], maxUnknown: true };

describe("progressionCheck: fired moves to the next producible load", () => {
  const RULE: ProgressionRule = { targetSets: 3, repTop: 12, rirTarget: 2, increment: { min: 2.5, max: 5 } };

  it("the next load is the lightest producible load within the increment", () => {
    const got = progressionCheck([done(12), done(12), done(12)], RULE, { currentLoad: 30, implement: KG_STACK });
    expect(got).toMatchObject({ verdict: "fired", nextLoad: 32.5 });
  });

  it("without an inventory the next load is the current load plus the minimum increment", () => {
    const got = progressionCheck([done(12), done(12), done(12)], RULE, {
      currentLoad: 30,
      implement: { id: "elsewhere", unit: "kg" },
    });
    expect(got).toMatchObject({ verdict: "fired", nextLoad: 32.5 });
  });
});

describe("progressionCheck: the smallest producible step", () => {
  const RULE: ProgressionRule = { targetSets: 3, repTop: 12, rirTarget: 2, increment: "smallest_step" };

  it("moves to the next load the implement produces, however big the step", () => {
    const got = progressionCheck([done(12), done(12), done(12)], RULE, { currentLoad: 32.5, implement: KG_STACK });
    expect(got).toMatchObject({ verdict: "fired", nextLoad: 35 });
  });

  it("is never at the top of the list", () => {
    const got = progressionCheck([done(12), done(12), done(12)], RULE, { currentLoad: 40, implement: KG_STACK });
    expect(got).toMatchObject({ verdict: "never", reason: "at_highest_load" });
  });

  it("without an inventory it fires with no next load, since no step is known", () => {
    const got = progressionCheck([done(12), done(12), done(12)], RULE, { currentLoad: 30, implement: { id: "elsewhere", unit: "kg" } });
    expect(got).toMatchObject({ verdict: "fired", nextLoad: null });
  });

  it("steps up an assistance list toward less help", () => {
    const assist: Implement = { id: "assist", unit: "kg", loads: [-40, -35, -30] };
    const got = progressionCheck([done(12), done(12), done(12)], RULE, { currentLoad: -40, implement: assist });
    expect(got).toMatchObject({ verdict: "fired", nextLoad: -35 });
  });
});

describe("progressionCheck: a mixed-unit rack's near-duplicates", () => {
  // A pound rack and a few kilogram dumbbells: 27.5 lb and 12.5 kg are two
  // dumbbells 0.026 kg apart. Moving between them is not progress.
  const RULE: ProgressionRule = { targetSets: 3, repTop: 12, rirTarget: 2, increment: "smallest_step" };
  const RACK: Implement = { id: "mixed", unit: "lb", kind: "dumbbell", loads: [25, 27.5, { value: 12.5, unit: "kg" }, 30, 35] };

  it("steps over a load a few grams above the current one", () => {
    const got = progressionCheck([done(12), done(12), done(12)], RULE, { currentLoad: 27.5, implement: RACK });
    expect(got).toMatchObject({ verdict: "fired", nextLoad: 30, nextLoadUnit: "lb" });
  });

  it("does not drop onto one either", () => {
    const got = progressionCheck([done(8), done(8), done(8)], RULE, {
      prescription: { repLow: 10, repHigh: 12 }, currentLoad: { value: 12.5, unit: "kg" }, implement: RACK,
    });
    expect(got).toMatchObject({ verdict: "not_yet", reason: "autoregulation", autoregulation: { action: "drop", dropTo: 25 } });
  });
});

describe("progressionCheck: above a known top, the ladder's own spacing is the guess", () => {
  it("uses the last two known loads rather than the kind's default step", () => {
    // Dumbbells on a 10 kg ladder, top unknown: the kind's default is 2.5 kg.
    const rack: Implement = { id: "rack", unit: "kg", kind: "dumbbell", loads: [10, 20, 30], maxUnknown: true };
    const rule: ProgressionRule = { targetSets: 3, repTop: 12, rirTarget: 2, increment: "smallest_step" };
    const got = progressionCheck([done(12), done(12), done(12)], rule, { currentLoad: 30, implement: rack });
    expect(got).toMatchObject({ verdict: "fired", nextLoad: 40, nextLoadUnit: "kg", unverified: true });
  });
});

describe("progressionCheck: never fires", () => {
  it("when the increment does not exist on this implement", () => {
    // 5 lb dumbbell, rule says add 2.5 lb, the rack has no 7.5 lb.
    const rule: ProgressionRule = { targetSets: 3, repTop: 15, rirTarget: 2, increment: { min: 2.5 } };
    const got = progressionCheck([done(15), done(15), done(15)], rule, { currentLoad: 5, implement: LB_RACK });
    expect(got.verdict).toBe("never");
    expect(got.reason).toBe("increment_not_on_implement");
    expect(got.message).toContain("increment does not exist on this implement");
  });

  it("when the current load is already the highest the implement produces", () => {
    const rule: ProgressionRule = { targetSets: 3, repTop: 12, rirTarget: 2, increment: { min: 5 } };
    const got = progressionCheck([done(12), done(12), done(12)], rule, { currentLoad: 40, implement: KG_STACK });
    expect(got).toMatchObject({ verdict: "never", reason: "at_highest_load" });
  });

  it("at the top of a fixed-bar rack whose maximum is unknown, it is not never (see unknown-top tests)", () => {
    const rule: ProgressionRule = { targetSets: 3, repTop: 10, rirTarget: 2, increment: { min: 5 } };
    const got = progressionCheck([done(10), done(10), done(10)], rule, { currentLoad: 20, implement: FIXED_BARS });
    expect(got).toMatchObject({ verdict: "fired", nextLoad: 25, nextLoadUnit: "kg", unverified: true });
  });

  it("when the rep cap is below the rule's requirement", () => {
    const rule: ProgressionRule = { targetSets: 3, repTop: 12, rirTarget: 2 };
    const got = progressionCheck([done(10), done(10), done(10)], rule, { prescription: { repLow: 8, repHigh: 10 } });
    expect(got.verdict).toBe("never");
    expect(got.reason).toBe("rep_cap_below_requirement");
    expect(got.message).toContain("rep cap is below the rule's requirement");
  });

  it("says never even before any sets are logged", () => {
    const rule: ProgressionRule = { targetSets: 3, repTop: 12, rirTarget: 2 };
    expect(progressionCheck([], rule, { prescription: { repLow: 8, repHigh: 10 } }).verdict).toBe("never");
  });
});

describe("progressionCheck: not yet, with a reason", () => {
  const RULE: ProgressionRule = { targetSets: 3, repTop: 12, rirTarget: 2 };

  it("RIR not recorded cannot move a load", () => {
    const s: ProgressionSet[] = [done(12), done(12), { reps: 12, rir: "not_recorded", repsConfirmed: true }];
    const got = progressionCheck(s, RULE);
    expect(got).toMatchObject({ verdict: "not_yet", reason: "rir_not_recorded" });
    expect(got.message).toContain("RIR not recorded");
  });
});

describe("progressionCheck: autoregulation", () => {
  // Guide 46: a set landing 2+ reps under target means hold or drop.
  const RULE: ProgressionRule = { targetSets: 3, repTop: 12, rirTarget: 2 };
  const context = { prescription: { repLow: 10, repHigh: 12 }, currentLoad: 32.5, implement: KG_STACK };

  it("a later set 2+ reps under the rep floor holds the load", () => {
    const got = progressionCheck([done(10), done(9), done(8)], RULE, context);
    expect(got).toMatchObject({ verdict: "not_yet", reason: "autoregulation", autoregulation: { action: "hold" } });
  });

  it("a first set 2+ reps under the rep floor drops to the next lighter producible load", () => {
    const got = progressionCheck([done(8), done(7), done(7)], RULE, context);
    expect(got).toMatchObject({
      verdict: "not_yet",
      reason: "autoregulation",
      autoregulation: { action: "drop", dropTo: 30 },
    });
  });

  it("one rep under the floor is not autoregulation", () => {
    const got = progressionCheck([done(10), done(9), done(9)], RULE, context);
    expect(got).toMatchObject({ verdict: "not_yet", reason: "reps_below_requirement", autoregulation: null });
  });

  it("the threshold comes from the rule when it sets one", () => {
    const got = progressionCheck([done(10), done(10), done(9)], { ...RULE, autoregulationRepsUnder: 1 }, context);
    expect(got).toMatchObject({ reason: "autoregulation", autoregulation: { action: "hold" } });
  });

  it("warm-ups are not autoregulated", () => {
    const s: ProgressionSet[] = [{ ...done(4), setType: "warm-up" }, done(12), done(12), done(12)];
    expect(progressionCheck(s, RULE, context).verdict).toBe("fired");
  });

  it("a drop with no lighter producible load, or no inventory, has no target", () => {
    const got = progressionCheck([done(8)], RULE, { prescription: { repLow: 10, repHigh: 12 } });
    expect(got).toMatchObject({ autoregulation: { action: "drop", dropTo: null } });
  });
});

describe("progressionCheck: inferred reps", () => {
  // Reps reported in bulk ("done", "as prescribed") were inferred, not counted.
  const RULE: ProgressionRule = { targetSets: 3, repTop: 12, rirTarget: 2, increment: { min: 2.5, max: 5 } };
  const inferred = (reps: number): ProgressionSet => ({ ...done(reps), repsConfirmed: false });

  it("a rule that would fire on inferred reps asks for confirmation instead, naming the load it would move to", () => {
    const got = progressionCheck([done(12), inferred(12), inferred(12)], RULE, { currentLoad: 30, implement: KG_STACK });
    expect(got).toMatchObject({ verdict: "needs_confirmation", reason: "reps_inferred", nextLoad: 32.5 });
    expect(got.message).toContain("sets 2, 3");
  });

  it("once every qualifying set's reps are confirmed, it fires", () => {
    const got = progressionCheck([done(12), done(12), done(12)], RULE, { currentLoad: 30, implement: KG_STACK });
    expect(got.verdict).toBe("fired");
  });

  it("inferred reps that would not fire anyway are just not yet: nothing to confirm", () => {
    const got = progressionCheck([inferred(10), inferred(10), inferred(10)], RULE);
    expect(got).toMatchObject({ verdict: "not_yet", reason: "reps_below_requirement" });
  });

  it("an inferred set beyond the rule's target sets doesn't hold the load back", () => {
    const got = progressionCheck([done(12), done(12), done(12), inferred(12)], RULE);
    expect(got.verdict).toBe("fired");
  });
});
