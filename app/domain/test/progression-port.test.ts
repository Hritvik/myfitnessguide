import { describe, expect, it } from "vitest";
import { parseRir, progressionCheck } from "../src/index";
import type { ProgressionResult, ProgressionRule, ProgressionSet } from "../src/index";

/**
 * gymcalc returned "eligible" / "needs_confirmation" / "not_yet". The port
 * returns a richer result; this maps it back so each gymcalc assertion is
 * ported verbatim.
 */
function legacy(result: ProgressionResult): string {
  if (result.verdict === "fired") return "eligible";
  return result.verdict;
}

function sets(count: number, reps: number | null, rir: string | number | null, repsConfirmed = true): ProgressionSet[] {
  return Array.from({ length: count }, () => ({ reps, rir: parseRir(rir), repsConfirmed }));
}

// Ported from shared/test_gymcalc.py TestProgressionCheck (R3).
describe("progressionCheck (gymcalc port)", () => {
  const CABLE_ROW: ProgressionRule = { targetSets: 3, repTop: 12, rirTarget: 2 };
  const INCLINE: ProgressionRule = { targetSets: 4, repTop: 10, rirTarget: 2 };

  it("eligible when confirmed at the top of the range", () => {
    expect(legacy(progressionCheck(sets(3, 12, 2), CABLE_ROW))).toBe("eligible");
  });

  it("needs confirmation when reps are unconfirmed", () => {
    expect(legacy(progressionCheck(sets(3, 12, 2, false), CABLE_ROW))).toBe("needs_confirmation");
  });

  it("not yet when too few sets", () => {
    expect(legacy(progressionCheck(sets(3, 8, 2), INCLINE))).toBe("not_yet");
  });

  it("not yet when below the rep top", () => {
    expect(legacy(progressionCheck(sets(3, 10, 2), CABLE_ROW))).toBe("not_yet");
  });

  it("eligible when RIR is above the cap: reps in reserve at the rep cap is the signal to add load", () => {
    expect(legacy(progressionCheck(sets(3, 12, 4), CABLE_ROW))).toBe("eligible");
  });

  it("a RIR range string is read at its easier end ('1-2' clears a target of 2)", () => {
    expect(legacy(progressionCheck(sets(3, 12, "1-2"), CABLE_ROW))).toBe("eligible");
  });

  it("a RIR range well above the cap still fires", () => {
    expect(legacy(progressionCheck(sets(3, 12, "3-4"), CABLE_ROW))).toBe("eligible");
  });

  it("not yet when ground out at failure", () => {
    expect(legacy(progressionCheck(sets(3, 12, 0), CABLE_ROW))).toBe("not_yet");
  });

  it("not yet when one set of three was ground out", () => {
    const s = [...sets(2, 12, 2), ...sets(1, 12, 0)];
    expect(legacy(progressionCheck(s, CABLE_ROW))).toBe("not_yet");
  });

  it("missing RIR is not yet", () => {
    expect(legacy(progressionCheck(sets(3, 12, null), CABLE_ROW))).toBe("not_yet");
  });

  it("missing reps is not yet", () => {
    expect(legacy(progressionCheck(sets(1, null, null, false), CABLE_ROW))).toBe("not_yet");
  });

  it("extra sets are still eligible", () => {
    expect(legacy(progressionCheck(sets(4, 12, 2), CABLE_ROW))).toBe("eligible");
  });
});

// Ported from shared/test_gymcalc.py TestProgressionCheckSetTypes. 23 Sep hip
// thrust: three warm-ups logged ahead of the working sets.
describe("progressionCheck set types (gymcalc port)", () => {
  const RULE: ProgressionRule = { targetSets: 2, repTop: 10, rirTarget: 2 };

  it("warm-ups cannot satisfy the rule", () => {
    const s: ProgressionSet[] = [
      ...sets(3, 12, 2).map((x) => ({ ...x, setType: "warm-up" as const })),
      ...sets(2, 8, "1-2").map((x) => ({ ...x, setType: "working" as const })),
    ];
    expect(legacy(progressionCheck(s, RULE))).toBe("not_yet");
  });

  it("warm-ups cannot spoil the rule", () => {
    const s: ProgressionSet[] = [
      ...sets(3, 12, 4).map((x) => ({ ...x, setType: "warm-up" as const })),
      ...sets(2, 10, 2),
    ];
    expect(legacy(progressionCheck(s, RULE))).toBe("eligible");
  });

  it("a blank set type is working", () => {
    const s = sets(2, 10, 2).map((x) => ({ ...x, setType: "" as const }));
    expect(legacy(progressionCheck(s, RULE))).toBe("eligible");
  });

  it("calibration and substitution sets do not count", () => {
    for (const kind of ["calibration", "substitution"] as const) {
      const s = sets(2, 10, 2).map((x) => ({ ...x, setType: kind }));
      expect(legacy(progressionCheck(s, RULE)), kind).toBe("not_yet");
    }
  });

  it("an unknown set type throws", () => {
    const s = sets(2, 10, 2).map((x) => ({ ...x, setType: "drop" as unknown as "working" }));
    expect(() => progressionCheck(s, RULE)).toThrow(RangeError);
  });
});

describe("parseRir: reading reported RIR text", () => {
  it("reads a number, a range and an open-ended value", () => {
    expect(parseRir(2)).toEqual({ low: 2, high: 2 });
    expect(parseRir("1-2")).toEqual({ low: 1, high: 2 });
    expect(parseRir("4+")).toEqual({ low: 4, high: 4 });
  });

  it("blank is null", () => {
    expect(parseRir(null)).toBeNull();
    expect(parseRir("")).toBeNull();
  });

  it("unreadable text and Sheets date serials are null, not a huge RIR", () => {
    // 46024 is a Sheets date serial left where '1-2' was typed (import hazard 35).
    expect(parseRir("46024")).toBeNull();
    expect(parseRir("lots")).toBeNull();
  });
});
