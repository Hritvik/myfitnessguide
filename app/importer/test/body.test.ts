// Body -> readings (log_reading); Bloods -> blood draws (log_blood_draw);
// Trajectory and the goal lifts -> goal points.
import { describe, expect, it } from "vitest";
import { rehearse } from "../src/rehearse";
import { basePeople, BODY_HEADER, f, LOG_HEADER, members, set, snapshot } from "./fixture";

function run(hritvik: Record<string, unknown[][]>) {
  return rehearse({ snapshot: snapshot({ base: { People: basePeople() }, hritvik } as never), members: members() });
}

const body = [
  [...BODY_HEADER, "Skinfold Chest (mm)", "Skinfold Abdomen (mm)", "Skinfold Thigh (mm)", "Skinfold SUM (mm)", "BIA device / conditions", "BIA Skeletal muscle (kg)", "BIA Fat mass (kg)", "BIA Body water (kg)", "BIA Body fat (%)", "A LONG PROTOCOL HEADER THAT IS REALLY A PARAGRAPH OF PROSE ABOUT CALIPERS"],
  [46240, 2, 80.2, "", "", "AM fasted - protocol", "", "", "", "", "", "", "", "", "", "", "", "", "", 6.5, "First reading", 118, 76, 58, 12, 18, 14, f("=SUM(Y2:AA2)", 44), "Watch", 30, 15, 40.1, 25.5],
  [46241, 2, 80.6, f("=AVERAGE(C2:C3)", 80.4), 81, "post-meal", "88.5", 88.5, "", "", 30.1, "", 99, 36.2, f("=I3/G3", ""), f("=G3/M3", 0.89), f("=G3/170", 0.52)],
];

describe("body readings", () => {
  it("logs one reading per measured column, with units, body state and conditions", async () => {
    const r = await run({ Body: body });
    expect(r.db.all("SELECT measured_on, metric, value, unit, side, body_state, method FROM reading WHERE metric <> 'height' ORDER BY id")).toEqual([
      { measured_on: "2026-08-06", metric: "weight", value: 80.2, unit: "kg", side: null, body_state: "fasted", method: null },
      { measured_on: "2026-08-06", metric: "sleep", value: 6.5, unit: "h", side: null, body_state: "not_recorded", method: null },
      { measured_on: "2026-08-06", metric: "bp_systolic", value: 118, unit: "mmHg", side: null, body_state: "not_recorded", method: null },
      { measured_on: "2026-08-06", metric: "bp_diastolic", value: 76, unit: "mmHg", side: null, body_state: "not_recorded", method: null },
      { measured_on: "2026-08-06", metric: "resting_hr", value: 58, unit: "bpm", side: null, body_state: "not_recorded", method: null },
      { measured_on: "2026-08-06", metric: "skinfold_chest", value: 12, unit: "mm", side: null, body_state: "not_recorded", method: null },
      { measured_on: "2026-08-06", metric: "skinfold_abdomen", value: 18, unit: "mm", side: null, body_state: "not_recorded", method: null },
      { measured_on: "2026-08-06", metric: "skinfold_thigh", value: 14, unit: "mm", side: null, body_state: "not_recorded", method: null },
      { measured_on: "2026-08-06", metric: "bia_skeletal_muscle_mass", value: 30, unit: "kg", side: null, body_state: "not_recorded", method: "Watch" },
      { measured_on: "2026-08-06", metric: "bia_body_fat_mass", value: 15, unit: "kg", side: null, body_state: "not_recorded", method: "Watch" },
      { measured_on: "2026-08-06", metric: "bia_body_fat_pct", value: 25.5, unit: "pct", side: null, body_state: "not_recorded", method: "Watch" },
      { measured_on: "2026-08-07", metric: "weight", value: 80.6, unit: "kg", side: null, body_state: "fasted", method: null },
      { measured_on: "2026-08-07", metric: "weight", value: 81, unit: "kg", side: null, body_state: "not_recorded", method: null },
      { measured_on: "2026-08-07", metric: "waist_navel", value: 88.5, unit: "cm", side: null, body_state: "not_recorded", method: null },
      { measured_on: "2026-08-07", metric: "abdomen_widest", value: 88.5, unit: "cm", side: null, body_state: "not_recorded", method: null },
      { measured_on: "2026-08-07", metric: "arm", value: 30.1, unit: "cm", side: "right", body_state: "not_recorded", method: null },
      { measured_on: "2026-08-07", metric: "hips", value: 99, unit: "cm", side: null, body_state: "not_recorded", method: null },
      { measured_on: "2026-08-07", metric: "neck", value: 36.2, unit: "cm", side: null, body_state: "not_recorded", method: null },
    ]);
    expect(r.db.get("SELECT note, conditions FROM reading WHERE metric = 'weight' ORDER BY id LIMIT 1")).toEqual({ note: "First reading", conditions: "AM fasted - protocol" });
    expect(r.rulings.find((x) => x.id === "hritvik/Body!2/unknown_metric/AF")).toMatchObject({ kind: "semantic", proposal: null });
    expect(r.rulings.find((x) => x.id === "hritvik/Body!3/stored_as_text")).toMatchObject({ kind: "mechanical" });
    expect(r.db.all("SELECT topic FROM v_member_note WHERE topic <> 'targets'")).toEqual([{ topic: "Body: header AH" }]);
  });
});

describe("metrics added by ruling", () => {
  it("logs a column ruled add_metric as that metric, in the header's unit", async () => {
    const sheet = [["Date", "Week", "BIA Body water (kg)", "BIA BMR (kcal)"], [46240, 2, 33.3, 1405]];
    const ruled = (col: string, code: string) => ({
      id: `hritvik/Body!2/unknown_metric/${col}`, origin: { file: "hritvik", tab: "Body", row: 2 }, code: "unknown_metric", kind: "semantic" as const, cause: null,
      problem: "", proposed_fix: "", proposal: null, decision: "accepted" as const, decided_by: "Test", override: { add_metric: code }, day: null, row: {}, note: null,
    });
    const r = await rehearse({ snapshot: snapshot({ base: { People: basePeople() }, hritvik: { Body: sheet } } as never), members: members(), previousRulings: [ruled("C", "bia_body_water_kg"), ruled("D", "bia_bmr_kcal")] });
    expect(r.db.all("SELECT metric, value, unit FROM reading WHERE metric LIKE 'bia%' ORDER BY id")).toEqual([
      { metric: "bia_body_water_kg", value: 33.3, unit: "kg" },
      { metric: "bia_bmr_kcal", value: 1405, unit: "kcal" },
    ]);
  });
});

describe("bloods", () => {
  const bloods = [
    ["BLOOD MARKERS", "Test Lab. Two draws."],
    [],
    ["Marker", 46100, 46200, "Ref Range", "Change", "Status", "Notes"],
    ["SECTION A"],
    ["ALT", 30, 55, "5 - 40", "UP", "HIGH", "Up."],
    ["HbA1c", 0.052, 0.05, "4.0 - 5.6", "", "Normal"],
    ["Creatinine / GFR", "0.9 / 100", "1 / 95", "0.70-1.30 / >59", "Flat", "Normal"],
    ["LDL", 140, 110, "<100", "Improved", "High"],
    ["Vitamin D", "30.5", "not retested", "75 - 250 nmol/L", "-", "DEFICIENT"],
    [],
    ["WHAT TO ASK", "", ""],
    ["1. Liver", "ALT up", "Priority"],
  ];

  it("logs one draw per date column, with ranges and units, and asks about what it cannot read", async () => {
    const r = await run({ Bloods: bloods });
    expect(r.db.all("SELECT drawn_on, lab FROM blood_draw ORDER BY id")).toEqual([
      { drawn_on: "2026-03-19", lab: "Test Lab" },
      { drawn_on: "2026-06-27", lab: "Test Lab" },
    ]);
    expect(r.db.all("SELECT drawn_on, marker, value, unit, ref_low, ref_high, status FROM v_lab_result ORDER BY id")).toEqual([
      { drawn_on: "2026-03-19", marker: "ALT", value: 30, unit: "not recorded", ref_low: 5, ref_high: 40, status: "within" },
      { drawn_on: "2026-03-19", marker: "HbA1c", value: 5.2, unit: "not recorded", ref_low: 4, ref_high: 5.6, status: "within" },
      { drawn_on: "2026-03-19", marker: "Creatinine", value: 0.9, unit: "not recorded", ref_low: 0.7, ref_high: 1.3, status: "within" },
      { drawn_on: "2026-03-19", marker: "GFR", value: 100, unit: "not recorded", ref_low: 59, ref_high: null, status: "within" },
      { drawn_on: "2026-03-19", marker: "LDL", value: 140, unit: "not recorded", ref_low: null, ref_high: 100, status: "above" },
      { drawn_on: "2026-03-19", marker: "Vitamin D", value: 30.5, unit: "nmol/L", ref_low: 75, ref_high: 250, status: "below" },
      { drawn_on: "2026-06-27", marker: "ALT", value: 55, unit: "not recorded", ref_low: 5, ref_high: 40, status: "above" },
      { drawn_on: "2026-06-27", marker: "HbA1c", value: 5, unit: "not recorded", ref_low: 4, ref_high: 5.6, status: "within" },
      { drawn_on: "2026-06-27", marker: "Creatinine", value: 1, unit: "not recorded", ref_low: 0.7, ref_high: 1.3, status: "within" },
      { drawn_on: "2026-06-27", marker: "GFR", value: 95, unit: "not recorded", ref_low: 59, ref_high: null, status: "within" },
      { drawn_on: "2026-06-27", marker: "LDL", value: 110, unit: "not recorded", ref_low: null, ref_high: 100, status: "above" },
    ]);
    expect(r.rulings.find((x) => x.id === "hritvik/Bloods!6/percent_as_fraction")).toMatchObject({ kind: "semantic" });
    expect(r.rulings.find((x) => x.id === "hritvik/Bloods!7/combined_marker")).toMatchObject({ kind: "semantic" });
    expect(r.rulings.find((x) => x.id === "hritvik/Bloods!3/lab_units")).toMatchObject({ kind: "semantic" });
    expect(r.db.all("SELECT topic FROM v_member_note WHERE topic <> 'targets'")).toEqual([{ topic: "bloods: notes from Sheets" }]);
  });
});

describe("goals", () => {
  it("turns Trajectory weeks into planned goal points, and dates the goal lifts by ruling", async () => {
    const r = await run({
      Trajectory: [["Wk", "Week of", "Phase", "Target Waist", "Actual Waist", "Target Weight", "Actual Weight 7d", "Note"], [2, 46237, "P1 deficit", 90, "", 75, "", "Photos due"]],
      Log: [LOG_HEADER, set({ date: 46240, session: "Upper A", exercise: "Bench Press", set: 1, reps: 8, rir: 2, weight: 30, total: 30 })],
      "Chart Data": [[], [], ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "Bench Press", "", "", 70]],
      Guide: [["GUIDE"], ["WHO", "Target date", "Mon 7 Jun 2027. ASSUMED."]],
    });
    expect(r.db.all("SELECT metric, exercise_name, week_of, tier, value_low, unit, note FROM v_goal_point ORDER BY id")).toEqual([
      { metric: "waist_navel", exercise_name: null, week_of: "2026-08-02", tier: "planned", value_low: 90, unit: "cm", note: "P1 deficit; Photos due" },
      { metric: "weight", exercise_name: null, week_of: "2026-08-02", tier: "planned", value_low: 75, unit: "kg", note: "P1 deficit; Photos due" },
      { metric: null, exercise_name: "Bench Press", week_of: "2027-06-06", tier: "planned", value_low: 70, unit: "kg", note: "Goal lift from Chart Data; Sheets gives no date." },
    ]);
    expect(r.rulings.find((x) => x.id === "hritvik/Chart Data!3/undated_goal_lift")).toMatchObject({ kind: "semantic", proposal: "2027-06-07" });
  });
});
