import { describe, expect, it } from "vitest";
import { WEEK1_ANCHOR, weekOf } from "../src/index";

// Ported from shared/test_gymcalc.py TestWeekOf. Fixtures are the Week
// column of real Log and Body rows.
describe("weekOf (gymcalc port)", () => {
  it("programme starts at week one", () => {
    expect(weekOf("2026-07-26")).toBe(1);
  });

  it("first session is week one", () => {
    expect(weekOf("2026-07-27")).toBe(1);
  });

  it("Lower A 3 Aug is week two", () => {
    expect(weekOf("2026-08-03")).toBe(2);
  });

  it("Upper B 6 Aug is week two", () => {
    expect(weekOf("2026-08-06")).toBe(2);
  });

  it("Upper A 12 Aug is week three", () => {
    expect(weekOf("2026-08-12")).toBe(3);
  });

  it("14 Aug is still week three", () => {
    expect(weekOf("2026-08-14")).toBe(3);
  });

  it("16 Aug (a Sunday) rolls to week four", () => {
    expect(weekOf("2026-08-16")).toBe(4);
  });

  it("Lower A 15 Sep is week eight", () => {
    expect(weekOf("2026-09-15")).toBe(8);
  });

  it("Saturday 19 Sep is still week eight", () => {
    expect(weekOf("2026-09-19")).toBe(8);
  });

  it("Sunday 20 Sep rolls to week nine", () => {
    expect(weekOf("2026-09-20")).toBe(9);
  });

  // gymcalc's test_accepts_iso_string: every date in the domain is an ISO
  // string, so this is the only form; the Date overload has no equivalent.
  it("accepts an ISO string", () => {
    expect(weekOf("2026-09-15")).toBe(8);
  });

  it("throws for a date before the anchor", () => {
    expect(() => weekOf("2026-07-25")).toThrow(RangeError);
  });

  it("takes a per-person anchor", () => {
    expect(WEEK1_ANCHOR).toBe("2026-07-26");
    expect(weekOf("2026-10-05", "2026-09-28")).toBe(2);
  });

  it("rejects a malformed date", () => {
    expect(() => weekOf("2026-13-01")).toThrow(RangeError);
    expect(() => weekOf("5 Oct")).toThrow(RangeError);
  });
});
