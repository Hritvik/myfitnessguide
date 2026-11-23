// commit_route: the free-text Save. Every resolved piece in one atomic
// write, and the router's stats for app writes only.
import { describe, expect, it } from "vitest";
import { toolWithinBudget } from "./budget";
import { setup } from "./harness";
import { busyInput, MONDAY, seedUpperA } from "./input-seed";
import { seedCatalogue, seedTraining } from "./seed";

async function ready() {
  const x = setup();
  await seedCatalogue(x);
  const s = seedTraining(x);
  seedUpperA(x, s);
  const meal = await x.ok("household_meal", {
    date: MONDAY, meal_slot: "lunch",
    cooks: [{ name: "Ghugni", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Asha", fraction: 0.25, provenance: "estimated" }] }],
  }, "asha");
  return { x, component: meal.cooks[0].components[0].id as number };
}

const egg = { kind: "item", item: { source: "food", food: "egg", value: 2, measure: "egg", provenance: "estimated", confidence: "medium", label: "2 eggs" } };
const pulldown = { kind: "set", count: 2, set: { exercise: "Cable lat pulldown", set_type: "working", reps: 12, rir: { low: 2, high: 2 }, load: { value: 40, unit: "kg", basis: "total" } } };
const count = (x: Awaited<ReturnType<typeof ready>>["x"], table: string) => x.t.get(`SELECT count(*) AS n FROM ${table}`)?.n as number;

describe("commit_route", () => {
  it("writes food, a share of today's pot and sets in one write, and records the stats", async () => {
    const { x, component } = await ready();
    const batches = x.db.batches;
    const body = await x.ok("commit_route", {
      member: "Hritvik", date: MONDAY, meal_slot: "dinner",
      pieces: [
        { entry: egg, edited: false },
        { entry: { kind: "cook", component_id: component, fraction: 0.5, provenance: "estimated" }, edited: true },
        { entry: pulldown, edited: false },
      ],
    }, "hritvik");
    expect(x.db.batches).toBe(batches + 1);
    expect(body.items).toEqual([expect.objectContaining({ ref: "FS003", meal_slot: "dinner", state: "confirmed" })]);
    expect(body.portions[0]).toMatchObject({ component: "whole", fraction: 0.5, state: "confirmed" });
    expect(body.portions[0].nutrients.kcal.value).toBeCloseTo(162, 9);
    expect(body.sets.session).toMatchObject({ created: true, template: "Upper A" });
    expect(body.sets.sets.map((s: { set: { set_number: number } }) => s.set.set_number)).toEqual([1, 2]);
    expect(body.stats).toEqual({ unedited: 2, edited: 1 });
    expect(x.t.all("SELECT member_id, recorded_on, unedited, edited, inbox FROM route_stat")).toEqual([{ member_id: x.h.hritvik, recorded_on: MONDAY, unedited: 2, edited: 1, inbox: 0 }]);
    expect(x.t.get("SELECT eaten_on, meal_slot, source_kind FROM intake_item WHERE portion_id = ?", body.portions[0].id)).toEqual({ eaten_on: MONDAY, meal_slot: "dinner", source_kind: "portion" });
  });

  it("is atomic: one piece's question writes nothing", async () => {
    const { x, component } = await ready();
    const before = [count(x, "intake_item"), count(x, "portion"), count(x, "session_set"), count(x, "route_stat")];
    const reply = await x.call("commit_route", {
      member: "Hritvik", date: MONDAY, meal_slot: "dinner",
      pieces: [{ entry: egg, edited: false }, { entry: { kind: "cook", component_id: component, fraction: 0.9, provenance: "estimated" }, edited: false }],
    }, "hritvik");
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "portions_exceed_whole" });
    expect([count(x, "intake_item"), count(x, "portion"), count(x, "session_set"), count(x, "route_stat")]).toEqual(before);
  });

  it("records no stats for an agent's call", async () => {
    const { x } = await ready();
    const body = await x.ok("commit_route", { member: "Hritvik", date: MONDAY, meal_slot: "dinner", pieces: [{ entry: egg, edited: false }] });
    expect(body.stats).toBeNull();
    expect(count(x, "route_stat")).toBe(0);
  });

  it("writes another member's pieces as drafts", async () => {
    const { x } = await ready();
    const body = await x.ok("commit_route", { member: "Asha", date: MONDAY, meal_slot: "dinner", pieces: [{ entry: egg, edited: false }] }, "hritvik");
    expect(body.items[0].state).toBe("draft");
  });

  it("asks for the meal when food comes without one, and for a second share of one pot", async () => {
    const { x, component } = await ready();
    expect((await x.call("commit_route", { member: "Hritvik", date: MONDAY, pieces: [{ entry: egg, edited: false }] }, "hritvik")).body).toMatchObject({ reason: "meal_slot_needed" });
    const twice = { kind: "cook", component_id: component, fraction: 0.2, provenance: "estimated" };
    expect((await x.call("commit_route", { member: "Hritvik", date: MONDAY, meal_slot: "dinner", pieces: [{ entry: twice, edited: false }, { entry: twice, edited: false }] }, "hritvik")).body).toMatchObject({ reason: "duplicate_portion" });
  });

  it("refuses an empty Save", async () => {
    const { x } = await ready();
    expect((await x.call("commit_route", { member: "Hritvik", date: MONDAY, meal_slot: "dinner", pieces: [] }, "hritvik")).http).toBe(400);
  });

  it("takes a session_id for sets when the member has several sessions that day", async () => {
    const { x } = await ready();
    const a = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper A" })).session.id;
    await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength" });
    expect((await x.call("commit_route", { member: "Hritvik", date: MONDAY, pieces: [{ entry: pulldown, edited: false }] }, "hritvik")).body).toMatchObject({ reason: "session_choice" });
    const body = await x.ok("commit_route", { member: "Hritvik", date: MONDAY, session_id: a, pieces: [{ entry: pulldown, edited: false }] }, "hritvik");
    expect(body.sets.session.id).toBe(a);
  });

  it("stays within the budget with food, a share of the pot and sets for a new session, at 40 implements", async () => {
    const { x } = await busyInput(40);
    const meal = await x.ok("household_meal", {
      date: MONDAY, meal_slot: "lunch",
      cooks: [{ name: "Ghugni", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Asha", fraction: 0.25, provenance: "estimated" }] }],
    }, "asha");
    const run = await toolWithinBudget(x, "commit_route", {
      member: "Hritvik", date: MONDAY, meal_slot: "dinner",
      pieces: [
        { entry: egg, edited: false },
        { entry: { kind: "item", item: { source: "food", food: "curd", value: 100, unit: "g", provenance: "estimated", confidence: "medium" } }, edited: false },
        { entry: { kind: "cook", component_id: meal.cooks[0].components[0].id, fraction: 0.5, provenance: "estimated" }, edited: true },
        { entry: pulldown, edited: false },
        { entry: { ...pulldown, count: 1, set: { ...pulldown.set, exercise: "bench", load: { value: 12.5, unit: "lb", basis: "per_side", bar: { value: 20, unit: "kg" } } } }, edited: false },
      ],
    }, "hritvik");
    expect(run.body.sets.sets).toHaveLength(3);
  });

  it("stays within the budget with 20 mixed pieces (food, shares of three pots, sets) on a two-session day, at 40 implements", async () => {
    const { x } = await busyInput(40);
    const pot = (name: string) => ({ name, lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Asha", fraction: 0.25, provenance: "estimated" }] });
    const meal = await x.ok("household_meal", { date: MONDAY, meal_slot: "lunch", cooks: [pot("Ghugni"), pot("Matar"), pot("Peas pulao")] }, "asha");
    const a = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper A" })).session.id;
    await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength" });
    const food = (food: string, value: number, unit: string, state?: string) => ({ entry: { kind: "item", item: { source: "food", food, value, unit, ...(state ? { state } : {}), provenance: "estimated", confidence: "medium" } }, edited: false });
    const manual = { entry: { kind: "item", item: { source: "manual", kcal: 150, protein_g: 4, carbs_g: 20, fat_g: 6, reason: "No label", provenance: "estimated", confidence: "low" } }, edited: true };
    const share = (c: { id: number }) => ({ entry: { kind: "cook", component_id: c.id, fraction: 0.3, provenance: "estimated" }, edited: true });
    const set = (exercise: string, load: Record<string, unknown>, reps = 10) => ({ entry: { kind: "set", count: 1, set: { exercise, set_type: "working", reps, rir: { low: 2, high: 2 }, load } }, edited: false });
    const kg = (value: number) => ({ value, unit: "kg", basis: "total" });
    const pieces = [
      { entry: egg, edited: false }, food("curd", 100, "g"), food("rice", 150, "g", "cooked"), food("mustard oil", 5, "ml"), food("peas", 80, "g"),
      { entry: egg, edited: true }, food("curd", 50, "g"), manual, food("egg", 100, "g"), food("peas", 40, "g"),
      ...meal.cooks.map((c: { components: { id: number }[] }) => share(c.components[0] as { id: number })),
      { entry: pulldown, edited: false }, set("Cable lat pulldown", kg(45), 8), set("Dumbbell curl", { value: 10, unit: "kg", basis: "per_hand" }),
      set("Dumbbell curl", { value: 10, unit: "kg", basis: "per_hand" }, 9), set("bench", { value: 12.5, unit: "lb", basis: "per_side", bar: { value: 20, unit: "kg" } }, 8),
      set("Push-up", "none" as unknown as Record<string, unknown>, 15), set("Cable lat pulldown", kg(40), 12),
    ];
    expect(pieces).toHaveLength(20);
    const run = await toolWithinBudget(x, "commit_route", { member: "Hritvik", date: MONDAY, meal_slot: "dinner", session_id: a, pieces }, "hritvik");
    expect(run.body.items).toHaveLength(10);
    expect(run.body.portions).toHaveLength(3);
    expect(run.body.sets.session.id).toBe(a);
    expect(run.body.sets.sets).toHaveLength(8);
    expect(run.body.stats).toEqual({ unedited: 15, edited: 5 });
  });

  it("stays within the budget at its worst: food, a recipe, a manual item, a share and sets for a new programme session", async () => {
    const { x } = await busyInput(40);
    await x.ok("upsert_recipe", { name: "Curd rice", kind: "dish", servings: 1, lines: [{ food: "FS002", value: 200, unit: "g" }, { food: "FS004", value: 100, unit: "g" }] });
    const meal = await x.ok("household_meal", {
      date: MONDAY, meal_slot: "lunch",
      cooks: [{ name: "Ghugni", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Asha", fraction: 0.25, provenance: "estimated" }] }],
    }, "asha");
    const run = await toolWithinBudget(x, "commit_route", {
      member: "Hritvik", date: MONDAY, meal_slot: "dinner",
      pieces: [
        { entry: egg, edited: false },
        { entry: { kind: "item", item: { source: "recipe", recipe: "Curd rice", servings: 1, provenance: "estimated", confidence: "medium" } }, edited: false },
        { entry: { kind: "item", item: { source: "manual", kcal: 150, protein_g: 4, carbs_g: 20, fat_g: 6, reason: "No label", provenance: "estimated", confidence: "low" } }, edited: true },
        { entry: { kind: "cook", component_id: meal.cooks[0].components[0].id, fraction: 0.5, provenance: "estimated" }, edited: true },
        { entry: pulldown, edited: false },
      ],
    }, "hritvik");
    expect(run.body.sets.session).toMatchObject({ created: true, template: "Upper A" });
    // One under the budget: the schedule's slots and swaps are one read (decision 121).
    expect(run.statements).toBeLessThanOrEqual(29);
    expect(run.log.filter((q: string) => q.includes("FROM schedule_slot"))).toHaveLength(1);
    // Every intake item (food, recipe, manual and the share's) is one INSERT.
    expect(run.log.filter((q: string) => q.startsWith("INSERT INTO intake_item"))).toHaveLength(1);
    expect(x.t.all("SELECT source_kind FROM intake_item WHERE eaten_on = ? AND meal_slot = 'dinner' ORDER BY id", MONDAY)).toEqual([
      { source_kind: "food_source" }, { source_kind: "recipe" }, { source_kind: "manual" }, { source_kind: "portion" },
    ]);
  });

  it("never writes a set into another member's session", async () => {
    const { x } = await ready();
    const theirs = (await x.ok("start_session", { member: "Asha", date: MONDAY, session_type: "strength" })).session.id;
    const reply = await x.call("commit_route", { member: "Hritvik", date: MONDAY, session_id: theirs, pieces: [{ entry: pulldown, edited: false }] }, "hritvik");
    expect(reply.http).toBe(400);
    expect(count(x, "session_set")).toBe(0);
  });
});

describe("a share of a pot, in the member's words and in the right meal", () => {
  const ghugniAsks = "The Ghugni has no cooked weight yet, so 150 g of it can't be worked out. Give the share as a fraction (say, half), or weigh the whole pot first.";

  it("asks for a weighed share of a pot with no cooked weight by the pot's name, at weighed_g: commit_route, mark_remainder and route_text alike", async () => {
    const { x, component } = await ready();
    const commit = await x.call("commit_route", { member: "Hritvik", date: MONDAY, meal_slot: "dinner", pieces: [{ entry: { kind: "cook", component_id: component, weighed_g: 150, provenance: "estimated" }, edited: false }] }, "hritvik");
    expect(commit.body).toMatchObject({ status: "needs_clarification", reason: "cooked_weight_needed", question: ghugniAsks, path: ["pieces", 0, "entry", "weighed_g"] });
    const mark = await x.call("mark_remainder", { component_id: component, disposition: "eaten", member: "Hritvik", meal_slot: "dinner", weighed_g: 150, provenance: "estimated" }, "hritvik");
    expect(mark.body).toMatchObject({ status: "needs_clarification", reason: "cooked_weight_needed", question: ghugniAsks, path: ["weighed_g"] });
    const routed = (await x.ok("route_text", { member: "Hritvik", text: "150 g the ghugni", date: MONDAY, meal_slot: "dinner" }, "hritvik")).pieces[0];
    expect(routed).toMatchObject({ status: "needs_choice", reason: "cooked_weight_needed", question: ghugniAsks, field: ["weighed_g"] });
    expect(count(x, "portion")).toBe(1);
  });

  it("names the component of a pot with several", async () => {
    const x = setup();
    await seedCatalogue(x);
    const meal = await x.ok("household_meal", {
      date: MONDAY, meal_slot: "lunch",
      cooks: [{ name: "Salad bowl", components: [{ name: "Greens", lines: [{ food: "peas", value: 200, unit: "g", provenance: "weighed" }] }, { name: "Dressing", lines: [{ food: "curd", value: 100, unit: "g", provenance: "weighed" }] }], portions: [{ member: "Asha", component: "Greens", fraction: 0.5, provenance: "estimated" }] }],
    }, "asha");
    const dressing = meal.cooks[0].components.find((c: { name: string }) => c.name === "Dressing").id;
    const reply = await x.call("commit_route", { member: "Hritvik", date: MONDAY, meal_slot: "dinner", pieces: [{ entry: { kind: "cook", component_id: dressing, weighed_g: 50, provenance: "estimated" }, edited: false }] }, "hritvik");
    expect(reply.body).toMatchObject({
      reason: "cooked_weight_needed",
      question: "The Dressing of Salad bowl has no cooked weight yet, so 50 g of it can't be worked out. Give the share as a fraction (say, half), or weigh the whole pot first.",
      path: ["pieces", 0, "entry", "weighed_g"],
    });
  });

  it("names the member whose share already in the pot raises a problem, never its key", async () => {
    const { x, component } = await ready();
    // Asha's portion made weighed on a pot with no cooked weight (as an old row could be).
    x.t.run("UPDATE portion SET kind = 'weighed', fraction = NULL, weighed_g = 100 WHERE component_id = ?", component);
    const reply = await x.call("commit_route", { member: "Hritvik", date: MONDAY, meal_slot: "dinner", pieces: [{ entry: { kind: "cook", component_id: component, fraction: 0.5, provenance: "estimated" }, edited: false }] }, "hritvik");
    expect(reply.body).toMatchObject({ reason: "cooked_weight_needed", path: ["pieces", 0, "entry", "fraction"] });
    expect(reply.body.question).toMatch(/^Asha's weighed portion/);
    expect(JSON.stringify(reply.body)).not.toMatch(/(portion|serving):-?\d/);
  });

  const noKeys = (body: unknown) => expect(JSON.stringify(body)).not.toMatch(/(portion|serving):-?\d|"-\d+"/);
  const potAsks = (g: number) => `The Dal pot has no cooked weight yet, so ${g} g of it can't be worked out. Give the share as a fraction (say, half), or weigh the whole pot first.`;
  const dal = (portion: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    date: MONDAY, meal_slot: "dinner",
    cooks: [{ name: "Dal pot", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], ...over, portions: [{ member: "Hritvik", fraction: 0.25, provenance: "estimated" }, { member: "Asha", provenance: "weighed", ...portion }] }],
  });

  it("household_meal and preview_meal ask for a grams share with no cooked weight in the member's words, at the share's weighed_g", async () => {
    const { x } = await ready();
    for (const tool of ["preview_meal", "household_meal"]) {
      const reply = await x.call(tool, dal({ weighed_g: 120 }), "hritvik");
      expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "cooked_weight_needed", question: potAsks(120), path: ["cooks", 0, "portions", 1, "weighed_g"] });
      noKeys(reply.body);
    }
    expect(count(x, "portion")).toBe(1);
  });

  it("household_meal takes a grams share once the whole pot is weighed, and names members when the shares pass the whole", async () => {
    const { x } = await ready();
    const saved = await x.ok("household_meal", dal({ weighed_g: 300 }, { cooked_weight_g: 600, cooked_weight_provenance: "weighed" }), "hritvik");
    expect(saved.cooks[0].portions.map((p: { member: string; fraction: number }) => [p.member, p.fraction])).toEqual([["Hritvik", 0.25], ["Asha", 0.5]]);
    const over = await x.call("preview_meal", dal({ weighed_g: 580 }, { cooked_weight_g: 600, cooked_weight_provenance: "weighed" }), "hritvik");
    expect(over.body).toMatchObject({ reason: "portions_exceed_whole", path: ["cooks", 0, "portions"] });
    noKeys(over.body);
  });

  it("mark_remainder names the member behind a share's problem: an unaccounted rest, and a leftover helping", async () => {
    const { x, component } = await ready();
    x.t.run("UPDATE portion SET kind = 'weighed', fraction = NULL, weighed_g = 100 WHERE component_id = ?", component);
    const rest = await x.call("mark_remainder", { component_id: component, disposition: "discarded", provenance: "estimated" }, "hritvik");
    expect(rest.body).toMatchObject({ reason: "cooked_weight_needed" });
    expect(rest.body.question).toMatch(/^Asha's weighed portion/);
    noKeys(rest.body);

    const fresh = await ready();
    await fresh.x.ok("mark_remainder", { component_id: fresh.component, disposition: "leftover", provenance: "estimated" }, "hritvik");
    const grams = await fresh.x.call("mark_remainder", { component_id: fresh.component, disposition: "eaten", member: "Kabir", meal_slot: "dinner", weighed_g: 80, provenance: "estimated" }, "hritvik");
    expect(grams.body).toMatchObject({ reason: "cooked_weight_needed", question: "The Ghugni has no cooked weight yet, so 80 g of it can't be worked out. Give the share as a fraction (say, half), or weigh the whole pot first.", path: ["weighed_g"] });
    fresh.x.t.run("UPDATE portion SET kind = 'weighed', fraction = NULL, weighed_g = 100 WHERE component_id = ?", fresh.component);
    const helping = await fresh.x.call("mark_remainder", { component_id: fresh.component, disposition: "eaten", member: "Kabir", meal_slot: "dinner", fraction: 0.1, provenance: "estimated" }, "hritvik");
    expect(helping.body.question).toMatch(/^Asha's weighed portion/);
    noKeys(helping.body);
  });

  it("amend names the member behind a share's problem, never its key", async () => {
    const { x, component } = await ready();
    const mine = await x.ok("commit_route", { member: "Hritvik", date: MONDAY, meal_slot: "dinner", pieces: [{ entry: { kind: "cook", component_id: component, fraction: 0.25, provenance: "estimated" }, edited: false }] }, "hritvik");
    x.t.run("UPDATE portion SET kind = 'weighed', fraction = NULL, weighed_g = 100 WHERE component_id = ? AND id <> ?", component, mine.portions[0].id);
    const reply = await x.call("amend", { record: { table: "portion", id: mine.portions[0].id }, changes: { fraction: 0.3 }, reason: "had a bit more" }, "hritvik");
    expect(reply.body).toMatchObject({ reason: "cooked_weight_needed", path: ["changes"] });
    expect(reply.body.question).toMatch(/^Asha's weighed portion/);
    noKeys(reply.body);
  });

  it("links a share to the pot's household meal only when it is the same date and meal", async () => {
    const { x, component } = await ready();
    const lunch = x.t.get("SELECT id FROM household_meal WHERE eaten_on = ? AND meal_slot = 'lunch'", MONDAY)?.id;
    const dinner = await x.ok("commit_route", { member: "Hritvik", date: MONDAY, meal_slot: "dinner", pieces: [{ entry: { kind: "cook", component_id: component, fraction: 0.25, provenance: "estimated" }, edited: false }] }, "hritvik");
    expect(x.t.get("SELECT household_meal_id, meal_slot FROM intake_item WHERE id = ?", dinner.portions[0].intake_item_id)).toEqual({ household_meal_id: null, meal_slot: "dinner" });
    const atLunch = await x.ok("commit_route", { member: "Kabir", date: MONDAY, meal_slot: "lunch", pieces: [{ entry: { kind: "cook", component_id: component, fraction: 0.25, provenance: "estimated" }, edited: false }] }, "hritvik");
    expect(x.t.get("SELECT household_meal_id FROM intake_item WHERE id = ?", atLunch.portions[0].intake_item_id)).toEqual({ household_meal_id: lunch });
  });
});
