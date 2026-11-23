import { describe, expect, it } from "vitest";
import { setup } from "./harness";
import { seedCatalogue } from "./seed";

const DAY = "2026-10-05";

async function ready() {
  const x = setup();
  await seedCatalogue(x);
  return x;
}

const food = (f: string, value: number, more: Record<string, unknown> = {}) => ({
  source: "food", food: f, value, unit: "g", provenance: "weighed", confidence: "high", ...more,
});

describe("log_intake", () => {
  it("logs a food source by amount, confirmed when the agent is talking with that member, and returns what it computed", async () => {
    const x = await ready();
    const body = await x.ok("log_intake", {
      member: "Hritvik", date: DAY, meal_slot: "lunch", items: [food("rice", 150, { state: "cooked" })],
    });
    expect(body.items).toHaveLength(1);
    const [item] = body.items;
    expect(item).toMatchObject({ state: "confirmed", source_kind: "food_source", ref: "FS002", amount_value: 150, amount_unit: "g" });
    expect(item.nutrients.kcal.value).toBeCloseTo(180, 9);
    expect(body.day.so_far.kcal.value).toBeCloseTo(180, 9);
  });

  it("asks whether rice is dry or cooked when no state is given, and writes nothing", async () => {
    const x = await ready();
    const reply = await x.call("log_intake", { member: "Hritvik", date: DAY, meal_slot: "lunch", items: [food("rice", 150)] });
    expect(reply.http).toBe(200);
    expect(reply.body).toMatchObject({
      status: "needs_clarification", reason: "ambiguous_state", options: ["cooked", "dry"], path: ["items", 0],
    });
    const items = await x.ok("day_items", { member: "Hritvik", date: DAY });
    expect(items.items).toEqual([]);
  });

  it("converts kg to the source's reference unit and stores that", async () => {
    const x = await ready();
    const body = await x.ok("log_intake", {
      member: "Hritvik", date: DAY, meal_slot: "lunch", items: [food("FS002", 0.2, { unit: "kg" })],
    });
    expect(body.items[0]).toMatchObject({ amount_value: 200, amount_unit: "g" });
    expect(body.items[0].nutrients.kcal.value).toBeCloseTo(240, 9);
  });

  it("counts eggs by a named measure", async () => {
    const x = await ready();
    const body = await x.ok("log_intake", {
      member: "Hritvik", date: DAY, meal_slot: "breakfast",
      items: [{ source: "food", food: "egg", value: 2, measure: "egg", provenance: "counted", confidence: "high" }],
    });
    expect(body.items[0]).toMatchObject({ amount_value: 2, amount_unit: "measure", measure: "egg" });
    expect(body.items[0].nutrients.kcal.value).toBeCloseTo(143, 9);
  });

  it("asks for a unit when a bare number is given", async () => {
    const x = await ready();
    const reply = await x.call("log_intake", {
      member: "Hritvik", date: DAY, meal_slot: "snack",
      items: [{ source: "food", food: "curd", value: 2, provenance: "estimated", confidence: "low" }],
    });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "no_unit" });
  });

  it("logs a recipe by servings", async () => {
    const x = await ready();
    await x.ok("upsert_recipe", {
      name: "Egg fried rice", kind: "dish", servings: 2,
      lines: [{ food: "FS002", value: 300, unit: "g" }, { food: "egg", value: 2, measure: "egg" }],
    });
    const body = await x.ok("log_intake", {
      member: "Hritvik", date: DAY, meal_slot: "dinner",
      items: [{ source: "recipe", recipe: "R001", servings: 1.5, provenance: "estimated", confidence: "medium" }],
    });
    // (360 + 143) / 2 per serving, x 1.5.
    expect(body.items[0]).toMatchObject({ source_kind: "recipe", ref: "R001", recipe_servings: 1.5 });
    expect(body.items[0].nutrients.kcal.value).toBeCloseTo(377.25, 9);
  });

  it("refuses to eat a meal idea", async () => {
    const x = await ready();
    await x.ok("upsert_recipe", { name: "Idea: sprouts chaat", kind: "idea", servings: 1 });
    const reply = await x.call("log_intake", {
      member: "Hritvik", date: DAY, meal_slot: "dinner",
      items: [{ source: "recipe", recipe: "R001", servings: 1, provenance: "estimated", confidence: "medium" }],
    });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "recipe_is_idea" });
  });

  it("logs manual macros with their reason and dominant uncertainty", async () => {
    const x = await ready();
    const body = await x.ok("log_intake", {
      member: "Hritvik", date: DAY, meal_slot: "lunch",
      items: [{
        source: "manual", kcal: 650, protein_g: 20, carbs_g: 90, fat_g: 22, reason: "office canteen, no label",
        provenance: "estimated", confidence: "low", dominant_uncertainty: { description: "ghee in the dal", kcal: 120 },
      }],
    });
    expect(body.items[0]).toMatchObject({ source_kind: "manual", dominant_uncertainty: "ghee in the dal", dominant_uncertainty_kcal: 120 });
    expect(body.items[0].nutrients.kcal).toEqual({ value: 650, known: 1, of: 1 });
  });

  it("a write about another member is a draft", async () => {
    const x = await ready();
    const body = await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "lunch", items: [food("FS002", 100)] });
    expect(body.items[0].state).toBe("draft");
  });

  it("an Inbox write is a draft even about the speaker", async () => {
    const x = await ready();
    const body = await x.ok("log_intake", {
      origin: "inbox", member: "Hritvik", date: DAY, meal_slot: "lunch", items: [food("FS002", 100)],
    });
    expect(body.items[0].state).toBe("draft");
  });

  it("a member logging their own intake in the app is confirmed and logged as the member", async () => {
    const x = await ready();
    const body = await x.ok("log_intake", { member: "Asha", date: DAY, meal_slot: "lunch", items: [food("FS002", 100)] }, "asha");
    expect(body.items[0].state).toBe("confirmed");
    const history = await x.ok("history", { table: "intake_item", id: body.items[0].id });
    expect(history.versions[0]).toMatchObject({ resolver: "member", origin: "app", on_behalf_of_member_id: x.h.asha, actor_member_id: x.h.asha });
  });

  it("the agent must say which member it is talking with", async () => {
    const x = await ready();
    const reply = await x.call("log_intake", { speaker: undefined, member: "Hritvik", date: DAY, meal_slot: "lunch", items: [food("FS002", 100)] });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "speaker_required" });
  });

  it("asks who an unknown member is", async () => {
    const x = await ready();
    const reply = await x.call("log_intake", { member: "Hritu", date: DAY, meal_slot: "lunch", items: [food("FS002", 100)] });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "unknown_member", options: ["Hritvik", "Asha", "Kabir"] });
  });
});

describe("day_totals", () => {
  it("returns so far, target, left, micros with coverage, protein bands and cost", async () => {
    const x = await ready();
    await x.ok("set_target", {
      member: "Hritvik", effective_from: "2026-10-01", provenance: "agent", reasoning: "cut phase",
      values: [
        { nutrient: "kcal", kind: "target", value: 1900 },
        { nutrient: "protein_g", kind: "target", value: 130 },
        { nutrient: "protein_g", kind: "floor", value: 120 },
        { nutrient: "fat_g", kind: "target", value: 55 },
        { nutrient: "carbs_g", kind: "remainder" },
      ],
    });
    await x.ok("log_intake", {
      member: "Hritvik", date: DAY, meal_slot: "lunch",
      items: [food("FS001", 100), food("FS004", 200)],
    });
    const body = await x.ok("day_totals", { member: "Hritvik", date: DAY });
    expect(body.day_status).toBe("open");
    expect(body.so_far.kcal).toEqual({ value: 480, known: 2, of: 2 });
    expect(body.so_far.protein.value).toBeCloseTo(14, 9);
    expect(body.target).toMatchObject({ kcal: 1900, protein: { goal: 130, floor: 120 }, fat: { goal: 55, floor: null } });
    expect(body.target.carbs.goal).toBeCloseTo(221.25, 9);
    expect(body.left.kcal.left).toBeCloseTo(1420, 9);
    expect(body.left.protein.floorLeft).toBeCloseTo(106, 9);
    // Rice has iron, curd doesn't say: 1 of 2 known.
    expect(body.micros.iron_mg).toEqual({ value: 0.8, known: 1, of: 2 });
    expect(body.micros.calcium_mg).toEqual({ value: 240, known: 1, of: 2 });
    expect(body.protein_bands.complete.value).toBeCloseTo(7, 9);
    expect(body.protein_bands.incomplete.value).toBeCloseTo(7, 9);
    // Rice is priced, curd isn't.
    expect(body.cost_inr).toEqual({ min: { value: 6, known: 1, of: 2 }, max: { value: 8, known: 1, of: 2 } });
  });

  it("says when there is no target rather than inventing one", async () => {
    const x = await ready();
    const body = await x.ok("day_totals", { member: "Hritvik", date: DAY });
    expect(body).toMatchObject({ source: "empty", target: null, left: null, day_status: "open" });
  });
});

describe("set_day_status and skipped meals", () => {
  it("closes a day and records skipped meals", async () => {
    const x = await ready();
    const body = await x.ok("set_day_status", { member: "Hritvik", date: DAY, status: "complete", skipped_meals: ["breakfast"] });
    expect(body).toMatchObject({ status_set: "complete", skipped_meals: ["breakfast"] });
    const totals = await x.ok("day_totals", { member: "Hritvik", date: DAY });
    expect(totals.day_status).toBe("complete");
    expect(totals.skipped_meals).toEqual(["breakfast"]);
  });
});

describe("what_if", () => {
  it("computes the day as if the items were eaten, and writes nothing", async () => {
    const x = await ready();
    await x.ok("log_intake", { member: "Hritvik", date: DAY, meal_slot: "lunch", items: [food("FS001", 100)] });
    const batches = x.db.batches;
    const body = await x.ok("what_if", { member: "Hritvik", date: DAY, items: [food("FS004", 100)] });
    expect(body.items[0].nutrients.kcal.value).toBe(60);
    expect(body.day.so_far.kcal.value).toBe(420);
    expect(x.db.batches).toBe(batches);
    const totals = await x.ok("day_totals", { member: "Hritvik", date: DAY });
    expect(totals.so_far.kcal.value).toBe(360);
  });
});

describe("household_meal", () => {
  const friedRice = (portions: unknown[]) => ({
    date: DAY, meal_slot: "dinner",
    cooks: [{
      name: "Fried rice",
      lines: [
        { food: "rice", state: "dry", value: 300, unit: "g", provenance: "weighed" },
        { food: "egg", value: 4, measure: "egg", provenance: "counted" },
        { food: "mustard oil", value: 30, unit: "ml", provenance: "estimated" },
      ],
      portions,
    }],
  });
  // 1080 + 286 + 265.2 kcal in the pot.
  const POT_KCAL = 1631.2;

  it("keeps a one-person composed dish as one named cook", async () => {
    const x = await ready();
    const body = await x.ok("household_meal", {
      date: DAY, meal_slot: "breakfast",
      cooks: [{
        name: "Paneer veg cheese sandwich",
        lines: [
          { food: "curd", value: 100, unit: "g", provenance: "weighed" },
          { food: "egg", value: 2, measure: "egg", provenance: "counted" },
        ],
        portions: [{ member: "Hritvik", fraction: 1, provenance: "estimated" }],
      }],
    });

    expect(body.cooks).toHaveLength(1);
    expect(body.cooks[0]).toMatchObject({ name: "Paneer veg cheese sandwich" });
    expect(body.cooks[0].lines).toHaveLength(2);
    expect(body.cooks[0].portions).toEqual([expect.objectContaining({ member: "Hritvik", fraction: 1 })]);
    expect(body.cooks[0].remainder).toEqual([]);
  });

  it("records a pot before shares are known and allocates them later", async () => {
    const x = await ready();
    const body = await x.ok("household_meal", friedRice([]));
    const cook = body.cooks[0];

    expect(cook.portions).toEqual([]);
    expect(cook.remainder).toEqual([expect.objectContaining({ component: "whole", status: "unaccounted", fraction: 1 })]);
    expect(body.members).toEqual({});

    // A later agent can recover the component id from the cooked day's read model.
    const cookedDay = await x.ok("day_cooks", { member: "Hritvik", date: DAY });
    const componentId = cookedDay.cooks[0].components[0].component_id;
    const hritvik = await x.ok("mark_remainder", {
      component_id: componentId, disposition: "eaten", member: "Hritvik", fraction: 0.4, provenance: "estimated",
    });
    expect(hritvik.portion).toMatchObject({ member: "Hritvik", fraction: 0.4 });
    expect(hritvik.remainder[0].fraction).toBeCloseTo(0.6, 9);

    const asha = await x.ok("mark_remainder", {
      component_id: componentId, disposition: "eaten", member: "Asha", fraction: 0.35, provenance: "estimated",
    });
    expect(asha.portion).toMatchObject({ member: "Asha", fraction: 0.35 });
    expect(asha.remainder[0].fraction).toBeCloseTo(0.25, 9);
  });

  it("splits H 40 / S 35 / Hz 25 in one call: each member's portion, as drafts for the others", async () => {
    const x = await ready();
    const body = await x.ok("household_meal", friedRice([
      { member: "Hritvik", fraction: 0.4, provenance: "estimated" },
      { member: "Asha", fraction: 0.35, provenance: "estimated" },
      { member: "Kabir", fraction: 0.25, provenance: "estimated" },
    ]));
    const [cook] = body.cooks;
    expect(cook.components).toHaveLength(1);
    expect(cook.components[0].name).toBe("whole");
    expect(cook.totals.kcal.value).toBeCloseTo(POT_KCAL, 6);
    const by = Object.fromEntries(cook.portions.map((p: { member: string }) => [p.member, p]));
    expect(by.Hritvik).toMatchObject({ fraction: 0.4, state: "confirmed" });
    expect(by.Asha).toMatchObject({ fraction: 0.35, state: "draft" });
    expect(by.Kabir.nutrients.kcal.value).toBeCloseTo(POT_KCAL * 0.25, 6);
    expect(cook.remainder).toEqual([]);
    expect(body.members.Asha.kcal.value).toBeCloseTo(POT_KCAL * 0.35, 6);
    const day = await x.ok("day_totals", { member: "Asha", date: DAY });
    expect(day.so_far.kcal.value).toBeCloseTo(POT_KCAL * 0.35, 6);
  });

  it("a member who wasn't there gets no portion, and their share stays unaccounted", async () => {
    const x = await ready();
    const body = await x.ok("household_meal", friedRice([
      { member: "Hritvik", fraction: 0.4, provenance: "estimated" },
      { member: "Asha", fraction: 0.35, provenance: "estimated" },
    ]));
    const [cook] = body.cooks;
    expect(cook.portions.map((p: { member: string }) => p.member)).toEqual(["Hritvik", "Asha"]);
    expect(cook.remainder).toHaveLength(1);
    expect(cook.remainder[0]).toMatchObject({ component: "whole", status: "unaccounted" });
    expect(cook.remainder[0].fraction).toBeCloseTo(0.25, 9);
    expect(body.members.Kabir).toBeUndefined();
    const hz = await x.ok("day_totals", { member: "Kabir", date: DAY });
    expect(hz.source).toBe("empty");
  });

  it("asks when the shares add up to more than the whole", async () => {
    const x = await ready();
    const reply = await x.call("household_meal", friedRice([
      { member: "Hritvik", fraction: 0.6, provenance: "estimated" },
      { member: "Asha", fraction: 0.5, provenance: "estimated" },
    ]));
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "portions_exceed_whole", path: ["cooks", 0, "portions"] });
  });

  it("allows one portion per member per component", async () => {
    const x = await ready();
    const reply = await x.call("household_meal", friedRice([
      { member: "Hritvik", fraction: 0.3, provenance: "estimated" },
      { member: "hritvik", fraction: 0.2, provenance: "estimated" },
    ]));
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "duplicate_portion" });
  });

  it("asks for the cooked weight when a portion is weighed", async () => {
    const x = await ready();
    const reply = await x.call("household_meal", friedRice([{ member: "Hritvik", weighed_g: 300, provenance: "weighed" }]));
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "cooked_weight_needed" });
  });

  it("splits per component, with weighed portions out of each component's cooked weight", async () => {
    const x = await ready();
    const body = await x.ok("household_meal", {
      date: DAY, meal_slot: "lunch",
      cooks: [{
        name: "Rice and raita",
        components: [
          { name: "rice", cooked_weight_g: 900, cooked_weight_provenance: "weighed", lines: [{ food: "FS001", value: 300, unit: "g", provenance: "weighed" }] },
          { name: "raita", lines: [{ food: "curd", value: 400, unit: "g", provenance: "weighed" }] },
        ],
        portions: [
          { member: "Hritvik", component: "rice", weighed_g: 360, provenance: "weighed" },
          { member: "Hritvik", component: "raita", fraction: 0.5, provenance: "estimated" },
          { member: "Asha", component: "raita", fraction: 0.5, provenance: "estimated" },
        ],
      }],
    });
    const hritvik = body.members.Hritvik;
    // 0.4 of the rice (1080 kcal) + half the raita (240 kcal).
    expect(hritvik.kcal.value).toBeCloseTo(432 + 120, 9);
    expect(body.cooks[0].remainder).toEqual([
      expect.objectContaining({ component: "rice", status: "unaccounted" }),
    ]);
  });

  it("offers the last split for the same recipe instead of guessing one", async () => {
    const x = await ready();
    await x.ok("upsert_recipe", {
      name: "Egg fried rice", kind: "dish", servings: 3,
      lines: [{ food: "FS001", value: 300, unit: "g" }, { food: "egg", value: 4, measure: "egg" }],
    });
    await x.ok("household_meal", {
      date: "2026-10-01", meal_slot: "dinner",
      cooks: [{ name: "Fried rice", recipe: "R001", portions: [
        { member: "Hritvik", fraction: 0.4, provenance: "estimated" },
        { member: "Asha", fraction: 0.35, provenance: "estimated" },
        { member: "Kabir", fraction: 0.25, provenance: "estimated" },
      ] }],
    });
    const reply = await x.call("household_meal", { date: DAY, meal_slot: "dinner", cooks: [{ name: "Fried rice", recipe: "R001" }] });
    expect(reply.body).toMatchObject({
      status: "needs_clarification", reason: "split_needed", path: ["cooks", 0, "portions"],
      suggestion: [
        { member: "Hritvik", component: "whole", fraction: 0.4 },
        { member: "Asha", component: "whole", fraction: 0.35 },
        { member: "Kabir", component: "whole", fraction: 0.25 },
      ],
    });
  });

  it("starts a cook from its recipe's lines, marked inferred", async () => {
    const x = await ready();
    await x.ok("upsert_recipe", {
      name: "Egg fried rice", kind: "dish", servings: 3,
      lines: [{ food: "FS001", value: 300, unit: "g" }, { food: "egg", value: 4, measure: "egg" }],
    });
    const body = await x.ok("household_meal", {
      date: DAY, meal_slot: "dinner",
      cooks: [{ name: "Fried rice", recipe: "R001", portions: [{ member: "Hritvik", fraction: 1, provenance: "estimated" }] }],
    });
    expect(body.cooks[0].lines.map((l: { provenance: string }) => l.provenance)).toEqual(["inferred", "inferred"]);
    expect(body.cooks[0].totals.kcal.value).toBeCloseTo(1080 + 286, 9);
  });

  it("includes direct items such as a shared bowl of curd", async () => {
    const x = await ready();
    const body = await x.ok("household_meal", {
      date: DAY, meal_slot: "lunch", cooks: [],
      items: [{ member: "Asha", ...food("curd", 150) }],
    });
    expect(body.items[0]).toMatchObject({ member: "Asha", state: "draft" });
    expect(body.members.Asha.kcal.value).toBeCloseTo(90, 9);
  });
});

describe("idempotent retries of a many-record write", () => {
  it("retrying household_meal with its key returns the original response and writes no second meal", async () => {
    const x = await ready();
    const input = {
      idempotency_key: "dinner-5-oct", date: DAY, meal_slot: "dinner",
      cooks: [{ name: "Dal", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }],
        portions: [{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }, { member: "Asha", fraction: 0.5, provenance: "estimated" }] }],
    };
    const first = await x.call("household_meal", input);
    const again = await x.call("household_meal", input);
    expect(again.body).toEqual(first.body);
    const day = await x.ok("day_totals", { member: "Asha", date: DAY });
    expect(day.so_far.kcal.value).toBeCloseTo(162, 9);
  });
});

describe("targets", () => {
  it("reads the target in force on a date, resolved, and warns below BMR when set", async () => {
    const x = await ready();
    const set = await x.ok("set_target", {
      member: "Kabir", effective_from: "2026-09-01", provenance: "professional", reasoning: "dietitian plan", bmr_kcal: 1400,
      values: [
        { nutrient: "kcal", kind: "target", value: 1300 }, { nutrient: "protein_g", kind: "target", value: 80 },
        { nutrient: "fat_g", kind: "target", value: 45 }, { nutrient: "carbs_g", kind: "remainder" },
      ],
    });
    expect(set.below_bmr).toEqual({ below: true, by: 100, bmr_kcal: 1400, bmr_source: "given" });
    const read = await x.ok("targets", { member: "Kabir", date: DAY });
    expect(read.target).toMatchObject({ effective_from: "2026-09-01", reasoning: "dietitian plan" });
    expect(read.resolved.carbs.goal).toBeCloseTo((1300 - 320 - 405) / 4, 9);
    expect((await x.ok("targets", { member: "Kabir", date: "2026-08-01" })).target).toBeNull();
  });
});

describe("mark_remainder", () => {
  it("marks an unaccounted remainder as leftover", async () => {
    const x = await ready();
    const meal = await x.ok("household_meal", {
      date: DAY, meal_slot: "dinner",
      cooks: [{ name: "Dal", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }],
        portions: [{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }] }],
    });
    const componentId = meal.cooks[0].components[0].id;
    const body = await x.ok("mark_remainder", { component_id: componentId, disposition: "leftover", provenance: "estimated" });
    expect(body.remainder).toEqual([expect.objectContaining({ component: "whole", status: "leftover" })]);
  });

  it("marks the remainder eaten by a member as a new portion", async () => {
    const x = await ready();
    const meal = await x.ok("household_meal", {
      date: DAY, meal_slot: "dinner",
      cooks: [{ name: "Dal", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }],
        portions: [{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }] }],
    });
    const componentId = meal.cooks[0].components[0].id;
    const body = await x.ok("mark_remainder", { component_id: componentId, disposition: "eaten", member: "Kabir", provenance: "inferred" });
    expect(body.remainder).toEqual([]);
    expect(body.portion).toMatchObject({ member: "Kabir", fraction: 0.5, state: "draft" });
  });
});
