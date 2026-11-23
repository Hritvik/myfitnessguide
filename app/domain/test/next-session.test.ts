import { describe, expect, it } from "vitest";
import { nextInRotation, nextSession, ROTATION } from "../src/index";
import type { Schedule } from "../src/index";

// Ported from shared/test_gymcalc.py TestNextSession (R16).
describe("nextInRotation (gymcalc next_session port)", () => {
  it("follows the rotation order", () => {
    expect(nextInRotation("Upper A")).toBe("Lower A");
    expect(nextInRotation("Lower A")).toBe("Upper B");
    expect(nextInRotation("Upper B")).toBe("Lower B");
  });

  it("wraps", () => {
    expect(nextInRotation("Lower B")).toBe("Upper A");
  });

  it("throws for a session not in the rotation", () => {
    expect(() => nextInRotation("Arms Day")).toThrow(RangeError);
  });

  it("defaults to Hritvik's four-session rotation", () => {
    expect(ROTATION).toEqual(["Upper A", "Lower A", "Upper B", "Lower B"]);
  });
});

// Handover 15, set 3 Oct 2026: gym on weekdays, dance at weekends, fixed.
const HRITVIK_WEEK: Schedule = {
  kind: "weekday",
  days: { mon: "Lower B", tue: "Upper B", thu: "Lower A", fri: "Upper A", sat: "Dance", sun: "Dance" },
  swaps: [],
};

describe("nextSession", () => {
  it("a rotation follows the last session, ignoring the calendar", () => {
    const schedule: Schedule = { kind: "rotation", order: ["Upper A", "Lower A", "Upper B", "Lower B"] };
    expect(nextSession(schedule, { today: "2026-10-05", last: { session: "Lower A", date: "2026-10-01" } })).toEqual({
      session: "Upper B",
      date: null,
    });
  });

  it("a rotation with nothing logged starts at the top", () => {
    const schedule: Schedule = { kind: "rotation", order: ["Full Body A", "Full Body B"] };
    expect(nextSession(schedule, { today: "2026-10-05", last: null })).toEqual({ session: "Full Body A", date: null });
  });

  it("a weekday plan gives today's session when today has not been trained", () => {
    // Monday 5 Oct 2026, last session Friday 2 Oct.
    expect(nextSession(HRITVIK_WEEK, { today: "2026-10-05", last: { session: "Upper A", date: "2026-10-02" } })).toEqual({
      session: "Lower B",
      date: "2026-10-05",
    });
  });

  it("a weekday plan skips today once today is trained, and skips rest days", () => {
    // Tuesday trained; Wednesday is the full rest day.
    expect(nextSession(HRITVIK_WEEK, { today: "2026-10-06", last: { session: "Upper B", date: "2026-10-06" } })).toEqual({
      session: "Lower A",
      date: "2026-10-08",
    });
  });

  it("a one-off swap replaces that date's session only", () => {
    const swapped: Schedule = { ...HRITVIK_WEEK, swaps: [{ date: "2026-10-05", session: "Lower A" }] };
    expect(nextSession(swapped, { today: "2026-10-05", last: null })).toEqual({ session: "Lower A", date: "2026-10-05" });
    // The following Monday is back to the plan.
    expect(nextSession(swapped, { today: "2026-10-12", last: null })).toEqual({ session: "Lower B", date: "2026-10-12" });
  });

  it("a swap can turn a training day into rest", () => {
    const swapped: Schedule = { ...HRITVIK_WEEK, swaps: [{ date: "2026-10-05", session: null }] };
    expect(nextSession(swapped, { today: "2026-10-05", last: null })).toEqual({ session: "Upper B", date: "2026-10-06" });
  });

  it("a weekday plan with no training days has no next session", () => {
    expect(nextSession({ kind: "weekday", days: {}, swaps: [] }, { today: "2026-10-05", last: null })).toBeNull();
  });
});
