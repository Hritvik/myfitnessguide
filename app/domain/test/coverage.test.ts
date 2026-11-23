import { describe, expect, it } from "vitest";
import { checkWeekday, fallbackCoverage, neverPerformedGaps } from "../src/index";
import type { GapPrescription } from "../src/index";

// Handover 13 (3)-(4): an ordinary skip is not made up; an exercise never
// performed since it was prescribed is a GAP, carried forward until done.
describe("neverPerformedGaps", () => {
  const prescriptions: GapPrescription[] = [
    { id: "p-crunch", exerciseId: "reverse-crunch-ankle", prescribedOn: "2026-09-16", template: "Lower B" },
    { id: "p-hack", exerciseId: "hack-squat", prescribedOn: "2026-08-01", template: "Lower A" },
    { id: "p-hang", exerciseId: "dead-hang", prescribedOn: "2026-09-01", template: "Upper B" },
  ];

  it("an exercise never performed since it was prescribed is a gap", () => {
    const performed = [
      { exerciseId: "hack-squat", date: "2026-09-24" },
      { exerciseId: "dead-hang", date: "2026-09-30" },
    ];
    expect(neverPerformedGaps(prescriptions, performed).map((p) => p.id)).toEqual(["p-crunch"]);
  });

  it("an ordinary skip of something performed before is not carried", () => {
    // Hack squat done once in August, skipped since: not a gap.
    const performed = [{ exerciseId: "hack-squat", date: "2026-08-10" }];
    const ids = neverPerformedGaps(prescriptions, performed).map((p) => p.id);
    expect(ids).not.toContain("p-hack");
  });

  it("performing it before it was prescribed does not count", () => {
    const performed = [{ exerciseId: "reverse-crunch-ankle", date: "2026-09-01" }];
    expect(neverPerformedGaps(prescriptions, performed).map((p) => p.id)).toContain("p-crunch");
  });

  it("gaps come oldest first", () => {
    expect(neverPerformedGaps(prescriptions, []).map((p) => p.id)).toEqual(["p-hack", "p-hang", "p-crunch"]);
  });
});

// Handover 13 (2): a fallback counts as coverage only when it delivers the
// same stimulus type.
describe("fallbackCoverage", () => {
  it("matching stimulus tags count as coverage", () => {
    expect(
      fallbackCoverage(
        { mechanics: "isolation", position: "lengthened" },
        { mechanics: "isolation", position: "lengthened" },
      ),
    ).toEqual({ covered: true, mismatches: [] });
  });

  it("a compound does not replace an isolation", () => {
    expect(
      fallbackCoverage(
        { mechanics: "isolation", position: "lengthened" },
        { mechanics: "compound", position: "lengthened" },
      ),
    ).toEqual({ covered: false, mismatches: ["mechanics"] });
  });

  it("a shortened-position lift does not replace a lengthened one", () => {
    expect(
      fallbackCoverage({ mechanics: "isolation", position: "lengthened" }, { mechanics: "isolation", position: "shortened" }),
    ).toEqual({ covered: false, mismatches: ["position"] });
  });

  it("a missing tag on either side is not coverage", () => {
    expect(fallbackCoverage({ mechanics: "isolation", position: "lengthened" }, { mechanics: "isolation" })).toEqual({
      covered: false,
      mismatches: ["position"],
    });
  });
});

// Handover 16 p3 (3): "8 Oct" was written for a Wednesday drift test, but
// 8 Oct 2026 is a Thursday.
describe("checkWeekday", () => {
  it("a stated weekday that matches the date is consistent", () => {
    expect(checkWeekday("2026-10-07", "wed")).toEqual({ consistent: true, actual: "wed" });
  });

  it("a stated weekday that does not match is caught", () => {
    expect(checkWeekday("2026-10-08", "wed")).toEqual({ consistent: false, actual: "thu" });
  });
});
