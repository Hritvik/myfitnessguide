import { describe, expect, it } from "vitest";
import { clamp, dateScale, dateTicks, dayIndex, extent, linePath, linear, niceTicks, plot } from "../src/charts/scale";

describe("linear", () => {
  it("maps the domain onto the range, inverted for SVG's downward y", () => {
    const y = linear([0.48, 0.56], [100, 0]);
    expect(y(0.48)).toBe(100);
    expect(y(0.56)).toBeCloseTo(0, 9);
    expect(y(0.52)).toBeCloseTo(50, 9);
  });

  it("puts every value in the middle when the domain has no span, never NaN", () => {
    expect(linear([5, 5], [0, 100])(5)).toBe(50);
    expect(Number.isFinite(linear([5, 5], [0, 100])(999))).toBe(true);
  });

  it("clamps out-of-domain values to the range when clamped=true", () => {
    const y = linear([0.48, 0.56], [100, 0], true);
    expect(y(0.40)).toBe(100); // below domain, clamps to range start
    expect(y(0.60)).toBe(0);   // above domain, clamps to range end
    expect(y(0.52)).toBeCloseTo(50, 9); // inside domain, unchanged

    // Inverted range: range [0, 100]
    const y2 = linear([0.48, 0.56], [0, 100], true);
    expect(y2(0.40)).toBe(0);   // below domain, clamps to range start
    expect(y2(0.60)).toBe(100); // above domain, clamps to range end
  });

  it("extrapolates by default (clamped omitted)", () => {
    const y = linear([0.48, 0.56], [100, 0]);
    expect(y(0.40)).toBeCloseTo(200, 9); // extrapolates beyond range
    expect(y(0.60)).toBeCloseTo(-50, 9);
  });
});

describe("extent", () => {
  it("pads a span, and opens a single value or identical values around themselves", () => {
    expect(extent([1, 3], 0.25)).toEqual([0.5, 3.5]);
    expect(extent([0.52])).toEqual([0.494, 0.546]);
    expect(extent([80, 80])).toEqual([76, 84]);
    expect(extent([0, 0])).toEqual([-1, 1]);
    expect(extent([])).toBeNull();
  });
});

describe("niceTicks", () => {
  it("steps by 1, 2, 2.5 or 5 times a power of ten, inside the span, without float noise", () => {
    expect(niceTicks(0.48, 0.56, 4)).toEqual([0.48, 0.5, 0.52, 0.54, 0.56]);
    expect(niceTicks(76.2, 81.9, 4)).toEqual([78, 80]);
    expect(niceTicks(0, 100, 4)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(5, 5)).toEqual([5]);
  });
});

describe("dates", () => {
  it("scales dates by day and keeps a single day in the middle", () => {
    const x = dateScale("2026-09-01", "2026-09-11", [0, 100]);
    expect(x("2026-09-01")).toBe(0);
    expect(x("2026-09-06")).toBe(50);
    expect(x("2026-09-11")).toBe(100);
    expect(dateScale("2026-09-01", "2026-09-01", [0, 100])("2026-09-01")).toBe(50);
    expect(Number.isFinite(dateScale("2026-09-01", "2026-09-01", [0, 100])("2026-09-15"))).toBe(true);
    expect(dayIndex("1970-01-02")).toBe(1);
  });

  it("clamps out-of-span dates to the range when clamped=true", () => {
    const x = dateScale("2026-09-01", "2026-09-11", [0, 100], true);
    expect(x("2026-08-25")).toBe(0);    // before span, clamps to range start
    expect(x("2026-09-20")).toBe(100);  // after span, clamps to range end
    expect(x("2026-09-06")).toBe(50);   // inside span, unchanged
  });

  it("extrapolates dates by default (clamped omitted)", () => {
    const x = dateScale("2026-09-01", "2026-09-11", [0, 100]);
    expect(x("2026-08-25")).toBeCloseTo(-70, 9); // before span, extrapolates (7 days before start)
    expect(x("2026-09-20")).toBeCloseTo(190, 9);  // after span, extrapolates (19 days from start)
  });

  it("spreads date ticks evenly, without repeats", () => {
    expect(dateTicks("2026-09-01", "2026-09-28", 4)).toEqual(["2026-09-01", "2026-09-10", "2026-09-19", "2026-09-28"]);
    expect(dateTicks("2026-09-01", "2026-09-02", 4)).toEqual(["2026-09-01", "2026-09-02"]);
    expect(dateTicks("2026-09-01", "2026-09-01", 4)).toEqual(["2026-09-01"]);
  });
});

describe("drawing", () => {
  it("clamps a mark outside the axis to its edge, whichever way the range runs", () => {
    expect(clamp(120, 0, 100)).toBe(100);
    expect(clamp(-5, 100, 0)).toBe(0);
  });

  it("writes a path, and gives a plot area inside its margins", () => {
    expect(linePath([{ x: 0, y: 10 }, { x: 20.04, y: 5.56 }])).toBe("M0.0 10.0 L20.0 5.6");
    expect(linePath([])).toBe("");
    expect(plot(320, 160)).toEqual({ width: 320, height: 160, left: 40, right: 308, top: 12, bottom: 132 });
  });
});
