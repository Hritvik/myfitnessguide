import { describe, expect, it } from "vitest";
import { slugOf } from "../src/tools/screens";
import { READ_BUDGET, withinBudget } from "./budget";
import { NOW } from "./db";
import { setup } from "./harness";
import { seedTraining } from "./seed";

const TODAY = "2026-10-05";

function history(years = 1) {
  const x = setup({ now: `${TODAY}T07:30:00Z` });
  const s = seedTraining(x);
  for (let week = 0; week < years * 52; week++) {
    const date = new Date(Date.parse(`${TODAY}T00:00:00Z`) - week * 7 * 86_400_000).toISOString().slice(0, 10);
    const confirmed_at = `${date}T10:00:00Z`;
    const session = x.t.insert("session", { member_id: x.h.hritvik, performed_on: date, gym_id: s.gym, session_type: "strength", state: "confirmed", confirmed_at });
    x.t.insert("session_set", { session_id: session, exercise_id: s.bench, set_number: 1, set_type: "working", reps: 8, reps_inferred: week === 0 ? 1 : 0, load_status: "entered", load_value: 40 + week % 3, load_unit: "kg", load_basis: "total", load_implement_id: s.barbell, rir_status: "recorded", rir_low: 2, rir_high: 2, state: "confirmed", confirmed_at, position: 1, note: week === 0 ? "elbows tucked" : null });
    x.t.insert("session_set", { session_id: session, exercise_id: s.curl, set_number: 1, set_type: "working", reps: 8, reps_inferred: 0, load_status: "entered", load_value: 10, load_unit: "kg", load_basis: "per_hand", load_implement_id: s.dumbbells, rir_status: "not_recorded", state: "confirmed", confirmed_at, position: 2 });
  }
  x.t.insert("goal_point", { member_id: x.h.hritvik, exercise_id: s.bench, week_of: "2026-10-18", tier: "planned", basis: "absolute", value_low: 45, value_high: 47.5, unit: "kg" });
  x.t.insert("goal_point", { member_id: x.h.hritvik, exercise_id: s.bench, week_of: "2026-12-06", tier: "stretch", basis: "bodyweight_multiple", value_low: 1, value_high: 1 });
  x.t.insert("goal_point", { member_id: x.h.hritvik, metric: "weight", week_of: "2026-10-18", tier: "planned", basis: "absolute", value_low: 78, value_high: 78, unit: "kg" });
  x.t.insert("method_change", { member_id: x.h.hritvik, exercise_id: s.bench, changed_on: "2026-06-01", note: "paused reps from here" });
  x.t.insert("method_change", { member_id: x.h.hritvik, metric: "weight", changed_on: "2026-06-01", note: "new scale" });
  return { x, s };
}

describe("lift_trends", () => {
  it("lists lifts and weekly volume with honest missing-estimate reasons and next goals", async () => {
    const { x, s } = history();
    const out = await x.ok("lift_trends", { member: "Hritvik" }, "asha");
    expect(out.lifts.map((lift: { last_done: string }) => lift.last_done)).toEqual([...out.lifts.map((lift: { last_done: string }) => lift.last_done)].sort().reverse());
    expect(out.lifts.find((lift: { exercise_id: number }) => lift.exercise_id === s.bench)).toMatchObject({
      exercise: "Barbell bench press", slug: "barbell-bench-press", last_done: TODAY, no_e1rm: null,
      next_goal: { week_of: "2026-10-18", tier: "planned", low: 45, high: 47.5, unit: "kg" },
    });
    expect(out.lifts.find((lift: { exercise_id: number }) => lift.exercise_id === s.curl)).toMatchObject({ best_e1rm: null, no_e1rm: "no_rir", best_top_set: { kg: 20 } });
    expect(out.weekly_volume.at(-1)).toMatchObject({ week_start: "2026-10-04", sessions: 1 });
  });

  it("returns one stable full series with segments, inferred-reps provenance, goals and described sets", async () => {
    const { x, s } = history();
    const out = await x.ok("lift_trends", { member: "Hritvik", exercise_id: s.bench }, "asha");
    expect(out).toMatchObject({ exercise_id: s.bench, exercise: "Barbell bench press", slug: "barbell-bench-press", bodyweight_dominant: false });
    expect(out.points.map((point: { date: string }) => point.date)).toEqual([...out.points.map((point: { date: string }) => point.date)].sort());
    expect(out.points.at(-1)).toMatchObject({ date: TODAY, state: "confirmed", segment: 1, e1rm: { effective_reps: 10, reps_assumed: true } });
    expect(out.goals).toEqual([
      { week_of: "2026-10-18", tier: "planned", low: 45, high: 47.5, unit: "kg" },
      { week_of: "2026-12-06", tier: "stretch", multiple_low: 1, multiple_high: 1 },
    ]);
    expect(out.method_changes).toEqual([{ date: "2026-06-01", note: "paused reps from here" }]);
    expect(out.sessions[0]).toMatchObject({ date: TODAY });
    expect(out.sessions[0].sets[0]).toMatchObject({ note: "elbows tucked" });
    expect(out.sessions[0].sets[0]).toHaveProperty("e1rm_rir_kg");
    expect(JSON.stringify(out)).not.toMatch(/new scale|bodyweight_kg|reading/);
  });

  it("includes warm-ups behind a plotted session but excludes warm-up-only sessions", async () => {
    const { x, s } = history();
    const plotted = x.t.get("SELECT id FROM session WHERE member_id = ? AND performed_on = ?", x.h.hritvik, TODAY)!.id as number;
    x.t.insert("session_set", {
      session_id: plotted, exercise_id: s.bench, set_number: 2, set_type: "warm_up", reps: 10, reps_inferred: 0,
      load_status: "entered", load_value: 20, load_unit: "kg", load_basis: "total", load_implement_id: s.barbell,
      rir_status: "not_recorded", state: "confirmed", confirmed_at: `${TODAY}T10:00:00Z`, position: 3,
    });
    const warmupOnly = x.t.insert("session", { member_id: x.h.hritvik, performed_on: "2026-10-03", gym_id: s.gym, session_type: "strength", state: "confirmed", confirmed_at: "2026-10-03T10:00:00Z" });
    x.t.insert("session_set", {
      session_id: warmupOnly, exercise_id: s.bench, set_number: 1, set_type: "warm_up", reps: 10, reps_inferred: 0,
      load_status: "entered", load_value: 20, load_unit: "kg", load_basis: "total", load_implement_id: s.barbell,
      rir_status: "not_recorded", state: "confirmed", confirmed_at: "2026-10-03T10:00:00Z", position: 1,
    });

    const out = await x.ok("lift_trends", { member: "Hritvik", exercise_id: s.bench }, "asha");
    expect(out.sessions.map((session: { session_id: number }) => session.session_id)).not.toContain(warmupOnly);
    expect(out.sessions.find((session: { session_id: number }) => session.session_id === plotted).sets.map((set: { set_type: string }) => set.set_type)).toContain("warm_up");
    expect(new Set(out.sessions.map((session: { session_id: number }) => session.session_id))).toEqual(new Set(out.points.map((point: { session_id: number }) => point.session_id)));
  });

  it("returns a valid empty list but 404 for a missing or foreign exercise", async () => {
    const x = setup();
    expect(await x.ok("lift_trends", { member: "Hritvik" }, "asha")).toEqual({ status: "ok", member: "Hritvik", lifts: [], weekly_volume: [] });
    const unused = x.t.insert("exercise", { household_id: x.h.id, name: "Unused press", implement_kind: "barbell" });
    expect(await x.ok("lift_trends", { member: "Hritvik", exercise_id: unused }, "asha")).toMatchObject({
      exercise_id: unused, exercise: "Unused press", points: [], goals: [], method_changes: [], sessions: [],
    });
    const other = x.t.insert("household", { name: "Other", created_at: NOW });
    const foreign = x.t.insert("exercise", { household_id: other, name: "Foreign press", implement_kind: "barbell" });
    for (const id of [foreign, 999_999]) {
      const reply = await x.call("lift_trends", { member: "Hritvik", exercise_id: id }, "asha");
      expect(reply.http).toBe(404);
      expect(reply.body.error.code).toBe("not_found");
    }
  });

  it(`stays within ${READ_BUDGET} fixed statements at one and two years`, async () => {
    const one = history(1);
    const two = history(2);
    for (const detail of [false, true]) {
      const a = await one.x.counted("lift_trends", { member: "Hritvik", ...(detail ? { exercise_id: one.s.bench } : {}) }, "asha");
      const b = await two.x.counted("lift_trends", { member: "Hritvik", ...(detail ? { exercise_id: two.s.bench } : {}) }, "asha");
      withinBudget(a, READ_BUDGET);
      expect(b.statements, b.log.join("\n")).toBe(a.statements);
    }
  }, 120_000);
});

describe("slugOf", () => {
  it("normalizes non-alphanumeric runs", () => {
    expect(slugOf("Lat pulldown (wide grip) / V-bar")).toBe("lat-pulldown-wide-grip-v-bar");
    expect(slugOf("  Barbell  bench press ")).toBe("barbell-bench-press");
  });
});
