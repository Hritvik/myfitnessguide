// Migration 0030 goes onto a live database holding data. It copies the
// exercise aliases into the one alias store (spec §6), keeps exercise_alias
// for the Worker still running until the deploy (and for a rollback), and
// otherwise only adds tables and a nullable column, so every row comes
// through, the aliases keep their ids, and v_exercise reads exactly as before.
import { describe, expect, it } from "vitest";
import { NOW, TestDb } from "./db";
import { exercise, foodSource, gym, household, session, writeLog } from "./fixtures";

/** The migration before this one: the display plan's 0029_leftover_servings (TestDb stops at the last file at or below it). */
const BEFORE = "0029";

function populated() {
  const t = new TestDb({ through: BEFORE });
  const h = household(t);
  const pulldown = exercise(t, h, { name: "Cable lat pulldown", implement_kind: "cable" });
  const bench = exercise(t, h, { name: "Barbell bench press", implement_kind: "barbell" });
  t.insert("exercise_alias", { exercise_id: pulldown, alias: "lat pulldown" });
  t.insert("exercise_alias", { exercise_id: pulldown, alias: "LPD" });
  t.insert("exercise_alias", { exercise_id: bench, alias: "bench" });
  const g = gym(t, h);
  const s = session(t, h.hritvik, g, { state: "confirmed", confirmed_at: NOW });
  return { t, h, s };
}

describe("migration 0030 on a database holding data", () => {
  it("copies every exercise alias into the alias store with its id, keeps exercise_alias as it was, and v_exercise reads the same", () => {
    const { t, h } = populated();
    const view = t.all("SELECT id, name, aliases FROM v_exercise ORDER BY id");
    const old = t.all("SELECT id, exercise_id, alias FROM exercise_alias ORDER BY id");
    t.migrateAfter(BEFORE);
    expect(t.all("SELECT id, name, aliases FROM v_exercise ORDER BY id")).toEqual(view);
    expect(t.all("SELECT id, household_id, alias, kind, target_id, created_by FROM alias ORDER BY id")).toEqual(
      old.map((a) => ({ id: a.id, household_id: h.id, alias: a.alias, kind: "exercise", target_id: a.exercise_id, created_by: null })),
    );
    // The Worker still running until the deploy (or restored by a rollback) reads exercise_alias: it stays as it was.
    expect(t.all("SELECT id, exercise_id, alias FROM exercise_alias ORDER BY id")).toEqual(old);
    expect(t.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(t.get("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
  });

  it("keeps every session, with no workout", () => {
    const { t, s } = populated();
    const before = t.all("SELECT * FROM session ORDER BY id");
    t.migrateAfter(BEFORE);
    expect(t.all("SELECT * FROM session ORDER BY id")).toEqual(before.map((r) => ({ ...r, workout_id: null })));
    expect(t.get("SELECT workout_id FROM session WHERE id = ?", s)).toEqual({ workout_id: null });
  });
});

describe("the alias store", () => {
  it("holds one meaning per word, ignoring case, across every kind", () => {
    const t = new TestDb();
    const h = household(t);
    const food = foodSource(t, h, { name: "Paneer bhurji" });
    const e = exercise(t, h);
    t.insert("alias", { household_id: h.id, alias: "PB", kind: "food_source", target_id: food, created_at: NOW });
    expect(() => t.insert("alias", { household_id: h.id, alias: "pb", kind: "exercise", target_id: e, created_at: NOW })).toThrow(/UNIQUE/);
  });

  it("refuses an unknown kind, a blank word and a word with space around it", () => {
    const t = new TestDb();
    const h = household(t);
    const e = exercise(t, h);
    const row = (over: Record<string, unknown>) => ({ household_id: h.id, alias: "row", kind: "exercise", target_id: e, created_at: NOW, ...over });
    expect(() => t.insert("alias", row({ kind: "cook" }))).toThrow(/CHECK/);
    expect(() => t.insert("alias", row({ alias: "  " }))).toThrow(/CHECK/);
    expect(() => t.insert("alias", row({ alias: " row" }))).toThrow(/CHECK/);
  });
});

describe("workouts", () => {
  function base() {
    const t = new TestDb();
    const h = household(t);
    const e = exercise(t, h, { name: "Goblet squat", implement_kind: "dumbbell" });
    const w = t.insert("workout", { household_id: h.id, name: "Hotel legs", created_at: NOW });
    const line = (over: Record<string, unknown> = {}) =>
      t.insert("workout_line", { workout_id: w, position: 1, exercise_id: e, sets: 3, target_kind: "reps", rep_low: 10, rep_high: 12, ...over });
    return { t, h, e, w, line };
  }

  it("are named once per household, ignoring case", () => {
    const { t, h } = base();
    expect(() => t.insert("workout", { household_id: h.id, name: "HOTEL LEGS", created_at: NOW })).toThrow(/UNIQUE/);
  });

  it("number their lines once each", () => {
    const { line } = base();
    line();
    expect(() => line()).toThrow(/UNIQUE/);
  });

  it("give each line one target: reps, a duration or a distance", () => {
    const { line } = base();
    expect(() => line({ duration_s: 60 })).toThrow(/CHECK/);
    expect(() => line({ target_kind: "duration", rep_low: null, rep_high: null })).toThrow(/CHECK/);
    expect(() => line({ rep_low: 12, rep_high: 10 })).toThrow(/CHECK/);
    expect(line({ position: 2, target_kind: "duration", rep_low: null, rep_high: null, duration_s: 45 })).toBeGreaterThan(0);
  });

  it("hold a default load as a value, plates per side on a bar, or none", () => {
    const { t, line } = base();
    expect(line({ position: 2, load_kind: "value", load_value: 12.5, load_unit: "kg", load_basis: "per_hand" })).toBeGreaterThan(0);
    expect(line({ position: 3, load_kind: "none" })).toBeGreaterThan(0);
    const plates = JSON.stringify([{ value: 10, unit: "kg", count: 1 }, { value: 5, unit: "lb", count: 1 }]);
    expect(line({ position: 4, load_kind: "plates", load_value: 12.27, load_unit: "kg", load_basis: "per_side", bar_value: 20, bar_unit: "kg", plates })).toBeGreaterThan(0);
    expect(() => line({ position: 5, load_kind: "plates", load_value: 12.27, load_unit: "kg", load_basis: "total", plates })).toThrow(/CHECK/);
    expect(() => line({ position: 6, load_kind: "value" })).toThrow(/CHECK/);
    expect(() => line({ position: 7, load_kind: "none", load_value: 5, load_unit: "kg", load_basis: "total" })).toThrow(/CHECK/);
    expect(() => line({ position: 8, rir_low: 2 })).toThrow(/CHECK/);
    void t;
  });

  it("a session follows a template or a workout, never both", () => {
    const { t, h, w } = base();
    const g = gym(t, h);
    const programme = t.insert("programme", { member_id: h.hritvik, name: "Base", schedule_kind: "rotation", active: 1, started_on: "2026-08-01" });
    const template = t.insert("session_template", { programme_id: programme, name: "Upper A", session_type: "strength" });
    expect(session(t, h.hritvik, g, { workout_id: w })).toBeGreaterThan(0);
    expect(() => session(t, h.hritvik, g, { workout_id: w, template_id: template })).toThrow(/CHECK/);
  });
});

describe("inbox entries, feedback and router stats", () => {
  it("an inbox entry is pending until resolved or rejected with a note", () => {
    const t = new TestDb();
    const h = household(t);
    const entry = (over: Record<string, unknown> = {}) =>
      t.insert("inbox_entry", { member_id: h.hritvik, entry_on: "2026-10-05", text: "2 idli and the green chutney", spans: JSON.stringify([{ text: "the green chutney", start: 11, end: 28 }]), created_at: NOW, ...over });
    expect(entry()).toBeGreaterThan(0);
    expect(() => entry({ status: "resolved", resolved_at: NOW })).toThrow(/CHECK/);
    expect(() => entry({ status: "pending", resolved_at: NOW })).toThrow(/CHECK/);
    expect(() => entry({ spans: "[]" })).toThrow(/CHECK/);
    expect(entry({ status: "rejected", resolved_at: NOW, resolution_note: "a duplicate of lunch" })).toBeGreaterThan(0);
  });

  it("feedback has a type, a context object, and a note once triaged", () => {
    const t = new TestDb();
    const h = household(t);
    const fb = (over: Record<string, unknown> = {}) =>
      t.insert("feedback", { member_id: h.asha, type: "confusing", text: "Which button saves?", context: JSON.stringify({ route: "/" }), created_at: NOW, ...over });
    expect(fb()).toBeGreaterThan(0);
    expect(() => fb({ type: "praise" })).toThrow(/CHECK/);
    expect(() => fb({ context: "[]" })).toThrow(/CHECK/);
    expect(() => fb({ status: "done" })).toThrow(/CHECK/);
    expect(fb({ status: "wont_do", triage_note: "the sheet says it" })).toBeGreaterThan(0);
  });

  it("a router stat counts at least one piece and belongs to a write", () => {
    const t = new TestDb();
    const h = household(t);
    const w = writeLog(t, { resolver: "member", origin: "app", actor_member_id: h.hritvik, tool: "commit_route" });
    expect(t.insert("route_stat", { member_id: h.hritvik, write_id: w, recorded_on: "2026-10-05", unedited: 2, edited: 1, inbox: 0 })).toBeGreaterThan(0);
    expect(() => t.insert("route_stat", { member_id: h.hritvik, write_id: w, recorded_on: "2026-10-05", unedited: 0, edited: 0, inbox: 0 })).toThrow(/CHECK/);
  });
});
