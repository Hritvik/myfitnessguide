import { describe, expect, it } from "vitest";
import {
  energyAvailability,
  goalVerdict,
  isRealChange,
  sevenDayAverage,
  trendSegments,
  waistToHeight,
} from "../src/index";
import type { BodyReading } from "../src/index";

describe("sevenDayAverage: fasted readings from date-6 to date", () => {
  const readings: BodyReading[] = [
    { date: "2026-09-28", value: 71.0, fasted: true }, // date-7: outside
    { date: "2026-09-29", value: 70.6, fasted: true }, // date-6: inside
    { date: "2026-10-01", value: 70.4, fasted: true },
    { date: "2026-10-02", value: 72.1, fasted: false }, // not fasted: never averaged
    { date: "2026-10-05", value: 70.2, fasted: true }, // the date itself
    { date: "2026-10-06", value: 69.0, fasted: true }, // after: outside
  ];

  it("averages only fasted readings inside the window, ends included", () => {
    expect(sevenDayAverage(readings, "2026-10-05")).toBeCloseTo((70.6 + 70.4 + 70.2) / 3, 9);
  });

  it("is null when the window has no fasted reading", () => {
    expect(sevenDayAverage(readings, "2026-09-20")).toBeNull();
  });

  it("does not average across a method change", () => {
    expect(sevenDayAverage(readings, "2026-10-05", ["2026-10-01"])).toBeCloseTo((70.4 + 70.2) / 2, 9);
  });
});

describe("waistToHeight", () => {
  it("uses stored height, not a hard-coded 165", () => {
    expect(waistToHeight(95.3, 165)).toBeCloseTo(0.5776, 4);
    expect(waistToHeight(82.5, 165)).toBeCloseTo(0.5, 9);
    expect(waistToHeight(80, 160)).toBe(0.5);
  });
});

describe("isRealChange: a change within one resolution step is not a change", () => {
  it("neck 38.1 to 39.37 cm, taken in half inches, is one tick: not a change", () => {
    expect(isRealChange(38.1, 39.37, 1.27)).toBe(false);
  });

  it("more than one step is a change", () => {
    expect(isRealChange(38.1, 40.64, 1.27)).toBe(true);
  });

  it("works downward too", () => {
    expect(isRealChange(95.3, 94.9, 0.5)).toBe(false);
    expect(isRealChange(95.3, 94.0, 0.5)).toBe(true);
  });
});

describe("trendSegments: a method change splits the series", () => {
  it("readings before and after a method change are separate segments", () => {
    const readings: BodyReading[] = [
      { date: "2026-10-09", value: 150 },
      { date: "2026-09-30", value: 160 },
      { date: "2026-10-07", value: 140 },
      { date: "2026-10-02", value: 158 },
    ];
    // Polar H10 from 7 Oct: wrist optical HR before that is not comparable.
    expect(trendSegments(readings, ["2026-10-07"])).toEqual([
      [
        { date: "2026-09-30", value: 160 },
        { date: "2026-10-02", value: 158 },
      ],
      [
        { date: "2026-10-07", value: 140 },
        { date: "2026-10-09", value: 150 },
      ],
    ]);
  });

  it("no method change is one segment; an empty segment is dropped", () => {
    const readings: BodyReading[] = [{ date: "2026-10-01", value: 1 }];
    expect(trendSegments(readings, [])).toEqual([readings]);
    expect(trendSegments(readings, ["2026-09-01", "2026-12-01"])).toEqual([readings]);
  });
});

describe("energyAvailability: (intake - exercise kcal) / fat-free mass", () => {
  it("flags below 25 kcal/kg FFM (Handover 16 p6b: 21 on a lifting day)", () => {
    const got = energyAvailability({ intakeKcal: 1550, exerciseKcal: 477, ffmKg: 51.1 });
    expect(got.value).toBeCloseTo(20.998, 3);
    expect(got.low).toBe(true);
  });

  it("26 on a double Zone 2 day is not flagged", () => {
    const got = energyAvailability({ intakeKcal: 1550, exerciseKcal: 221.4, ffmKg: 51.1 });
    expect(got.value).toBeCloseTo(26, 3);
    expect(got.low).toBe(false);
  });

  it("exactly 25 is not below 25", () => {
    expect(energyAvailability({ intakeKcal: 1500, exerciseKcal: 250, ffmKg: 50 }).low).toBe(false);
  });

  it("rejects a non-positive fat-free mass", () => {
    expect(() => energyAvailability({ intakeKcal: 1500, exerciseKcal: 0, ffmKg: 0 })).toThrow(RangeError);
  });
});

describe("goalVerdict: waist against the week's goal point, no interpolation", () => {
  // Weekly goal points, Sundays, waist going down.
  const goals = [
    { date: "2026-09-13", value: 94.0 },
    { date: "2026-09-20", value: 93.5 },
    { date: "2026-09-27", value: 93.0 },
    { date: "2026-10-04", value: 92.5 },
  ];

  it("asOf judges the week holding that date: no reading that week, however recent the last one", () => {
    const got = goalVerdict([{ date: "2026-09-29", value: 93.1 }], goals, { direction: "decrease", asOf: "2026-10-05" });
    expect(got).toEqual({ verdict: "no_reading", week: "2026-10-04", reading: null, goal: 92.5, deviation: null, weeksBehind: 0 });
  });

  it("asOf says no goal point when that week has none, with the week's reading", () => {
    const got = goalVerdict([{ date: "2026-10-12", value: 92.0 }], goals, { direction: "decrease", asOf: "2026-10-12" });
    expect(got).toEqual({ verdict: "no_goal_point", week: "2026-10-11", reading: 92.0, goal: null, deviation: null, weeksBehind: 0 });
  });

  it("of two readings on one day, judges the later one, the one a chart shows last (click test P2-23)", () => {
    const got = goalVerdict([{ date: "2026-10-05", value: 92.4 }, { date: "2026-10-05", value: 95.0 }], goals, { direction: "decrease", asOf: "2026-10-06" });
    expect(got).toMatchObject({ week: "2026-10-04", reading: 95.0, goal: 92.5 });
  });

  it("asOf ignores readings after it, and counts weeks behind back from its week", () => {
    const got = goalVerdict(
      [
        { date: "2026-09-21", value: 95.0 },
        { date: "2026-09-29", value: 94.2 },
        { date: "2026-10-05", value: 94.0 },
        { date: "2026-10-06", value: 90.0 },
      ],
      goals,
      { direction: "decrease", asOf: "2026-10-05" },
    );
    expect(got).toMatchObject({ verdict: "behind", week: "2026-10-04", reading: 94.0, weeksBehind: 3 });
  });

  it("without asOf, judges the latest week with a reading, as before", () => {
    expect(goalVerdict([{ date: "2026-09-29", value: 93.1 }], goals, { direction: "decrease" })).toMatchObject({ verdict: "on_track", week: "2026-09-27" });
  });

  it("within 1.0 cm of the week's goal point is on track", () => {
    const got = goalVerdict([{ date: "2026-10-05", value: 93.4 }], goals, { direction: "decrease" });
    expect(got).toMatchObject({ verdict: "on_track", goal: 92.5, reading: 93.4, weeksBehind: 0 });
    expect(got.deviation).toBeCloseTo(0.9, 9);
  });

  it("outside the band for fewer than three consecutive weeks is still on track", () => {
    const got = goalVerdict(
      [
        { date: "2026-09-29", value: 94.2 },
        { date: "2026-10-05", value: 94.0 },
      ],
      goals,
      { direction: "decrease" },
    );
    expect(got).toMatchObject({ verdict: "on_track", weeksBehind: 2 });
  });

  it("behind only after three consecutive weekly readings outside the band", () => {
    const got = goalVerdict(
      [
        { date: "2026-09-21", value: 95.0 },
        { date: "2026-09-29", value: 94.2 },
        { date: "2026-10-05", value: 94.0 },
      ],
      goals,
      { direction: "decrease" },
    );
    expect(got).toMatchObject({ verdict: "behind", weeksBehind: 3 });
  });

  it("a missing week breaks the run", () => {
    const got = goalVerdict(
      [
        { date: "2026-09-14", value: 95.5 },
        { date: "2026-09-29", value: 94.2 },
        { date: "2026-10-05", value: 94.0 },
      ],
      goals,
      { direction: "decrease" },
    );
    expect(got).toMatchObject({ verdict: "on_track", weeksBehind: 2 });
  });

  it("uses the latest reading in a week", () => {
    const got = goalVerdict(
      [
        { date: "2026-10-05", value: 95.0 },
        { date: "2026-10-08", value: 93.0 },
      ],
      goals,
      { direction: "decrease" },
    );
    expect(got).toMatchObject({ verdict: "on_track", reading: 93.0 });
  });

  it("more than 1.0 cm the good side of the goal is ahead, at once", () => {
    expect(goalVerdict([{ date: "2026-10-05", value: 91.0 }], goals, { direction: "decrease" }).verdict).toBe("ahead");
  });

  it("a week with no goal point gets no verdict rather than an interpolated one", () => {
    expect(goalVerdict([{ date: "2026-10-12", value: 92.0 }], goals, { direction: "decrease" })).toMatchObject({
      verdict: "no_goal_point",
    });
  });

  it("no reading, no verdict", () => {
    expect(goalVerdict([], goals, { direction: "decrease" }).verdict).toBe("no_reading");
  });

  it("an increasing goal is behind when below the band", () => {
    const up = [
      { date: "2026-09-20", value: 50 },
      { date: "2026-09-27", value: 52 },
      { date: "2026-10-04", value: 54 },
    ];
    const got = goalVerdict(
      [
        { date: "2026-09-21", value: 47 },
        { date: "2026-09-28", value: 49 },
        { date: "2026-10-05", value: 50 },
      ],
      up,
      { direction: "increase", band: 2.5 },
    );
    expect(got).toMatchObject({ verdict: "behind", weeksBehind: 3 });
  });
});
