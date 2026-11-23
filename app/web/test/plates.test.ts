import { describe, expect, it } from "vitest";
import { MAX_DRAWN, plateLayout } from "../src/plates";
import { loadText } from "../src/format";

describe("plateLayout", () => {
  it("draws the bar, then each plate labelled in its own unit, with mixed units", () => {
    const layout = plateLayout({ value: 12.27, unit: "kg", basis: "per_side", bar: { value: 20, unit: "kg" }, plates: [{ value: 10, unit: "kg", count: 1 }, { value: 5, unit: "lb", count: 1 }] });
    expect(layout).toEqual({
      bar: "20 kg bar",
      plates: [{ label: "10 kg", unit: "kg", value: 10, height: 0.76 }, { label: "5 lb", unit: "lb", value: 5, height: 0.5 }],
      hidden: 0,
      text: "20 kg bar + 10 kg + 5 lb a side",
    });
  });

  it("draws each plate of a count, and at most MAX_DRAWN, saying how many more", () => {
    const layout = plateLayout({ value: 130, unit: "kg", basis: "per_side", bar: null, plates: [{ value: 20, unit: "kg", count: 6 }, { value: 2.5, unit: "kg", count: 4 }] });
    expect(layout?.plates).toHaveLength(MAX_DRAWN);
    expect(layout?.hidden).toBe(10 - MAX_DRAWN);
    expect(layout?.plates.map((p) => p.label).slice(5, 8)).toEqual(["20 kg", "2.5 kg", "2.5 kg"]);
    expect(layout?.text).toBe("6 × 20 kg + 4 × 2.5 kg a side");
  });

  it("is null for a value with no plates (a stack, a dumbbell, a per-side value)", () => {
    expect(plateLayout({ value: 40, unit: "kg", basis: "total", bar: null, plates: null })).toBeNull();
    expect(plateLayout({ value: 12.5, unit: "lb", basis: "per_side", bar: null, plates: null })).toBeNull();
  });

  it("an odd plate gets a middling height; an assisted load reads as assistance", () => {
    expect(plateLayout({ value: 7.5, unit: "kg", basis: "per_side", bar: null, plates: [{ value: 7.5, unit: "kg", count: 1 }] })?.plates[0]?.height).toBe(0.45);
    expect(loadText({ value: -20, unit: "kg", basis: "total", bar: null, plates: null })).toBe("20 kg assistance");
  });
});
