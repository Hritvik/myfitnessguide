// Decided rulings whose override asks the importer for more than "apply the
// proposal": progression increments and cues, non-rep prescriptions,
// substitution sets, values read by hand, sets left out with their note
// kept on the prescription, manual macros for a refused row, and an
// unitemised remainder. Invented values only.
import { describe, expect, it } from "vitest";
import { rehearse } from "../src/rehearse";
import type { Ruling } from "../src/rulings";
import { basePeople, DAILY_HEADER, food, FOOD_HEADER, intake, LOG_HEADER, members, NUTRITION_HEADER, PROGRAM_HEADER, recipe, RECIPES_HEADER, set, snapshot } from "./fixture";

const D1 = 46240; // 2026-08-06

function ruled(id: string, override: unknown, decision: "accepted" | "rejected" = "accepted"): Ruling {
  const m = /^([^/]+)\/([^!]+)!(\d+)\/([^/]+)/.exec(id) as RegExpExecArray;
  return {
    id, origin: { file: m[1] as string, tab: m[2] as string, row: Number(m[3]) }, code: m[4] as string, kind: "semantic", cause: null,
    problem: "", proposed_fix: "", proposal: null, decision, decided_by: "Test", override, day: null, row: {}, note: null,
  };
}

const program = [
  PROGRAM_HEADER,
  ["Upper A", 1, "Bench Press", "Press", 3, "8-10", 1, "90s", 40, "kg", "per side", "", "Add 5 lb per side when 3x10", "Arch", "", ""],
  ["Upper A", 2, "Dead Hang", "Grip", 3, "max time", "-", "60s", "", "", "", "", "", "Full hang", "", ""],
  ["Upper A", 3, "Zone 2 Treadmill", "Cardio", "-", "20-25 min", "-", "-", "", "", "", "", "", "Easy", "", ""],
  ["Upper A", 4, "Farmer Walk", "Carry", 2, "30 m", "-", "60s", 12, "kg", "per hand", "", "", "", "", ""],
  ["Upper A", 5, "Leg Extension", "Quads", 3, "10-12", 1, "60s", 25, "kg", "Machine", "", "Add the smallest step when 3x12", "", "", ""],
  ["Upper A", 6, "Lateral Raise", "Delts", 3, "12-15", 1, "45s", 4, "kg", "per hand", "", "Move up only after clean 3x15", "", "", ""],
];

const programRulings = [
  ruled("hritvik/Program!2/progression_rule", { kind: "rep_top", target_sets: 3, rep_top: 10, rir_floor: "from_prescription", increment: { min_kg: 2.268, max_kg: 2.268, basis: "per_side" }, cue: "Pause on the chest." }),
  ruled("hritvik/Program!3/not_a_strength_prescription", { prescription_target: "duration", progression: "manual" }),
  ruled("hritvik/Program!4/not_a_strength_prescription", { prescription_target: "duration", progression: "manual" }),
  ruled("hritvik/Program!5/not_a_strength_prescription", { prescription_target: "distance", progression: "manual" }),
  ruled("hritvik/Program!6/progression_rule", { kind: "rep_top", target_sets: 3, rep_top: 12, rir_floor: 1, increment: { min_kg: 0, max_kg: 0, basis: "total" }, per_leg: true }),
  ruled("hritvik/Program!7/progression_rule", { kind: "manual", cue: "Only after a clean 3x15." }),
];

describe("programme overrides", () => {
  it("stores increments, cues, per_leg and RIR floors from the rulings, and keeps non-rep rows as prescriptions", async () => {
    const r = await rehearse({ snapshot: snapshot({ base: { People: basePeople() }, hritvik: { Program: program } } as never), members: members(), previousRulings: programRulings });
    const rows = r.db.all<{ exercise_name: string; target_kind: string; sets: number | null; rep_low: number | null; rir_target_low: number | null; duration_low_s: number | null; duration_high_s: number | null; distance_value: number | null; rule: string | null }>(
      "SELECT exercise_name, target_kind, sets, rep_low, rir_target_low, duration_low_s, duration_high_s, distance_value, progression_rule AS rule FROM v_prescription ORDER BY position",
    );
    expect(rows.map((x) => ({ ...x, rule: x.rule === null ? null : JSON.parse(x.rule) }))).toEqual([
      { exercise_name: "Bench Press", target_kind: "reps", sets: 3, rep_low: 8, rir_target_low: 1, duration_low_s: null, duration_high_s: null, distance_value: null,
        rule: { kind: "rep_top", target_sets: 3, rep_top: 10, rir_floor: "from_prescription", increment: { min: 2.268, max: 2.268, unit: "kg", basis: "per_side" }, cue: "Pause on the chest." } },
      { exercise_name: "Dead Hang", target_kind: "duration", sets: 3, rep_low: null, rir_target_low: null, duration_low_s: null, duration_high_s: null, distance_value: null, rule: { kind: "manual" } },
      { exercise_name: "Zone 2 Treadmill", target_kind: "duration", sets: null, rep_low: null, rir_target_low: null, duration_low_s: 1200, duration_high_s: 1500, distance_value: null, rule: { kind: "manual" } },
      { exercise_name: "Farmer Walk", target_kind: "distance", sets: 2, rep_low: null, rir_target_low: null, duration_low_s: null, duration_high_s: null, distance_value: 30, rule: { kind: "manual" } },
      { exercise_name: "Leg Extension", target_kind: "reps", sets: 3, rep_low: 10, rir_target_low: 1, duration_low_s: null, duration_high_s: null, distance_value: null,
        rule: { kind: "rep_top", target_sets: 3, rep_top: 12, rir_floor: 1, increment: "smallest_step", per_leg: true } },
      { exercise_name: "Lateral Raise", target_kind: "reps", sets: 3, rep_low: 12, rir_target_low: 1, duration_low_s: null, duration_high_s: null, distance_value: null, rule: { kind: "manual", cue: "Only after a clean 3x15." } },
    ]);
    expect(r.db.all("SELECT topic FROM v_member_note WHERE subject_table = 'programme'")).toEqual([]);
    expect(r.db.get("SELECT current_load_value, current_load_basis FROM v_prescription WHERE exercise_name = 'Farmer Walk'")).toEqual({ current_load_value: 12, current_load_basis: "per_hand" });
  });
});

describe("Log overrides", () => {
  const log = [
    LOG_HEADER,
    set({ date: D1, session: "Upper A", exercise: "Bench Press", set: 1, reps: 10, rir: 2, weight: 20, basis: "per side", total: 40 }),
    { ...set({ date: D1, session: "Upper A", exercise: "Bench Press (smith)", set: 1, reps: "", rir: "", weight: 20, basis: "per side", total: 40 }), 15: "Stopped early; reps not counted." },
    set({ date: D1, session: "Upper A", exercise: "Goblet Squat", set: 1, reps: 12, rir: 2, weight: 10, type: "substitute" }),
    set({ date: D1, session: "Upper A", exercise: "Split Squat", set: 1, reps: "8 / 7", rir: 1, basis: "bodyweight" }),
  ].map((row) => (Array.isArray(row) ? row : Object.values(row)));

  const logRulings = [
    ruled("hritvik/Log!3/rejected_by_api/log_set", { member_note_on_prescription: true }, "rejected"),
    ruled("hritvik/Log!4/substitution_set", { set_type: "substitution", replaces: "Leg Extension" }),
    ruled("hritvik/Log!5/unreadable_value", { reps: 7, note: "Reported as 8 / 7 per leg; the weaker side is recorded." }),
  ];

  it("links a substitution to the prescription it replaced, reads a value by hand, and keeps a left-out set's note on its prescription", async () => {
    const r = await rehearse({ snapshot: snapshot({ base: { People: basePeople() }, hritvik: { Program: program, Log: log } } as never), members: members(), previousRulings: [...programRulings, ...logRulings] });
    const sets = r.db.all("SELECT v.exercise_name, v.set_type, v.reps, s.note, (SELECT e.name FROM prescription p JOIN exercise e ON e.id = p.exercise_id WHERE p.id = v.substituted_prescription_id) AS replaced FROM v_set v JOIN session_set s ON s.id = v.id ORDER BY v.id");
    expect(sets).toEqual([
      { exercise_name: "Bench Press", set_type: "working", reps: 10, note: null, replaced: null },
      { exercise_name: "Goblet Squat", set_type: "substitution", reps: 12, note: "Sheets set type: substitute", replaced: "Leg Extension" },
      { exercise_name: "Split Squat", set_type: "working", reps: 7, note: "Reported as 8 / 7 per leg; the weaker side is recorded.", replaced: null },
    ]);
    const note = r.db.get<{ body: string; ex: string }>(
      "SELECT n.body, e.name AS ex FROM v_member_note n JOIN prescription p ON p.id = n.subject_id JOIN exercise e ON e.id = p.exercise_id WHERE n.subject_table = 'prescription' AND n.topic = 'set left out of the import'",
    );
    expect(note?.ex).toBe("Bench Press");
    expect(note?.body).toContain("Stopped early; reps not counted.");
    expect(note?.body).toContain("2026-08-06");
  });
});

describe("nutrition overrides", () => {
  const whey = { ref: "FS001", name: "Test whey", serving: "1 scoop (30 g)", kcal: 120, protein: 24, carbs: 3, fat: 1 };
  const base = {
    People: basePeople(),
    "Food Sources": [FOOD_HEADER, food(whey)],
    Recipes: [RECIPES_HEADER, recipe({ ref: "R001", name: "Idea bowl", macros: [300, 20, 30, 10], derivation: "stored", kind: "meal plan" })],
  };

  it("replaces a refused row with the manual macros its ruling gives", async () => {
    const nutrition = [NUTRITION_HEADER, intake({ date: D1, meal: "Dinner", item: "Idea bowl", person: "Hritvik", ref: "R001", qty: 1, macros: ["300", "20", "30", "10"] })];
    const prior = ruled("hritvik/Nutrition!2/rejected_by_api/log_intake", { manual_macros: { kcal: 410, protein_g: 22, carbs_g: 35, fat_g: 18 }, provenance: "estimated", confidence: "low", reason: "The idea was not what was eaten." });
    const r = await rehearse({ snapshot: snapshot({ base, hritvik: { Nutrition: nutrition } } as never), members: members(), previousRulings: [prior] });
    expect(r.db.get("SELECT source_kind AS source, manual_kcal, manual_protein_g, manual_carbs_g, manual_fat_g, manual_reason, provenance, confidence FROM intake_item")).toEqual({
      source: "manual", manual_kcal: 410, manual_protein_g: 22, manual_carbs_g: 35, manual_fat_g: 18, manual_reason: "The idea was not what was eaten.", provenance: "estimated", confidence: "low",
    });
    expect(r.rulings.find((x) => x.id === prior.id)).toMatchObject({ decision: "accepted" });
  });

  it("adds an unitemised item for a DAY TOTAL above its items, provenance reconstructed", async () => {
    const nutrition = [
      NUTRITION_HEADER,
      intake({ date: D1, meal: "Breakfast", item: "Whey", person: "Hritvik", ref: "FS001", qty: 2 }),
      intake({ date: D1, meal: "DAY TOTAL", item: "", person: "Hritvik", macros: [300, 52, 10, 5] }),
    ];
    const prior = ruled("hritvik/Nutrition!3/day_total_with_items", { keep_items_plus_remainder: true, provenance: "reconstructed" });
    const daily = [DAILY_HEADER, [D1, "Hritvik", 240, 48, 6, 2, 1]];
    const r = await rehearse({ snapshot: snapshot({ base, hritvik: { Nutrition: nutrition, "Daily Nutrition": daily } } as never), members: members(), previousRulings: [prior] });
    const items = r.db.all("SELECT source_kind AS source, label, manual_kcal, manual_protein_g, manual_carbs_g, manual_fat_g, provenance FROM intake_item ORDER BY id");
    expect(items[1]).toEqual({ source: "manual", label: "Unitemised (DAY TOTAL minus items)", manual_kcal: 60, manual_protein_g: 4, manual_carbs_g: 4, manual_fat_g: 3, provenance: "reconstructed" });
    // Sheets' daily total sums the items only: the difference is the ruled remainder.
    const day = r.parity.differences.filter((d) => d.group === "Day totals");
    expect(day.map((d) => [d.metric, d.status, d.cause])).toEqual([
      ["carbs_g", "explained", "manual-macros"], ["fat_g", "explained", "manual-macros"], ["kcal", "explained", "manual-macros"], ["protein_g", "explained", "manual-macros"],
    ]);
  });
});
