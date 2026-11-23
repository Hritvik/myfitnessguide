import { describe, expect, it } from "vitest";
import { addDays, isIsoDate } from "../src/dates";

describe("dates", () => {
  it("steps across month and year ends", () => {
    expect(addDays("2026-10-01", -1)).toBe("2026-09-30");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-10-04", 7)).toBe("2026-10-11");
  });

  it("accepts only real calendar dates", () => {
    expect(isIsoDate("2026-09-28")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("28-09-2026")).toBe(false);
    expect(isIsoDate(null)).toBe(false);
  });
});
