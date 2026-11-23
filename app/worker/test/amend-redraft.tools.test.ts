// Ticket 69: an edit by anyone but its member turns a confirmed record back
// into a draft, so its member is asked again (the 48 h starts from the
// edit); the member's own edit is unchanged. Invented data only.
import { describe, expect, it } from "vitest";
import { autoConfirm } from "../src/autoconfirm";
import { toolWithinBudget } from "./budget";
import { setup, type Harness } from "./harness";
import { seedCatalogue, seedTraining } from "./seed";

const DAY = "2026-10-05";
const rice = (value: number) => ({ source: "food", food: "FS002", value, unit: "g", provenance: "weighed", confidence: "high" });
const run = (x: Harness) => autoConfirm(x.db, x.clock.now);

async function ready() {
  const x = setup();
  await seedCatalogue(x);
  return x;
}

/** Hritvik logs an item about Asha (a draft), through the app or the agent. */
async function hisDraftAboutHer(x: Harness, via: "hritvik" | "agent" = "hritvik") {
  const logged = await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "dinner", items: [rice(100)] }, via);
  expect(logged.items[0].state).toBe("draft");
  return { table: "intake_item", id: logged.items[0].id as number };
}

/** Asha logs her own item from the app: confirmed. */
async function herConfirmedItem(x: Harness) {
  const logged = await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "lunch", items: [rice(150)] }, "asha");
  expect(logged.items[0].state).toBe("confirmed");
  return { table: "intake_item", id: logged.items[0].id as number };
}

const stateOf = (x: Harness, r: { table: string; id: number }) => x.t.get(`SELECT state, confirmed_at FROM ${r.table} WHERE id = ?`, r.id);
const refusal = async (x: Harness, tool: string, input: Record<string, unknown>, as: Parameters<Harness["call"]>[2]) => {
  const r = await x.call(tool, input, as);
  return [r.http, r.body.error?.code];
};

describe("an edit by anyone but its member makes a confirmed record a draft again", () => {
  it("re-drafts another member's confirmed item, says whose draft it is, and its member's confirm works", async () => {
    const x = await ready();
    const item = await herConfirmedItem(x);
    const body = await x.ok("amend", { record: item, changes: { amount_value: 120 }, reason: "smaller bowl" });
    expect(body.after).toMatchObject({ state: "draft", confirmed_at: null, amount_value: 120 });
    expect(body.state).toBe("draft");
    expect(body.draft_for).toBe("Asha");
    expect(stateOf(x, item)).toEqual({ state: "draft", confirmed_at: null });
    expect(x.t.get("SELECT on_behalf_of_member_id AS o FROM write_log ORDER BY id DESC LIMIT 1")).toEqual({ o: x.h.asha });
    const waiting = (await x.ok("household_overview", {}, "asha")).waiting_on_you.drafts.map((d: { table: string; id: number }) => `${d.table}:${d.id}`);
    expect(waiting).toContain(`intake_item:${item.id}`);
    await x.ok("confirm", { records: [item] }, "asha");
    expect(stateOf(x, item)).toMatchObject({ state: "confirmed" });
  });

  it("the 48 h auto-confirm runs from the edit", async () => {
    const x = await ready();
    const item = await herConfirmedItem(x);
    x.advanceHours(100);
    await x.ok("amend", { record: item, changes: { amount_value: 120 }, reason: "smaller bowl" }, "hritvik");
    x.advanceHours(47);
    expect((await run(x)).confirmed).toEqual([]);
    x.advanceHours(2);
    expect((await run(x)).confirmed).toEqual([item]);
  });

  it("a draft not yours to decide stays a draft", async () => {
    const x = await ready();
    const draft = await hisDraftAboutHer(x);
    const body = await x.ok("amend", { record: draft, changes: { amount_value: 90 }, reason: "less" }, "kabir");
    expect(body.after.state).toBe("draft");
    expect(body.draft_for).toBe("Asha");
  });

  it("the member's own edit is unchanged: a confirmed record stays confirmed, a draft about them confirms", async () => {
    const x = await ready();
    const item = await herConfirmedItem(x);
    const own = await x.ok("amend", { record: item, changes: { amount_value: 140 }, reason: "weighed again" }, "asha");
    expect(own.after.state).toBe("confirmed");
    expect(own.state).toBe("confirmed");
    expect(own.draft_for).toBeUndefined();
    const draft = await hisDraftAboutHer(x);
    expect((await x.ok("amend", { record: draft, changes: { amount_value: 90 }, reason: "less" }, "asha")).after.state).toBe("confirmed");
    // The agent talking with her is her own edit too.
    expect((await x.ok("amend", { speaker: "Asha", record: item, changes: { amount_value: 130 }, reason: "less" })).after.state).toBe("confirmed");
  });

  it("household records are nobody's to consent to: a food and a cook keep their state", async () => {
    const x = await ready();
    const food = x.t.get("SELECT id, state FROM food_source WHERE ref = 'FS002'") as { id: number; state: string };
    const amended = await x.ok("amend", { record: { table: "food_source", id: food.id }, changes: { tags: "invented" }, reason: "tagging" }, "asha");
    expect(amended.after.state).toBe(food.state);
    expect(amended.draft_for).toBeUndefined();
    const meal = await x.ok("household_meal", {
      date: DAY, meal_slot: "dinner",
      cooks: [{ name: "Invented dal", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }] }],
    }, "hritvik");
    const cook = { table: "cook", id: meal.cooks[0].id as number };
    expect(stateOf(x, cook)).toMatchObject({ state: "confirmed" });
    expect((await x.ok("amend", { record: cook, changes: { note: "invented" }, reason: "x" }, "asha")).after.state).toBe("confirmed");
  });

  it("a confirmed portion and its intake item become drafts together, and confirm together", async () => {
    const x = await ready();
    const meal = await x.ok("household_meal", {
      date: DAY, meal_slot: "dinner",
      cooks: [{ name: "Invented dal", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Asha", fraction: 0.5, provenance: "estimated" }] }],
    }, "asha");
    const portion = { table: "portion", id: meal.cooks[0].portions[0].id as number };
    const item = { table: "intake_item", id: (x.t.get("SELECT id FROM intake_item WHERE portion_id = ?", portion.id) as { id: number }).id };
    expect(stateOf(x, item)).toMatchObject({ state: "confirmed" });
    const body = await x.ok("amend", { record: portion, changes: { fraction: 0.4 }, reason: "she had less" }, "hritvik");
    expect(body.after.state).toBe("draft");
    expect(body.computed.linked).toEqual({ table: "intake_item", id: item.id, state: "draft" });
    expect(stateOf(x, item)).toEqual({ state: "draft", confirmed_at: null });
    // Amending the item side moves the portion the same way.
    await x.ok("confirm", { records: [portion] }, "asha");
    await x.ok("amend", { record: item, changes: { note: "invented" }, reason: "x" }, "hritvik");
    expect([stateOf(x, portion), stateOf(x, item)]).toEqual([{ state: "draft", confirmed_at: null }, { state: "draft", confirmed_at: null }]);
    expect((await x.ok("confirm", { records: [portion] }, "asha")).confirmed).toEqual([portion, item]);
  });

  it("a Coach-mode set its member confirmed at end_session, then edited by someone else, auto-confirms 48 h after the edit", async () => {
    const x = setup();
    const s = seedTraining(x);
    const session = (await x.ok("start_session", { origin: "coach", speaker: "Asha", member: "Asha", date: DAY, session_type: "strength", gym: s.gym })).session.id;
    const set = (await x.ok("log_set", { origin: "coach", speaker: "Asha", session_id: session, exercise: "lat pulldown", reps: 10, rir: { low: 1, high: 2 }, load: { value: 40, unit: "kg", basis: "total", implement: s.stack } })).set.id;
    await x.ok("end_session", { origin: "coach", speaker: "Asha", session_id: session });
    expect(stateOf(x, { table: "session_set", id: set })).toMatchObject({ state: "confirmed" });
    await x.ok("amend", { record: { table: "session_set", id: set }, changes: { reps: 9 }, reason: "she said 9" }, "hritvik");
    expect(stateOf(x, { table: "session_set", id: set })).toMatchObject({ state: "draft" });
    const listed = (await x.ok("household_overview", {}, "asha")).waiting_on_you.drafts.find((d: { id: number; table: string }) => d.table === "session_set" && d.id === set);
    expect(listed).toMatchObject({ waits: null });
    x.advanceHours(49);
    expect((await run(x)).confirmed).toEqual([{ table: "session_set", id: set }]);
  });

  it("a confirmed set's recorded RIR stays recorded, whoever edits it", async () => {
    const x = setup();
    const s = seedTraining(x);
    const session = (await x.ok("start_session", { member: "Hritvik", date: DAY, session_type: "strength", gym: s.gym }, "hritvik")).session.id;
    const set = (await x.ok("log_set", { session_id: session, exercise: "lat pulldown", reps: 10, rir: { low: 1, high: 2 }, load: { value: 40, unit: "kg", basis: "total", implement: s.stack } }, "hritvik")).set.id;
    const asked = await x.call("amend", { record: { table: "session_set", id: set }, changes: { rir_status: "not_recorded", rir_low: null, rir_high: null }, reason: "x" }, "asha");
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "rir_needed" });
  });

  it("a record its member had confirmed and someone else then edited is not the editor's to reject", async () => {
    const x = await ready();
    const draft = await hisDraftAboutHer(x);
    await x.ok("confirm", { records: [draft] }, "asha");
    await x.ok("amend", { record: draft, changes: { amount_value: 90 }, reason: "less" }, "hritvik");
    expect(stateOf(x, draft)).toMatchObject({ state: "draft" });
    expect(await refusal(x, "reject", { records: [draft], reason: "x" }, "hritvik")).toEqual([403, "not_yours_to_decide"]);
    // Her reject turns his edit down: the version she confirmed comes back (review P1-1).
    expect((await x.ok("reject", { records: [draft], reason: "not mine" }, "asha")).restored).toMatchObject([{ ...draft, version: 4 }]);
    expect(x.t.get("SELECT state, amount_value FROM intake_item WHERE id = ?", draft.id)).toEqual({ state: "confirmed", amount_value: 100 });
  });

  it("stays within the read budget", async () => {
    const x = await ready();
    const item = await herConfirmedItem(x);
    await toolWithinBudget(x, "amend", { record: item, changes: { amount_value: 120 }, reason: "smaller bowl" }, "hritvik");
  });
});

describe("who re-drafts, and what (review P2-1, P2-6)", () => {
  it("the member's own edit never re-drafts, whatever the origin, the Inbox included", async () => {
    const x = await ready();
    const item = await herConfirmedItem(x);
    const body = await x.ok("amend", { origin: "inbox", speaker: "Asha", record: item, changes: { amount_value: 120 }, reason: "her note" });
    expect(body.after.state).toBe("confirmed");
    expect(body.draft_for).toBeUndefined();
  });

  it("an Inbox edit naming another member, or naming nobody, re-drafts", async () => {
    const x = await ready();
    const item = await herConfirmedItem(x);
    expect((await x.ok("amend", { origin: "inbox", speaker: "Hritvik", record: item, changes: { amount_value: 120 }, reason: "his note" })).after.state).toBe("draft");
    await x.ok("confirm", { records: [item] }, "asha");
    expect((await x.ok("amend", { origin: "inbox", record: item, changes: { amount_value: 110 }, reason: "a note" })).draft_for).toBe("Asha");
  });

  it("the agent talking with another member re-drafts, and says for whom", async () => {
    const x = await ready();
    const item = await herConfirmedItem(x);
    const body = await x.ok("amend", { speaker: "Kabir", record: item, changes: { amount_value: 120 }, reason: "x" });
    expect([body.after.state, body.draft_for]).toEqual(["draft", "Asha"]);
  });

  it("a confirmed leftover serving and its item become drafts together", async () => {
    const x = await ready();
    const meal = await x.ok("household_meal", { date: DAY, meal_slot: "lunch", cooks: [{ name: "Invented dal", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Asha", fraction: 0.5, provenance: "estimated" }] }] }, "asha");
    const component = meal.cooks[0].components[0].id;
    await x.ok("mark_remainder", { component_id: component, disposition: "leftover", provenance: "estimated", date: DAY }, "asha");
    const eaten = await x.ok("mark_remainder", { component_id: component, disposition: "eaten", member: "Asha", meal_slot: "dinner", fraction: 0.1, provenance: "estimated", date: DAY }, "asha");
    const serving = { table: "leftover_serving", id: eaten.serving.id as number };
    const item = { table: "intake_item", id: (x.t.get("SELECT id FROM intake_item WHERE leftover_serving_id = ?", serving.id) as { id: number }).id };
    expect([stateOf(x, serving), stateOf(x, item)].map((r) => (r as { state: string }).state)).toEqual(["confirmed", "confirmed"]);
    const body = await x.ok("amend", { record: serving, changes: { provenance: "weighed" }, reason: "x" }, "hritvik");
    expect(body.computed.linked).toEqual({ table: "intake_item", id: item.id, state: "draft" });
    expect([stateOf(x, serving), stateOf(x, item)]).toEqual([{ state: "draft", confirmed_at: null }, { state: "draft", confirmed_at: null }]);
  });

  it("a session re-drafts alone: its sets keep their state", async () => {
    const x = setup();
    const s = seedTraining(x);
    const session = (await x.ok("start_session", { member: "Asha", date: DAY, session_type: "strength", gym: s.gym }, "asha")).session.id;
    const set = (await x.ok("log_set", { session_id: session, exercise: "lat pulldown", reps: 10, rir: { low: 1, high: 2 }, load: { value: 40, unit: "kg", basis: "total", implement: s.stack } }, "asha")).set.id;
    await x.ok("end_session", { session_id: session }, "asha");
    await x.ok("amend", { record: { table: "session", id: session }, changes: { note: "invented" }, reason: "x" }, "hritvik");
    expect(stateOf(x, { table: "session", id: session })).toEqual({ state: "draft", confirmed_at: null });
    expect(stateOf(x, { table: "session_set", id: set })).toMatchObject({ state: "confirmed" });
  });

  it("a portion's re-draft stays within the read budget", async () => {
    const x = await ready();
    const meal = await x.ok("household_meal", { date: DAY, meal_slot: "dinner", cooks: [{ name: "Invented dal", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Asha", fraction: 0.5, provenance: "estimated" }] }] }, "asha");
    await toolWithinBudget(x, "amend", { record: { table: "portion", id: meal.cooks[0].portions[0].id }, changes: { fraction: 0.4 }, reason: "less" }, "hritvik");
  });
});

describe("the member undoes someone else's edit (review P1-1)", () => {
  it("rejecting a re-drafted item restores the version they confirmed, as a new version, and keeps the item", async () => {
    const x = await ready();
    const item = await herConfirmedItem(x);
    const confirmedAt = (stateOf(x, item) as { confirmed_at: string }).confirmed_at;
    x.advanceHours(5);
    await x.ok("amend", { record: item, changes: { amount_value: 120, note: "invented" }, reason: "smaller bowl" }, "hritvik");
    x.advanceHours(1);
    const body = await x.ok("reject", { records: [item], reason: "it was 150" }, "asha");
    expect(body.rejected).toEqual([]);
    expect(body.restored).toMatchObject([{ table: "intake_item", id: item.id, version: 3 }]);
    expect(body.restored[0].computed.nutrients.kcal.value).toBeGreaterThan(0);
    expect(x.t.get("SELECT state, confirmed_at, amount_value, note FROM intake_item WHERE id = ?", item.id)).toEqual({ state: "confirmed", confirmed_at: confirmedAt, amount_value: 150, note: null });
    expect((await x.ok("day_totals", { member: "Asha", date: DAY }, "asha")).item_count).toBe(1);
    const history = await x.ok("history", { table: "intake_item", id: item.id });
    expect(history.versions.at(-1)).toMatchObject({ version: 3, reason: "it was 150", data: { amount_value: 150, state: "confirmed" } });
    expect((await run(x)).confirmed).toEqual([]);
  });

  it("restores a portion and its item together", async () => {
    const x = await ready();
    const meal = await x.ok("household_meal", { date: DAY, meal_slot: "dinner", cooks: [{ name: "Invented dal", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Asha", fraction: 0.5, provenance: "estimated" }] }] }, "asha");
    const portion = { table: "portion", id: meal.cooks[0].portions[0].id as number };
    const item = { table: "intake_item", id: (x.t.get("SELECT id FROM intake_item WHERE portion_id = ?", portion.id) as { id: number }).id };
    await x.ok("amend", { record: portion, changes: { fraction: 0.4 }, reason: "less" }, "hritvik");
    const body = await x.ok("reject", { records: [portion], reason: "it was half" }, "asha");
    expect(body.restored.map((r: { table: string; id: number }) => ({ table: r.table, id: r.id }))).toEqual([portion, item]);
    expect(x.t.get("SELECT state, fraction FROM portion WHERE id = ?", portion.id)).toEqual({ state: "confirmed", fraction: 0.5 });
    expect(stateOf(x, item)).toMatchObject({ state: "confirmed" });
  });

  it("restores a session's row alone; its sets stay", async () => {
    const x = setup();
    const s = seedTraining(x);
    const session = (await x.ok("start_session", { member: "Asha", date: DAY, session_type: "strength", gym: s.gym }, "asha")).session.id;
    const set = (await x.ok("log_set", { session_id: session, exercise: "lat pulldown", reps: 10, rir: { low: 1, high: 2 }, load: { value: 40, unit: "kg", basis: "total", implement: s.stack } }, "asha")).set.id;
    await x.ok("end_session", { session_id: session }, "asha");
    await x.ok("amend", { record: { table: "session", id: session }, changes: { performed_on: "2026-10-04" }, reason: "x" }, "hritvik");
    const body = await x.ok("reject", { records: [{ table: "session", id: session }], reason: "it was the 5th" }, "asha");
    expect(body.restored).toHaveLength(1);
    expect(x.t.get("SELECT state, performed_on FROM session WHERE id = ?", session)).toEqual({ state: "confirmed", performed_on: DAY });
    expect(stateOf(x, { table: "session_set", id: set })).toMatchObject({ state: "confirmed" });
  });

  it("a never-confirmed draft is still deleted", async () => {
    const x = await ready();
    const draft = await hisDraftAboutHer(x);
    await x.ok("amend", { record: draft, changes: { amount_value: 90 }, reason: "less" }, "kabir");
    const body = await x.ok("reject", { records: [draft], reason: "not eaten" }, "asha");
    expect([body.rejected, body.restored]).toEqual([[draft], []]);
  });

  it("stays within the read budget", async () => {
    const x = await ready();
    const item = await herConfirmedItem(x);
    await x.ok("amend", { record: item, changes: { amount_value: 120 }, reason: "x" }, "hritvik");
    await toolWithinBudget(x, "reject", { records: [item], reason: "it was 150" }, "asha");
  });
});

describe("day_meals says which drafts were re-drafted, and by whom (review P2-3, P2-4)", () => {
  it("a re-drafted item is ever_confirmed with edited_by its editor; a plain draft is neither", async () => {
    const x = await ready();
    const item = await herConfirmedItem(x);
    await x.ok("amend", { record: item, changes: { amount_value: 120 }, reason: "x" }, "hritvik");
    const plain = await hisDraftAboutHer(x, "agent");
    const run = await toolWithinBudget(x, "day_meals", { member: "Asha", date: DAY }, "asha");
    const items = run.body.slots.flatMap((s: { items: unknown[] }) => s.items) as { id: number; logged_by: unknown; ever_confirmed: boolean; edited_by: unknown }[];
    const of = (id: number) => items.find((i) => i.id === id);
    expect(of(item.id)).toMatchObject({ logged_by: { kind: "member", name: "Asha" }, ever_confirmed: true, edited_by: { kind: "member", name: "Hritvik" } });
    expect(of(plain.id)).toMatchObject({ logged_by: { kind: "agent", origin: "live", speaker: "Hritvik" }, ever_confirmed: false, edited_by: null });
  });
});

describe("undoing many edits in one reject is set-based (re-review P1-R1)", () => {
  /** Asha's confirmed items and portions, each then edited by Hritvik: `items` items and `pots` portions, all re-drafted. */
  async function redrafts(x: Harness, items: number, pots: number) {
    const refs: { table: string; id: number }[] = [];
    for (let i = 0; i < items; i += 25) {
      const n = Math.min(25, items - i);
      const logged = await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "lunch", items: Array.from({ length: n }, (_, k) => rice(100 + k)) }, "asha");
      refs.push(...logged.items.map((it: { id: number }) => ({ table: "intake_item", id: it.id })));
    }
    for (let p = 0; p < pots; p++) {
      const meal = await x.ok("household_meal", { date: DAY, meal_slot: "dinner", cooks: [{ name: `Invented dal ${p}`, lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Asha", fraction: 0.5, provenance: "estimated" }] }] }, "asha");
      refs.push({ table: "portion", id: meal.cooks[0].portions[0].id });
    }
    for (const r of refs) {
      await x.ok("amend", { record: r, changes: r.table === "portion" ? { fraction: 0.4 } : { amount_value: 90 }, reason: "less" }, "hritvik");
    }
    return refs;
  }

  const countFor = async (n: number, pots = 0) => {
    const x = await ready();
    const refs = await redrafts(x, n, pots);
    const run = await x.counted("reject", { records: refs, reason: "it was what I said" }, "asha");
    return { x, refs, run };
  };

  it("restores 98 items and 2 portions (with their items) in one reject, within the read budget", async () => {
    const { x, refs, run } = await countFor(98, 2);
    expect(run.statements, run.log.join("\n")).toBeLessThanOrEqual(30);
    expect(run.body.rejected).toEqual([]);
    expect(run.body.restored).toHaveLength(102);
    expect(x.t.get("SELECT count(*) AS n FROM intake_item WHERE state = 'confirmed' AND member_id = ?", x.h.asha)).toEqual({ n: 100 });
    expect(x.t.get("SELECT count(*) AS n FROM portion WHERE state = 'confirmed' AND fraction = 0.5")).toEqual({ n: 2 });
    const first = refs[0] as { id: number };
    expect(x.t.get("SELECT amount_value FROM intake_item WHERE id = ?", first.id)).toEqual({ amount_value: 100 });
    const history = await x.ok("history", { table: "intake_item", id: first.id });
    expect(history.versions.at(-1)).toMatchObject({ version: 3, action: "amend", data: { state: "confirmed", amount_value: 100 } });
  });

  it("costs the same for 1, 15 and 100 restores", async () => {
    const counts = [];
    for (const n of [1, 15, 100]) counts.push((await countFor(n)).run.statements);
    expect(new Set(counts).size).toBe(1);
  });

  it("a batch that deletes some drafts and restores some re-drafts does both, within the read budget", async () => {
    const x = await ready();
    const restoring = await redrafts(x, 40, 1);
    const fresh = (await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "snack", items: [rice(50), rice(60), rice(70)] }, "hritvik")).items.map((i: { id: number }) => ({ table: "intake_item", id: i.id }));
    const run = await toolWithinBudget(x, "reject", { records: [...fresh, ...restoring], reason: "x" }, "asha");
    expect(run.body.rejected).toEqual(fresh);
    expect(run.body.restored).toHaveLength(42);
    expect(x.t.get("SELECT count(*) AS n FROM intake_item WHERE meal_slot = 'snack'")).toEqual({ n: 0 });
  });
});

describe("day_cooks asks about a re-drafted portion as a re-draft (re-review)", () => {
  it("its ask says ever_confirmed and edited_by; a plain draft portion's says neither", async () => {
    const x = await ready();
    const meal = await x.ok("household_meal", { date: DAY, meal_slot: "dinner", cooks: [{ name: "Invented dal", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Asha", fraction: 0.5, provenance: "estimated" }] }] }, "asha");
    await x.ok("amend", { record: { table: "portion", id: meal.cooks[0].portions[0].id }, changes: { fraction: 0.4 }, reason: "less" }, "hritvik");
    await x.ok("household_meal", { date: DAY, meal_slot: "lunch", cooks: [{ name: "Invented rajma", lines: [{ food: "peas", value: 300, unit: "g", provenance: "weighed" }], portions: [{ member: "Asha", fraction: 0.3, provenance: "estimated" }] }] }, "hritvik");
    const cooks = (await x.ok("day_cooks", { member: "Asha", date: DAY }, "asha")).cooks as { name: string; ask: Record<string, unknown> }[];
    expect(cooks.find((c) => c.name === "Invented dal")?.ask).toMatchObject({ logged_by: { kind: "member", name: "Asha" }, ever_confirmed: true, edited_by: { kind: "member", name: "Hritvik" } });
    expect(cooks.find((c) => c.name === "Invented rajma")?.ask).toMatchObject({ logged_by: { kind: "member", name: "Hritvik" }, ever_confirmed: false, edited_by: null });
  });
});
