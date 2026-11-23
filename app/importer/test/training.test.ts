// Log, Program and Cardio -> exercises, a programme, sessions with sets,
// and cardio sessions with blocks.
import { describe, expect, it } from "vitest";
import { rehearse } from "../src/rehearse";
import { basePeople, CARDIO_HEADER, LOG_HEADER, members, PROGRAM_HEADER, set, snapshot } from "./fixture";

const D1 = 46240; // 2026-08-06

function run(hritvik: Record<string, unknown[][]>, asha: Record<string, unknown[][]> = {}) {
  return rehearse({ snapshot: snapshot({ base: { People: basePeople() }, hritvik, asha } as never), members: members() });
}

const program = [
  PROGRAM_HEADER,
  ["Upper A", 1, "Bench Press", "Horizontal Press", 3, "8-10", 1, "90s", "40", "kg", "total", "2026-08-10 (progressed)", "Add 2.5 kg when 3x10 at RIR 1", "Arch", "40 total", "DB bench"],
  ["Upper A", 2, "Cable Fly  [SS-A]", "Chest Isolation", 2, 46310, 2, "45s", "5", "kg", "per side", "", "Add 2.5kg when 2x15", "Slow", "", ""],
  ["Upper A", 3, "Zone 2 Treadmill", "Cardio", "-", "25-30 min", "-", "-", "", "", "", "", "Add 2 min/wk", "Easy", "-", ""],
  ["Lower A", 1, "Leg Press", "Quad Compound", 4, "8-12", 1, "100s", 50, "kg", "per side", "", "Add 5 kg per side when 4x12", "", "", ""],
];

describe("exercises", () => {
  it("creates one exercise per distinct name (ignoring case), with a guessed implement kind, and asks about look-alikes", async () => {
    const r = await run({
      Log: [
        LOG_HEADER,
        set({ date: D1, session: "Upper A", exercise: "Bench Press", set: 1, reps: 8, weight: 30, total: 30 }),
        set({ date: D1, session: "Upper A", exercise: "bench press", set: 2, reps: 8, weight: 30, total: 30 }),
        set({ date: D1, session: "Upper A", exercise: "Low Row (machine)", set: 1, reps: 10, weight: 35, total: 35 }),
        set({ date: D1, session: "Upper A", exercise: "Low Row", set: 1, reps: 10, weight: 35, total: 35 }),
        set({ date: D1, session: "Upper A", exercise: "Wobble Thing", set: 1, reps: 10, basis: "bodyweight" }),
      ],
    });
    expect(r.db.all("SELECT name, implement_kind FROM exercise ORDER BY id")).toEqual([
      { name: "Bench Press", implement_kind: "barbell" },
      { name: "Low Row (machine)", implement_kind: "machine" },
      { name: "Low Row", implement_kind: "machine" },
      { name: "Wobble Thing", implement_kind: "other" },
    ]);
    expect(r.rulings.find((x) => x.id === "hritvik/Log!5/exercise_mapping")).toMatchObject({ kind: "semantic", proposal: "separate" });
    expect(r.rulings.find((x) => x.id === "hritvik/Log!6/exercise_kind")).toMatchObject({ kind: "semantic", proposal: "other" });
  });
});

describe("Log sets", () => {
  it("groups rows into sessions and logs each set through log_set, decoding RIR date serials mechanically", async () => {
    const r = await run({
      Log: [
        LOG_HEADER,
        set({ date: D1, session: "Upper A", exercise: "Bench Press", set: 1, reps: 8, rir: 46024, weight: 30, total: 30, volume: 240 }),
        set({ date: D1, session: "Upper A", exercise: "Bench Press", set: 2, reps: 6, rir: 0, weight: 32.5, total: 32.5, volume: 195, e1rm: 39 }),
        set({ date: D1, session: "Upper A", exercise: "DB Shoulder Press", set: 1, reps: 10, rir: "1-2", weight: 7.5, basis: "per hand", total: 15, volume: 150 }),
        set({ date: D1, session: "Upper A", exercise: "Leg Press", set: 1, reps: 12, rir: "", weight: 15, basis: "per side", total: 30, volume: 360 }),
        set({ date: D1, session: "Upper A", exercise: "Assisted Pull-up", set: 1, reps: 6, rir: 2, weight: 40, basis: "assistance" }),
        set({ date: D1, session: "Upper A", exercise: "Dead Hang", set: 1, reps: "", basis: "bodyweight", duration: 20 }),
        set({ date: D1 + 1, session: "Lower A", exercise: "Calf Raise (single-leg)", set: 1, reps: 12, rir: 1, weight: 10, basis: "per leg", total: 10, volume: 120 }),
      ],
    });
    expect(r.db.all("SELECT performed_on, session_type, state, (SELECT name FROM gym WHERE id = gym_id) AS gym FROM session ORDER BY id")).toEqual([
      { performed_on: "2026-08-06", session_type: "strength", state: "confirmed", gym: "Hritvik's gym" },
      { performed_on: "2026-08-07", session_type: "strength", state: "confirmed", gym: "Hritvik's gym" },
    ]);
    expect(r.db.all("SELECT exercise_name, set_number, reps, rir_status, rir_low, rir_high, load_status, load_value, load_basis, unilateral, bar_value, round(total_load_kg, 3) AS total, duration_s FROM v_set ORDER BY id")).toEqual([
      { exercise_name: "Bench Press", set_number: 1, reps: 8, rir_status: "recorded", rir_low: 1, rir_high: 2, load_status: "entered", load_value: 30, load_basis: "total", unilateral: 0, bar_value: null, total: 30, duration_s: null },
      { exercise_name: "Bench Press", set_number: 2, reps: 6, rir_status: "recorded", rir_low: 0, rir_high: 0, load_status: "entered", load_value: 32.5, load_basis: "total", unilateral: 0, bar_value: null, total: 32.5, duration_s: null },
      { exercise_name: "DB Shoulder Press", set_number: 1, reps: 10, rir_status: "recorded", rir_low: 1, rir_high: 2, load_status: "entered", load_value: 7.5, load_basis: "per_hand", unilateral: 0, bar_value: null, total: 15, duration_s: null },
      { exercise_name: "Leg Press", set_number: 1, reps: 12, rir_status: "not_recorded", rir_low: null, rir_high: null, load_status: "entered", load_value: 15, load_basis: "per_side", unilateral: 0, bar_value: 0, total: 30, duration_s: null },
      { exercise_name: "Assisted Pull-up", set_number: 1, reps: 6, rir_status: "recorded", rir_low: 2, rir_high: 2, load_status: "entered", load_value: -40, load_basis: "total", unilateral: 0, bar_value: null, total: -40, duration_s: null },
      { exercise_name: "Dead Hang", set_number: 1, reps: null, rir_status: "not_recorded", rir_low: null, rir_high: null, load_status: "none", load_value: null, load_basis: null, unilateral: 0, bar_value: null, total: null, duration_s: 20 },
      { exercise_name: "Calf Raise (single-leg)", set_number: 1, reps: 12, rir_status: "recorded", rir_low: 1, rir_high: 1, load_status: "entered", load_value: 10, load_basis: "per_leg", unilateral: 0, bar_value: null, total: 20, duration_s: null },
    ]);
    expect(r.rulings.find((x) => x.id === "hritvik/Log!2/rir_date_serial/I")).toMatchObject({ kind: "mechanical", decision: "accepted", proposal: { low: 1, high: 2 } });
    const detail = r.db.get<{ d: string }>("SELECT resolver_detail AS d FROM write_log WHERE tool = 'log_set' ORDER BY id LIMIT 1");
    expect(JSON.parse(String(detail?.d))).toMatchObject({ origin: { file: "hritvik", tab: "Log", row: 2 }, typed: { total_kg: 30, volume_kg: 240 } });
  });

  it("reads the Sheets' per-implement convention: a per-leg set covers both legs, e1RM is per hand, leg or side", async () => {
    const r = await run({
      Log: [
        LOG_HEADER,
        // Single-leg, 8 kg added, 12 reps each leg: Sheets types the total as one leg's load and volume for both.
        set({ date: D1, session: "Lower A", exercise: "Calf Raise (single-leg)", set: 1, reps: 12, rir: 2, weight: 8, basis: "per leg", total: 8, volume: 192 }),
        set({ date: D1, session: "Lower A", exercise: "Lateral Raise", set: 1, reps: 9, rir: 0, weight: 3, basis: "per hand", total: 6, volume: 54, e1rm: 3.9 }),
        set({ date: D1, session: "Lower A", exercise: "Cable Fly", set: 1, reps: 10, rir: 0, weight: 6, basis: "per side", total: 12, volume: 120, e1rm: 8 }),
        // A one-arm set still reads unilateral when the typed total is one hand's.
        set({ date: D1, session: "Lower A", exercise: "DB Row", set: 1, reps: 10, rir: 1, weight: 12, basis: "per hand", total: 12, volume: 120 }),
      ],
    });
    expect(r.db.all("SELECT exercise_name, unilateral, round(volume_kg, 3) AS volume, round(e1rm_kg, 3) AS e1rm FROM v_set ORDER BY id")).toEqual([
      { exercise_name: "Calf Raise (single-leg)", unilateral: 0, volume: 192, e1rm: null },
      { exercise_name: "Lateral Raise", unilateral: 0, volume: 54, e1rm: 3.9 },
      { exercise_name: "Cable Fly", unilateral: 0, volume: 120, e1rm: 8 },
      { exercise_name: "DB Row", unilateral: 1, volume: 120, e1rm: null },
    ]);
    const log = r.parity.differences.filter((d) => d.group.startsWith("Log"));
    expect(log).toEqual([]);
  });

  it("puts rows ruled to replace a pointer row in that row's place in the running order", async () => {
    const log = [
      LOG_HEADER,
      set({ date: "2026-09-30", session: "Full Body B", exercise: "Floor routine (unspecified)", set: 1, reps: "", basis: "bodyweight", type: "accessory" }),
      set({ date: "2026-09-30", session: "Full Body B", exercise: "Seated Row", set: 1, reps: 15, weight: 10, type: "working" }),
      set({ date: "2026-09-30", session: "Full Body B", exercise: "Bird Dog", set: 1, reps: 16, basis: "bodyweight", type: "accessory" }),
      set({ date: "2026-09-30", session: "Full Body B", exercise: "Dead Bug", set: 1, reps: 16, basis: "bodyweight", type: "accessory" }),
    ];
    const prior = { id: "asha/Log!2/rejected_by_api/log_set", origin: { file: "asha", tab: "Log", row: 2 }, code: "rejected_by_api", kind: "semantic" as const, cause: null, problem: "", proposed_fix: "", proposal: null, decision: "rejected" as const, decided_by: "Test", override: { replace_with_rows: "asha/Log!4-5", at_position_of: "asha/Log!2" }, day: null, row: {}, note: null };
    const r = await rehearse({ snapshot: snapshot({ base: { People: basePeople() }, asha: { Log: log } } as never), members: members(), previousRulings: [prior] });
    expect(r.db.all("SELECT exercise_name, position FROM v_set ORDER BY position")).toEqual([
      { exercise_name: "Bird Dog", position: 1 },
      { exercise_name: "Dead Bug", position: 2 },
      { exercise_name: "Seated Row", position: 3 },
    ]);
    expect(r.rulings.find((x) => x.id === "asha/Log!2/rejected_by_api/log_set")).toMatchObject({ decision: "rejected" });
  });

  it("asks about RIR text it cannot read, proposing not recorded", async () => {
    const r = await run({ Log: [LOG_HEADER, set({ date: D1, session: "Upper A", exercise: "Bench Press", set: 1, reps: 4, rir: "form-limited", weight: 30, total: 30 })] });
    expect(r.rulings.find((x) => x.id === "hritvik/Log!2/rir_text")).toMatchObject({ kind: "semantic", proposal: "not_recorded" });
    expect(r.db.get("SELECT rir_status FROM session_set")).toEqual({ rir_status: "not_recorded" });
  });

  it("logs a record-only member's sets with RIR not recorded", async () => {
    const r = await run({}, { Log: [LOG_HEADER, set({ date: "2026-09-28", session: "Full Body A", exercise: "Lat Pulldown", set: "1", reps: "20", weight: "7.5", basis: "", type: "accessory" })] });
    expect(r.db.get("SELECT set_type, reps, load_value, rir_status, state FROM session_set")).toEqual({ set_type: "working", reps: 20, load_value: 7.5, rir_status: "not_recorded", state: "confirmed" });
  });
});

describe("Program", () => {
  it("creates the programme: templates, ordered prescriptions and a provisional rotation", async () => {
    const r = await run({ Program: program, Log: [LOG_HEADER, set({ date: D1, session: "Upper A", exercise: "Bench Press", set: 1, reps: 8, rir: 2, weight: 30, total: 30 })] });
    expect(r.db.all("SELECT template_name, position, exercise_name, sets, rep_low, rep_high, rir_target_low, rest_s, current_load_value, current_load_basis, json_extract(progression_rule, '$.rep_top') AS top FROM v_prescription ORDER BY id")).toEqual([
      { template_name: "Upper A", position: 1, exercise_name: "Bench Press", sets: 3, rep_low: 8, rep_high: 10, rir_target_low: 1, rest_s: 90, current_load_value: 40, current_load_basis: "total", top: 10 },
      { template_name: "Upper A", position: 2, exercise_name: "Cable Fly", sets: 2, rep_low: 10, rep_high: 15, rir_target_low: 2, rest_s: 45, current_load_value: 5, current_load_basis: "per_side", top: 15 },
      { template_name: "Lower A", position: 1, exercise_name: "Leg Press", sets: 4, rep_low: 8, rep_high: 12, rir_target_low: 1, rest_s: 100, current_load_value: 50, current_load_basis: "per_side", top: 12 },
    ]);
    expect(r.db.get("SELECT template_id IS NOT NULL AS linked FROM session")).toEqual({ linked: 1 });
    expect(r.rulings.find((x) => x.id === "hritvik/Program!3/range_date_serial/F")).toMatchObject({ kind: "mechanical", proposal: { low: 10, high: 15 } });
    expect(r.rulings.find((x) => x.id === "hritvik/Program!2/progression_rule")).toMatchObject({ kind: "semantic", proposal: { kind: "rep_top", target_sets: 3, rep_top: 10, rir_floor: 1 } });
    expect(r.rulings.find((x) => x.id === "hritvik/Program!4/not_a_strength_prescription")).toMatchObject({ kind: "semantic", proposal: "member_note" });
    expect(r.rulings.find((x) => x.id === "hritvik/Program!1/programme_schedule")).toMatchObject({ kind: "semantic", proposal: "rotation" });
    expect(r.db.all("SELECT topic, subject_table FROM v_member_note WHERE topic <> 'targets' ORDER BY id")).toEqual([
      { topic: "prescription notes from Sheets", subject_table: "prescription" },
      { topic: "prescription notes from Sheets", subject_table: "prescription" },
      { topic: "prescription notes from Sheets", subject_table: "prescription" },
      { topic: "programme: Zone 2 Treadmill (Upper A)", subject_table: "programme" },
    ]);
  });
});

describe("Cardio", () => {
  it("groups blocks into cardio sessions and classes", async () => {
    const r = await run({
      Cardio: [
        CARDIO_HEADER,
        [D1, 1, "P1", "Zone 2", 1, 20, 5.5, 1, 1.8, 0.4545, 135, 145, "", "Yes", "Easy"],
        [D1, 1, "P1", "Zone 2", 2, 4, 6.5, 0, 0.43, 0.38, "", "", "", "", ""],
        [D1 + 1, 1, "P1", "Intervals", 1, 12, 9, 0, "", "", "", 170, "", "No", "", 5, 140],
        [D1 + 2, 1, "P1", "Dance Class", "Other", 45, "", "", "", "", 131.5, "", "", "", "Fun"],
      ],
    });
    expect(r.db.all("SELECT performed_on, session_type FROM session ORDER BY id")).toEqual([
      { performed_on: "2026-08-06", session_type: "cardio" },
      { performed_on: "2026-08-07", session_type: "cardio" },
      { performed_on: "2026-08-08", session_type: "class" },
    ]);
    expect(r.db.all("SELECT position, kind, duration_s, speed_value, distance_value, avg_hr, max_hr, conversational, rounds, recovery_hr FROM cardio_block ORDER BY id")).toEqual([
      { position: 1, kind: "steady", duration_s: 1200, speed_value: 5.5, distance_value: 1.8, avg_hr: 135, max_hr: 145, conversational: 1, rounds: null, recovery_hr: null },
      { position: 2, kind: "steady", duration_s: 240, speed_value: 6.5, distance_value: 0.43, avg_hr: null, max_hr: null, conversational: null, rounds: null, recovery_hr: null },
      { position: 1, kind: "interval", duration_s: 720, speed_value: 9, distance_value: null, avg_hr: null, max_hr: 170, conversational: 0, rounds: 5, recovery_hr: 140 },
      { position: 1, kind: "steady", duration_s: 2700, speed_value: null, distance_value: null, avg_hr: 132, max_hr: null, conversational: null, rounds: null, recovery_hr: null },
    ]);
    expect(r.rulings.find((x) => x.id === "hritvik/Cardio!5/hr_not_integer/K")).toMatchObject({ kind: "semantic", proposal: 132 });
  });
});
