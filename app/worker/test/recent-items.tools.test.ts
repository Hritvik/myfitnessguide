// "My usual X" is history, not a stored default: the most frequent amount
// in the window, the most recent of a tie, so the last one logged when
// nothing repeats.
import { describe, expect, it } from "vitest";
import { toolWithinBudget } from "./budget";
import { setup } from "./harness";
import { bar20, busyInput, MONDAY, seedUpperA } from "./input-seed";
import { seedCatalogue, seedTraining } from "./seed";

const eggs = (value: number) => ({ source: "food", food: "egg", value, measure: "egg", provenance: "counted", confidence: "high" });
const rice = (state: string, value: number) => ({ source: "food", food: "rice", state, value, unit: "g", provenance: "weighed", confidence: "high" });
const day = (n: number) => new Date(Date.parse(`${MONDAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

async function ready() {
  const x = setup();
  await seedCatalogue(x);
  return x;
}

describe("recent_items", () => {
  it("gives the most frequent amount as the usual, over the last one logged", async () => {
    const x = await ready();
    await x.ok("log_intake", { member: "Hritvik", date: day(5), meal_slot: "breakfast", items: [eggs(2)] });
    await x.ok("log_intake", { member: "Hritvik", date: day(3), meal_slot: "breakfast", items: [eggs(2)] });
    await x.ok("log_intake", { member: "Hritvik", date: day(1), meal_slot: "breakfast", items: [eggs(3)] });
    const body = await x.ok("recent_items", { member: "Hritvik", date: MONDAY }, "hritvik");
    expect(body.items[0]).toEqual({ kind: "food_source", name: "Egg", ref: "FS003", state: "shelled", count: 3, last_on: day(1), usual: { food: "FS003", value: 2, measure: "egg" } });
  });

  it("falls back to the last one logged when nothing repeats", async () => {
    const x = await ready();
    await x.ok("log_intake", { member: "Hritvik", date: day(4), meal_slot: "lunch", items: [rice("cooked", 150)] });
    await x.ok("log_intake", { member: "Hritvik", date: day(2), meal_slot: "lunch", items: [rice("cooked", 180)] });
    const body = await x.ok("recent_items", { member: "Hritvik", date: MONDAY }, "hritvik");
    expect(body.items[0].usual).toEqual({ food: "FS002", value: 180, unit: "g" });
  });

  it("groups a food's states under its name, the usual taking the most frequent state", async () => {
    const x = await ready();
    await x.ok("log_intake", { member: "Hritvik", date: day(4), meal_slot: "lunch", items: [rice("cooked", 150)] });
    await x.ok("log_intake", { member: "Hritvik", date: day(3), meal_slot: "lunch", items: [rice("cooked", 150)] });
    await x.ok("log_intake", { member: "Hritvik", date: day(1), meal_slot: "lunch", items: [rice("dry", 60)] });
    const body = await x.ok("recent_items", { member: "Hritvik", date: MONDAY }, "hritvik");
    expect(body.items.filter((i: { name: string }) => i.name === "Rice")).toEqual([
      { kind: "food_source", name: "Rice", ref: "FS002", state: "cooked", count: 3, last_on: day(1), usual: { food: "FS002", value: 150, unit: "g" } },
    ]);
  });

  it("gives recipes by servings, and leaves out what is older than the window", async () => {
    const x = await ready();
    await x.ok("upsert_recipe", { name: "Curd rice", kind: "dish", servings: 1, lines: [{ food: "FS002", value: 200, unit: "g" }, { food: "FS004", value: 100, unit: "g" }] });
    await x.ok("log_intake", { member: "Hritvik", date: day(2), meal_slot: "dinner", items: [{ source: "recipe", recipe: "Curd rice", servings: 1.5, provenance: "estimated", confidence: "medium" }] });
    await x.ok("log_intake", { member: "Hritvik", date: day(40), meal_slot: "dinner", items: [eggs(4)] });
    const body = await x.ok("recent_items", { member: "Hritvik", date: MONDAY }, "hritvik");
    expect(body.items).toEqual([{ kind: "recipe", name: "Curd rice", ref: "R001", count: 1, last_on: day(2), usual: { recipe: "R001", servings: 1.5 } }]);
    expect((await x.ok("recent_items", { member: "Hritvik", date: MONDAY, days: 60 }, "hritvik")).items).toHaveLength(2);
  });

  it("lists exercises, today's first, with their usual load and reps", async () => {
    const x = setup();
    const s = seedTraining(x);
    seedUpperA(x, s);
    await x.ok("log_set", { member: "Hritvik", date: day(7), exercise: "lat pulldown", reps: 12, rir: 2, load: { value: 40, unit: "kg", basis: "total" } });
    await x.ok("log_set", { member: "Hritvik", date: day(7), exercise: "lat pulldown", reps: 12, rir: 2, load: { value: 40, unit: "kg", basis: "total" } });
    await x.ok("log_set", { member: "Hritvik", date: MONDAY, exercise: "bench", reps: 10, rir: 2, load: { value: 12.5, unit: "lb", basis: "per_side", bar: bar20 } });
    const body = await x.ok("recent_items", { member: "Hritvik", date: MONDAY }, "hritvik");
    expect(body.exercises).toEqual([
      { exercise: "Barbell bench press", count: 1, last_on: MONDAY, today: true, usual: { load: { value: 12.5, unit: "lb", basis: "per_side", bar: { value: 20, unit: "kg" } }, reps: 10 } },
      { exercise: "Cable lat pulldown", count: 2, last_on: day(7), today: false, usual: { load: { value: 40, unit: "kg", basis: "total" }, reps: 12 } },
    ]);
  });

  it("reads confirmed rows only: another member's draft about you is not your usual", async () => {
    const x = await ready();
    await x.ok("log_intake", { member: "Hritvik", date: day(3), meal_slot: "breakfast", items: [eggs(2)] });
    await x.ok("log_intake", { member: "Hritvik", date: day(2), meal_slot: "breakfast", items: [eggs(5)], speaker: "Asha" });
    await x.ok("log_intake", { member: "Hritvik", date: day(1), meal_slot: "breakfast", items: [eggs(5)], speaker: "Asha" });
    const body = await x.ok("recent_items", { member: "Hritvik", date: MONDAY }, "hritvik");
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ count: 1, last_on: day(3), usual: { value: 2 } });
  });

  it("leaves out a draft set, and never lets an unrecorded load beat an entered one", async () => {
    const x = setup();
    const s = seedTraining(x);
    seedUpperA(x, s);
    const session = x.t.insert("session", { member_id: x.h.hritvik, performed_on: day(2), gym_id: s.gym, session_type: "strength", state: "confirmed", confirmed_at: "2026-10-01T00:00:00Z" });
    const set = (n: number, o: Record<string, unknown>) =>
      x.t.insert("session_set", { session_id: session, exercise_id: s.pulldown, set_number: n, set_type: "working", reps: 10, rir_status: "not_recorded", position: n, state: "confirmed", confirmed_at: "2026-10-01T00:00:00Z", ...o });
    set(1, { load_status: "not_recorded" });
    set(2, { load_status: "not_recorded" });
    set(3, { load_status: "entered", load_value: 30, load_unit: "kg", load_basis: "total" });
    set(4, { load_status: "entered", load_value: 99, load_unit: "kg", load_basis: "total", state: "draft", confirmed_at: null });
    const body = await x.ok("recent_items", { member: "Hritvik", date: MONDAY }, "hritvik");
    expect(body.exercises).toHaveLength(1);
    expect(body.exercises[0]).toMatchObject({ count: 3, usual: { load: { value: 30, unit: "kg", basis: "total" }, reps: 10 } });
  });

  it("stays within the statement budget over a year of history, in one pass", async () => {
    const { x, s } = await busyInput(40);
    const { t, h } = x;
    const refs = t.all("SELECT id FROM food_source ORDER BY id") as { id: number }[];
    for (let k = 0; k < 365; k++) {
      const on = day(k);
      const session = t.insert("session", { member_id: h.hritvik, performed_on: on, gym_id: s.gym, session_type: "strength", state: "confirmed", confirmed_at: "2026-10-01T00:00:00Z" });
      for (let n = 1; n <= 10; n++) {
        t.insert("session_set", {
          session_id: session, exercise_id: n % 2 ? s.pulldown : s.bench, set_number: n, set_type: "working", reps: 8 + (k % 4), load_status: "entered", load_value: 30 + (k % 5) * 5,
          load_unit: "kg", load_basis: "total", rir_status: "recorded", rir_low: 1, rir_high: 1, state: "confirmed", confirmed_at: "2026-10-01T00:00:00Z", position: n,
        });
      }
      for (let n = 0; n < 3; n++) {
        t.insert("intake_item", {
          member_id: h.hritvik, eaten_on: on, meal_slot: "lunch", source_kind: "food_source", food_source_id: (refs[(k + n) % refs.length] as { id: number }).id,
          amount_value: 100 + (k % 3) * 50, amount_unit: "g", provenance: "weighed", confidence: "high", state: "confirmed", confirmed_at: "2026-10-01T00:00:00Z",
        });
      }
    }
    const started = performance.now();
    const run = await toolWithinBudget(x, "recent_items", { member: "Hritvik", days: 365, date: MONDAY }, "hritvik");
    const ms = performance.now() - started;
    if (process.env.BUDGET_REPORT) console.log(`CPU recent_items over 3650 sets and 1095 intake rows: ${ms.toFixed(1)} ms (node, wall clock)`);
    expect(run.body.exercises.length).toBeGreaterThan(0);
    expect(run.body.items.length).toBeGreaterThan(0);
  });

  it("stays within the budget at 40 implements", async () => {
    const { x } = await busyInput(40);
    await toolWithinBudget(x, "recent_items", { member: "Hritvik" }, "hritvik");
  });
});
