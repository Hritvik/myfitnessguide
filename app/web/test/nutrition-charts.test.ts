import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CostChart, FoodCost, costGeometry } from "../src/charts/CostChart";
import { DailyChart, dailyGeometry } from "../src/charts/DailyChart";
import { SplitChart, splitGeometry } from "../src/charts/SplitChart";
import type { CostModel, DailyChartModel, SplitModel } from "../src/nutrition";

const daily: DailyChartModel = {
  key: "kcal",
  title: "Calories vs target",
  unit: " kcal",
  from: "2026-09-27",
  to: "2026-10-17",
  withTarget: true,
  weeklyOnly: false,
  bars: [
    { date: "2026-09-27", value: 0, mark: "filled", label: null },
    { date: "2026-09-28", value: null, mark: "unlogged", label: null },
    { date: "2026-09-29", value: 1_600, mark: "outline", label: "so far" },
    { date: "2026-09-30", value: 1_800, mark: "open", label: "at least" },
  ],
  weeks: [
    { from: "2026-09-27", to: "2026-10-03", value: 1_700, target: 2_100 },
    { from: "2026-10-11", to: "2026-10-17", value: 1_900, target: 2_200 },
  ],
  failed: [{ from: "2026-10-04", to: "2026-10-10" }],
  y: { min: 0, max: 2_400, ticks: [0, 800, 1_600, 2_400] },
  x: { ticks: ["2026-09-27", "2026-10-17"] },
  summary: "Calories: one partial week and one week could not load.",
  table: [
    { iso: "2026-09-27", date: "Sun 27 Sep", value: "0 kcal", target: "2,100 kcal", note: "" },
    { iso: "2026-09-28", date: "Mon 28 Sep", value: "—", target: "2,100 kcal", note: "Not logged" },
  ],
};

const split: SplitModel = {
  title: "Macro split",
  summary: "Macro split by week, with one unavailable week.",
  weeks: [
    { key: "2026-09-27", label: "Sun 27 Sep", shares: { protein: 0.3, carbs: 0.45, fat: 0.25 }, text: "Protein 30% · carbs 45% · fat 25%", failed: false },
    { key: "2026-10-04", label: "Sun 4 Oct", shares: null, text: "Couldn't load these weeks", failed: true },
  ],
};

const cost: CostModel = {
  empty: null,
  daily: {
    title: "Daily cost",
    summary: "Daily cost has partial pricing and one failed week.",
    from: "2026-09-27",
    to: "2026-10-10",
    bars: [
      { date: "2026-09-27", min: 0, max: 0, atLeast: false },
      { date: "2026-09-28", min: 120, max: 160, atLeast: true },
    ],
    weeks: [{ from: "2026-09-27", to: "2026-10-03", min: 110, max: 150 }],
    failed: [{ from: "2026-10-04", to: "2026-10-10" }],
    y: { min: 0, max: 200, ticks: [0, 100, 200] },
    x: { ticks: ["2026-09-27", "2026-10-10"] },
    table: [{ iso: "2026-09-28", date: "Mon 28 Sep", cost: "≥ ₹120", note: "Partial" }],
  },
  per25: {
    title: "Cost per 25 g protein",
    summary: "Cost per 25 g protein for priced items.",
    from: "2026-09-27",
    to: "2026-10-17",
    weeks: [
      { from: "2026-09-27", to: "2026-10-03", min: 20, max: 25 },
      { from: "2026-10-11", to: "2026-10-17", min: 22, max: 28 },
    ],
    points: [{ date: "2026-09-28", min: 18, max: 24 }],
    failed: [{ from: "2026-10-04", to: "2026-10-10" }],
    y: { min: 0, max: 30, ticks: [0, 10, 20, 30] },
    x: { ticks: ["2026-09-27", "2026-10-10"] },
    table: [{ key: "2026-09-27", week: "Sun 27 Sep", value: "₹20–₹25" }],
  },
};

describe("nutrition chart geometry", () => {
  it.each([390, 480, 900])("uses the rendered width at %d px while preserving fixed type and safe plot bounds", (width) => {
    const d = dailyGeometry(daily, width);
    const s = splitGeometry(split, width);
    const c = costGeometry(cost.daily, width);
    expect(d).toMatchObject({ width, height: 180, fontSize: 11 });
    expect(s).toMatchObject({ width, fontSize: 11 });
    expect(c).toMatchObject({ width, height: 160, fontSize: 11 });
    expect(d.plot.left).toBe(40);
    expect(d.plot.right).toBe(width - 12);
    expect(d.dayWidth).toBeGreaterThan(0);
    expect(d.bars.every((bar) => bar.x >= d.plot.left - 0.01 && bar.x + bar.width <= d.plot.right + 0.01)).toBe(true);
  });

  it("keeps zero as data, null as absence, and failed ranges as visible gaps", () => {
    const d = dailyGeometry(daily, 390);
    const c = costGeometry(cost.daily, 390);
    expect(d.bars.find((bar) => bar.date === "2026-09-27")).toMatchObject({ value: 0, height: 1 });
    expect(d.bars.find((bar) => bar.date === "2026-09-28")).toMatchObject({ value: null, kind: "unlogged" });
    expect(d.weekPaths).toHaveLength(2);
    expect(d.targetPaths).toHaveLength(2);
    expect(d.failed).toHaveLength(1);
    expect(c.bars.find((bar) => bar.date === "2026-09-27")).toMatchObject({ min: 0, max: 0, height: 1 });
    expect(c.failed).toHaveLength(1);
    const per25 = costGeometry(cost.per25, 390);
    expect(per25.minPaths).toHaveLength(2);
    expect(per25.maxPaths).toHaveLength(2);
  });
});

describe("nutrition chart accessibility", () => {
  it("exposes the graphic summary and coverage detail through a semantic collapsible table", () => {
    const html = renderToStaticMarkup(createElement(DailyChart, { chart: daily, width: 390 }));
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Calories: one partial week and one week could not load."');
    expect(html).toContain("Couldn&#x27;t load");
    expect(html).toContain("so far");
    expect(html).toContain("at least");
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>Data</summary>");
    expect(html).toContain('<th scope="col">Target</th>');
    expect(html).toContain("Not logged");
  });

  it("renders split labels and failed/empty weeks in both the graphic and table", () => {
    const html = renderToStaticMarkup(createElement(SplitChart, { model: split, width: 480 }));
    expect(html).toContain('role="img"');
    expect(html).toContain("30%");
    expect(html).toContain("couldn&#x27;t load these weeks");
    expect(html).toContain('<th scope="col">Split</th>');
  });

  it("renders both cost charts with failed gaps, labels, summaries, and tables", () => {
    const html = renderToStaticMarkup(createElement(FoodCost, { model: cost, width: 900 }));
    expect(html.match(/role="img"/g)).toHaveLength(2);
    expect(html).toContain("Daily cost has partial pricing and one failed week.");
    expect(html).toContain("Couldn&#x27;t load");
    expect(html).toContain("at least");
    expect(html).toContain("₹ per 25 g protein");
    expect(html.match(/<details>/g)).toHaveLength(2);
  });

  it("gives the cost section a meaningful empty state instead of empty graphics", () => {
    const html = renderToStaticMarkup(createElement(FoodCost, { model: { ...cost, empty: "No priced foods in this range" } }));
    expect(html).toContain('role="status"');
    expect(html).toContain("No priced foods in this range");
    expect(html).not.toContain('role="img"');
  });

  it("lets an individual cost chart remain a supported public seam", () => {
    const html = renderToStaticMarkup(createElement(CostChart, { chart: cost.per25, kind: "per25", width: 390 }));
    expect(html).toContain("Cost per 25 g protein");
    expect(html).toContain('<th scope="col">₹ per 25 g protein</th>');
  });
});
