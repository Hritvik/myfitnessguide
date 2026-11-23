// The waiting read (redesign-a spec §5): Waiting on you's four groups and the badge, the Worker's grouping and
// count, owner filters, partial totals, the cap, and the budget on a stress household. Invented data.
// The ChatGPT reconciliation keeps training/equipment in their dedicated reads.
import { describe, expect, it } from "vitest";
import { toolWithinBudget } from "./budget";
import { day, invented, seedFoods, WED } from "./invented";

const food = (name: string, value: number, extra: Record<string, unknown> = {}) => ({ source: "food", food: name, value, unit: "g", provenance: "estimated", confidence: "medium", ...extra });

async function ready() {
  const x = invented();
  await seedFoods(x);
  return x;
}

describe("waiting: a member names only themselves", () => {
  it("answers for the signed-in member, refuses another, and the agent may name anyone", async () => {
    const x = await ready();
    expect((await x.ok("waiting", {}, "asha")).member).toBe("Asha");
    expect((await x.call("waiting", { member: "Kabir" }, "asha")).http).toBe(403);
    expect((await x.ok("waiting", { member: "Kabir" })).member).toBe("Kabir");
  });
});

describe("waiting: Logged for you", () => {
  it.each([
    { input: { fraction: 0.2 }, expected: { fraction: 0.2 } },
    { input: { weighed_g: 120 }, expected: { grams: 120 } },
  ])("shows a leftover serving's known amount $expected", async ({ input, expected }) => {
    const x = await ready();
    // An older pot is outside the settlement window; Asha did not have an original portion.
    const meal = await x.ok("household_meal", { date: day(-4), meal_slot: "dinner", cooks: [{
      name: "Toor dal pot", cooked_weight_g: 600, cooked_weight_provenance: "weighed",
      lines: [{ food: "Toor dal", value: 600, unit: "g", provenance: "weighed" }],
      portions: [{ member: "Kabir", fraction: 0.4, provenance: "estimated" }],
    }] }, "kabir");
    const component = meal.cooks[0].components[0].id;
    await x.ok("mark_remainder", { component_id: component, disposition: "leftover", provenance: "estimated", date: day(-4) }, "kabir");
    const eaten = await x.ok("mark_remainder", { component_id: component, disposition: "eaten", member: "Asha", meal_slot: "lunch", date: WED, provenance: "estimated", ...input }, "kabir");

    const run = await toolWithinBudget(x, "waiting", {}, "asha");
    const [handoff] = run.body.handoffs;
    expect(handoff.items).toHaveLength(1);
    expect(handoff.items[0]).toMatchObject({ table: "leftover_serving", id: eaten.serving.id, amount: expected });
    expect(handoff.items[0].kcal).toBeCloseTo(139.2);
    expect(handoff.items[0].protein).toBeCloseTo(8.16);
    expect(handoff.totals.kcal).toBeCloseTo(139.2);
    expect(handoff.totals.protein).toBeCloseTo(8.16);
    expect(handoff.totals.unknown_items).toEqual({ kcal: 0, protein: 0, any: 0 });
  });

  it("groups Kabir's lunch for Asha into one card with items, kcal and a total, and counts it once", async () => {
    const x = await ready();
    await x.ok("log_intake", { member: "Asha", date: WED, meal_slot: "lunch", items: [food("Curd", 150), food("Rice", 200)] }, "kabir");
    const w = await x.ok("waiting", {}, "asha");
    expect(w.handoffs).toHaveLength(1);
    expect(w.handoffs[0]).toMatchObject({
      kind: "handoff", type: "food", logger: { member: "Kabir", origin: "app" }, date: WED, slot: "lunch", waits: null,
      totals: { kcal: 330, unknown_items: { kcal: 0, protein: 0, any: 0 } },
    });
    expect(w.handoffs[0].totals.protein).toBeCloseTo(10.05);
    expect(w.handoffs[0].items.map((i: { summary: string; amount: unknown; kcal: number }) => [i.summary, i.amount, i.kcal])).toEqual([["Curd", { value: 150, unit: "g" }, 90], ["Rice", { value: 200, unit: "g" }, 240]]);
    expect(w.count).toBe(1);
  });

  // Review Focus 5: an item nobody can value leaves the total partial, with the count.
  it("carries unknown_items when an item can't be valued, and null kcal for it", async () => {
    const x = await ready();
    const logged = await x.ok("log_intake", { member: "Asha", date: WED, meal_slot: "lunch", items: [food("Curd", 150), food("Egg", 100)] }, "kabir");
    // Existing/imported rows may have an amount nobody can convert; new writes correctly refuse it.
    x.t.db.prepare("UPDATE intake_item SET amount_value = 2, amount_unit = 'piece' WHERE id = ?").run(logged.items[1].id);
    const [h] = (await x.ok("waiting", {}, "asha")).handoffs;
    expect(h.totals).toMatchObject({ kcal: 90, unknown_items: { kcal: 1, protein: 1, any: 1 } });
    expect(h.totals.protein).toBeCloseTo(5.25);
    expect(h.items[1]).toMatchObject({ summary: "Egg", kcal: null, protein: null });
  });

  it("folds Asha's four-day back-fill for Noor into one batch on Noor's list, counted by its days, and on Asha's waiting on others", async () => {
    const x = await ready();
    for (const n of [-3, -2, -1, 0]) {
      await x.ok("log_intake", { member: "Noor", date: day(n), meal_slot: "lunch", items: [food("Rice", 150)] }, "asha");
      x.advanceHours(0.25);
    }
    // Isolate the four batch days from the independent yesterday-open settlement rule.
    await x.ok("set_day_status", { member: "Noor", date: day(-1), status: "complete" }, "noor");
    const noor = await x.ok("waiting", {}, "noor");
    expect(noor.handoffs.map((u: { kind: string }) => u.kind)).toEqual(["batch"]);
    expect(noor.handoffs[0].days.map((d: { date: string; items: number }) => [d.date, d.items])).toEqual([[day(-3), 1], [day(-2), 1], [day(-1), 1], [day(0), 1]]);
    expect(noor.count).toBe(4);
    const asha = await x.ok("waiting", {}, "asha");
    expect(asha.on_others).toEqual([expect.objectContaining({ member: "Noor", kind: "batch", from: day(-3), to: day(0), items: 4, can_take_back: true })]);
  });

  it("says who edited a re-draft", async () => {
    const x = await ready();
    const id = (await x.ok("log_intake", { member: "Asha", date: WED, meal_slot: "lunch", items: [food("Curd", 150)] }, "asha")).items[0].id;
    await x.ok("amend", { record: { table: "intake_item", id }, changes: { amount_value: 250 }, reason: "A bigger bowl" }, "kabir");
    const [h] = (await x.ok("waiting", {}, "asha")).handoffs;
    expect(h.items[0]).toMatchObject({ ever_confirmed: true, edited_by: "Kabir" });
  });
});

describe("waiting: assistant questions, To settle, Sent for review, owner filters", () => {
  it("lists Asha's open question with her quoted text, the pot to settle, yesterday open and her sent text; the count adds them", async () => {
    const x = await ready();
    const text = "two phulka with the leftover dal";
    const sent = await x.ok("submit_to_inbox", { member: "Asha", date: WED, meal_slot: "dinner", text, spans: [{ text: "the leftover dal", start: text.indexOf("the leftover dal"), end: text.length }] }, "asha");
    await x.ok("ask_member", { member: "Asha", text: "Which dal was it?", choices: ["Toor dal", "Dal makhani"], inbox_entry_id: sent.entry.id });
    await x.ok("household_meal", { date: day(-1), meal_slot: "dinner", cooks: [{ name: "Toor dal pot", lines: [{ food: "Toor dal", value: 600, unit: "g", provenance: "weighed" }], portions: [{ member: "Asha", fraction: 0.4, provenance: "estimated" }] }] }, "asha");
    const w = await x.ok("waiting", {}, "asha");
    expect(w.asks).toEqual([expect.objectContaining({ kind: "question", text: "Which dal was it?", quote: { text: "two phulka with the leftover dal", sent_at: sent.entry.created_at } })]);
    expect(w.settle.map((s: { kind: string }) => s.kind)).toEqual(["remainder", "yesterday"]);
    expect(w.sent.map((s: { text: string }) => s.text)).toEqual(["two phulka with the leftover dal"]);
    expect(w.count).toBe(3);
  });

  it("never shows Kabir a reading he logged about Asha (owner-only, spec §2's departure), and never Asha's sent texts", async () => {
    const x = await ready();
    // Claude, talking with Kabir, logs Asha's weight: her draft, logged by Kabir, and owner-only.
    await x.ok("log_reading", { member: "Asha", date: WED, metric: "weight", value: 66.4, unit: "kg", body_state: "fasted", measurer: "not_recorded", speaker: "Kabir" });
    await x.ok("submit_to_inbox", { member: "Asha", date: WED, text: "a chai at five", spans: [{ text: "a chai at five", start: 0, end: 14 }] }, "asha");
    const kabir = await x.ok("waiting", {}, "kabir");
    expect(kabir.on_others).toEqual([]);
    expect(kabir.sent).toEqual([]);
  });
});

// R6: due lines are the Worker's, structured; the web only words them.
describe("waiting: due lines", () => {
  it("lists raised cadences by id (a reading one with its metric, a computed one without), then open flags due within 7 days", async () => {
    const x = await ready();
    await x.ok("set_measurement_cadence", { member: "Asha", name: "waist", every_days: 7, source: { kind: "reading", metric: "waist_navel", body_state: "fasted" }, message: "Measure it." }, "asha");
    await x.ok("set_measurement_cadence", { member: "Asha", name: "weight", every_days: 7, source: { kind: "reading", metric: "weight", body_state: "fasted" }, message: "Measure it." }, "asha");
    await x.ok("raise_flag", { member: "Asha", subtype: "health_watch", subject: "Repeat the thyroid panel", due_on: day(5) }, "asha");
    await x.ok("raise_flag", { member: "Asha", subtype: "health_watch", subject: "Later", due_on: day(30) }, "asha");
    const due = (await x.ok("waiting", {}, "asha")).due;
    // Two cadences with one message each keep their own metric (never matched by text).
    expect(due.filter((d: { kind: string }) => d.kind === "reading").map((d: { metric: string; body_state: string }) => [d.metric, d.body_state]).sort()).toEqual([["waist_navel", "fasted"], ["weight", "fasted"]]);
    expect(due.filter((d: { kind: string }) => d.kind === "flag")).toEqual([{ kind: "flag", flag_id: expect.any(Number), subject: "Repeat the thyroid panel", due_on: day(5), window_days: 7 }]);
    expect((await x.ok("waiting", {}, "asha")).count).toBe(0);
  });

  it("gives a computed metric's cadence no field", async () => {
    const x = await ready();
    await x.ok("set_measurement_cadence", { member: "Asha", name: "wth", every_days: 30, source: { kind: "reading", metric: "waist_to_height" }, message: "Waist to height is due." }, "asha");
    expect((await x.ok("waiting", {}, "asha")).due).toEqual([expect.objectContaining({ kind: "cadence", name: "wth", message: "Waist to height is due.", last: null, due_since: null })]);
  });
});

// Reconciliation decision 6: equipment stays in inventory_gaps, outside the global badge.
describe("waiting: equipment stays in its dedicated read", () => {
  it("does not duplicate an inventory gap into waiting", async () => {
    const x = await ready();
    const gym = x.t.insert("gym", { household_id: x.h.id, name: "Sample Gym" });
    x.t.db.prepare("UPDATE member SET home_gym_id = ? WHERE id = ?").run(gym, x.h.asha);
    const stack = x.t.insert("implement", { gym_id: gym, name: "Row stack", kind: "cable", unit: "kg", loading: "total", load_list_complete: 0 });
    for (const load of [20, 25, 30]) x.t.insert("implement_load", { implement_id: stack, load, unit: "kg" });
    const w = await x.ok("waiting", {}, "asha");
    expect(w).not.toHaveProperty("inventory");
    expect(w.asks).toEqual([]);
    expect(w.count).toBe(0);
    expect((await x.ok("inventory_gaps", { member: "Asha" }, "asha")).ask).toMatchObject({ kind: "stack_top", implement: "Row stack" });
  });
});

describe("waiting: the cap and the budget", () => {
  // Review Focus 3: a 40-day back-fill, more than 100 drafts.
  it("keeps whole hand-offs up to 100 drafts, says truncated, counts everything, within the read budget", async () => {
    const x = await ready();
    for (let n = 0; n < 40; n++) {
      await x.ok("log_intake", { member: "Asha", date: day(-n), meal_slot: "lunch", items: [food("Curd", 150), food("Rice", 150), food("Toor dal", 100)] }, "kabir");
      x.advanceHours(3);
    }
    const run = await toolWithinBudget(x, "waiting", {}, "asha");
    expect(run.body.truncated).toBe(true);
    expect(run.body.handoffs.flatMap((u: { items: unknown[] }) => u.items).length).toBe(99);
    expect(run.body.count).toBe(40);
    if (process.env.BUDGET_REPORT) console.log(`BUDGET waiting, 120 drafts: ${run.statements}`);
  });
});
