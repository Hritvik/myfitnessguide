// Read-only tools for the app's screens (Today first), driven through the
// HTTP seam like every other tool.
import { describe, expect, it } from "vitest";
import { setup } from "./harness";
import { seedCatalogue } from "./seed";

const DAY = "2026-10-05";

async function ready() {
  const x = setup();
  await seedCatalogue(x);
  return x;
}

describe("whoami", () => {
  it("names the signed-in member first, then the rest of the household, and gives today's date", async () => {
    const x = setup();
    const body = await x.ok("whoami", {}, "asha");
    expect(body.member).toBe("Asha");
    expect(body.members).toEqual(["Asha", "Hritvik", "Kabir"]);
    // 07:30 UTC on 5 Oct is 13:00 in Asia/Kolkata.
    expect(body.today).toBe("2026-10-05");
    expect(body.time).toBe("13:00");
    expect(body.time_zone).toBe("Asia/Kolkata");
  });

  it("gives the agent no member of its own", async () => {
    const x = setup();
    const body = await x.ok("whoami", {}, "agent");
    expect(body.member).toBeNull();
    expect(body.members).toEqual(["Hritvik", "Asha", "Kabir"]);
  });
});

const food = (f: string, value: number, more: Record<string, unknown> = {}) => ({
  source: "food", food: f, value, unit: "g", provenance: "weighed", confidence: "high", ...more,
});

// 400 g of peas at 81 kcal / 100 g: 324 kcal in the pot.
const dal = (portions: unknown[]) => ({
  date: DAY, meal_slot: "lunch",
  cooks: [{ name: "Masoor dal", lines: [{ food: "peas", value: 400, unit: "g", provenance: "weighed" }], portions }],
});

describe("day_meals", () => {
  it("lists the day's meals in order with each meal's kcal and protein, and an empty core meal as nothing yet", async () => {
    const x = await ready();
    await x.ok("log_intake", { member: "Hritvik", date: DAY, meal_slot: "lunch", items: [food("rice", 150, { state: "cooked" })] });
    await x.ok("log_intake", {
      member: "Hritvik", date: DAY, meal_slot: "breakfast",
      items: [{ source: "food", food: "egg", value: 2, measure: "egg", provenance: "counted", confidence: "high" }],
    });
    const body = await x.ok("day_meals", { member: "Hritvik", date: DAY }, "hritvik");
    expect(body.slots.map((s: { slot: string }) => s.slot)).toEqual(["breakfast", "lunch", "snack", "dinner"]);
    const [breakfast, lunch, snack] = body.slots;
    expect(breakfast).toMatchObject({ slot: "breakfast", state: "eaten" });
    expect(breakfast.totals.kcal).toBeCloseTo(143, 9);
    expect(breakfast.totals.protein).toBeCloseTo(12.6, 9);
    expect(breakfast.items[0]).toMatchObject({
      table: "intake_item", name: "Egg", amount: { value: 2, unit: "measure", measure: "egg" }, provenance: "counted", state: "confirmed",
    });
    expect(lunch.totals.kcal).toBeCloseTo(180, 9);
    expect(snack).toMatchObject({ slot: "snack", state: "nothing_yet", items: [], totals: null });
  });

  it("tells a skipped meal from one not recorded on a partial day, and shows a workout slot only when used", async () => {
    const x = await ready();
    await x.ok("log_intake", { member: "Hritvik", date: DAY, meal_slot: "pre_workout", items: [food("curd", 100)] });
    await x.ok("set_day_status", { member: "Hritvik", date: DAY, status: "partial", skipped_meals: ["breakfast"] });
    const body = await x.ok("day_meals", { member: "Hritvik", date: DAY }, "hritvik");
    const states = Object.fromEntries(body.slots.map((s: { slot: string; state: string }) => [s.slot, s.state]));
    expect(states).toEqual({ pre_workout: "eaten", breakfast: "skipped", lunch: "not_recorded", snack: "not_recorded", dinner: "not_recorded" });
    expect(body.day_status).toBe("partial");
  });

  it("sums the items' ± kcal into the day's estimate, names the largest, and counts estimates with no size", async () => {
    const x = await ready();
    await x.ok("log_intake", {
      member: "Hritvik", date: DAY, meal_slot: "lunch",
      items: [
        { source: "manual", kcal: 260, protein_g: 16, carbs_g: 6, fat_g: 19, reason: "paneer bhurji", label: "1 bowl", provenance: "estimated", confidence: "low",
          dominant_uncertainty: { description: "bowl size", kcal: 120 } },
        food("rice", 150, { state: "cooked", provenance: "estimated", confidence: "medium", dominant_uncertainty: { description: "scoop size", kcal: 60 } }),
        food("curd", 100, { provenance: "estimated", confidence: "medium" }),
      ],
    });
    const body = await x.ok("day_meals", { member: "Hritvik", date: DAY }, "hritvik");
    expect(body.estimate).toMatchObject({
      plus_minus_kcal: 180, estimated_items: 3, estimated_without_size: 1,
      dominant: { name: "1 bowl", description: "bowl size", kcal: 120 },
    });
    const lunch = body.slots.find((s: { slot: string }) => s.slot === "lunch");
    expect(lunch.items.map((i: { plus_minus_kcal: number | null }) => i.plus_minus_kcal)).toEqual([120, 60, null]);
  });

  it("says who logged a draft: a member through the app, or the agent and the member it was talking with", async () => {
    const x = await ready();
    await x.ok("log_intake", { member: "Hritvik", date: DAY, meal_slot: "lunch", items: [food("curd", 100)] }, "asha");
    await x.ok("log_intake", { member: "Hritvik", date: DAY, meal_slot: "dinner", items: [food("curd", 50)], speaker: "Asha" }, "agent");
    await x.ok("log_intake", { member: "Hritvik", date: DAY, meal_slot: "snack", items: [food("curd", 30)], origin: "inbox" }, "agent");
    const body = await x.ok("day_meals", { member: "Hritvik", date: DAY }, "hritvik");
    const bySlot = Object.fromEntries(body.slots.map((s: { slot: string; items: unknown[] }) => [s.slot, s.items[0]]));
    expect(bySlot.lunch).toMatchObject({ state: "draft", logged_by: { kind: "member", name: "Asha" } });
    expect(bySlot.dinner).toMatchObject({ state: "draft", logged_by: { kind: "agent", origin: "live", speaker: "Asha" } });
    // The Inbox has no speaker, so only the agent can be named.
    expect(bySlot.snack).toMatchObject({ state: "draft", logged_by: { kind: "agent", origin: "inbox", speaker: null } });
  });

  it("names a portion item after its cook, with its share and the portion's provenance", async () => {
    const x = await ready();
    await x.ok("household_meal", dal([{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }]));
    const body = await x.ok("day_meals", { member: "Hritvik", date: DAY }, "hritvik");
    const lunch = body.slots.find((s: { slot: string }) => s.slot === "lunch");
    expect(lunch.items[0]).toMatchObject({ source_kind: "portion", name: "Masoor dal", amount: { fraction: 0.5 }, provenance: "estimated" });
    expect(lunch.items[0].kcal).toBeCloseTo(162, 9);
  });

  it("an empty open day has every core meal as nothing yet and no estimate", async () => {
    const x = await ready();
    const body = await x.ok("day_meals", { member: "Hritvik", date: DAY }, "hritvik");
    expect(body.slots.every((s: { state: string }) => s.state === "nothing_yet")).toBe(true);
    expect(body.estimate).toMatchObject({ plus_minus_kcal: null, estimated_items: 0, dominant: null });
  });
});

describe("day_cooks", () => {
  it("shows a shared pot: each present member's share, the absent member, the unaccounted remainder, and the ask about your draft", async () => {
    const x = await ready();
    // Asha logs the pot from the app, so Hritvik's portion is a draft about him.
    await x.ok("household_meal", dal([
      { member: "Asha", fraction: 0.34, provenance: "estimated" },
      { member: "Hritvik", fraction: 0.38, provenance: "estimated" },
    ]), "asha");
    const body = await x.ok("day_cooks", { member: "Hritvik", date: DAY }, "hritvik");
    expect(body.cooks).toHaveLength(1);
    const [cook] = body.cooks;
    expect(cook).toMatchObject({ name: "Masoor dal", cooked_on: DAY, meal_slot: "lunch", logged_by: { kind: "member", name: "Asha" }, absent: ["Kabir"] });
    const [component] = cook.components;
    // You first, then the others in household order.
    expect(component.shares).toEqual([
      expect.objectContaining({ member: "Hritvik", you: true, fraction: 0.38, state: "draft" }),
      expect.objectContaining({ member: "Asha", you: false, fraction: 0.34, state: "confirmed" }),
    ]);
    expect(component.remainder.status).toBe("unaccounted");
    expect(component.remainder.fraction).toBeCloseTo(0.28, 9);
    expect(cook.ask).toMatchObject({ component_id: component.component_id, fraction: 0.38, logged_by: { kind: "member", name: "Asha" } });
    expect(cook.ask.kcal).toBeCloseTo(324 * 0.38, 9);
    // Confirming the portion confirms its intake item with it.
    expect(cook.ask.records).toEqual([{ table: "portion", id: cook.ask.portion_id }]);
  });

  it("names the member the agent was talking with as who logged the pot and your draft", async () => {
    const x = await ready();
    await x.ok("household_meal", { ...dal([{ member: "Hritvik", fraction: 0.4, provenance: "estimated" }]), speaker: "Asha" }, "agent");
    const body = await x.ok("day_cooks", { member: "Hritvik", date: DAY }, "hritvik");
    expect(body.cooks[0].logged_by).toEqual({ kind: "agent", origin: "live", speaker: "Asha" });
    expect(body.cooks[0].ask.logged_by).toEqual({ kind: "agent", origin: "live", speaker: "Asha" });
  });

  it("asks nothing when your portion is confirmed, or when someone else views your day", async () => {
    const x = await ready();
    await x.ok("household_meal", dal([{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }]), "asha");
    const asAsha = await x.ok("day_cooks", { member: "Hritvik", date: DAY }, "asha");
    expect(asAsha.cooks[0].ask).toBeNull();
    expect(asAsha.cooks[0].components[0].shares[0]).toMatchObject({ member: "Hritvik", you: false });
    expect(asAsha.cooks[0].absent).toEqual(["Asha", "Kabir"]);

    const mine = await x.ok("household_meal", { ...dal([{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }]), meal_slot: "dinner" }, "hritvik");
    expect(mine.cooks[0].portions[0].state).toBe("confirmed");
    const body = await x.ok("day_cooks", { member: "Hritvik", date: DAY }, "hritvik");
    expect(body.cooks.map((c: { meal_slot: string; ask: unknown }) => [c.meal_slot, c.ask === null])).toEqual([["lunch", false], ["dinner", true]]);
  });

  it("marks the signed-in member's share as yours even on someone else's day", async () => {
    const x = await ready();
    await x.ok("household_meal", dal([
      { member: "Hritvik", fraction: 0.5, provenance: "estimated" },
      { member: "Asha", fraction: 0.3, provenance: "estimated" },
    ]), "asha");
    const body = await x.ok("day_cooks", { member: "Hritvik", date: DAY }, "asha");
    expect(body.cooks[0].components[0].shares.map((s: { member: string; you: boolean }) => [s.member, s.you])).toEqual([["Asha", true], ["Hritvik", false]]);
  });

  it("shows a remainder marked leftover as settled", async () => {
    const x = await ready();
    const meal = await x.ok("household_meal", dal([{ member: "Hritvik", fraction: 0.5, provenance: "estimated" }]), "hritvik");
    await x.ok("mark_remainder", { component_id: meal.cooks[0].components[0].id, disposition: "leftover", provenance: "estimated" }, "hritvik");
    const body = await x.ok("day_cooks", { member: "Hritvik", date: DAY }, "hritvik");
    expect(body.cooks[0].components[0].remainder).toMatchObject({ fraction: 0.5, status: "leftover" });
  });

  it("a day with no cooks has none", async () => {
    const x = await ready();
    await x.ok("log_intake", { member: "Hritvik", date: DAY, meal_slot: "lunch", items: [food("curd", 100)] });
    const body = await x.ok("day_cooks", { member: "Hritvik", date: DAY }, "hritvik");
    expect(body.cooks).toEqual([]);
  });
});
