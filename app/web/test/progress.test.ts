import { describe, expect, it } from "vitest";
import { buildHealth, buildProgressSummary, buildTrajectory, drawRows, readingRows, verdictText, type ChartModel, type ProgressSummaryData, type TrajectoryData, type TrajectoryView } from "../src/progress";
import type { BloodDraws, BodyTrends, Flags, GoalVerdict, ProgressSummary } from "../src/types";

const verdict = (over: Partial<GoalVerdict> = {}): GoalVerdict => ({ verdict: "on_track", week: "2026-10-04", reading: 0.5086, goal: 0.5143, deviation: -0.0057, weeksBehind: 0, ...over });

function waist(over: Partial<BodyTrends> = {}): BodyTrends {
  return {
    member: "Asha", metric: "waist_navel", canonical_unit: "cm", end_target: null,
    segments: [
      { start: "2026-09-13", readings: [{ id: 1, date: "2026-09-13", value_canonical: 91, unit: "cm" }, { id: 2, date: "2026-09-20", value_canonical: 90.4, unit: "cm" }] },
      { start: "2026-09-27", readings: [{ id: 3, date: "2026-09-27", value_canonical: 89.6, unit: "cm" }, { id: 4, date: "2026-10-05", value_canonical: 89, unit: "cm" }] },
    ],
    method_changes: [{ date: "2026-09-27", note: "new tape" }],
    goal_points: [],
    current_week: verdict({ reading: 89, goal: 90 }),
    current_phase: { name: "Cut 1", starts_on: "2026-08-01", ends_on: null, energy_stance: "deficit" },
    headline: { metric: "waist_to_height", direction: "decrease", reason: null },
    waist_to_height: {
      height_cm: 175, height_measured_on: "2026-01-01",
      segments: [
        { start: "2026-09-13", readings: [{ date: "2026-09-13", value: 0.52 }, { date: "2026-09-20", value: 0.5166 }] },
        { start: "2026-09-27", readings: [{ date: "2026-09-27", value: 0.512 }, { date: "2026-10-05", value: 0.5086 }] },
      ],
      goal_path: [{ week_of: "2026-09-13", value: 0.5200 }, { week_of: "2026-10-04", value: 0.5143 }, { week_of: "2027-03-28", value: 0.5 }],
      goal_points: [{ week_of: "2027-03-28", tier: "planned", low: 0.5, high: 0.5 }],
      end_target: { week_of: "2027-03-28", low: 0.5, high: 0.5 },
      band: 1 / 175,
      current_week: verdict(),
    },
    ...over,
  };
}

function weight(): BodyTrends {
  return {
    member: "Asha", metric: "weight", canonical_unit: "kg", end_target: null,
    segments: [], method_changes: [{ date: "2026-09-27", note: "new scale" }], goal_points: [], current_phase: null,
    headline: { metric: "waist_to_height", direction: "decrease", reason: null },
    seven_day_averages: [{ date: "2026-09-20", average_kg: 78.4 }, { date: "2026-09-26", average_kg: 78.1 }, { date: "2026-09-27", average_kg: 77.6 }, { date: "2026-10-05", average_kg: 77.2 }],
  };
}

const data = (over: Partial<Extract<TrajectoryData, { private: false }>> = {}): Extract<TrajectoryData, { private: false }> => ({
  private: false, today: "2026-10-06", range: "12w", from: "2026-07-15", lead: waist(), weight: weight(), ...over,
});

describe("verdictText", () => {
  it("words every state, and behind with the weeks running", () => {
    expect(verdictText(verdict())).toBe("On track");
    expect(verdictText(verdict({ verdict: "ahead" }))).toBe("Ahead");
    expect(verdictText(verdict({ verdict: "behind", weeksBehind: 4 }))).toBe("Behind, 4 weeks running");
    expect(verdictText(verdict({ verdict: "no_reading" }))).toBe("No reading this week");
    expect(verdictText(verdict({ verdict: "no_goal_point" }))).toBe("No goal point this week");
  });
});

describe("Trajectory headline", () => {
  it("leads with waist:height against its stored target, the current week's verdict and the waist in cm", () => {
    const view = buildTrajectory(data());
    expect(view.headline).toEqual({
      title: "Waist to height", value: "0.51", target: "Target 0.50 by 28 Mar 2027", verdict: { kind: "on_track", text: "On track" }, secondary: "Waist 89.0 cm on Mon 5 Oct",
      observation: "Moved in the intended direction by 0.01 across 4 readings since Sun 13 Sep.",
    });
  });

  it("falls back to the first planned goal metric when the API says so", () => {
    // body_trends answered the headline call for weight (no height stored).
    const fallback = {
      ...weight(), metric: "weight", headline: { metric: "weight", direction: "decrease" as const, reason: "No height is stored." },
      segments: [{ start: "2026-09-20", readings: [{ id: 9, date: "2026-10-05", value_canonical: 77.4, unit: "kg" }] }],
      goal_points: [{ week_of: "2026-12-27", tier: "planned" as const, low: 74, high: 74 }], end_target: { week_of: "2026-12-27", low: 74, high: 74 },
      current_week: verdict({ verdict: "behind", weeksBehind: 3, reading: 77.4 }),
    };
    const view = buildTrajectory(data({ lead: fallback }));
    expect(view.headline).toEqual({ title: "Body weight", value: "77.4 kg", target: "Target 74.0 kg by 27 Dec 2026", verdict: { kind: "behind", text: "Behind, 3 weeks running" }, secondary: null, observation: "One reading in this range; there isn't a trend yet." });
  });

  it("keeps the end target when the range clips the goal points", () => {
    const lead = waist();
    const clipped = { ...lead, waist_to_height: { ...lead.waist_to_height!, goal_points: [] } };
    expect(buildTrajectory(data({ range: "4w", lead: clipped })).headline?.target).toBe("Target 0.50 by 28 Mar 2027");
  });

  it("says plainly when no goal is set yet", () => {
    const view = buildTrajectory(data({ lead: waist({ metric: null, headline: { metric: null, direction: null, reason: "No planned goal points yet." }, waist_to_height: null, segments: [] }), weight: null }));
    expect(view).toMatchObject({ headline: null, chart: null, message: "No goal set yet. The agent sets goal points from your Guide." });
  });

  it("describes movement away from the intended direction without claiming a cause", () => {
    const lead = waist();
    const rising = { ...lead, waist_to_height: { ...lead.waist_to_height!, segments: [{ start: null, readings: [{ date: "2026-09-20", value: 0.50 }, { date: "2026-10-05", value: 0.52 }] }] } };
    expect(buildTrajectory(data({ lead: rising })).headline?.observation).toBe("Moved away from the intended direction by 0.02 across 2 readings since Sun 20 Sep.");
  });

  it("calls a displayed-flat series steady", () => {
    const lead = waist();
    const flat = { ...lead, waist_to_height: { ...lead.waist_to_height!, segments: [{ start: null, readings: [{ date: "2026-09-20", value: 0.512 }, { date: "2026-10-05", value: 0.514 }] }] } };
    expect(buildTrajectory(data({ lead: flat })).headline?.observation).toBe("Held steady across 2 readings since Sun 20 Sep.");
  });

  it("separates the current headline from an empty selected range", () => {
    const lead = waist();
    const empty = { ...lead, waist_to_height: { ...lead.waist_to_height!, segments: [] } };
    expect(buildTrajectory(data({ range: "4w", lead: empty })).headline?.observation).toBe("No reading in this range.");
  });
});

describe("Trajectory chart", () => {
  it("draws readings cut at the method change, goals up to today, today's value marked, and the phase within the range", () => {
    const chart = buildTrajectory(data()).chart;
    expect(chart?.segments.map((s) => s.map((p) => p.date))).toEqual([["2026-09-13", "2026-09-20"], ["2026-09-27", "2026-10-05"]]);
    expect(chart?.goals).toEqual([{ date: "2026-09-13", value: 0.52 }, { date: "2026-10-04", value: 0.5143 }]);
    expect(chart?.current).toEqual({ date: "2026-10-05", value: 0.5086 });
    expect(chart).toMatchObject({ from: "2026-07-15", to: "2026-10-06", phase: { from: "2026-08-01", to: "2026-10-06", name: "Cut 1" } });
    expect(chart?.y.ticks.length).toBeGreaterThan(1);
  });

  it("has a text equivalent: a summary line and a table of every reading and goal", () => {
    const chart = buildTrajectory(data()).chart;
    expect(chart?.summary).toBe("Waist to height: 0.51 on Mon 5 Oct; latest goal 0.51. 4 readings shown.");
    expect(chart?.table[0]).toEqual({ iso: "2026-09-13", date: "Sun 13 Sep", reading: "0.52", goal: "0.52" });
    expect(chart?.table.find((r) => r.date === "Sun 4 Oct")).toEqual({ iso: "2026-10-04", date: "Sun 4 Oct", reading: null, goal: "0.51" });
  });

  it("starts at the first reading for All", () => {
    expect(buildTrajectory(data({ range: "all", from: null })).chart?.from).toBe("2026-09-13");
  });

  it("draws the 7-day fasted weight beneath, on the same dates, cut at its method change", () => {
    const w = buildTrajectory(data()).weight;
    expect(w).toMatchObject({ from: "2026-07-15", to: "2026-10-06", title: "7-day fasted weight" });
    expect(w?.segments.map((s) => s.map((p) => p.value))).toEqual([[78.4, 78.1], [77.6, 77.2]]);
  });
});

describe("Trajectory goal ranges and thin data", () => {
  it("shows a goal range as low to high, never a midpoint", () => {
    const lead = { ...weight(), metric: "weight", headline: { metric: "weight", direction: "decrease" as const, reason: null }, segments: [{ start: null, readings: [{ id: 1, date: "2026-10-05", value_canonical: 77.4, unit: "kg" }] }],
      goal_points: [{ week_of: "2026-10-04", tier: "planned" as const, low: 76, high: 78 }], end_target: { week_of: "2026-12-27", low: 73.5, high: 75 }, current_week: verdict({ reading: 77.4 }) };
    const view = buildTrajectory(data({ lead }));
    expect(view.headline?.target).toBe("Target 73.5\u201375.0 kg by 27 Dec 2026");
    expect(view.chart?.goals).toEqual([{ date: "2026-10-04", value: 76, high: 78 }]);
    expect(view.chart?.table.find((r) => r.date === "Sun 4 Oct")?.goal).toBe("76.0\u201378.0 kg");
  });

  it("keeps a single reading as a chart with that one point", () => {
    const lead = waist();
    const one = { ...lead, waist_to_height: { ...lead.waist_to_height!, segments: [{ start: null, readings: [{ date: "2026-10-05", value: 0.5086 }] }], goal_path: [] } };
    const chart = buildTrajectory(data({ lead: one })).chart;
    expect(chart?.segments).toEqual([[{ date: "2026-10-05", value: 0.5086 }]]);
    expect(chart?.summary).toBe("Waist to height: 0.51 on Mon 5 Oct. 1 reading shown.");
  });
});

describe("Trajectory range independence and shared axis", () => {
  it("keeps the headline value when the range holds no reading", () => {
    const lead = waist();
    const empty = { ...lead, waist_to_height: { ...lead.waist_to_height!, segments: [] } };
    const view = buildTrajectory(data({ range: "4w", from: "2026-09-09", lead: empty }));
    expect(view.headline?.value).toBe("0.51");
  });

  it("puts both charts on one x axis for All", () => {
    const view = buildTrajectory(data({ range: "all", from: null }));
    expect(view.chart?.from).toBe("2026-09-13");
    expect(view.weight?.from).toBe(view.chart?.from);
    expect(view.weight?.to).toBe(view.chart?.to);
  });

  it("carries the unit in weight's text equivalent", () => {
    const w = buildTrajectory(data()).weight;
    expect(w?.summary).toBe("7-day fasted weight: 77.2 kg on Mon 5 Oct. 4 readings shown.");
    expect(w?.table.at(-1)).toEqual({ iso: "2026-10-05", date: "Mon 5 Oct", reading: "77.2 kg", goal: null });
  });

  it("starts both charts at the earliest mark under All, so none is clamped to the edge", () => {
    const base = weight();
    const early = { ...base, seven_day_averages: [{ date: "2026-08-30", average_kg: 79 }, ...base.seven_day_averages!] };
    const view = buildTrajectory(data({ range: "all", from: null, weight: early }));
    expect(view.chart?.from).toBe("2026-08-30");
    expect(view.weight?.from).toBe("2026-08-30");
    for (const s of view.weight!.segments) for (const pt of s) expect(pt.date >= view.weight!.from).toBe(true);
  });
});

describe("the readings table (Progress, wide)", () => {
  const chartOf = (table: ChartModel["table"]) => ({ table }) as unknown as ChartModel;
  const view = (lead: ChartModel["table"], weight: ChartModel["table"] | null): TrajectoryView => ({
    range: "12w", headline: null, message: null, chart: chartOf(lead), weight: weight ? chartOf(weight) : null,
  });

  it("lists the chart's own rows newest first, each with the latest 7-day weight on or before it within 7 days; nothing computed", () => {
    const rows = readingRows(view(
      [
        { iso: "2026-09-13", date: "Sun 13 Sep", reading: "91.0 cm", goal: "91.0 cm" },
        { iso: "2026-09-20", date: "Sun 20 Sep", reading: "90.4 cm", goal: null },
        { iso: "2026-09-27", date: "Sun 27 Sep", reading: null, goal: "90.0 cm" },
        { iso: "2026-10-06", date: "Tue 6 Oct", reading: "89.8 cm", goal: null },
      ],
      [
        { iso: "2026-09-18", date: "Fri 18 Sep", reading: "62.6 kg", goal: null },
        { iso: "2026-09-22", date: "Tue 22 Sep", reading: "62.4 kg", goal: null },
        { iso: "2026-09-25", date: "Fri 25 Sep", reading: "62.1 kg", goal: null },
      ],
    ));
    expect(rows).toEqual([
      { date: "Tue 6 Oct", value: "89.8 cm", goal: "no goal point", weight: null },
      { date: "Sun 27 Sep", value: "no reading", goal: "90.0 cm", weight: "62.1 kg" },
      { date: "Sun 20 Sep", value: "90.4 cm", goal: "no goal point", weight: "62.6 kg" },
      { date: "Sun 13 Sep", value: "91.0 cm", goal: "91.0 cm", weight: null },
    ]);
  });

  it("takes a weight on the row's own date, and none from after it", () => {
    const rows = readingRows(view([{ iso: "2026-09-20", date: "Sun 20 Sep", reading: "90.4 cm", goal: null }], [{ iso: "2026-09-20", date: "Sun 20 Sep", reading: "62.4 kg", goal: null }, { iso: "2026-09-21", date: "Mon 21 Sep", reading: "62.0 kg", goal: null }]));
    expect(rows[0]?.weight).toBe("62.4 kg");
  });

  it("is empty with no chart", () => {
    expect(readingRows({ range: "12w", headline: null, message: "No goal yet.", chart: null, weight: null })).toEqual([]);
  });
});

describe("the blood draws (Health, both layouts)", () => {
  const healthResult = (id: number, marker: string, status: "below" | "above" | "within" | null) => ({ id, marker, value: 1, comparator: null, value_text: null, unit: "u", ref_low: 0, ref_high: 2, ref_text: null, status, change: null });
  const healthDraws = (results: BloodDraws["draws"][number]["results"] = []): BloodDraws => ({
    member: "Asha",
    draws: results.length === 0 ? [] : [{ id: 1, drawn_on: "2026-10-01", lab: "Sample lab", fasting: 1, state: "confirmed", results }],
  });
  const healthFlags = (flags: Flags["flags"] = []): Flags => ({ flags });

  it("summarises recorded results and open follow-ups without turning them into a diagnosis", () => {
    const flags: Flags["flags"] = [
      { id: 1, subtype: "data", subject: "Upload missing report", due_on: null, status: "open", note: null, raised_on: "2026-10-01" },
      { id: 2, subtype: "follow_up", subject: "Discuss at next visit", due_on: null, status: "open", note: null, raised_on: "2026-10-01" },
      { id: 3, subtype: "follow_up", subject: "Already done", due_on: null, status: "resolved", note: null, raised_on: "2026-10-01" },
    ];
    const view = buildHealth(healthDraws([healthResult(1, "TSH", "above"), healthResult(2, "Ferritin", "within")]), healthFlags(flags));

    expect(view.overview).toEqual({
      kind: "review",
      title: "Review recorded items",
      summary: "1 result outside its reported range · 1 data item · 1 open follow-up",
      note: "A lab range is context, not a diagnosis. Changes compare only with the previous recorded result.",
    });
  });

  it("says when nothing recorded is currently flagged", () => {
    expect(buildHealth(healthDraws([healthResult(1, "TSH", "within")]), healthFlags()).overview).toMatchObject({
      kind: "clear",
      title: "Nothing currently flagged",
      summary: "The latest recorded results are within their reported ranges or were not checked against one.",
    });
  });

  it("keeps the overview honest before any health records exist", () => {
    expect(buildHealth(healthDraws(), healthFlags()).overview).toMatchObject({
      kind: "empty",
      title: "No health records yet",
      summary: "Add a blood draw or follow-up to start this view.",
    });
  });

  it("gives each draw its date, lab, result count and how many are out of the lab's range", () => {
    const result = (id: number, status: "below" | "above" | "within" | null) => ({ id, marker: `M${id}`, value: 1, comparator: null, value_text: null, unit: "u", ref_low: null, ref_high: null, ref_text: null, status, change: null });
    const draws: BloodDraws = {
      member: "Asha",
      draws: [
        { id: 2, drawn_on: "2026-10-01", lab: "Sample lab", fasting: 1, state: "confirmed", results: [result(1, "below"), result(2, "within"), result(3, "above")] },
        { id: 1, drawn_on: "2026-04-01", lab: "Sample lab", fasting: null, state: "confirmed", results: [result(4, "within")] },
      ],
    };
    expect(drawRows(draws)).toMatchObject([
      { id: 2, date: "1 Oct 2026", lab: "Sample lab", results: "3 results", out: "2 out of range" },
      { id: 1, date: "1 Apr 2026", lab: "Sample lab", results: "1 result", out: "None out of range" },
    ]);
  });

  it("opens each draw to every one of its results, an earlier draw's too (click test P2-22)", () => {
    const result = (id: number, marker: string, value: number, status: "below" | "above" | "within" | null) => ({ id, marker, value, comparator: null, value_text: null, unit: "mIU/L", ref_low: 0.4, ref_high: 4, ref_text: null, status, change: null });
    const draws: BloodDraws = {
      member: "Asha",
      draws: [
        { id: 2, drawn_on: "2026-10-01", lab: "Sample lab", fasting: 1, state: "draft", results: [result(1, "TSH", 3.1, "within")] },
        { id: 1, drawn_on: "2026-04-01", lab: "Other lab", fasting: null, state: "confirmed", results: [result(2, "TSH", 5.2, "above"), result(3, "Ferritin", 30, "within")] },
      ],
    };
    const [latest, earlier] = drawRows(draws);
    expect(latest).toMatchObject({ title: "Sample lab, 1 Oct 2026 (draft)", markers: [{ name: "TSH", value: "3.1 mIU/L", statusText: "in range" }] });
    // The earlier draw keeps its own TSH, which the panels above leave out for the latest one.
    expect(earlier?.markers.map((m) => [m.name, m.value, m.statusText])).toEqual([["TSH", "5.2 mIU/L", "above range"], ["Ferritin", "30 mIU/L", "in range"]]);
  });

  it("doesn't say none is out of range while some weren't checked against one (click test P2-21)", () => {
    const r = (id: number, status: "above" | null) => ({ id, marker: `M${id}`, value: 1, comparator: null, value_text: null, unit: null, ref_low: null, ref_high: null, ref_text: "in words", status, change: null });
    const draws: BloodDraws = { member: "Asha", draws: [
      { id: 5, drawn_on: "2026-10-02", lab: "Sample lab", fasting: null, state: "confirmed", results: [r(1, null), r(2, null)] },
      { id: 6, drawn_on: "2026-09-02", lab: "Sample lab", fasting: null, state: "confirmed", results: [r(3, "above"), r(4, null)] },
    ] };
    expect(drawRows(draws).map((d) => d.out)).toEqual(["2 not checked against a range", "1 out of range, 1 not checked"]);
  });
});

describe("the unified Progress summary", () => {
  const summary = (over: Partial<ProgressSummary["signals"][0]> = {}): Extract<ProgressSummaryData, { private: false }> => {
    const body = {
      name: "body" as const,
      metric: "weight",
      latest: { date: "2026-10-05", value: 77.2, unit: "kg" },
      change: -1.6,
      rate_per_week: -0.35,
      reading_count: 8,
      body_states: ["fasted"],
      method_changes_reflected: true,
      note: null,
    };
    return {
      private: false,
      today: "2026-10-06",
      range: "12w",
      summary: {
        member: "Hritvik",
        period: "12w",
        as_of: "2026-10-06",
        from: "2026-07-15",
        to: "2026-10-06",
        signals: [
          { ...body, ...(over as object) },
          { name: "strength", lifts: [{ exercise: "Bench press", best_e1rm_kg: 72.5, change_kg: 2.5, sessions: 9 }], note: null },
          { name: "nutrition", from: "2026-07-15", to: "2026-10-05", logged_days: 60, days_in_window: 83, coverage: 0.72, average_kcal: 2050, target_kcal: 2000, adherence_gap_kcal: 50, note: null },
          { name: "review", open_flags: 0, blood_draws_in_period: 1, latest_reading_on: "2026-10-05", note: null },
          { name: "next", drill_down: "body", reason: "readings and goal path are the fullest story" },
        ],
      },
    };
  };

  it("leads with a direction, the four signals in the Worker's order, and the next drill-down", () => {
    const view = buildProgressSummary(summary());
    expect(view.direction.kind).toBe("moving");
    expect(view.direction.title).toBe("Decreased by 1.6 kg");
    expect(view.signals.map((s) => s.name)).toEqual(["body", "strength", "nutrition", "review"]);
    expect(view.next).toEqual({ view: "body", reason: "readings and goal path are the fullest story" });
  });

  it("says plainly when there is not a trend yet, and when there is no reading at all", () => {
    const one = buildProgressSummary(summary({ latest: { date: "2026-10-05", value: 77.2, unit: "kg" }, change: null, reading_count: 1 }));
    expect(one.direction.kind).toBe("waiting");
    expect(one.direction.observation).toContain("there isn't a trend yet");
    const none = buildProgressSummary(summary({ latest: null, change: null, rate_per_week: null, reading_count: 0 }));
    expect(none.direction.title).toBe("No reading yet");
    expect(none.direction.href).toBeNull();
  });

  it("calls a flat series steady rather than moved", () => {
    const view = buildProgressSummary(summary({ change: 0, rate_per_week: 0 }));
    expect(view.direction.kind).toBe("holding");
    expect(view.direction.title).toBe("Holding steady");
  });

  it("words the nutrition coverage and the adherence gap", () => {
    const view = buildProgressSummary(summary());
    const nutrition = view.signals.find((s) => s.name === "nutrition")!;
    expect(nutrition.value).toBe("72%");
    expect(nutrition.detail).toContain("+50 kcal");
  });

  it("carries the prior-period strip for a fixed period, and none for all", () => {
    const view = buildProgressSummary(summary());
    expect(view.comparison).toEqual({ label: "Previous period", from: "2026-04-22", to: "2026-07-14", days: 84 });
    expect(buildProgressSummary({ ...summary(), range: "all" }).comparison).toBeNull();
  });

  it("points the next drill-down at Health for flags, Nutrition for coverage", () => {
    const flags = summary();
    (flags.summary.signals[4] as { drill_down: string }).drill_down = "flags";
    expect(buildProgressSummary(flags).next.view).toBe("health");
    const food = summary();
    (food.summary.signals[4] as { drill_down: string }).drill_down = "nutrition";
    expect(buildProgressSummary(food).next.view).toBe("nutrition");
  });
});
