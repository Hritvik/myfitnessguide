import { describe, expect, it } from "vitest";
import { implausibleReading, READING_BOUNDS, READING_RATIO } from "../src/index";

// Click test P1-2: a 700 kg weight and a 94 in (238.8 cm) waist were logged without a word.
describe("implausibleReading: bounds per metric, in canonical units", () => {
  it("a body weight of 700 kg is outside the range a body weight can be", () => {
    expect(implausibleReading("weight", 700, 70)).toEqual({ kind: "out_of_range", low: READING_BOUNDS.weight!.low, high: READING_BOUNDS.weight!.high });
    expect(implausibleReading("weight", 70.4, 70)).toBeNull();
  });

  it("a waist of 238.8 cm (94 typed in inches) is out of range before it is far from the last", () => {
    expect(implausibleReading("waist_navel", 238.76, 96)).toMatchObject({ kind: "out_of_range" });
  });

  it("an in-range value far from the last reading of a weight, height or circumference is asked about", () => {
    expect(READING_RATIO).toBe(1.25);
    // 94 lb entered as kg would be in range for some people; against a last 42.6 kg it is 2.2 times.
    expect(implausibleReading("weight", 94, 42.6)).toEqual({ kind: "far_from_last", previous: 42.6, ratio: 94 / 42.6 });
    expect(implausibleReading("arm", 14 * 2.54, 14)).toMatchObject({ kind: "far_from_last" });
    expect(implausibleReading("waist_navel", 80, 96)).toBeNull();
    // Below the last by as much counts too.
    expect(implausibleReading("waist_navel", 70, 96)).toMatchObject({ kind: "far_from_last" });
  });

  it("no last reading: the bounds alone", () => {
    expect(implausibleReading("weight", 150, null)).toBeNull();
    expect(implausibleReading("weight", 10, null)).toMatchObject({ kind: "out_of_range" });
  });

  it("skinfolds, BIA, blood pressure, heart rate and sleep have bounds but no last-reading check (they move a lot)", () => {
    expect(implausibleReading("bp_systolic", 150, 110)).toBeNull();
    expect(implausibleReading("bp_systolic", 400, null)).toMatchObject({ kind: "out_of_range" });
    expect(implausibleReading("skinfold_abdomen", 3, 1.2)).toBeNull();
    expect(implausibleReading("bia_body_fat_pct", 95, null)).toMatchObject({ kind: "out_of_range" });
    expect(implausibleReading("sleep", 30, null)).toMatchObject({ kind: "out_of_range" });
  });

  it("every metric the app offers has bounds, and a metric with none is never asked about", () => {
    for (const m of ["weight", "height", "waist_navel", "abdomen_widest", "shoulders", "chest", "arm", "thigh", "hips", "neck", "skinfold_chest", "skinfold_abdomen", "skinfold_thigh", "bp_systolic", "bp_diastolic", "resting_hr", "sleep", "bia_skeletal_muscle_mass", "bia_body_fat_mass", "bia_body_fat_pct", "bia_fat_free_mass", "bia_visceral_fat"]) {
      const b = READING_BOUNDS[m];
      expect(b, m).toBeDefined();
      expect(b!.low).toBeLessThan(b!.high);
    }
    expect(implausibleReading("something_new", 1e6, 1)).toBeNull();
  });
});
