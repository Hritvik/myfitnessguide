import { describe, expect, it } from "vitest";
import { e1rm, volume } from "../src/index";

// Ported from shared/test_gymcalc.py TestE1RM. Fixtures are real Log rows.
describe("e1rm (Epley, gymcalc port)", () => {
  it("bench press 12 Aug from the true load", () => {
    // 20 kg bar + 12.5 lb per side is 31.3398 kg; Epley gives the 39.7 shown.
    expect(e1rm(31.3398, 8)).toBe(39.7);
  });

  it("bench press 12 Aug from the displayed load gives 39.6, not 39.7", () => {
    // Callers must pass the TRUE load, not the rounded display value.
    expect(e1rm(31.3, 8)).toBe(39.6);
  });

  it("incline press 6 Aug", () => {
    expect(e1rm(29.1, 8)).toBe(36.9);
  });

  it("rear delt fly 6 Aug", () => {
    expect(e1rm(10, 15)).toBe(15.0);
  });

  it("leg press 3 Aug", () => {
    expect(e1rm(50, 12)).toBe(70.0);
  });

  it("seated leg curl 3 Aug", () => {
    expect(e1rm(32, 12)).toBe(44.8);
  });

  it("rear delt fly 20 reps rounds from 16.666...", () => {
    expect(e1rm(10, 20)).toBe(16.7);
  });

  it("is blank for assisted lifts", () => {
    expect(e1rm(null, 8)).toBeNull();
    expect(e1rm(56, null)).toBeNull();
  });
});

// Ported from shared/test_gymcalc.py TestVolume.
describe("volume (gymcalc port)", () => {
  it("bench press 12 Aug", () => {
    expect(volume(31.3, 8)).toBe(250.4);
  });

  it("cable row 6 Aug", () => {
    expect(volume(30, 12)).toBe(360.0);
  });

  it("lateral raise 6 Aug", () => {
    expect(volume(4.6, 15)).toBe(69.0);
  });

  it("rear delt 20 reps", () => {
    expect(volume(10, 20)).toBe(200.0);
  });

  it("is blank for assisted lifts", () => {
    expect(volume(null, 8)).toBeNull();
    expect(volume(56, null)).toBeNull();
  });
});
