// Fixing or removing a logged food (Today) and a logged set (Train), ticket 61:
// the plans' records, reasons and changed-only fields. Invented data only.
import { describe, expect, it } from "vitest";
import { editItemPlan, editSetPlan, itemFix, removeItemPlan, removeSetPlan, SET_LOAD_NOTE, setFix, switchItemMeasure, editAmountCheck, type ItemEditDraft } from "../src/fixes";
import { buildHistory } from "../src/train";
import { buildToday } from "../src/today";
import type { DescribedSet } from "../src/types";
import { item, meals, today } from "./fixtures";

const keyless = (p: { steps: { tool: string; input: Record<string, unknown> }[] }) => p.steps.map((s) => [s.tool, { ...s.input, idempotency_key: "k" }]);
const TODAY = "2026-10-06";

describe("a logged food's fix", () => {
  it("removes a plain item as its intake item, a pot share as its portion and a leftover as its serving", () => {
    expect(itemFix(item({ id: 1 }), "breakfast", TODAY).remove).toEqual({ table: "intake_item", id: 1 });
    expect(itemFix(item({ id: 3, source_kind: "portion", portion_id: 7, amount: { fraction: 0.38 } }), "lunch", TODAY).remove).toEqual({ table: "portion", id: 7 });
    const leftover = item({ id: 12, source_kind: "manual", name: "Dal, leftover", label: "Dal, leftover", amount: null, leftover_serving_id: 4 });
    expect(itemFix(leftover, "dinner", TODAY).remove).toEqual({ table: "leftover_serving", id: 4 });
  });

  it("asks once, naming the amount, the food and the meal", () => {
    expect(itemFix(item({ name: "Whole egg", amount: { value: 2, unit: "piece" } }), "breakfast", TODAY).ask).toBe("Remove 2 pc Whole egg from Breakfast?");
    expect(itemFix(item({ source_kind: "manual", name: "Paneer bhurji", label: "1 bowl", amount: null }), "pre_workout", TODAY).ask).toBe("Remove Paneer bhurji from Pre-workout?");
  });

  it("removes with one retract and a fixed reason the member never types", () => {
    const plan = removeItemPlan({ table: "portion", id: 7 });
    expect(keyless(plan)).toEqual([["retract", { records: [{ table: "portion", id: 7 }], reason: "Removed in the app", idempotency_key: "k" }]]);
    expect(plan.done).toBe("Removed.");
  });

  it("edits the amount where it lives: a food's amount, a recipe's servings, a pot share's percent or grams on its portion, none for a typed item", () => {
    expect(itemFix(item({ id: 1, amount: { value: 50, unit: "g" } }), "breakfast", TODAY).edit).toEqual({
      itemId: 1, slot: "breakfast", date: TODAY, amount: { table: "intake_item", id: 1, field: "amount_value", value: "50", unit: "g" },
    });
    expect(itemFix(item({ id: 2, amount: { value: 1, unit: "measure", measure: "scoop" } }), "breakfast", TODAY).edit).toMatchObject({ amount: { field: "amount_value", value: "1", unit: "scoop" } });
    expect(itemFix(item({ id: 6, source_kind: "recipe", amount: { servings: 1.5 } }), "dinner", TODAY).edit).toMatchObject({ amount: { table: "intake_item", field: "recipe_servings", value: "1.5", unit: "servings" } });
    expect(itemFix(item({ id: 3, source_kind: "portion", portion_id: 7, amount: { fraction: 0.38 } }), "lunch", TODAY).edit).toMatchObject({ amount: { table: "portion", id: 7, field: "fraction", value: "38", unit: "% of the pot" } });
    expect(itemFix(item({ id: 3, source_kind: "portion", portion_id: 7, amount: { weighed_g: 210 } }), "lunch", TODAY).edit).toMatchObject({ amount: { table: "portion", id: 7, field: "weighed_g", value: "210", unit: "g" } });
    expect(itemFix(item({ id: 4, source_kind: "manual", amount: null }), "lunch", TODAY).edit).toMatchObject({ amount: null });
  });

  it("can't edit a leftover helping: it says to remove it and log it again", () => {
    expect(itemFix(item({ id: 12, source_kind: "manual", amount: null, leftover_serving_id: 4 }), "dinner", TODAY).edit).toBe("leftover");
  });

  const fix = itemFix(item({ id: 1, amount: { value: 50, unit: "g" } }), "breakfast", TODAY);
  const edit = fix.edit === "leftover" ? null : fix.edit;
  const draft = (over: Partial<ItemEditDraft> = {}): ItemEditDraft => ({ amount: "50", slot: "breakfast", date: TODAY, ...over });

  it("amends only the fields that changed, with a fixed reason", () => {
    const amount = editItemPlan(edit!, draft({ amount: "75" }), TODAY);
    expect("steps" in amount && keyless(amount)).toEqual([["amend", { record: { table: "intake_item", id: 1 }, changes: { amount_value: 75 }, reason: "Corrected in the app", idempotency_key: "k" }]]);
    const moved = editItemPlan(edit!, draft({ slot: "lunch", date: "2026-10-05" }), TODAY);
    expect("steps" in moved && keyless(moved)).toEqual([["amend", { record: { table: "intake_item", id: 1 }, changes: { meal_slot: "lunch", eaten_on: "2026-10-05" }, reason: "Corrected in the app", idempotency_key: "k" }]]);
    expect("done" in moved && moved.done).toBe("Changed.");
  });

  it("changes a pot share's percent on its portion first, then its meal on its item, so a question on the share writes nothing", () => {
    const pot = itemFix(item({ id: 3, source_kind: "portion", portion_id: 7, amount: { fraction: 0.38 } }), "lunch", TODAY).edit;
    if (pot === "leftover") throw new Error("not a leftover");
    const plan = editItemPlan(pot, { amount: "50", slot: "dinner", date: TODAY }, TODAY);
    expect("steps" in plan && keyless(plan)).toEqual([
      ["amend", { record: { table: "portion", id: 7 }, changes: { fraction: 0.5 }, reason: "Corrected in the app", idempotency_key: "k" }],
      ["amend", { record: { table: "intake_item", id: 3 }, changes: { meal_slot: "dinner" }, reason: "Corrected in the app", idempotency_key: "k" }],
    ]);
  });

  it("says what to fix: nothing changed, an amount that isn't above 0, a share over 100%, a day after today", () => {
    expect(editItemPlan(edit!, draft(), TODAY)).toEqual({ error: "Nothing has changed." });
    for (const bad of ["", "0", "-1", "abc"]) expect(editItemPlan(edit!, draft({ amount: bad }), TODAY)).toEqual({ error: "Enter the amount as a number above 0." });
    const pot = itemFix(item({ id: 3, source_kind: "portion", portion_id: 7, amount: { fraction: 0.38 } }), "lunch", TODAY).edit;
    if (pot === "leftover") throw new Error("not a leftover");
    expect(editItemPlan(pot, { amount: "120", slot: "lunch", date: TODAY }, TODAY)).toEqual({ error: "Enter your share as a percent from 1 to 100." });
    expect(editItemPlan(edit!, draft({ date: "2026-10-07" }), TODAY)).toEqual({ error: "Choose a day up to today." });
    expect(editItemPlan(edit!, draft({ date: "" }), TODAY)).toEqual({ error: "Choose a day up to today." });
  });
});

describe("a logged food's measure (click test P2-8)", () => {
  const egg = { ref: "FS003", reference_unit: "g" as const, measures: [{ name: "egg", amount: 50 }, { name: "tbsp", amount: 15 }] };
  const logged = itemFix(item({ id: 1, name: "Egg", amount: { value: 100, unit: "g" }, food: egg }), "breakfast", TODAY).edit;
  const e = logged === "leftover" ? null : logged;

  it("offers the food's measures, then its own unit, with the stored one chosen", () => {
    expect(e!.amount).toMatchObject({
      unit: "g",
      options: [{ label: "egg (50 g)", measure: "egg" }, { label: "tbsp (15 g)", measure: "tbsp" }, { label: "g", unit: "g" }],
      current: 2,
    });
    const byEgg = itemFix(item({ id: 2, amount: { value: 2, unit: "measure", measure: "egg" }, food: egg }), "breakfast", TODAY).edit;
    expect(byEgg !== "leftover" && byEgg.amount).toMatchObject({ unit: "egg", current: 0 });
  });

  it("converts the amount when the measure changes, so it still means the same food", () => {
    const d: ItemEditDraft = { amount: "100", slot: "breakfast", date: TODAY, option: 2 };
    expect(switchItemMeasure(e!.amount!, d, 0)).toEqual({ ...d, amount: "2", option: 0 });
    expect(switchItemMeasure(e!.amount!, { ...d, amount: "" }, 0)).toEqual({ ...d, amount: "1", option: 0 });
  });

  it("sends the amount with its new measure or unit, as log_intake takes it", () => {
    const plan = editItemPlan(e!, { amount: "3", slot: "breakfast", date: TODAY, option: 0 }, TODAY);
    expect("steps" in plan && keyless(plan)).toEqual([["amend", { record: { table: "intake_item", id: 1 }, changes: { amount_value: 3, measure: "egg" }, reason: "Corrected in the app", idempotency_key: "k" }]]);
    const byEgg = itemFix(item({ id: 2, amount: { value: 2, unit: "measure", measure: "egg" }, food: egg }), "breakfast", TODAY).edit;
    if (byEgg === "leftover") throw new Error("not a leftover");
    const back = editItemPlan(byEgg, { amount: "100", slot: "breakfast", date: TODAY, option: 2 }, TODAY);
    expect("steps" in back && keyless(back)).toEqual([["amend", { record: { table: "intake_item", id: 2 }, changes: { amount_value: 100, unit: "g" }, reason: "Corrected in the app", idempotency_key: "k" }]]);
    // The same amount in another measure is still a change.
    const same = editItemPlan(byEgg, { amount: "2", slot: "breakfast", date: TODAY, option: 1 }, TODAY);
    expect("steps" in same && keyless(same)[0]![1]).toMatchObject({ changes: { amount_value: 2, measure: "tbsp" } });
  });
});

describe("a logged food's new amount is checked as the Food tab checks one (review P2)", () => {
  const egg = { ref: "FS003", reference_unit: "g" as const, measures: [{ name: "egg", amount: 50 }] };
  const e = itemFix(item({ id: 1, name: "Egg", amount: { value: 100, unit: "g" }, food: egg }), "breakfast", TODAY, null, "Asha").edit;
  const edit = e === "leftover" ? null : e;

  it("names the member, and gives what_if the new amount and foodCheck its draft", () => {
    expect(edit?.member).toBe("Asha");
    expect(editAmountCheck(edit!, { amount: "5000", slot: "breakfast", date: TODAY, option: 1 })).toEqual({
      item: { source: "food", food: "FS003", value: 5000, unit: "g", provenance: "estimated", confidence: "low" },
      draft: { value: "5000", unit: "g", measure: null, provenance: "estimated", uncertainty: "", uncertaintyKcal: "" },
      ref: "FS003",
    });
    expect(editAmountCheck(edit!, { amount: "3", slot: "breakfast", date: TODAY, option: 0 })?.item).toMatchObject({ value: 3, measure: "egg" });
  });

  it("checks nothing when the amount is as it was, or the item isn't a food", () => {
    expect(editAmountCheck(edit!, { amount: "100", slot: "lunch", date: TODAY, option: 1 })).toBeNull();
    const recipe = itemFix(item({ id: 6, source_kind: "recipe", amount: { servings: 1.5 } }), "dinner", TODAY).edit;
    expect(recipe !== "leftover" && editAmountCheck(recipe, { amount: "9", slot: "dinner", date: TODAY })).toBeNull();
  });
});

describe("Today offers a fix on the member's own confirmed items only", () => {
  it("gives your own confirmed items a fix, and drafts none", () => {
    const view = buildToday(today());
    const [breakfast, lunch] = view.tiers;
    expect(breakfast?.items.map((i) => i.fix?.remove)).toEqual([{ table: "intake_item", id: 1 }, { table: "intake_item", id: 2 }]);
    // Lunch: a draft pot share (no fix) and a confirmed typed item.
    expect(lunch?.items.map((i) => i.fix?.remove ?? null)).toEqual([null, { table: "intake_item", id: 4 }]);
  });

  it("gives another member's items none", () => {
    const view = buildToday(today({ viewing: "Kabir", meals: meals({ member: "Kabir" }) }));
    expect(view.tiers.flatMap((t) => t.items).every((i) => i.fix === undefined)).toBe(true);
  });
});

const set = (over: Partial<DescribedSet> = {}): DescribedSet => ({
  id: 21, exercise: "Cable row", set_number: 2, set_type: "working", reps: 10, load_status: "entered", load_value: 40, load_unit: "kg",
  load_basis: "total", bar: null, plates: null, rir: { low: 2, high: 2 }, state: "confirmed", ...over,
});

describe("a logged set's fix", () => {
  it("edits reps and RIR only: a load is changed by removing the set and logging it again", () => {
    expect(setFix(set()).edit).toEqual({ id: 21, setType: "working", reps: "10", rir: "2" });
    expect(setFix(set({ rir: { low: 1, high: 2 } })).edit.rir).toBe("1-2");
    expect(setFix(set({ rir: "not_recorded" })).edit.rir).toBe("");
    expect(setFix(set()).ask).toBe("Remove set 2 of Cable row?");
    expect(SET_LOAD_NOTE).toBe("To change the load, remove the set and log it again.");
  });

  it("removes with one retract of the set and the fixed reason", () => {
    expect(keyless(removeSetPlan(21))).toEqual([["retract", { records: [{ table: "session_set", id: 21 }], reason: "Removed in the app", idempotency_key: "k" }]]);
  });

  it("amends only what changed, checked as the Set form checks it", () => {
    const e = setFix(set()).edit;
    const reps = editSetPlan(e, { reps: "12", rir: "2" }, "prescribed");
    expect("steps" in reps && keyless(reps)).toEqual([["amend", { record: { table: "session_set", id: 21 }, changes: { reps: 12 }, reason: "Corrected in the app", idempotency_key: "k" }]]);
    const rir = editSetPlan(e, { reps: "10", rir: "1-2" }, "prescribed");
    expect("steps" in rir && rir.steps[0]?.input.changes).toEqual({ rir_status: "recorded", rir_low: 1, rir_high: 2 });
    expect("done" in rir && rir.done).toBe("Set changed.");
    expect(editSetPlan(e, { reps: "10", rir: "2" }, "prescribed")).toEqual({ error: "Nothing has changed." });
    expect(editSetPlan(e, { reps: "", rir: "2" }, "prescribed")).toEqual({ error: "Enter the reps." });
    expect(editSetPlan(e, { reps: "10", rir: "11" }, "prescribed")).toEqual({ error: "Enter the reps in reserve as a number, or a range like 1-2." });
    expect(editSetPlan(e, { reps: "10", rir: "" }, "prescribed")).toEqual({ error: "Enter the reps in reserve." });
  });

  it("edits a timed set's seconds, never asking for reps or RIR (ticket 68)", () => {
    const hang = setFix(set({ exercise: "Dead hang", reps: null, rir: "not_recorded", duration_s: 45, load_status: "none", load_value: null, load_unit: null })).edit;
    expect(hang).toEqual({ id: 21, setType: "working", reps: "", rir: "", counted: "seconds", secs: "45" });
    const plan = editSetPlan(hang, { reps: "", rir: "", secs: "60" }, "prescribed");
    expect("steps" in plan && plan.steps[0]?.input.changes).toEqual({ duration_s: 60 });
    expect(editSetPlan(hang, { reps: "", rir: "", secs: "45" }, "prescribed")).toEqual({ error: "Nothing has changed." });
    expect(editSetPlan(hang, { reps: "", rir: "", secs: "" }, "prescribed")).toEqual({ error: "Enter the seconds." });
    // A RIR may still be given, as log_set keeps one on such a set.
    const rir = editSetPlan(hang, { reps: "", rir: "2", secs: "45" }, "prescribed");
    expect("steps" in rir && rir.steps[0]?.input.changes).toEqual({ rir_status: "recorded", rir_low: 2, rir_high: 2 });
  });

  it("edits a carried distance's RIR only, with no reps asked", () => {
    const carry = setFix(set({ exercise: "Farmer's carry", reps: null, rir: null, distance: { value: 20, unit: "m" } })).edit;
    expect(carry).toMatchObject({ counted: "distance", reps: "" });
    expect(editSetPlan(carry, { reps: "", rir: "" }, "prescribed")).toEqual({ error: "Nothing has changed." });
  });

  it("lets a record-only member clear a set's RIR", () => {
    const plan = editSetPlan(setFix(set()).edit, { reps: "10", rir: "" }, "record_only");
    expect("steps" in plan && plan.steps[0]?.input.changes).toEqual({ rir_status: "not_recorded", rir_low: null, rir_high: null });
  });
});

describe("Train offers a fix on your own confirmed sets only", () => {
  const list = {
    member: "Asha", from: "2026-08-12", to: TODAY,
    sessions: [{
      id: 9, date: "2026-10-05", session_type: "strength", template: null, gym: null, state: "confirmed", working_sets: 2, volume_kg: 800, records: [], cardio: null, energy_kcal: null, imported: false,
      sets: [set({ id: 1 }), set({ id: 2, state: "draft" })],
    }],
  };
  it("own: confirmed sets have a fix; drafts don't", () => {
    expect(buildHistory(list, true)[0]?.sets.map((s) => s.fix?.edit.id ?? null)).toEqual([1, null]);
  });
  it("own drafts can be confirmed where they are shown (click test P1-5); another member's can't", () => {
    expect(buildHistory(list, true)[0]?.sets.map((s) => s.confirm ?? null)).toEqual([null, [{ table: "session_set", id: 2 }]]);
    expect(buildHistory(list, false)[0]?.sets.every((s) => s.confirm === undefined)).toBe(true);
  });
  it("another member's: none", () => {
    expect(buildHistory(list, false)[0]?.sets.every((s) => s.fix === undefined)).toBe(true);
    expect(buildHistory(list)[0]?.sets.every((s) => s.fix === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------- readings (click test P1-3)
import { editReadingPlan, readingFixes, removeReadingPlan } from "../src/fixes";
import type { ReadingMetrics } from "../src/types";

const bodyMetrics: ReadingMetrics = {
  member: "Asha",
  metrics: [
    { code: "weight", label: "Body weight", dimension: "mass", units: ["kg", "lb"], sides: [], usual_unit: "kg", last: null },
    { code: "arm", label: "Arm", dimension: "length", units: ["cm", "in", "mm"], sides: ["left"], usual_unit: "cm", last: null },
  ],
  recent: [
    { id: 41, metric: "weight", date: "2026-10-06", value: 700, unit: "kg", side: null, body_state: "fasted" },
    { id: 40, metric: "arm", date: "2026-10-05", value: 35.5, unit: "cm", side: "left", body_state: "not_recorded" },
    { id: 39, metric: "bia_visceral_fat", date: "2026-10-04", value: 9, unit: "score", side: null, body_state: "fasted" },
  ],
};

describe("a reading's fix", () => {
  it("lists your recent readings in words, each with its Remove question; one of a metric the app doesn't offer is left out", () => {
    const rows = readingFixes(bodyMetrics);
    expect(rows.map((r) => r.text)).toEqual(["Body weight: 700 kg, fasted, Tue 6 Oct", "Arm, left: 35.5 cm, Mon 5 Oct"]);
    expect(rows[0]!.ask).toBe("Remove Body weight 700 kg of Tue 6 Oct?");
    expect(rows[0]!.edit).toEqual({ id: 41, value: "700", unit: "kg", units: ["kg", "lb"], date: "2026-10-06" });
    expect(readingFixes({ member: "Asha", metrics: [] })).toEqual([]);
  });

  it("Remove is one retract of the reading, with the fixed reason", () => {
    expect(keyless(removeReadingPlan(41))).toEqual([["retract", { records: [{ table: "reading", id: 41 }], reason: "Removed in the app", idempotency_key: "k" }]]);
  });

  it("Edit amends only what changed: the value, the unit, the day", () => {
    const e = readingFixes(bodyMetrics)[0]!.edit;
    expect(keyless(editReadingPlan(e, { value: "70", unit: "kg", date: "2026-10-06" }, TODAY) as never)).toEqual([
      ["amend", { record: { table: "reading", id: 41 }, changes: { value: 70 }, reason: "Corrected in the app", idempotency_key: "k" }],
    ]);
    expect(keyless(editReadingPlan(e, { value: "700", unit: "lb", date: "2026-10-05" }, TODAY) as never)).toEqual([
      ["amend", { record: { table: "reading", id: 41 }, changes: { unit: "lb", measured_on: "2026-10-05" }, reason: "Corrected in the app", idempotency_key: "k" }],
    ]);
  });

  it("checks the entry as the Reading tab does, and says when nothing changed", () => {
    const e = readingFixes(bodyMetrics)[0]!.edit;
    expect(editReadingPlan(e, { value: "0", unit: "kg", date: "2026-10-06" }, TODAY)).toEqual({ error: "Enter the reading as a number above 0." });
    expect(editReadingPlan(e, { value: "70", unit: "st", date: "2026-10-06" }, TODAY)).toEqual({ error: "Choose the unit." });
    expect(editReadingPlan(e, { value: "70", unit: "kg", date: "2026-10-07" }, TODAY)).toEqual({ error: "Choose a day up to today." });
    expect(editReadingPlan(e, { value: "700", unit: "kg", date: "2026-10-06" }, TODAY)).toEqual({ error: "Nothing has changed." });
  });
});
