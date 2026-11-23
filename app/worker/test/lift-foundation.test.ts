import { describe, expect, it } from "vitest";
import { Ctx } from "../src/context";
import { foldLifts, liftGroups, memberExerciseSets, noE1rmReason, weeklyVolume } from "../src/training";
import { setup } from "./harness";
import { seedTraining } from "./seed";

const YEAR_TODAY = "2026-10-05";

const agent = (x: ReturnType<typeof setup>) =>
  new Ctx(x.counter, { kind: "agent", resolver: "claude_code", householdId: x.h.id, clientId: "test" }, () => x.clock.now, "Asia/Kolkata");

function seeded() {
  const x = setup();
  const s = seedTraining(x);
  for (const [date, load] of [["2026-05-25", 30], ["2026-06-08", 35], [YEAR_TODAY, 40]] as const) {
    const confirmed_at = `${date}T10:00:00Z`;
    const session = x.t.insert("session", { member_id: x.h.hritvik, performed_on: date, gym_id: s.gym, session_type: "strength", state: "confirmed", confirmed_at });
    x.t.insert("session_set", { session_id: session, exercise_id: s.bench, set_number: 1, set_type: "working", reps: 8, reps_inferred: 0, load_status: "entered", load_value: load, load_unit: "kg", load_basis: "total", load_implement_id: s.barbell, rir_status: "recorded", rir_low: 2, rir_high: 2, state: "confirmed", confirmed_at, position: 1 });
    x.t.insert("session_set", { session_id: session, exercise_id: s.pulldown, set_number: 1, set_type: "working", reps: 11, reps_inferred: 0, load_status: "entered", load_value: load, load_unit: "kg", load_basis: "total", load_implement_id: s.stack, rir_status: "recorded", rir_low: 1, rir_high: 1, state: "confirmed", confirmed_at, position: 2 });
  }
  return { x, s };
}

function history(weeks: number) {
  const { x, s } = seeded();
  for (let week = 1; week <= weeks; week++) {
    const date = new Date(Date.parse(`${YEAR_TODAY}T00:00:00Z`) - week * 7 * 86_400_000).toISOString().slice(0, 10);
    const confirmed_at = `${date}T10:00:00Z`;
    const session = x.t.insert("session", { member_id: x.h.hritvik, performed_on: date, gym_id: s.gym, session_type: "strength", state: "confirmed", confirmed_at });
    for (const [position, exercise, implement] of [[1, s.curl, s.dumbbells], [2, s.dbBench, s.dumbbells], [3, s.calf, s.fixedBars]] as const) {
      x.t.insert("session_set", { session_id: session, exercise_id: exercise, set_number: 1, set_type: "working", reps: 8, reps_inferred: 0, load_status: "entered", load_value: 10, load_unit: "kg", load_basis: "total", load_implement_id: implement, rir_status: "recorded", rir_low: 2, rir_high: 2, state: "confirmed", confirmed_at, position });
    }
  }
  return x;
}

describe("training chart foundations", () => {
  it("loads several exercises in one batch, newest session first", async () => {
    const { x, s } = seeded();
    x.counter.reset();
    const loaded = await memberExerciseSets(agent(x), x.h.hritvik, [s.bench, s.pulldown], { from: "2026-01-01", to: YEAR_TODAY });
    expect(new Set(loaded.sets.map((set) => set.exercise_id))).toEqual(new Set([s.bench, s.pulldown]));
    expect(loaded.sets.map((set) => set.performed_on)).toEqual([...loaded.sets.map((set) => set.performed_on)].sort().reverse());
    expect(x.counter.count).toBeLessThanOrEqual(4);
  });

  it("aggregates session and Sunday-week groups, preserving drafts and inferred reps", async () => {
    const { x, s } = seeded();
    const session = x.t.get("SELECT id FROM session WHERE member_id = ? AND performed_on = ?", x.h.hritvik, YEAR_TODAY)!.id as number;
    const best = x.t.get("SELECT id FROM session_set WHERE session_id = ? AND exercise_id = ? AND reps = 11", session, s.pulldown)!.id as number;
    x.t.run("UPDATE session_set SET reps_inferred = 1 WHERE id = ?", best);
    x.t.insert("session_set", {
      session_id: session, exercise_id: s.dbBench, set_number: 99, set_type: "working", reps: 8,
      load_status: "entered", load_value: 15, load_unit: "kg", load_basis: "per_hand", load_implement_id: s.dumbbells,
      rir_status: "recorded", rir_low: 2, rir_high: 2, state: "draft", position: 99,
    });
    const sled = x.t.insert("implement", { gym_id: s.gym, name: "Sled", kind: "plate_loaded", unit: "kg", loading: "plates_only", load_list_complete: 0 });
    const sledPush = x.t.insert("exercise", { household_id: x.h.id, name: "Sled push", implement_kind: "plate_loaded" });
    x.t.insert("session_set", { session_id: session, exercise_id: sledPush, set_number: 1, set_type: "working", reps: 8, reps_inferred: 0, load_status: "entered", load_value: 20, load_unit: "kg", load_basis: "per_side", load_implement_id: sled, rir_status: "recorded", rir_low: 2, rir_high: 2, state: "confirmed", confirmed_at: `${YEAR_TODAY}T10:00:00Z`, position: 100 });

    const bySession = await liftGroups(agent(x), x.h.hritvik, "session", { from: YEAR_TODAY, to: YEAR_TODAY });
    expect(bySession.find((group) => group.exercise_id === s.pulldown)?.e1rm).toMatchObject({ set_id: best, reps: 11, rir_low: 1, reps_assumed: true });
    expect(bySession.find((group) => group.exercise_id === s.dbBench)?.has_draft).toBe(true);
    expect(bySession.find((group) => group.exercise_id === sledPush)).toMatchObject({ e1rm: null, top_set: null, plates_only_estimates: 1 });
    const byWeek = await liftGroups(agent(x), x.h.hritvik, "week", { from: YEAR_TODAY, to: YEAR_TODAY });
    expect(byWeek.every((group) => group.week_start === "2026-10-04" && group.session_id === null)).toBe(true);
  });

  it("keeps fallback top sets when an implement is absent and either RIR or reps is omitted", async () => {
    const { x } = seeded();
    const session = x.t.get("SELECT id FROM session WHERE member_id = ? AND performed_on = ?", x.h.hritvik, YEAR_TODAY)!.id as number;
    const noRir = x.t.insert("exercise", { household_id: x.h.id, name: "Uncatalogued press", implement_kind: "machine" });
    const noReps = x.t.insert("exercise", { household_id: x.h.id, name: "Uncatalogued carry", implement_kind: "dumbbell" });
    x.t.insert("session_set", { session_id: session, exercise_id: noRir, set_number: 1, set_type: "working", reps: 8, reps_inferred: 0, load_status: "entered", load_value: 25, load_unit: "kg", load_basis: "total", load_implement_id: null, rir_status: null, state: "draft", position: 10 });
    x.t.insert("session_set", { session_id: session, exercise_id: noReps, set_number: 1, set_type: "working", reps: null, reps_inferred: 0, duration_s: 40, load_status: "entered", load_value: 20, load_unit: "kg", load_basis: "total", load_implement_id: null, rir_status: "recorded", rir_low: 2, rir_high: 2, state: "confirmed", confirmed_at: `${YEAR_TODAY}T10:00:00Z`, position: 11 });
    const groups = await liftGroups(agent(x), x.h.hritvik, "session", { from: YEAR_TODAY, to: YEAR_TODAY });
    expect(groups.find((group) => group.exercise_id === noRir)?.top_set).toMatchObject({ total_kg: 25, reps: 8 });
    expect(groups.find((group) => group.exercise_id === noReps)?.top_set).toMatchObject({ total_kg: 20, reps: null });
  });

  it("keeps plates-only fallback top sets when either RIR or reps is omitted", async () => {
    const { x, s } = seeded();
    const session = x.t.get("SELECT id FROM session WHERE member_id = ? AND performed_on = ?", x.h.hritvik, YEAR_TODAY)!.id as number;
    const sled = x.t.insert("implement", { gym_id: s.gym, name: "Regression sled", kind: "plate_loaded", unit: "kg", loading: "plates_only", load_list_complete: 0 });
    const noRir = x.t.insert("exercise", { household_id: x.h.id, name: "Sled press without RIR", implement_kind: "plate_loaded" });
    const noReps = x.t.insert("exercise", { household_id: x.h.id, name: "Sled push without reps", implement_kind: "plate_loaded" });
    x.t.insert("session_set", { session_id: session, exercise_id: noRir, set_number: 1, set_type: "working", reps: 8, reps_inferred: 0, load_status: "entered", load_value: 25, load_unit: "kg", load_basis: "per_side", load_implement_id: sled, rir_status: null, state: "draft", position: 12 });
    x.t.insert("session_set", { session_id: session, exercise_id: noReps, set_number: 1, set_type: "working", reps: null, reps_inferred: 0, duration_s: 40, load_status: "entered", load_value: 20, load_unit: "kg", load_basis: "per_side", load_implement_id: sled, rir_status: "recorded", rir_low: 2, rir_high: 2, state: "confirmed", confirmed_at: `${YEAR_TODAY}T10:00:00Z`, position: 13 });
    const groups = await liftGroups(agent(x), x.h.hritvik, "session", { from: YEAR_TODAY, to: YEAR_TODAY });
    expect(groups.find((group) => group.exercise_id === noRir)?.top_set).toMatchObject({ total_kg: 50, reps: 8 });
    expect(groups.find((group) => group.exercise_id === noReps)?.top_set).toMatchObject({ total_kg: 40, reps: null });
  });

  it("does not collapse Oct 5 and Oct 7/9 across a midweek method change", async () => {
    const x = setup();
    const s = seedTraining(x);
    const add = (date: string, load: number) => {
      const confirmed_at = `${date}T10:00:00Z`;
      const session = x.t.insert("session", { member_id: x.h.hritvik, performed_on: date, gym_id: s.gym, session_type: "strength", state: "confirmed", confirmed_at });
      x.t.insert("session_set", { session_id: session, exercise_id: s.pulldown, set_number: 1, set_type: "working", reps: 8, reps_inferred: 0, load_status: "entered", load_value: load, load_unit: "kg", load_basis: "total", load_implement_id: s.stack, rir_status: "recorded", rir_low: 2, rir_high: 2, state: "confirmed", confirmed_at, position: 1 });
    };
    add("2026-10-05", 60);
    add("2026-10-07", 40);
    add("2026-10-09", 45);
    x.t.insert("method_change", { member_id: x.h.hritvik, exercise_id: s.pulldown, changed_on: "2026-10-07", note: "new setup" });
    const weeks = await liftGroups(agent(x), x.h.hritvik, "week", { from: "2026-10-04", to: "2026-10-10" });
    const folded = foldLifts(weeks, [{ exercise_id: s.pulldown, date: "2026-10-07" }]).get(s.pulldown)!;
    expect(folded.points.map((point) => ({ date: point.date, segment: point.segment, kg: point.e1rm?.kg }))).toEqual([
      { date: "2026-10-05", segment: 0, kg: 60 * (1 + 10 / 30) },
      { date: "2026-10-09", segment: 1, kg: 45 * (1 + 10 / 30) },
    ]);
    expect(folded.best_e1rm?.kg).toBe(60 * (1 + 10 / 30));
  });

  it("cuts exercise series at method changes and explains missing estimates", async () => {
    const { x, s } = seeded();
    const groups = await liftGroups(agent(x), x.h.hritvik, "session");
    const series = foldLifts(groups, [{ exercise_id: s.bench, date: "2026-06-01" }]);
    const bench = series.get(s.bench)!;
    expect(bench.points.filter((point) => point.date < "2026-06-01").every((point) => point.segment === 0)).toBe(true);
    expect(bench.points.filter((point) => point.date >= "2026-06-01").every((point) => point.segment === 1)).toBe(true);
    const base = { best_e1rm: null, loaded_sets: 4, rep_sets: 4, rir_sets: 4, plates_only_estimates: 0 };
    expect(noE1rmReason(base, { bodyweight_dominant: 1 })).toBe("bodyweight_dominant");
    expect(noE1rmReason({ ...base, rep_sets: 0, rir_sets: 0, plates_only_estimates: 2 }, { bodyweight_dominant: 0 })).toBe("plates_only");
    expect(noE1rmReason({ ...base, rep_sets: 0, rir_sets: 0 }, { bodyweight_dominant: 0 })).toBe("no_reps");
    expect(noE1rmReason({ ...base, rir_sets: 0 }, { bodyweight_dominant: 0 })).toBe("no_rir");
    expect(noE1rmReason(base, { bodyweight_dominant: 0 })).toBe("over_cap");
  });

  it("fills empty Sunday weeks without calling unknown volume zero", async () => {
    const { x } = seeded();
    const rows = weeklyVolume(await liftGroups(agent(x), x.h.hritvik, "session"), YEAR_TODAY);
    expect(rows.find((row) => row.week_start === "2026-08-02")).toEqual({ week_start: "2026-08-02", sessions: 0, working_sets: 0, volume_kg: null, sets_without_volume: 0 });
  });

  it("keeps broad lift_history within 30 statements and flat from one year to two", async () => {
    const one = history(52);
    const a = await one.counted("lift_history", { member: "Hritvik", pattern: "*", sessions: 100 }, "asha");
    expect(a.statements, a.log.join("\n")).toBeLessThanOrEqual(30);
    const two = history(104);
    const b = await two.counted("lift_history", { member: "Hritvik", pattern: "*", sessions: 100 }, "asha");
    expect(b.statements, b.log.join("\n")).toBe(a.statements);
  });
});
