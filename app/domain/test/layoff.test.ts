import { describe, expect, it } from "vitest";
import { layoffPolicy } from "../src/index";

// Ported from shared/test_gymcalc.py TestLayoffPolicy.
describe("layoffPolicy (gymcalc port)", () => {
  it("an active week is normal", () => {
    expect(layoffPolicy(3, 8)).toBe("normal");
  });

  it("a stale session in an active week holds", () => {
    // 23 Sep: legs trained 8 days earlier, Lower B not run for 43.
    expect(layoffPolicy(7, 43)).toBe("hold");
  });

  it("one to three weeks off holds", () => {
    expect(layoffPolicy(10, 10)).toBe("hold");
    expect(layoffPolicy(21, 30)).toBe("hold");
  });

  it("over three weeks off backs off", () => {
    expect(layoffPolicy(22, 22)).toBe("back_off");
  });

  it("a never-run session is calibration, not a layoff", () => {
    expect(layoffPolicy(2, null)).toBe("normal");
  });

  it("a negative gap throws", () => {
    expect(() => layoffPolicy(-1, 3)).toThrow(RangeError);
  });
});
