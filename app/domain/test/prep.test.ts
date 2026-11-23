import { describe, expect, it } from "vitest";
import { buildPrepSchedule, type PrepOccurrence, type PrepStep } from "../src/index";

const step = (over: Partial<PrepStep>): PrepStep => ({
  action: "Prep",
  lead: "same_meal",
  lead_min_h: null,
  lead_max_h: null,
  duration_min: null,
  who: "anyone",
  batchable: false,
  keeps_days: null,
  batch_group: null,
  batch_days: null,
  storage: null,
  freezer_ok: false,
  food: null,
  amount_value: null,
  amount_unit: null,
  note: null,
  ...over,
});

const soak = (food: string, amount: number, group: string, batchDays = 1, who: PrepStep["who"] = "anyone") =>
  step({ action: "Soak", lead: "hours_before", lead_min_h: 8, lead_max_h: 12, who, batchable: true, keeps_days: 1, batch_group: group, batch_days: batchDays, storage: "fridge", food, amount_value: amount, amount_unit: "g" });

const occ = (date: string, meal_slot: string, meal: string, recipe: string, steps: PrepStep[], eaters = ["Hritvik"]): PrepOccurrence[] =>
  steps.map((s) => ({ date, meal_slot, meal, recipe, eaters, step: s }));

/** The worked plan #1: 23-29 Nov 2026. Only the prep-relevant meals. */
function planOne(): PrepOccurrence[] {
  const oats = step({ action: "Assemble overnight oats", lead: "evening_before", who: "eater", keeps_days: 1, storage: "fridge" });
  const kalaSoak = soak("kala chana", 140, "wed-pulses", 4);
  const kalaCook = step({ action: "Pressure-cook", lead: "same_meal", who: "cook", batchable: true, keeps_days: 3, batch_group: "wed-pulses", storage: "fridge", freezer_ok: true, food: "kala chana", amount_value: 140, amount_unit: "g" });
  const chanaSoak = soak("kabuli chana", 80, "wed-pulses", 4);
  const chanaCook = step({ action: "Pressure-cook", lead: "day_before", who: "cook", batchable: true, keeps_days: 3, batch_group: "wed-pulses", storage: "fridge", freezer_ok: true, food: "kabuli chana", amount_value: 80, amount_unit: "g" });
  const lobiaSoak = soak("lobia", 140, "fri-lobia", 1);
  const chop = step({ action: "Chop onion and capsicum", lead: "evening_before", who: "eater", keeps_days: 2, storage: "fridge" });
  const masala = step({ action: "Make the onion-tomato-garlic masala base", lead: "same_meal", who: "cook", batchable: true, keeps_days: 5, batch_group: "masala", storage: "fridge" });
  return [
    ...occ("2026-11-24", "breakfast", "Overnight protein oats", "R-oats", [oats]),
    ...occ("2026-11-26", "breakfast", "Overnight protein oats", "R-oats", [oats]),
    ...occ("2026-11-28", "breakfast", "Overnight protein oats", "R-oats", [oats]),
    ...occ("2026-11-25", "dinner", "Kala chana palak", "R058", [kalaSoak, kalaCook]),
    ...occ("2026-11-26", "lunch", "Chole-sprout paneer bowl", "R-chole", [chanaSoak, chanaCook]),
    ...occ("2026-11-29", "lunch", "Chole-sprout paneer bowl", "R-chole", [chanaSoak, chanaCook]),
    ...occ("2026-11-27", "dinner", "Lobia masala", "R059", [lobiaSoak]),
    ...occ("2026-11-24", "lunch", "Protein penne", "R-penne", [chop]),
    ...occ("2026-11-25", "lunch", "Protein penne", "R-penne", [chop]),
    ...occ("2026-11-27", "lunch", "Protein penne", "R-penne", [chop]),
    ...occ("2026-11-28", "lunch", "Protein penne", "R-penne", [chop]),
    ...occ("2026-11-23", "dinner", "Soya keema matar", "R061", [masala]),
    ...occ("2026-11-28", "dinner", "Soya keema matar", "R061", [masala]),
    ...occ("2026-11-26", "dinner", "Soya-stuffed capsicum", "R057", [masala]),
    ...occ("2026-11-27", "dinner", "Lobia masala", "R059", [masala]),
  ];
}

describe("buildPrepSchedule", () => {
  const tasks = buildPrepSchedule(planOne(), { batch_day: 1 });

  it("merges the two soaks into one job with both foods", () => {
    const soakTask = tasks.find((t) => t.action === "Soak" && t.for.some((f) => f.date === "2026-11-25"));
    expect(soakTask).toBeTruthy();
    expect(soakTask!.quantity.map((q) => q.food).sort()).toEqual(["kabuli chana", "kala chana"]);
    expect(soakTask!.for.map((f) => `${f.date} ${f.meal_slot}`).sort()).toEqual(["2026-11-25 dinner", "2026-11-26 lunch", "2026-11-29 lunch"]);
  });

  it("splits the cooked chickpeas: fridge for Thursday, freezer for Sunday, with a thaw", () => {
    const cook = tasks.find((t) => t.action === "Pressure-cook");
    expect(cook).toBeTruthy();
    expect(cook!.parts.map((p) => p.storage)).toEqual(["fridge", "freezer"]);
    const freezer = cook!.parts.find((p) => p.storage === "freezer")!;
    expect(freezer.for).toEqual([{ date: "2026-11-29", meal_slot: "lunch", meal: "Chole-sprout paneer bowl" }]);
    const thaw = tasks.find((t) => t.action.startsWith("Move the frozen"));
    expect(thaw).toMatchObject({ who: "eater", assignees: ["Hritvik"], for: [{ date: "2026-11-29" }] });
  });

  it("gives the cook the batch and the eater their own tasks", () => {
    expect(tasks.find((t) => t.action === "Pressure-cook")!.who).toBe("cook");
    expect(tasks.filter((t) => t.action === "Assemble overnight oats")).toHaveLength(3);
    expect(tasks.find((t) => t.action === "Assemble overnight oats")!.assignees).toEqual(["Hritvik"]);
  });

  it("batches the masala base on the plan's batch day", () => {
    const base = tasks.find((t) => t.action.startsWith("Make the onion"))!;
    expect(base.window_start.slice(0, 10)).toBe("2026-11-23");
    expect(base.for.map((f) => f.date).sort()).toEqual(["2026-11-23", "2026-11-26", "2026-11-27", "2026-11-28"]);
  });

  it("keeps per-meal chopping separate, one evening before each penne lunch", () => {
    const chops = tasks.filter((t) => t.action === "Chop onion and capsicum");
    expect(chops).toHaveLength(4);
    for (const chop of chops) expect(chop.for).toHaveLength(1);
    expect(chops.map((t) => t.window_start.slice(0, 10)).sort()).toEqual(["2026-11-23", "2026-11-24", "2026-11-26", "2026-11-27"]);
  });

  it("is empty for a plan with no prep steps", () => {
    expect(buildPrepSchedule([])).toEqual([]);
  });

  it("never moves a batch day past the first meal it serves", () => {
    // Plan #1 with the Sunday session (0): Wednesday's soak must not move.
    const sunday = buildPrepSchedule(planOne(), { batch_day: 0 });
    const soak = sunday.find((t) => t.action === "Soak" && t.quantity.some((q) => q.food === "kala chana"))!;
    expect(soak.window_start.slice(0, 10)).toBe("2026-11-25");
    expect(soak.due_by.slice(0, 10)).toBe("2026-11-25");
    expect(soak.window_end >= soak.window_start).toBe(true);
    expect(soak.window_end <= soak.due_by).toBe(true);
  });

  it("keeps a batch in the fridge when the shelf life is unknown, never assuming zero days", () => {
    const cook = step({
      action: "Cook a pot", lead: "day_before", who: "cook", batchable: true,
      keeps_days: null, batch_days: 5, storage: "fridge", freezer_ok: true,
      food: "dal", amount_value: 100, amount_unit: "g",
    });
    const tasks = buildPrepSchedule([
      ...occ("2026-11-23", "dinner", "Dal", "R-dal", [cook], []),
      ...occ("2026-11-27", "dinner", "Dal", "R-dal", [cook], []),
    ]);
    const batch = tasks.find((t) => t.action === "Cook a pot")!;
    expect(batch.parts).toEqual([]);
    expect(batch.storage).toBe("fridge");
    expect(tasks.some((t) => t.action.startsWith("Move the frozen"))).toBe(false);
  });
});
