import { describe, expect, it } from "vitest";
import { setup, type Harness } from "./harness";
import { seedCatalogue, seedTraining } from "./seed";

const TODAY = "2026-10-05";
const curd = (value: number) => ({ source: "food", food: "curd", value, unit: "g", provenance: "weighed", confidence: "high" });
const dal = (date: string, portions: unknown[]) => ({ date, meal_slot: "lunch", cooks: [{ name: "Masoor dal", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions }] });

async function ready() {
  const x = setup();
  seedTraining(x);
  await seedCatalogue(x);
  await x.ok("set_target", {
    member: "Hritvik", effective_from: "2026-09-01", provenance: "member", reasoning: "Test target",
    values: [
      { nutrient: "kcal", kind: "target", value: 2000 }, { nutrient: "protein_g", kind: "target", value: 150 },
      { nutrient: "fat_g", kind: "target", value: 60 }, { nutrient: "fat_g", kind: "floor", value: 45 }, { nutrient: "carbs_g", kind: "remainder" },
    ],
  });
  return x;
}

const row = (body: { members: { member: string }[] }, name: string) => body.members.find((m) => m.member === name) as Record<string, any>;

describe("household_overview members", () => {
  it("gives each member what is left, day status, drafts and last session, signed-in member first, and nothing else", async () => {
    const x = await ready();
    await x.ok("log_intake", { member: "Hritvik", date: TODAY, meal_slot: "lunch", items: [curd(500)] });
    const session = (await x.ok("start_session", { member: "Hritvik", date: "2026-10-03", session_type: "strength" })).session.id;
    await x.ok("end_session", { session_id: session });
    const body = await x.ok("household_overview", {}, "hritvik");
    expect(body.date).toBe(TODAY);
    expect(body.members.map((m: { member: string; you: boolean }) => [m.member, m.you])).toEqual([["Hritvik", true], ["Asha", false], ["Kabir", false]]);
    const h = row(body, "Hritvik");
    expect(Object.keys(h).sort()).toEqual(["day_status", "drafts", "kcal_left", "last_session", "member", "protein_left", "unknown_items", "you"]);
    expect(h.kcal_left).toBeCloseTo(1700, 6);
    expect(typeof h.protein_left).toBe("number");
    expect(h).toMatchObject({ day_status: "open", drafts: { count: 0, oldest: null }, last_session: { date: "2026-10-03", session_type: "strength", template: null } });
    // A member with nothing recorded: not known, never zero.
    expect(row(body, "Kabir")).toMatchObject({ kcal_left: null, protein_left: null, drafts: { count: 0, oldest: null }, last_session: null });
  });

  it("counts drafts waiting on a member, and lists the drafts you logged about others as waiting", async () => {
    const x = await ready();
    await x.ok("log_intake", { member: "Hritvik", date: TODAY, meal_slot: "snack", items: [curd(100)] }, "asha");
    const asAsha = await x.ok("household_overview", {}, "asha");
    expect(row(asAsha, "Hritvik").drafts).toMatchObject({ count: 1, oldest: { table: "intake_item", deadline: "2026-10-07T07:30:00Z", waits: null } });
    expect(asAsha.waiting).toEqual([expect.objectContaining({ table: "intake_item", about: "Hritvik", summary: "Curd", deadline: "2026-10-07T07:30:00Z" })]);
    expect((await x.ok("household_overview", {}, "hritvik")).waiting).toEqual([]);
  });

  it("never counts or lists an owner-only draft for someone who may not see it", async () => {
    const x = await ready();
    await x.ok("log_intake", { member: "Hritvik", date: TODAY, meal_slot: "snack", items: [curd(100)] }, "asha");
    // The agent, talking with Asha, logs a weight about Hritvik: an owner-only draft.
    await x.ok("log_reading", { member: "Hritvik", date: TODAY, metric: "weight", value: 78.2, unit: "kg", body_state: "fasted", speaker: "Asha" });
    const asAsha = await x.ok("household_overview", {}, "asha");
    expect(row(asAsha, "Hritvik").drafts.count).toBe(1);
    expect(asAsha.waiting.map((w: { table: string }) => w.table)).toEqual(["intake_item"]);
    expect(row(await x.ok("household_overview", {}, "hritvik"), "Hritvik").drafts.count).toBe(2);
    // The agent sees every draft, as needs_you does.
    expect(row(await x.ok("household_overview", {}, "agent"), "Hritvik").drafts.count).toBe(2);
  });
});

describe("household_overview meals and leftovers", () => {
  it("shows the household's cooks on the date and the two days before, with no ask", async () => {
    const x = await ready();
    await x.ok("household_meal", dal(TODAY, [{ member: "Hritvik", fraction: 0.4, provenance: "estimated" }]), "asha");
    await x.ok("household_meal", dal("2026-10-01", [{ member: "Asha", fraction: 0.5, provenance: "estimated" }]), "asha");
    const body = await x.ok("household_overview", {}, "hritvik");
    expect(body.meals.map((m: { date: string }) => m.date)).toEqual([TODAY]);
    expect(body.meals[0].cooks[0]).toMatchObject({ name: "Masoor dal", ask: null, absent: ["Asha", "Kabir"] });
    expect(body.meals[0].cooks[0].components[0].shares[0]).toMatchObject({ member: "Hritvik", you: true });
  });

  it("lists leftovers with how much and since when, until they are eaten", async () => {
    const x = await ready();
    const meal = await x.ok("household_meal", dal("2026-10-03", [{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }]), "hritvik");
    const componentId = meal.cooks[0].components[0].id;
    await x.ok("mark_remainder", { component_id: componentId, disposition: "leftover", provenance: "estimated", date: "2026-10-03" }, "hritvik");
    const body = await x.ok("household_overview", {}, "asha");
    expect(body.leftovers).toHaveLength(1);
    expect(body.leftovers[0]).toMatchObject({ cook_id: meal.cooks[0].id, cook: "Masoor dal", cooked_on: "2026-10-03", component_id: componentId, component: null, fraction: 0.5, since: "2026-10-03" });
    expect(body.leftovers[0].kcal).toBeCloseTo(162, 9);
    await x.ok("mark_remainder", { component_id: componentId, disposition: "eaten", member: "Asha", meal_slot: "dinner", provenance: "estimated" }, "asha");
    expect((await x.ok("household_overview", {}, "asha")).leftovers).toEqual([]);
  });

  it("lists only leftovers still open on the date: not one eaten up, not one discarded, not one marked after the date", async () => {
    const x = await ready();
    const pot = async (date: string, name: string) => {
      const meal = await x.ok("household_meal", {
        date, meal_slot: "lunch",
        cooks: [{ name, lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }] }],
      }, "hritvik");
      const id = meal.cooks[0].components[0].id as number;
      await x.ok("mark_remainder", { component_id: id, disposition: "leftover", provenance: "estimated", date }, "hritvik");
      return id;
    };
    await pot("2026-10-01", "Open");
    const eaten = await pot("2026-10-02", "Eaten");
    const thrown = await pot("2026-10-02", "Thrown");
    await x.ok("mark_remainder", { component_id: eaten, disposition: "eaten", member: "Asha", meal_slot: "dinner", provenance: "estimated", date: "2026-10-03" }, "asha");
    await x.ok("mark_remainder", { component_id: thrown, disposition: "discarded", provenance: "estimated" }, "hritvik");
    expect((await x.ok("household_overview", {}, "hritvik")).leftovers.map((l: { cook: string }) => l.cook)).toEqual(["Open"]);
    expect((await x.ok("household_overview", { date: "2026-09-30" }, "hritvik")).leftovers).toEqual([]);
  });

  it("on a past date, shows what was in the fridge that day, including leftovers eaten or discarded since", async () => {
    const x = await ready();
    const make = async (name: string) => {
      const meal = await x.ok("household_meal", {
        date: "2026-10-01", meal_slot: "lunch",
        cooks: [{ name, lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions: [{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }] }],
      }, "hritvik");
      const id = meal.cooks[0].components[0].id as number;
      await x.ok("mark_remainder", { component_id: id, disposition: "leftover", provenance: "estimated", date: "2026-10-01" }, "hritvik");
      return id;
    };
    const eaten = await make("Eaten later");
    const thrown = await make("Thrown later");
    await x.ok("mark_remainder", { component_id: eaten, disposition: "eaten", member: "Asha", meal_slot: "dinner", provenance: "estimated", date: "2026-10-03" }, "asha");
    await x.ok("mark_remainder", { component_id: thrown, disposition: "discarded", provenance: "estimated" }, "hritvik");
    const then = await x.ok("household_overview", { date: "2026-10-02" }, "hritvik");
    expect(then.leftovers.map((l: { cook: string; fraction: number; since: string }) => [l.cook, l.fraction, l.since])).toEqual([
      ["Eaten later", 0.5, "2026-10-01"],
      ["Thrown later", 0.5, "2026-10-01"],
    ]);
    expect((await x.ok("household_overview", {}, "hritvik")).leftovers).toEqual([]);
  });

  it("answers the agent too, with no one's waiting list", async () => {
    const x = await ready();
    const body = await x.ok("household_overview", { date: TODAY }, "agent");
    expect(body.members.map((m: { you: boolean }) => m.you)).toEqual([false, false, false]);
    expect(body.waiting).toEqual([]);
  });
});

describe("household_overview: a leftover an amend brings back", () => {
  /** Rajma cooked 3 Oct (800 g cooked), Hritvik half, the rest leftover; Asha eats it up today (weighed 400 g, or the rest by fraction). */
  async function eatenUp(weighed: boolean) {
    const x = await ready();
    const meal = await x.ok("household_meal", {
      date: "2026-10-03", meal_slot: "lunch",
      cooks: [{
        name: "Rajma", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }],
        ...(weighed ? { cooked_weight_g: 800, cooked_weight_provenance: "weighed" } : {}),
        portions: [{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }],
      }],
    }, "hritvik");
    const componentId = meal.cooks[0].components[0].id as number;
    await x.ok("mark_remainder", { component_id: componentId, disposition: "leftover", provenance: "estimated", date: "2026-10-03" }, "hritvik");
    await x.ok("mark_remainder", { component_id: componentId, disposition: "eaten", member: "Asha", meal_slot: "dinner", provenance: "weighed", ...(weighed ? { weighed_g: 400 } : {}) }, "asha");
    const lineId = x.t.get("SELECT id FROM cook_line WHERE component_id = ?", componentId)?.id as number;
    expect(x.t.get("SELECT settled_on FROM remainder_disposition WHERE component_id = ?", componentId)).toEqual({ settled_on: TODAY });
    expect((await x.ok("household_overview", {}, "hritvik")).leftovers).toEqual([]);
    return { x, componentId, lineId };
  }
  const settled = (x: Harness, componentId: number) => x.t.get("SELECT settled_on FROM remainder_disposition WHERE component_id = ?", componentId)?.settled_on;

  it("a cooked weight amended up leaves food in the pot: the leftover is open again, versioned in the same write, and listed", async () => {
    const { x, componentId } = await eatenUp(true);
    await x.ok("amend", { record: { table: "component", id: componentId }, changes: { cooked_weight_g: 1000 }, reason: "reweighed the pot" }, "hritvik");
    expect(settled(x, componentId)).toBeNull();
    const reopened = x.t.get(
      `SELECT v.action, json_extract(v.data, '$.settled_on') AS settled_on,
              v.write_id = (SELECT max(write_id) FROM record_version WHERE table_name = 'component' AND record_id = ?) AS same_write
       FROM record_version v JOIN remainder_disposition d ON d.id = v.record_id
       WHERE v.table_name = 'remainder_disposition' AND d.component_id = ? ORDER BY v.version DESC LIMIT 1`,
      componentId,
      componentId,
    );
    expect(reopened).toEqual({ action: "amend", settled_on: null, same_write: 1 });
    const body = await x.ok("household_overview", {}, "asha");
    expect(body.leftovers).toHaveLength(1);
    expect(body.leftovers[0]).toMatchObject({ component_id: componentId, cook: "Rajma", since: "2026-10-03" });
    expect(body.leftovers[0].fraction).toBeCloseTo(0.1, 9);
    // needs_you never had this gap: it reads no settled_on, and a leftover is accounted for, so it is no remainder card.
    const needs = await x.ok("needs_you", { member: "Hritvik", date: "2026-10-03" }, "hritvik");
    expect([...needs.cards, ...needs.more].filter((c: { rule: string }) => c.rule === "remainder")).toEqual([]);
  });

  it("a cook line amend re-opens a leftover left settled while food is still in the pot", async () => {
    const { x, componentId, lineId } = await eatenUp(true);
    // As an earlier cooked-weight amend left it before re-opening existed: food in the pot, the mark still settled.
    x.t.run("UPDATE component SET cooked_weight_g = 1000 WHERE id = ?", componentId);
    expect((await x.ok("household_overview", {}, "hritvik")).leftovers).toEqual([]);
    await x.ok("amend", { record: { table: "cook_line", id: lineId }, changes: { amount_value: 450 }, reason: "more peas than logged" }, "hritvik");
    expect(settled(x, componentId)).toBeNull();
    const body = await x.ok("household_overview", {}, "hritvik");
    expect(body.leftovers.map((l: { component_id: number; fraction: number }) => [l.component_id, Math.round(l.fraction * 100)])).toEqual([[componentId, 10]]);
  });

  it("an amend that leaves the pot eaten up keeps the leftover settled", async () => {
    const byFraction = await eatenUp(false);
    await byFraction.x.ok("amend", { record: { table: "component", id: byFraction.componentId }, changes: { cooked_weight_g: 900, cooked_weight_provenance: "weighed" }, reason: "weighed it" }, "hritvik");
    expect(settled(byFraction.x, byFraction.componentId)).toBe(TODAY);
    expect((await byFraction.x.ok("household_overview", {}, "hritvik")).leftovers).toEqual([]);
    // A line's amount moves no share's fraction, so a weighed pot stays eaten up too.
    const byWeight = await eatenUp(true);
    await byWeight.x.ok("amend", { record: { table: "cook_line", id: byWeight.lineId }, changes: { amount_value: 500 }, reason: "more peas than logged" }, "hritvik");
    expect(settled(byWeight.x, byWeight.componentId)).toBe(TODAY);
    expect((await byWeight.x.ok("household_overview", {}, "hritvik")).leftovers).toEqual([]);
  });
});
