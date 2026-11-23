import { describe, expect, it } from "vitest";
import { buildHealth, buildWeek, HEALTH_HEADINGS } from "../src/progress";
import type { BloodDraws, Flags, LabResult, WeekSummary } from "../src/types";

const day = (date: string, over: Partial<WeekSummary["days"][number]> = {}): WeekSummary["days"][number] => ({
  date, day_status: "open", item_count: 0, kcal: null, kcal_target: 2000, protein: null, protein_target: 150, training: [], kind: "rest", ...over,
});

function summary(over: Partial<WeekSummary> = {}): WeekSummary {
  return {
    member: "Asha", week_start: "2026-09-27", week_end: "2026-10-03",
    days: [
      day("2026-09-27", { day_status: "complete", item_count: 9, kcal: 1850.4, protein: 132.2, training: [{ kind: "dance", template: null, energy_kcal: 300 }], kind: "dance" }),
      day("2026-09-28", { item_count: 6, kcal: 1900, kcal_target: null, protein: 120, protein_target: null, training: [{ kind: "gym", template: "Upper A", energy_kcal: null }], kind: "gym" }),
      day("2026-09-29"), day("2026-09-30"), day("2026-10-01"), day("2026-10-02"), day("2026-10-03"),
    ],
    measured: { kcal_measured: 2328, kcal_known: 3750.4, share: 0.62 },
    energy_availability: { value: 31.44, low: false, threshold: 25, ffm_kg: 58, ffm_measured_on: "2026-09-01", days_counted: 2, intake_kcal_per_day: 1875.2, exercise_kcal_per_day: 150, sessions_without_energy: 0 },
    energy_availability_missing: null,
    ...over,
  };
}

describe("This week", () => {
  it("marks a day whose sums leave out unknown items, with the count (ticket 72)", () => {
    const s = summary();
    const view = buildWeek({ ...s, days: [{ ...s.days[0]!, unknown_items: { kcal: 1, protein: 1 } }, ...s.days.slice(1)] }, "2026-10-06");
    expect(view.days[0]).toMatchObject({ kcal: "1,850+ of 2,000 kcal · 1 item unknown", protein: "P 132+ g", fill: 0.9252 });
    expect(view.days[1]).toMatchObject({ kcal: "1,900 kcal", protein: "P 120 g" });
  });

  it("a day whose items are all unknown reads kcal unknown with the count, never Nothing logged (review P1-1)", () => {
    const s = summary();
    const view = buildWeek({ ...s, days: [day("2026-09-27", { item_count: 2, unknown_items: { kcal: 2, protein: 2, any: 2 } }), ...s.days.slice(1)] }, "2026-10-06");
    expect(view.days[0]).toMatchObject({ kcal: "kcal unknown · 2 items unknown", protein: "P unknown", fill: null });
  });

  it("lists each day with kcal against target, protein, status and training", () => {
    const view = buildWeek(summary(), "2026-10-06");
    expect(view.title).toBe("Week of Sun 27 Sep");
    expect(view.days[0]).toEqual({ date: "2026-09-27", label: "Sun 27 Sep", kcal: "1,850 of 2,000 kcal", fill: 0.9252, protein: "P 132 g", status: "complete", training: "Dance" });
    expect(view.days[1]).toMatchObject({ kcal: "1,900 kcal", fill: null, training: "Gym, Upper A" });
    expect(view.days[2]).toMatchObject({ kcal: "Nothing logged", fill: null, protein: "P —", training: "Rest" });
  });

  it("says the measured share, and energy availability with the days it covers", () => {
    const view = buildWeek(summary(), "2026-10-06");
    expect(view.measured).toBe("62% of this week's energy was measured.");
    expect(view.energy).toEqual({ text: "Energy availability 31.4 kcal/kg fat-free mass, over 2 days.", flagged: false });
    const low = buildWeek(summary({ energy_availability: { ...summary().energy_availability!, value: 21.7, low: true } }), "2026-10-06");
    expect(low.energy).toEqual({ text: "Energy availability 21.7 kcal/kg fat-free mass, over 2 days. Below 25.", flagged: true });
  });

  it("shows a manual day total as known, marked, and titles the current week plainly", () => {
    const view = buildWeek(summary({ days: [day("2026-09-27", { item_count: 0, kcal: 3081, kcal_target: 2400, protein: 150 })] }), "2026-09-30");
    expect(view.title).toBe("This week");
    expect(view.days[0]).toMatchObject({ kcal: "3,081 of 2,400 kcal · day total", fill: 1, protein: "P 150 g" });
  });

  it("says a day after today is ahead, never \"Nothing logged · open\" or \"Rest\" (ticket 68)", () => {
    const view = buildWeek(summary(), "2026-09-29");
    expect(view.days[2]).toMatchObject({ kcal: "Nothing logged", status: "open", training: "Rest" });
    expect(view.days[3]).toEqual({ date: "2026-09-30", label: "Wed 30 Sep", kcal: "Ahead", fill: null, protein: "", status: "", training: "" });
  });

  it("counts one day as a day", () => {
    const one = buildWeek(summary({ energy_availability: { ...summary().energy_availability!, days_counted: 1 } }), "2026-10-06");
    expect(one.energy.text).toBe("Energy availability 31.4 kcal/kg fat-free mass, over 1 day.");
  });

  it("says not known, never zero, when the API can't know", () => {
    const view = buildWeek(summary({ measured: { kcal_measured: 0, kcal_known: 0, share: null }, energy_availability: null, energy_availability_missing: "nothing logged this week" }), "2026-10-06");
    expect(view.measured).toBe("Nothing logged this week, so no measured share.");
    expect(view.energy).toEqual({ text: "Energy availability: not known (nothing logged this week).", flagged: false });
  });

  it("steps a week back, and forward only up to the current week", () => {
    expect(buildWeek(summary(), "2026-10-06")).toMatchObject({ prev: "2026-09-20", next: "2026-10-04" });
    expect(buildWeek(summary({ week_start: "2026-10-04", week_end: "2026-10-10" }), "2026-10-06").next).toBeNull();
  });
});

const result = (over: Partial<LabResult>): LabResult => ({
  id: 1, marker: "TSH", value: null, comparator: null, value_text: null, unit: null, ref_low: null, ref_high: null, ref_text: null, status: null, change: null, ...over,
});

const draws: BloodDraws = {
  member: "Asha",
  draws: [
    {
      id: 2, drawn_on: "2026-10-01", lab: "Thyrocare", fasting: 1, state: "confirmed",
      results: [
        result({ id: 10, marker: "TSH", value: 5.6, unit: "mIU/L", ref_low: 0.4, ref_high: 4.2, status: "above", change: { previous: 3.1, previous_on: "2026-04-01", delta: 2.5 } }),
        result({ id: 11, marker: "ALT", value: 52, unit: "U/L", ref_high: 45, status: "above", change: null }),
        result({ id: 12, marker: "Vitamin D", value: 34, unit: "ng/mL", ref_low: 30, ref_high: 100, status: "within", change: { previous: 18, previous_on: "2026-04-01", delta: 16 } }),
        result({ id: 13, marker: "CRP", value: 0.5, comparator: "<", unit: "mg/L", ref_high: 5, status: null }),
      ],
    },
    {
      id: 1, drawn_on: "2026-04-01", lab: "Thyrocare", fasting: 1, state: "confirmed",
      results: [
        result({ id: 1, marker: "TSH", value: 3.1, unit: "mIU/L", ref_low: 0.4, ref_high: 4.2, status: "within" }),
        result({ id: 2, marker: "Ferritin", value: 40, unit: "ng/mL", ref_low: 30, ref_high: 400, status: "within" }),
      ],
    },
  ],
};

const flags: Flags = {
  flags: [
    { id: 1, subtype: "data", subject: "Lipid report never received", due_on: "2026-10-20", status: "open", note: null, raised_on: "2026-10-01" },
    { id: 2, subtype: "health_watch", subject: "Repeat the thyroid panel", due_on: "2026-11-01", status: "open", note: "After six weeks on the new dose", raised_on: "2026-10-01" },
  ],
};

describe("Health", () => {
  it("lists out-of-range markers first, then each panel's latest values, with range, status and change", () => {
    const view = buildHealth(draws, flags);
    expect(view.outOfRange.map((m) => m.name)).toEqual(["TSH", "ALT"]);
    expect(view.outOfRange[0]).toEqual({
      id: 10, name: "TSH", value: "5.6 mIU/L", range: "0.4–4.2 mIU/L", status: "above", statusText: "above range", change: "+2.5 since Wed 1 Apr",
      draw: "Thyrocare, 1 Oct 2026", drawnOn: "2026-10-01", lab: "Thyrocare",
      band: { low: 0.4, high: 4.2, value: 5.6 },
    });
    expect(view.outOfRange[1]).toMatchObject({ range: "≤ 45 U/L", change: null, band: { low: null, high: 45, value: 52 } });
    expect(view.panels.map((p) => [p.title, p.markers.map((m) => m.name)])).toEqual([
      ["Thyrocare, 1 Oct 2026", ["Vitamin D", "CRP"]],
      ["Thyrocare, 1 Apr 2026", ["Ferritin"]],
    ]);
    expect(view.panels[0]?.markers[1]).toMatchObject({ value: "<0.5 mg/L", statusText: "not checked against the range", band: null });
  });

  it("labels a draft draw, and still heads a draw whose markers are all out of range", () => {
    const d: BloodDraws = { member: "Asha", draws: [{ id: 3, drawn_on: "2026-10-05", lab: "Orange", fasting: null, state: "draft", results: [result({ id: 20, marker: "LDL", value: 190, unit: "mg/dL", ref_high: 100, status: "above" })] }] };
    const view = buildHealth(d, { flags: [] });
    expect(view.outOfRange[0]).toMatchObject({ draw: "Orange, 5 Oct 2026 (draft)", lab: "Orange", drawnOn: "2026-10-05" });
    expect(view.panels).toEqual([{ title: "Orange, 5 Oct 2026 (draft)", markers: [], allOutOfRange: true }]);
  });

  it("heads the data flags as data to check, not \"Not received\": a data flag may be readings that disagree (ticket 68)", () => {
    expect(HEALTH_HEADINGS).toEqual({ gaps: "Data to check", flags: "Flags and follow-ups" });
  });

  it("lists reports never received as gaps, and open follow-ups with due dates and notes", () => {
    const view = buildHealth(draws, flags);
    expect(view.gaps).toEqual([{ id: 1, subject: "Lipid report never received", due: "due Tue 20 Oct", note: null }]);
    expect(view.flags).toEqual([{ id: 2, subject: "Repeat the thyroid panel", due: "due Sun 1 Nov", note: "After six weeks on the new dose" }]);
  });

  it("never prints an imported \"not recorded\" as a unit, and says a range in words isn't checked (click test P2-21)", () => {
    const d: BloodDraws = { member: "Asha", draws: [{ id: 4, drawn_on: "2026-09-01", lab: "Orange", fasting: null, state: "confirmed", results: [
      result({ id: 30, marker: "Free T4", value: 1.2, unit: "not recorded", ref_text: "0.8-1.8 (adult); 0.9-2.0 (pregnancy)", status: null }),
      result({ id: 31, marker: "Free T3", value: 3.1, unit: "not_recorded", ref_low: 2.3, ref_high: 4.2, status: "within" }),
    ] }] };
    const view = buildHealth(d, { flags: [] });
    expect(view.panels[0]?.markers.map((m) => [m.value, m.range, m.statusText])).toEqual([
      ["1.2", "0.8-1.8 (adult); 0.9-2.0 (pregnancy)", "not checked against the range"],
      ["3.1", "2.3–4.2", "in range"],
    ]);
  });

  it("says so when there are no draws and no flags", () => {
    expect(buildHealth({ member: "Asha", draws: [] }, { flags: [] }).empty).toBe("No blood draws and no open flags.");
  });
});
