// Closing a day from the app (spec addendum 7 Oct 2026, B): partial with the
// meals skipped clears the strip's card; reopening keeps the skipped meals.
// set_day_status is unchanged; this pins what Today's panel relies on.
import { describe, expect, it } from "vitest";
import { seedGym, toolWithinBudget } from "./budget";
import { setup } from "./harness";
import { seedCatalogue } from "./seed";

const YESTERDAY = "2026-10-04";
const curd = { source: "food", food: "curd", value: 150, unit: "g", provenance: "weighed", confidence: "high" };

describe("set_day_status from the app", () => {
  it("closes yesterday as partial with its skipped meals, which clears the strip's card, and reopens it keeping them", async () => {
    const x = setup();
    await seedCatalogue(x);
    await x.ok("log_intake", { member: "Hritvik", date: YESTERDAY, meal_slot: "lunch", items: [curd] }, "hritvik");
    const rules = async () => (await x.ok("needs_you", { member: "Hritvik" }, "hritvik")).cards.map((c: { rule: string }) => c.rule);
    expect(await rules()).toContain("yesterday_open");

    await x.ok("set_day_status", { member: "Hritvik", date: YESTERDAY, status: "partial", skipped_meals: ["breakfast", "dinner"] }, "hritvik");
    expect(await rules()).not.toContain("yesterday_open");
    const closed = await x.ok("day_meals", { member: "Hritvik", date: YESTERDAY }, "hritvik");
    expect(closed.day_status).toBe("partial");
    expect(closed.slots.map((s: { slot: string; state: string }) => [s.slot, s.state])).toEqual([
      ["breakfast", "skipped"], ["lunch", "eaten"], ["snack", "not_recorded"], ["dinner", "skipped"],
    ]);

    await x.ok("set_day_status", { member: "Hritvik", date: YESTERDAY, status: "open" }, "hritvik");
    const reopened = await x.ok("day_meals", { member: "Hritvik", date: YESTERDAY }, "hritvik");
    expect(reopened.day_status).toBe("open");
    expect(reopened.slots.filter((s: { state: string }) => s.state === "skipped").map((s: { slot: string }) => s.slot)).toEqual(["breakfast", "dinner"]);
  });

  it("stays within the budget with every meal skipped", async () => {
    const x = setup();
    seedGym(x, 40);
    await toolWithinBudget(x, "set_day_status", { member: "Hritvik", date: YESTERDAY, status: "partial", skipped_meals: ["breakfast", "lunch", "snack", "dinner", "pre_workout", "post_workout"] }, "hritvik");
  });
});
