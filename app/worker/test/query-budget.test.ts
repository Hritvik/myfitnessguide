// D1 query budgets (decision 96). D1 on the Workers Free plan runs at most
// 50 queries per Worker invocation, each statement in a batch counting
// separately. These tests count every statement one tool call runs (the
// caller lookup and the write batch included) against a busy, invented
// household: a gym with 23 or 40 implements, weeks of training history, a
// full day of meals with shared cooks, and months of weigh-ins. A tool
// whose count grows with the inventory or the day fails here long before
// it fails at the gym.
import { describe, expect, it } from "vitest";
import { invented, seedFoods, day } from "./invented";
import { Ctx } from "../src/context";
import { importWrite } from "../src/importing";
import { cadenceStatus, progressionsOf, type PrescriptionView } from "../src/training";
import { setup, type Harness } from "./harness";
import { seedCatalogue, seedTraining } from "./seed";
import { LOG_SET_BUDGET, READ_BUDGET, seedGym, withinBudget } from "./budget";

const MONDAY = "2026-10-05";
/** Hritvik's weekday programme: Upper A on Monday with six prescriptions (twelve when `copies` is 2), each with fallbacks. */
function seedProgramme(x: Harness, s: ReturnType<typeof seedTraining>, copies: number) {
  const { t, h } = x;
  const programme = t.insert("programme", { member_id: h.hritvik, name: "Base", schedule_kind: "weekday", active: 1, started_on: "2026-08-03" });
  const upper = t.insert("session_template", { programme_id: programme, name: "Upper A", session_type: "strength" });
  const lower = t.insert("session_template", { programme_id: programme, name: "Lower A", session_type: "strength" });
  t.insert("schedule_slot", { programme_id: programme, weekday: 1, template_id: upper });
  t.insert("schedule_slot", { programme_id: programme, weekday: 3, template_id: lower });
  const rule = (o: object) => JSON.stringify({ kind: "rep_top", target_sets: 3, rep_top: 12, rir_floor: 1, ...o });
  const p = (position: number, exercise: number, load: Record<string, unknown>, fallbacks: number[], template = upper) => {
    const id = t.insert("prescription", {
      template_id: template, position, exercise_id: exercise, sets: 3, rep_low: 8, rep_high: 12, rir_target_low: 1, rir_target_high: 2,
      rest_s: 120, progression_rule: rule({ increment: { min: 2.5 } }), ...load,
    });
    fallbacks.forEach((f, i) => t.insert("prescription_fallback", { prescription_id: id, exercise_id: f, rank: i + 1 }));
    return id;
  };
  const bench = p(1, s.bench, { load_value: 12.5, load_unit: "lb", load_basis: "per_side", load_implement_id: s.barbell }, [s.dbBench, s.pushup]);
  const pulldown = p(2, s.pulldown, { load_value: 40, load_unit: "kg", load_basis: "total", load_implement_id: s.stack }, [s.curl, s.pushup]);
  for (let k = 0; k < copies; k++) {
    if (k > 0) {
      p(6 * k + 1, s.bench, { load_value: 10, load_unit: "lb", load_basis: "per_side", load_implement_id: s.barbell }, [s.dbBench]);
      p(6 * k + 2, s.pulldown, { load_value: 35, load_unit: "kg", load_basis: "total", load_implement_id: s.stack }, [s.curl]);
    }
    p(6 * k + 3, s.curl, { load_value: 10, load_unit: "kg", load_basis: "per_hand", load_implement_id: s.dumbbells }, [s.calf]);
    p(6 * k + 4, s.dbBench, { load_value: 15, load_unit: "kg", load_basis: "per_hand", load_implement_id: s.dumbbells }, [s.bench, s.pushup]);
    p(6 * k + 5, s.pushup, {}, [s.dbBench]);
    p(6 * k + 6, s.walk, {}, []);
  }
  p(1, s.calf, { load_value: 10, load_unit: "kg", load_basis: "per_leg", load_implement_id: s.dumbbells }, [s.curl], lower);
  return { programme, upper, lower, bench, pulldown };
}

/** Eight past Mondays of Upper A, three working sets of each lift, confirmed. */
function seedHistory(x: Harness, s: ReturnType<typeof seedTraining>, p: ReturnType<typeof seedProgramme>) {
  const { t, h } = x;
  for (let week = 8; week >= 1; week--) {
    const day = new Date(Date.parse(`${MONDAY}T00:00:00Z`) - week * 7 * 86_400_000).toISOString().slice(0, 10);
    const session = t.insert("session", { member_id: h.hritvik, performed_on: day, gym_id: s.gym, session_type: "strength", template_id: p.upper, state: "confirmed", confirmed_at: "2026-10-01T00:00:00Z" });
    let position = 0;
    const lift = (exercise: number, prescription: number, load: Record<string, unknown>) => {
      for (let n = 1; n <= 3; n++) {
        t.insert("session_set", {
          session_id: session, exercise_id: exercise, prescription_id: prescription, set_number: n, set_type: "working", reps: 10,
          load_status: "entered", rir_status: "recorded", rir_low: 2, rir_high: 2, state: "confirmed", confirmed_at: "2026-10-01T00:00:00Z", position: ++position, ...load,
        });
      }
    };
    lift(s.bench, p.bench, { load_value: 12.5, load_unit: "lb", load_basis: "per_side", load_implement_id: s.barbell, bar_value: 20, bar_unit: "kg" });
    lift(s.pulldown, p.pulldown, { load_value: 35 + (week % 2) * 5, load_unit: "kg", load_basis: "total", load_implement_id: s.stack });
  }
}

/** A full day for Hritvik: weighed foods, recipes, three shared cooks, drafts logged by Asha; all of it `copies` times. */
async function seedDay(x: Harness, copies: number) {
  await seedCatalogue(x);
  await x.ok("upsert_recipe", { name: "Curd rice", kind: "dish", servings: 1, lines: [{ food: "FS002", value: 200, unit: "g" }, { food: "FS004", value: 100, unit: "g" }] });
  await x.ok("upsert_recipe", { name: "Egg bhurji", kind: "dish", servings: 1, lines: [{ food: "FS003", value: 100, unit: "g" }, { food: "FS005", value: 5, unit: "ml" }] });
  const food = (f: string, value: number, more: Record<string, unknown> = {}) => ({ source: "food", food: f, value, unit: "g", provenance: "weighed", confidence: "high", ...more });
  const recipe = (ref: string) => ({ source: "recipe", recipe: ref, servings: 1, provenance: "estimated", confidence: "medium", dominant_uncertainty: { description: "bowl size", kcal: 40 } });
  const cook = (name: string, slot: string, grams: number) => ({
    date: MONDAY, meal_slot: slot,
    cooks: [{ name, lines: [{ food: "peas", value: grams, unit: "g", provenance: "weighed" }, { food: "FS005", value: 10, unit: "ml", provenance: "weighed" }], portions: [
      { member: "Asha", fraction: 0.3, provenance: "estimated" },
      { member: "Hritvik", fraction: 0.4, provenance: "estimated", dominant_uncertainty: { description: "ladle", kcal: 30 } },
      { member: "Kabir", fraction: 0.2, provenance: "estimated" },
    ] }],
  });
  for (let k = 1; k <= copies; k++) {
    await x.ok("log_intake", { member: "Hritvik", date: MONDAY, meal_slot: "pre_workout", items: [food("curd", 100)] });
    await x.ok("log_intake", { member: "Hritvik", date: MONDAY, meal_slot: "breakfast", items: [{ source: "food", food: "egg", value: 3, measure: "egg", provenance: "counted", confidence: "high" }, recipe("R002")] });
    await x.ok("log_intake", { member: "Hritvik", date: MONDAY, meal_slot: "snack", items: [recipe("R001"), food("peas", 80)] }, "asha");
    await x.ok("log_intake", { member: "Hritvik", date: MONDAY, meal_slot: "snack", items: [food("curd", 50)], origin: "inbox" });
    await x.ok("household_meal", cook(`Masoor dal ${k}`, "lunch", 400), "asha");
    await x.ok("household_meal", cook(`Matar paneer ${k}`, "dinner", 300), "asha");
    await x.ok("household_meal", cook(`Ghugni ${k}`, "lunch", 250));
  }
  await x.ok("set_target", {
    member: "Hritvik", effective_from: "2026-09-01", provenance: "agent", reasoning: "invented",
    values: [
      { nutrient: "kcal", kind: "target", value: 2200 },
      { nutrient: "protein_g", kind: "target", value: 140 },
      { nutrient: "protein_g", kind: "floor", value: 125 },
      { nutrient: "fat_g", kind: "target", value: 60 },
      { nutrient: "carbs_g", kind: "remainder" },
    ],
  });
  await x.ok("set_day_status", { member: "Hritvik", date: MONDAY, status: "open", skipped_meals: ["post_workout"] });
}

/** Four months of fasted weigh-ins with a scale change and planned goal points. */
function seedWeights(x: Harness) {
  const { t, h } = x;
  for (let d = 120; d >= 0; d--) {
    const on = new Date(Date.parse(`${MONDAY}T00:00:00Z`) - d * 86_400_000).toISOString().slice(0, 10);
    t.insert("reading", { member_id: h.hritvik, metric: "weight", measured_on: on, value: 80 - d * 0.01, unit: "kg", body_state: "fasted", measurer: "self", suspect: 0, state: "confirmed", confirmed_at: "2026-10-01T00:00:00Z" });
  }
  t.insert("method_change", { member_id: h.hritvik, metric: "weight", changed_on: "2026-08-01", note: "new scale" });
  for (let w = 0; w < 16; w++) {
    const on = new Date(Date.parse("2026-06-07T00:00:00Z") + w * 7 * 86_400_000).toISOString().slice(0, 10);
    t.insert("goal_point", { member_id: h.hritvik, metric: "weight", week_of: on, tier: "planned", basis: "absolute", value_low: 80 - w * 0.1, value_high: 80 - w * 0.1, unit: "kg" });
  }
}

/** The busy household; `copies` 2 doubles the programme's prescriptions and the day's items and cooks. */
async function busyHousehold(implementCount: number, copies = 1) {
  const x = setup();
  const s = seedGym(x, implementCount);
  const p = seedProgramme(x, s, copies);
  seedHistory(x, s, p);
  await seedDay(x, copies);
  seedWeights(x);
  const implementsAtGym = x.t.get("SELECT count(*) AS n FROM implement WHERE gym_id = ?", s.gym)?.n;
  expect(implementsAtGym).toBe(implementCount);
  return { x, s, p };
}

describe.each([23, 40])("D1 statements per call, gym with %i implements", (implementCount) => {
  it(`log_set, the first set of a fresh Coach session: at most ${LOG_SET_BUDGET}`, async () => {
    const { x } = await busyHousehold(implementCount);
    const session = (await x.ok("start_session", { origin: "coach", member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper A" })).session.id;
    const run = await x.counted("log_set", {
      origin: "coach", session_id: session, exercise: "lat pulldown", reps: 10, rir: { low: 2, high: 2 }, load: { value: 40, unit: "kg", basis: "total" },
    });
    expect(run.body.set).toMatchObject({ exercise: "Cable lat pulldown", implement: "Lat pulldown stack", total_kg: 40 });
    withinBudget(run, LOG_SET_BUDGET);
  });

  it(`log_set into a session already holding fifteen sets: at most ${LOG_SET_BUDGET}`, async () => {
    const { x, s } = await busyHousehold(implementCount);
    const session = (await x.ok("start_session", { origin: "coach", member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper A" })).session.id;
    for (let n = 0; n < 15; n++) {
      await x.ok("log_set", {
        origin: "coach", session_id: session, exercise: "bench", reps: 10, rir: { low: 2, high: 2 },
        load: { value: 12.5, unit: "lb", basis: "per_side", implement: s.barbell, bar: { value: 20, unit: "kg" } },
      });
    }
    const run = await x.counted("log_set", {
      origin: "coach", session_id: session, exercise: "bench", reps: 9, rir: { low: 1, high: 1 },
      load: { value: 12.5, unit: "lb", basis: "per_side", implement: s.barbell, bar: { value: 20, unit: "kg" } },
    });
    expect(run.body.set).toMatchObject({ exercise: "Barbell bench press", set_number: 16, position: 16 });
    withinBudget(run, LOG_SET_BUDGET);
  });

  it(`log_set placed first in a session already holding twenty sets: at most ${LOG_SET_BUDGET}`, async () => {
    const { x, s } = await busyHousehold(implementCount);
    const session = (await x.ok("start_session", { origin: "coach", member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper A" })).session.id;
    for (let n = 0; n < 20; n++) {
      await x.ok("log_set", {
        origin: "coach", session_id: session, exercise: "bench", reps: 10, rir: { low: 2, high: 2 },
        load: { value: 12.5, unit: "lb", basis: "per_side", implement: s.barbell, bar: { value: 20, unit: "kg" } },
      });
    }
    const run = await x.counted("log_set", {
      origin: "coach", session_id: session, exercise: "lat pulldown", reps: 12, rir: 3, load: { value: 30, unit: "kg", basis: "total" }, position: 1,
    });
    expect(run.body.set).toMatchObject({ exercise: "Cable lat pulldown", position: 1 });
    // The twenty bench sets moved down one, each with a new version.
    const positions = x.t.all("SELECT position FROM session_set WHERE session_id = ? AND exercise_id = ? ORDER BY set_number", session, s.bench).map((r) => r.position);
    expect(positions).toEqual(Array.from({ length: 20 }, (_, i) => i + 2));
    const moved = x.t.all(
      "SELECT v.data FROM record_version v JOIN session_set st ON st.id = v.record_id WHERE v.table_name = 'session_set' AND v.version = 2 AND st.session_id = ? ORDER BY st.set_number",
      session,
    );
    expect(moved.map((v) => JSON.parse(v.data as string).position)).toEqual(Array.from({ length: 20 }, (_, i) => i + 2));
    withinBudget(run, LOG_SET_BUDGET);
  });

  it(`waiting, for the busy household's first member: at most ${READ_BUDGET}`, async () => {
    const { x } = await busyHousehold(implementCount);
    // The busy household's first member, by id, so this file names no one new.
    const first = x.t.get("SELECT name FROM member ORDER BY id LIMIT 1") as { name: string };
    const run = await x.counted("waiting", { member: first.name, date: MONDAY });
    expect(run.body.count).toBeGreaterThanOrEqual(0);
    expect(run.body.asks).toEqual([]);
    expect(run.body).not.toHaveProperty("inventory");
    withinBudget(run, READ_BUDGET);
  });

  it(`next_prescription: at most ${READ_BUDGET}`, async () => {
    const { x } = await busyHousehold(implementCount);
    const run = await x.counted("next_prescription", { member: "Hritvik", date: MONDAY });
    expect(run.body.session).toBe("Upper A");
    expect(run.body.prescriptions).toHaveLength(6);
    withinBudget(run, READ_BUDGET);
  });

  it(`progress_summary: at most ${READ_BUDGET}`, async () => {
    const { x } = await busyHousehold(implementCount);
    const run = await x.counted("progress_summary", { member: "Hritvik", period: "12w" }, "hritvik");
    expect(run.body.signals).toHaveLength(5);
    withinBudget(run, READ_BUDGET);
  });

  it(`check_progression: at most ${READ_BUDGET}`, async () => {
    const { x, p } = await busyHousehold(implementCount);
    const run = await x.counted("check_progression", { prescription_id: p.bench });
    expect(run.body.verdict).toBeDefined();
    withinBudget(run, READ_BUDGET);
  });

  it(`inventory: at most ${READ_BUDGET}`, async () => {
    const { x } = await busyHousehold(implementCount);
    const run = await x.counted("inventory", { member: "Hritvik" });
    expect(run.body.implements).toHaveLength(implementCount);
    withinBudget(run, READ_BUDGET);
  });

  it(`day_totals: at most ${READ_BUDGET}`, async () => {
    const { x } = await busyHousehold(implementCount);
    const run = await x.counted("day_totals", { member: "Hritvik", date: MONDAY });
    expect(run.body.item_count).toBe(9);
    withinBudget(run, READ_BUDGET);
  });

  it(`day_meals: at most ${READ_BUDGET}`, async () => {
    const { x } = await busyHousehold(implementCount);
    const run = await x.counted("day_meals", { member: "Hritvik", date: MONDAY }, "hritvik");
    expect(run.body.slots.flatMap((s: { items: unknown[] }) => s.items)).toHaveLength(9);
    withinBudget(run, READ_BUDGET);
  });

  it(`day_cooks: at most ${READ_BUDGET}`, async () => {
    const { x } = await busyHousehold(implementCount);
    const run = await x.counted("day_cooks", { member: "Hritvik", date: MONDAY }, "hritvik");
    expect(run.body.cooks).toHaveLength(3);
    withinBudget(run, READ_BUDGET);
  });

  it(`meal planning and prep reads: at most ${READ_BUDGET}`, async () => {
    const { x } = await busyHousehold(implementCount);
    const recipe = x.t.get("SELECT id, ref FROM recipe ORDER BY id LIMIT 1") as { id: number; ref: string };
    x.t.insert("recipe_prep_step", {
      recipe_id: recipe.id, position: 1, action: "Soak", lead: "hours_before", lead_min_h: 8, lead_max_h: 12,
      who: "anyone", batchable: 1, keeps_days: 1, batch_days: 2, storage: "fridge", freezer_ok: 0,
      food_source_id: 1, amount_value: 100, amount_unit: "g",
    });
    const entries = Array.from({ length: 7 }, (_, day) => {
      const date = new Date(Date.parse(`${MONDAY}T00:00:00Z`) + day * 86_400_000).toISOString().slice(0, 10);
      return ["breakfast", "lunch", "dinner"].map((meal_slot) => ({
        date, meal_slot,
        cooks: [{ name: recipe.ref, recipe: recipe.ref, portions: [{ member: "Hritvik", fraction: 1, provenance: "estimated" }] }],
        items: [],
      }));
    }).flat();
    withinBudget(await x.counted("household_planning_context", { from: MONDAY, to: MONDAY }), READ_BUDGET);
    const preview = await x.counted("preview_meal_plan", { entries, batch_day: 1 });
    expect(preview.body.prep_schedule.length).toBeGreaterThan(0);
    withinBudget(preview, READ_BUDGET);
    const saved = await x.counted("save_meal_plan", { name: "Budget week", status: "active", entries, batch_day: 1, change_reason: "budget" });
    withinBudget(saved, READ_BUDGET);
    withinBudget(await x.counted("meal_plan", { plan_id: saved.body.plan.id }), READ_BUDGET);
    withinBudget(await x.counted("day_prep", { member: "Hritvik", date: MONDAY }), READ_BUDGET);
    withinBudget(await x.counted("cook_sheet", { date: MONDAY }), READ_BUDGET);
    const task = x.t.get("SELECT id FROM prep_task ORDER BY id LIMIT 1") as { id: number };
    withinBudget(await x.counted("settle_prep_task", { task_id: task.id, status: "done", reason: "budget" }), READ_BUDGET);
    withinBudget(await x.counted("catalogue_lookup", { refs: [recipe.ref] }), READ_BUDGET);
    withinBudget(await x.counted("log_intake", { member: "Hritvik", date: MONDAY, meal_slot: "snack", items: [{ source: "food", food: "curd", value: 50, unit: "g", provenance: "weighed", confidence: "high" }] }), READ_BUDGET);
    withinBudget(await x.counted("household_meal", {
      date: MONDAY, meal_slot: "dinner",
      cooks: [{ name: "Budget dal", lines: [{ food: "peas", value: 100, unit: "g", provenance: "weighed" }], portions: [{ member: "Hritvik", fraction: 1, provenance: "estimated" }] }],
      items: [],
    }), READ_BUDGET);
    withinBudget(await x.counted("upsert_recipe", {
      name: "Budget prep recipe", kind: "dish", servings: 1, lines: [{ food: "peas", value: 100, unit: "g" }],
      prep_steps: [{ action: "Soak", lead: "hours_before", lead_min_h: 8, lead_max_h: 12, batchable: true, keeps_days: 1 }],
    }), READ_BUDGET);
    withinBudget(await x.counted("update_recipe", { recipe: recipe.ref, change_reason: "budget", patch: { prep_steps: null } }), READ_BUDGET);
    withinBudget(await x.counted("needs_you", { member: "Hritvik", date: MONDAY }, "hritvik"), READ_BUDGET);
    withinBudget(await x.counted("waiting", { member: "Hritvik", date: MONDAY }, "hritvik"), READ_BUDGET);
  });

  it(`body_trends: at most ${READ_BUDGET}`, async () => {
    const { x } = await busyHousehold(implementCount);
    const run = await x.counted("body_trends", { member: "Hritvik", metric: "weight", direction: "decrease" }, "hritvik");
    expect(run.body.segments).toHaveLength(2);
    withinBudget(run, READ_BUDGET);
  });
});

type Run = { statements: number; log: string[] };
const twice = async (run: (x: Harness) => Promise<Run>) => {
  const once = await run((await busyHousehold(40)).x);
  const doubled = await run((await busyHousehold(80, 2)).x);
  expect(doubled.statements, `once: ${once.statements}, twice: ${doubled.statements}\n${doubled.log.join("\n")}`).toBe(once.statements);
};

// No call may run a query per implement, prescription, item or cook: twice
// the inventory, programme and day costs exactly the same statements.
describe("D1 statements do not grow with the data", () => {
  it("next_prescription with twelve prescriptions instead of six", async () => {
    await twice((x) => x.counted("next_prescription", { member: "Hritvik", date: MONDAY }));
  });

  it("inventory with 80 implements instead of 40", async () => {
    await twice((x) => x.counted("inventory", { member: "Hritvik" }));
  });

  it("log_set at a gym with 80 implements instead of 40", async () => {
    await twice(async (x) => {
      const session = (await x.ok("start_session", { origin: "coach", member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper A" })).session.id;
      return x.counted("log_set", { origin: "coach", session_id: session, exercise: "lat pulldown", reps: 10, rir: 2, load: { value: 40, unit: "kg", basis: "total" } });
    });
  });

  it("day_totals with eighteen items instead of nine", async () => {
    await twice((x) => x.counted("day_totals", { member: "Hritvik", date: MONDAY }));
  });

  it("day_meals with eighteen items instead of nine", async () => {
    await twice((x) => x.counted("day_meals", { member: "Hritvik", date: MONDAY }, "hritvik"));
  });

  it("body_trends with the headline resolved, at twice the weeks of waist readings and goals", async () => {
    await twice(async (x) => {
      await seedWaist(x);
      return x.counted("body_trends", { member: "Hritvik", metric: "headline" }, "hritvik");
    });
  });

  it("day_cooks with six cooks instead of three", async () => {
    await twice((x) => x.counted("day_cooks", { member: "Hritvik", date: MONDAY }, "hritvik"));
  });
});

/** An agent context over the counting adapter, for counting a shared loader directly. */
function countingCtx(x: Harness): Ctx {
  return new Ctx(x.counter, { kind: "agent", resolver: "claude_code", householdId: x.h.id, clientId: "budget" }, () => x.clock.now, "Asia/Kolkata");
}

// App display (plan 2026-10-06): the shared loaders load once.
describe("app display: shared loaders", () => {
  it("progressionsOf runs the same statements for six prescriptions or twelve, and at most six", async () => {
    const count = async (copies: number) => {
      const { x, p } = await busyHousehold(40, copies);
      const ps = x.t.all("SELECT * FROM v_prescription WHERE template_id = ? ORDER BY position", p.upper) as unknown as PrescriptionView[];
      x.counter.reset();
      const out = await progressionsOf(countingCtx(x), ps);
      expect(out.size).toBe(ps.length);
      return x.counter.count;
    };
    const once = await count(1);
    expect(await count(2)).toBe(once);
    expect(once).toBeLessThanOrEqual(6);
  });

  it(`cadenceStatus runs at most 4 statements with five cadences; staleness at most ${READ_BUDGET}`, async () => {
    const { x } = await busyHousehold(40);
    for (const [name, source] of [
      ["waist", { kind: "reading", metric: "waist_navel" }], ["weight", { kind: "reading", metric: "weight", body_state: "fasted" }],
      ["hr", { kind: "cardio_hr" }], ["pushups", { kind: "exercise", exercise: "pushups" }], ["photos", { kind: "manual" }],
    ] as const) {
      await x.ok("set_measurement_cadence", { member: "Hritvik", name, every_days: 7, source, message: `${name} is overdue.` });
    }
    x.counter.reset();
    await cadenceStatus(countingCtx(x), x.h.hritvik, MONDAY);
    expect(x.counter.count).toBeLessThanOrEqual(4);
    withinBudget(await x.counted("staleness", { member: "Hritvik", date: MONDAY }, "hritvik"), READ_BUDGET);
  });

  it(`inventory_gaps and programme: at most ${READ_BUDGET}`, async () => {
    const { x } = await busyHousehold(40);
    withinBudget(await x.counted("inventory_gaps", { member: "Hritvik", date: MONDAY }), READ_BUDGET);
    withinBudget(await x.counted("programme", { member: "Hritvik", date: MONDAY }), READ_BUDGET);
  });
});

// App display (plan 2026-10-06): needs_you over the busy household, with yesterday open, a flag and cadences.
async function needsYouDay(x: Harness) {
  await x.ok("log_intake", { member: "Hritvik", date: "2026-10-04", meal_slot: "lunch", items: [{ source: "food", food: "curd", value: 150, unit: "g", provenance: "weighed", confidence: "high" }] });
  await x.ok("raise_flag", { member: "Hritvik", subtype: "health_watch", subject: "Repeat the thyroid panel", due_on: "2026-10-09" });
  for (const metric of ["waist_navel", "hips", "neck"]) {
    await x.ok("set_measurement_cadence", { member: "Hritvik", name: metric, every_days: 7, source: { kind: "reading", metric }, message: `${metric} is overdue.` });
  }
}

describe("app display: needs_you", () => {
  it(`needs_you over the busy household: at most ${READ_BUDGET}`, async () => {
    const { x } = await busyHousehold(40);
    await needsYouDay(x);
    const run = await x.counted("needs_you", { member: "Hritvik", date: MONDAY }, "hritvik");
    expect([...run.body.cards, ...run.body.more].map((c: { rule: string }) => c.rule)).toEqual(expect.arrayContaining(["drafts", "remainder", "yesterday_open", "flag", "measurement"]));
    withinBudget(run, READ_BUDGET);
  });

  it("needs_you runs the same statements with twice the programme, the drafts and the pots", async () => {
    await twice(async (x) => {
      await needsYouDay(x);
      return x.counted("needs_you", { member: "Hritvik", date: MONDAY }, "hritvik");
    });
  });
});

describe("app display: whoami", () => {
  it(`whoami with time_zone: at most ${READ_BUDGET}`, async () => {
    const { x } = await busyHousehold(40);
    withinBudget(await x.counted("whoami", {}, "asha"), READ_BUDGET);
  });
});

describe("app display: next_prescription with progression and state", () => {
  it(`every row carries its state, over eight weeks of history: at most ${READ_BUDGET}`, async () => {
    const { x } = await busyHousehold(40);
    const run = await x.counted("next_prescription", { member: "Hritvik", date: MONDAY });
    expect(run.body.prescriptions).toHaveLength(6);
    expect(run.body.prescriptions.every((p: { state: { kind: string }; progression: { verdict: string } }) => p.state.kind && p.progression.verdict)).toBe(true);
    withinBudget(run, READ_BUDGET);
  });
});

describe("app display: goal points and readings", () => {
  it(`set_goal_point, created then revised (the write batch included), and log_reading: at most ${READ_BUDGET} each`, async () => {
    const { x } = await busyHousehold(40);
    const goal = { member: "Hritvik", metric: "waist_to_height", week_of: "2027-03-31", value: 0.5, tier: "planned", reason: "End target from the Guide" };
    withinBudget(await x.counted("set_goal_point", goal, "hritvik"), READ_BUDGET);
    withinBudget(await x.counted("set_goal_point", { ...goal, value: 0.49, reason: "Guide revised" }, "hritvik"), READ_BUDGET);
    withinBudget(await x.counted("log_reading", { member: "Hritvik", date: "2026-10-05", metric: "waist_navel", value: 88, unit: "cm", body_state: "fasted" }, "hritvik"), READ_BUDGET);
  });

  it(`create_goal_point (import only), changed to build through goalPointRow: at most ${READ_BUDGET}, and no growth with the data`, async () => {
    const goal = { member: "Hritvik", metric: "waist_navel", week_of: "2026-08-03", tier: "planned", basis: "absolute", value_low: 90, value_high: 90, unit: "cm" };
    const at = { at: "2026-10-05T19:07:21Z", origin: { file: "hritvik", tab: "Trajectory", row: 2 } };
    const run = async (x: Harness) => {
      x.counter.reset();
      const body = await importWrite(x.counter, "create_goal_point", goal, at);
      expect(body.status).toBe("ok");
      return { statements: x.counter.count, log: x.counter.log };
    };
    withinBudget(await run((await busyHousehold(40)).x), READ_BUDGET);
    await twice(run);
  });
});

/** Twenty weeks of waist readings, weekly cm goal points, a height and the 0.50 end target, on top of the busy household. */
async function seedWaist(x: Harness) {
  const { t, h } = x;
  t.insert("reading", { member_id: h.hritvik, metric: "height", measured_on: "2026-01-01", value: 175, unit: "cm", body_state: "not_recorded", measurer: "self", suspect: 0, state: "confirmed", confirmed_at: "2026-10-01T00:00:00Z" });
  for (let w = 0; w < 20; w++) {
    const sunday = new Date(Date.parse("2026-05-17T00:00:00Z") + w * 7 * 86_400_000).toISOString().slice(0, 10);
    t.insert("reading", { member_id: h.hritvik, metric: "waist_navel", measured_on: sunday, value: 95 - w * 0.3, unit: "cm", body_state: "fasted", measurer: "self", suspect: 0, state: "confirmed", confirmed_at: "2026-10-01T00:00:00Z" });
    t.insert("goal_point", { member_id: h.hritvik, metric: "waist_navel", week_of: sunday, tier: "planned", basis: "absolute", value_low: 95 - w * 0.25, value_high: 95 - w * 0.25, unit: "cm" });
  }
  t.insert("goal_point", { member_id: h.hritvik, metric: "waist_to_height", week_of: "2027-03-28", tier: "planned", basis: "absolute", value_low: 0.5, value_high: 0.5, unit: "ratio" });
}

describe("app display: body_trends", () => {
  it(`body_trends resolving the headline, over twenty weeks of waist and goals: at most ${READ_BUDGET}`, async () => {
    const { x } = await busyHousehold(40);
    await seedWaist(x);
    const run = await x.counted("body_trends", { member: "Hritvik", metric: "headline", from: "2026-07-15" }, "hritvik");
    expect(run.body.metric).toBe("waist_navel");
    withinBudget(run, READ_BUDGET);
  });
});

/** The busy day plus the six days before it, each with weighed food, a shared pot and a session; a fat-free mass reading. */
async function busyWeek(x: Harness) {
  x.t.insert("reading", { member_id: x.h.hritvik, metric: "bia_fat_free_mass", measured_on: "2026-09-01", value: 128, unit: "lb", body_state: "fasted", measurer: "self", suspect: 0, state: "confirmed", confirmed_at: "2026-10-01T00:00:00Z" });
  for (let back = 1; back <= 6; back++) {
    const date = new Date(Date.parse(`${MONDAY}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
    await x.ok("log_intake", { member: "Hritvik", date, meal_slot: "breakfast", items: [{ source: "food", food: "curd", value: 200, unit: "g", provenance: "weighed", confidence: "high" }] });
    await x.ok("household_meal", {
      date, meal_slot: "dinner",
      cooks: [{ name: `Dal ${back}`, lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Hritvik", fraction: 0.4, provenance: "estimated" }, { member: "Asha", fraction: 0.4, provenance: "estimated" }] }],
    }, "asha");
    await x.ok("log_cardio", { member: "Hritvik", date, session_type: "class", energy_kcal: 250, blocks: [{ kind: "steady", duration_s: 2700 }] });
  }
}

describe("app display: week_summary and blood_draws", () => {
  it(`week_summary over a busy week: at most ${READ_BUDGET}`, async () => {
    const { x } = await busyHousehold(40);
    await busyWeek(x);
    const run = await x.counted("week_summary", { member: "Hritvik", week: MONDAY }, "hritvik");
    expect(run.body.days).toHaveLength(7);
    expect(run.body.energy_availability.ffm_kg).toBeCloseTo(128 * 0.45359237, 6);
    withinBudget(run, READ_BUDGET);
  });

  it("week_summary runs the same statements with twice the day's items and pots", async () => {
    await twice(async (x) => {
      await busyWeek(x);
      return x.counted("week_summary", { member: "Hritvik", week: MONDAY }, "hritvik");
    });
  });

  it(`blood_draws with six draws of ten markers: at most ${READ_BUDGET}`, async () => {
    const { x } = await busyHousehold(40);
    for (let draw = 0; draw < 6; draw++) {
      await x.ok("log_blood_draw", {
        member: "Hritvik", date: `2026-0${draw + 1}-15`, lab: "Thyrocare",
        results: Array.from({ length: 10 }, (_, m) => ({ marker: `Marker ${m}`, value: 10 + draw + m, unit: "u", ref_low: 5, ref_high: 20 })),
      });
    }
    const run = await x.counted("blood_draws", { member: "Hritvik" }, "hritvik");
    expect(run.body.draws[0].results[0].change).toMatchObject({ previous: 14, previous_on: "2026-05-15", delta: 1 });
    withinBudget(run, READ_BUDGET);
  });
});

describe("app display: leftovers", () => {
  it(`mark_remainder eating and discarding a leftover (the write batch included): at most ${READ_BUDGET} each; day_totals with a serving item stays within too`, async () => {
    const { x } = await busyHousehold(40);
    const cooks = x.t.all("SELECT c.id FROM component c JOIN household_meal_cook hc ON hc.cook_id = c.cook_id JOIN household_meal m ON m.id = hc.household_meal_id WHERE m.eaten_on = ? ORDER BY c.id", MONDAY);
    const [first, second] = cooks.map((c) => c.id as number);
    for (const id of [first, second]) await x.ok("mark_remainder", { component_id: id, disposition: "leftover", provenance: "estimated" });
    withinBudget(await x.counted("mark_remainder", { component_id: first, disposition: "eaten", member: "Hritvik", meal_slot: "snack", provenance: "estimated" }, "hritvik"), READ_BUDGET);
    withinBudget(await x.counted("mark_remainder", { component_id: second, disposition: "discarded", provenance: "estimated" }, "hritvik"), READ_BUDGET);
    withinBudget(await x.counted("day_totals", { member: "Hritvik", date: MONDAY }, "hritvik"), READ_BUDGET);
  });

  it(`confirming a draft leftover serving (it follows to its item, the write batch included): at most ${READ_BUDGET}`, async () => {
    const { x } = await busyHousehold(40);
    const cooks = x.t.all("SELECT c.id FROM component c JOIN household_meal_cook hc ON hc.cook_id = c.cook_id JOIN household_meal m ON m.id = hc.household_meal_id WHERE m.eaten_on = ? ORDER BY c.id", MONDAY);
    const [first] = cooks.map((c) => c.id as number);
    await x.ok("mark_remainder", { component_id: first, disposition: "leftover", provenance: "estimated" });
    const draft = await x.ok("mark_remainder", { component_id: first, disposition: "eaten", member: "Hritvik", meal_slot: "snack", provenance: "estimated" }, "asha");
    expect(draft.serving.state).toBe("draft");
    const run = await x.counted("confirm", { records: [{ table: "leftover_serving", id: draft.serving.id }] }, "hritvik");
    expect(x.t.get("SELECT state FROM leftover_serving WHERE id = ?", draft.serving.id)?.state).toBe("confirmed");
    withinBudget(run, READ_BUDGET);
  });

  it(`rejecting a draft leftover serving and retracting a confirmed one (the write batch included): at most ${READ_BUDGET} each`, async () => {
    const { x } = await busyHousehold(40);
    const cooks = x.t.all("SELECT c.id FROM component c JOIN household_meal_cook hc ON hc.cook_id = c.cook_id JOIN household_meal m ON m.id = hc.household_meal_id WHERE m.eaten_on = ? ORDER BY c.id", MONDAY);
    const [first, second] = cooks.map((c) => c.id as number);
    for (const id of [first, second]) await x.ok("mark_remainder", { component_id: id, disposition: "leftover", provenance: "estimated" });
    // The agent, talking with Asha, logs Hritvik's helping: a draft about him, which he rejects.
    const draft = await x.ok("mark_remainder", { component_id: first, disposition: "eaten", member: "Hritvik", meal_slot: "snack", provenance: "estimated" }, "asha");
    expect(draft.serving.state).toBe("draft");
    withinBudget(await x.counted("reject", { records: [{ table: "leftover_serving", id: draft.serving.id }], reason: "not eaten" }, "hritvik"), READ_BUDGET);
    const mine = await x.ok("mark_remainder", { component_id: second, disposition: "eaten", member: "Hritvik", meal_slot: "snack", provenance: "estimated" }, "hritvik");
    expect(mine.serving.state).toBe("confirmed");
    const run = await x.counted("retract", { records: [{ table: "leftover_serving", id: mine.serving.id }], reason: "logged twice" }, "hritvik");
    expect(run.body.retracted).toEqual([{ table: "intake_item", id: mine.serving.intake_item_id }, { table: "leftover_serving", id: mine.serving.id }]);
    withinBudget(run, READ_BUDGET);
  });
});

/** `n` past cooks with their rest marked leftover; `eatUp` eats each one up the next day (months of fully eaten leftovers). */
async function seedLeftovers(x: Harness, n: number, eatUp: boolean) {
  for (let k = 1; k <= n; k++) {
    const date = new Date(Date.parse(`${MONDAY}T00:00:00Z`) - (k + 3) * 86_400_000).toISOString().slice(0, 10);
    const meal = await x.ok("household_meal", {
      date, meal_slot: "dinner",
      cooks: [{ name: `Leftover pot ${k}`, lines: [{ food: "peas", value: 300, unit: "g", provenance: "weighed" }], portions: [{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }] }],
    });
    const component = meal.cooks[0].components[0].id as number;
    await x.ok("mark_remainder", { component_id: component, disposition: "leftover", provenance: "estimated", date });
    if (eatUp) await x.ok("mark_remainder", { component_id: component, disposition: "eaten", member: "Asha", meal_slot: "lunch", provenance: "estimated", date, speaker: "Asha" });
  }
}

describe("app display: household_overview", () => {
  it(`household_overview over the busy household: at most ${READ_BUDGET}; day_cooks still within too`, async () => {
    const { x } = await busyHousehold(40);
    await seedLeftovers(x, 3, false);
    const run = await x.counted("household_overview", { date: MONDAY }, "hritvik");
    expect(run.body.leftovers).toHaveLength(3);
    withinBudget(run, READ_BUDGET);
    withinBudget(await x.counted("day_cooks", { member: "Hritvik", date: MONDAY }, "hritvik"), READ_BUDGET);
  });

  it(`household_overview with 101 open leftovers (more than 100 keys, chunked by allIn): at most ${READ_BUDGET}`, async () => {
    const { x } = await busyHousehold(40);
    await seedLeftovers(x, 101, false);
    const run = await x.counted("household_overview", { date: MONDAY }, "hritvik");
    expect(run.body.leftovers).toHaveLength(101);
    withinBudget(run, READ_BUDGET);
  });

  it("months of fully eaten leftovers cost nothing: the same statements as none, and none listed", async () => {
    const none = await busyHousehold(40);
    const baseline = await none.x.counted("household_overview", { date: MONDAY }, "hritvik");
    const { x } = await busyHousehold(40);
    await seedLeftovers(x, 60, true);
    const run = await x.counted("household_overview", { date: MONDAY }, "hritvik");
    expect(run.body.leftovers).toEqual([]);
    expect(run.statements).toBe(baseline.statements);
  });

  it("household_overview runs the same statements with twice the day's items and pots", async () => {
    await twice((x) => x.counted("household_overview", { date: MONDAY }, "hritvik"));
  });
});

describe("app display: amends that re-open a leftover", () => {
  /** A weighed pot (600 g cooked) whose leftover Asha ate up by weight, in the busy household. */
  async function eatenUpPot() {
    const { x } = await busyHousehold(40);
    const meal = await x.ok("household_meal", {
      date: "2026-10-03", meal_slot: "dinner",
      cooks: [{ name: "Weighed pot", lines: [{ food: "peas", value: 300, unit: "g", provenance: "weighed" }], cooked_weight_g: 600, cooked_weight_provenance: "weighed", portions: [{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }] }],
    });
    const component = meal.cooks[0].components[0].id as number;
    await x.ok("mark_remainder", { component_id: component, disposition: "leftover", provenance: "estimated", date: "2026-10-03" });
    await x.ok("mark_remainder", { component_id: component, disposition: "eaten", member: "Asha", meal_slot: "lunch", weighed_g: 300, provenance: "weighed", date: MONDAY, speaker: "Asha" });
    const line = x.t.get("SELECT id FROM cook_line WHERE component_id = ?", component)?.id as number;
    const settled = () => x.t.get("SELECT settled_on FROM remainder_disposition WHERE component_id = ?", component)?.settled_on;
    expect(settled()).toBe(MONDAY);
    return { x, component, line, settled };
  }

  it(`amending a component's cooked weight so food remains (the re-open in the write batch): at most ${READ_BUDGET}`, async () => {
    const { x, component, settled } = await eatenUpPot();
    const run = await x.counted("amend", { record: { table: "component", id: component }, changes: { cooked_weight_g: 800 }, reason: "reweighed" }, "hritvik");
    expect(settled()).toBeNull();
    withinBudget(run, READ_BUDGET);
  });

  it(`amending a portion's fraction down so food remains (the re-open in the write batch): at most ${READ_BUDGET}`, async () => {
    const { x, component, settled } = await eatenUpPot();
    const portion = x.t.get("SELECT id FROM portion WHERE component_id = ?", component)?.id as number;
    const run = await x.counted("amend", { record: { table: "portion", id: portion }, changes: { fraction: 0.25 }, reason: "ate less" }, "hritvik");
    expect(settled()).toBeNull();
    withinBudget(run, READ_BUDGET);
  });

  it(`amending a cook line of a pot with a settled leftover still in it (the re-open in the write batch): at most ${READ_BUDGET}`, async () => {
    const { x, component, line, settled } = await eatenUpPot();
    x.t.run("UPDATE component SET cooked_weight_g = 800 WHERE id = ?", component);
    const run = await x.counted("amend", { record: { table: "cook_line", id: line }, changes: { amount_value: 350 }, reason: "more peas" }, "hritvik");
    expect(settled()).toBeNull();
    withinBudget(run, READ_BUDGET);
  });
});

/** `n` more Upper A sessions for Hritvik before the busy household's history, two days apart, three working pulldowns each. */
function seedSessions(x: Harness, s: ReturnType<typeof seedTraining>, n: number) {
  const { t, h } = x;
  for (let k = 1; k <= n; k++) {
    const day = new Date(Date.parse(`${MONDAY}T00:00:00Z`) - k * 86_400_000).toISOString().slice(0, 10);
    const session = t.insert("session", { member_id: h.hritvik, performed_on: day, gym_id: s.gym, session_type: "strength", state: "confirmed", confirmed_at: "2026-10-01T00:00:00Z" });
    for (let n_ = 1; n_ <= 3; n_++) {
      t.insert("session_set", {
        session_id: session, exercise_id: s.pulldown, set_number: n_, set_type: "working", reps: 10, load_status: "entered", load_value: 30 + (k % 5) * 5, load_unit: "kg",
        load_basis: "total", load_implement_id: s.stack, rir_status: "recorded", rir_low: 0, rir_high: 0, state: "confirmed", confirmed_at: "2026-10-01T00:00:00Z", position: n_,
      });
    }
  }
}

describe("app display: sessions", () => {
  it(`sessions over eight weeks of the busy household plus twenty more: at most ${READ_BUDGET}`, async () => {
    const { x, s } = await busyHousehold(40);
    seedSessions(x, s, 20);
    const run = await x.counted("sessions", { member: "Hritvik", from: "2026-08-01", to: MONDAY }, "asha");
    expect(run.body.sessions.length).toBeGreaterThanOrEqual(20);
    withinBudget(run, READ_BUDGET);
  });

  it(`sessions with 120 sessions in the range (more than 100 keys, chunked by allIn): at most ${READ_BUDGET}`, async () => {
    const { x, s } = await busyHousehold(40);
    seedSessions(x, s, 120);
    const started = performance.now();
    const run = await x.counted("sessions", { member: "Hritvik", from: "2026-01-01", to: MONDAY }, "hritvik");
    const ms = performance.now() - started;
    expect(run.body.sessions.length).toBeGreaterThan(100);
    // CPU: one pass over the history. BUDGET_REPORT=1 prints the time beside the count (Workers' CPU limit is 10 ms on Free, 30 s paid).
    if (process.env.BUDGET_REPORT) console.log(`CPU sessions over ${run.body.sessions.length} sessions: ${ms.toFixed(1)} ms (node, wall clock)`);
    withinBudget(run, READ_BUDGET);
  });

  it("sessions runs the same statements with twice the household", async () => {
    // Several exercises on several implements, so a per-exercise or per-implement query would show.
    const withMix = async (x: Harness, s: ReturnType<typeof seedTraining>) => {
      seedSessions(x, s, 10);
      const { t, h } = x;
      const sessions = t.all("SELECT id FROM session WHERE member_id = ? ORDER BY id DESC LIMIT 5", h.hritvik) as { id: number }[];
      const mix = [[s.bench, s.barbell], [s.curl, s.dumbbells], [s.calf, s.fixedBars], [s.pushup, null], [s.dbBench, s.dumbbells]] as const;
      sessions.forEach((se, i) => {
        const [exercise, implement] = mix[i % mix.length] as readonly [number, number | null];
        t.insert("session_set", {
          session_id: se.id, exercise_id: exercise, set_number: 9, set_type: "working", reps: 8, load_status: "entered", load_value: 10, load_unit: "kg",
          load_basis: "total", load_implement_id: implement, rir_status: "recorded", rir_low: 1, rir_high: 1, state: "confirmed", confirmed_at: "2026-10-01T00:00:00Z", position: 9,
        });
      });
    };
    const once = await busyHousehold(40);
    await withMix(once.x, once.s);
    const a = await once.x.counted("sessions", { member: "Hritvik", from: "2026-08-01", to: MONDAY }, "asha");
    const doubled = await busyHousehold(80, 2);
    await withMix(doubled.x, doubled.s);
    const b = await doubled.x.counted("sessions", { member: "Hritvik", from: "2026-08-01", to: MONDAY }, "asha");
    expect(b.statements, `once: ${a.statements}, twice: ${b.statements}\n${b.log.join("\n")}`).toBe(a.statements);
  });
});

describe("app display: history", () => {
  it(`history of an item amended five times, with names: at most ${READ_BUDGET}`, async () => {
    const { x } = await busyHousehold(40);
    const id = x.t.get("SELECT id FROM intake_item WHERE state = 'draft' ORDER BY id LIMIT 1")?.id as number;
    for (let i = 0; i < 5; i++) await x.ok("amend", { record: { table: "intake_item", id }, changes: { label: `edit ${i}` }, reason: "test edit" }, "hritvik");
    const run = await x.counted("history", { table: "intake_item", id }, "hritvik");
    expect(run.body.versions.length).toBeGreaterThanOrEqual(6);
    withinBudget(run, READ_BUDGET);
  });
});

describe("app display: day_meals honesty", () => {
  it(`day_meals with typed macros and the imported count: at most ${READ_BUDGET}`, async () => {
    const { x } = await busyHousehold(40);
    await x.ok("log_intake", { member: "Hritvik", date: MONDAY, meal_slot: "dinner", items: [{ source: "manual", kcal: 600, protein_g: 30, carbs_g: 60, fat_g: 26.7, reason: "Typed macros in Sheets (no catalogue ref).", provenance: "reconstructed", confidence: "medium" }] });
    const run = await x.counted("day_meals", { member: "Hritvik", date: MONDAY }, "hritvik");
    expect(run.body.honesty.typed_macros.items).toBe(1);
    withinBudget(run, READ_BUDGET);
  });
});
describe("a confirm that settles many questions (redesign-a plan, R2)", () => {
  it("All 20 days are right over 20 held days stays within the 30-statement budget", async () => {
    const x = invented();
    await seedFoods(x);
    const ids: number[] = [];
    for (let n = 0; n < 20; n++) {
      const out = await x.ok("log_intake", { member: "Asha", date: day(-n), meal_slot: "lunch", items: [{ source: "food", food: "Curd", value: 150, unit: "g", provenance: "estimated", confidence: "medium" }] }, "kabir");
      ids.push(out.items[0].id as number);
      await x.ok("ask_member", { member: "Asha", text: `Was day ${n + 1} curd or yogurt?`, choices: ["Curd", "Yogurt"], blocks: [{ table: "intake_item", id: out.items[0].id }] });
    }
    const run = await x.counted("confirm", { records: ids.map((id) => ({ table: "intake_item", id })) }, "asha");
    withinBudget(run, READ_BUDGET);
    expect(x.t.get("SELECT count(*) AS n FROM question WHERE status = 'dropped'")).toEqual({ n: 20 });
  });
});
