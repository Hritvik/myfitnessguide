import { describe, expect, it } from "vitest";
import { implausibleLoad } from "../src/index";

// Guide 111: question the UNIT before the effort. A mis-entered unit is the
// usual cause of a load that jumps far from the exercise's history.
const HISTORY = [
  { date: "2026-09-22", totalKg: 30 },
  { date: "2026-09-29", totalKg: 32.5 },
  { date: "2026-09-29", totalKg: 30 },
];

describe("implausibleLoad: warning against the exercise's history", () => {
  it("an ordinary progression is plausible", () => {
    expect(implausibleLoad(35, HISTORY)).toBeNull();
    expect(implausibleLoad(27.5, HISTORY)).toBeNull();
  });

  it("no history means nothing to compare against", () => {
    expect(implausibleLoad(200, [])).toBeNull();
  });

  it("pounds entered as kilos are flagged as a likely unit error", () => {
    // 32.5 kg is 71.6 lb; logging "71.6" as kg.
    const got = implausibleLoad(71.6, HISTORY);
    expect(got).not.toBeNull();
    expect(got?.likelyCause).toBe("lb_entered_as_kg");
    expect(got?.referenceKg).toBe(32.5);
  });

  it("kilos entered as pounds are flagged the other way", () => {
    const got = implausibleLoad(32.5 * 0.45359237, HISTORY);
    expect(got?.likelyCause).toBe("kg_entered_as_lb");
  });

  it("a doubled load suggests a per-side or per-hand value entered as total", () => {
    expect(implausibleLoad(65, HISTORY)?.likelyCause).toBe("basis_doubled");
    expect(implausibleLoad(16.25, HISTORY)?.likelyCause).toBe("basis_halved");
  });

  it("a big jump with no recognisable cause is still flagged", () => {
    const got = implausibleLoad(60, HISTORY);
    expect(got?.likelyCause).toBe("unknown");
    expect(got?.ratio).toBeCloseTo(60 / 32.5, 6);
  });

  it("compares against the most recent session's heaviest set", () => {
    const history = [
      { date: "2026-08-01", totalKg: 10 },
      { date: "2026-09-29", totalKg: 30 },
    ];
    expect(implausibleLoad(30, history)).toBeNull();
  });

  it("assisted loads compare by size of assistance", () => {
    expect(implausibleLoad(-50, [{ date: "2026-09-28", totalKg: -56 }])).toBeNull();
    expect(implausibleLoad(-123.5, [{ date: "2026-09-28", totalKg: -56 }])?.likelyCause).toBe("lb_entered_as_kg");
  });
});
