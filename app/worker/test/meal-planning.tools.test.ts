import { describe, expect, it } from "vitest";
import { Ctx } from "../src/context";
import { honestTotals, MEAL_PLANNING_TOOLS } from "../src/tools/meal-planning";
import { NUTRITION_TOOLS } from "../src/tools/nutrition";
import { NOW } from "./db";
import { setup } from "./harness";
import { seedCatalogue } from "./seed";

const MONDAY = "2026-10-05";

function ctxFor(x: ReturnType<typeof setup>) {
  return new Ctx(
    x.counter,
    { kind: "agent", resolver: "claude_code", householdId: x.h.id, clientId: "test", channel: "local_agent" },
    () => x.clock.now,
    "Asia/Kolkata",
  );
}

async function run(x: ReturnType<typeof setup>, name: string, input: unknown) {
  const tool = MEAL_PLANNING_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing ${name}`);
  return tool.run(ctxFor(x), tool.input.parse(input));
}

function target(x: ReturnType<typeof setup>, memberId: number, effectiveFrom: string, kcal: number, protein: number, carbs: number, fat: number) {
  const id = x.t.insert("target", {
    member_id: memberId,
    effective_from: effectiveFrom,
    provenance: "agent",
    reasoning: "private coaching discussion must not leave the target record",
    created_at: NOW,
  });
  for (const [nutrient, value] of [["kcal", kcal], ["protein_g", protein], ["carbs_g", carbs], ["fat_g", fat]] as const) {
    x.t.insert("target_value", { target_id: id, nutrient, kind: "target", value });
  }
}

const sandwich = (date = MONDAY, slot = "lunch") => ({
  date,
  meal_slot: slot,
  cooks: [{
    name: "Pea sandwich",
    lines: [{ food: "peas", value: 200, unit: "g", provenance: "weighed" }],
    portions: [{ member: "Hritvik", fraction: 1, provenance: "estimated" }],
  }],
  items: [],
});

describe("household_planning_context", () => {
  it("returns every active member's effective resolved target for each day without private reasoning", async () => {
    const x = setup();
    target(x, x.h.hritvik, "2026-10-01", 1700, 140, 150, 60);
    target(x, x.h.hritvik, "2026-10-06", 1800, 145, 165, 62);
    target(x, x.h.asha, "2026-10-01", 1500, 100, 155, 55);

    const result = await run(x, "household_planning_context", { from: MONDAY, to: "2026-10-06" });

    expect(result).toMatchObject({ from: MONDAY, to: "2026-10-06", active_plan: null, prepared_batches: [] });
    expect(result.members).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "Hritvik",
        days: [
          expect.objectContaining({ date: MONDAY, target_effective_from: "2026-10-01", target: expect.objectContaining({ kcal: 1700 }) }),
          expect.objectContaining({ date: "2026-10-06", target_effective_from: "2026-10-06", target: expect.objectContaining({ kcal: 1800 }) }),
        ],
      }),
      expect.objectContaining({ name: "Kabir", days: [expect.objectContaining({ target: null }), expect.objectContaining({ target: null })] }),
    ]));
    expect(JSON.stringify(result)).not.toContain("private coaching discussion");
  });

  it("accepts one through fourteen inclusive days and rejects reversed or longer periods", async () => {
    const x = setup();
    await expect(run(x, "household_planning_context", { from: MONDAY, to: MONDAY })).resolves.toBeTruthy();
    await expect(run(x, "household_planning_context", { from: MONDAY, to: "2026-10-18" })).resolves.toBeTruthy();
    await expect(run(x, "household_planning_context", { from: "2026-10-06", to: MONDAY })).rejects.toMatchObject({ code: "invalid_period" });
    await expect(run(x, "household_planning_context", { from: MONDAY, to: "2026-10-19" })).rejects.toMatchObject({ code: "period_too_long" });
  });
});

describe("preview_meal_plan", () => {
  it("uses canonical meal resolution and returns meal, member and day totals against effective targets without writing", async () => {
    const x = setup();
    await seedCatalogue(x);
    target(x, x.h.hritvik, "2026-10-01", 1700, 140, 150, 60);
    const before = x.t.get("SELECT count(*) AS n FROM write_log");

    const result = await run(x, "preview_meal_plan", { entries: [sandwich()] });

    const canonical = NUTRITION_TOOLS.find((candidate) => candidate.name === "preview_meal")!;
    const oneMeal = await canonical.run(ctxFor(x), canonical.input.parse(sandwich()));

    expect(x.t.get("SELECT count(*) AS n FROM write_log")).toEqual(before);
    expect(result.meals).toEqual([
      expect.objectContaining({ date: MONDAY, meal_slot: "lunch", members: expect.objectContaining({ Hritvik: expect.any(Object) }) }),
    ]);
    expect(result.members).toEqual(expect.arrayContaining([
      expect.objectContaining({
        member: "Hritvik",
        days: [expect.objectContaining({
          date: MONDAY,
          target: expect.objectContaining({ kcal: 1700 }),
          totals: expect.objectContaining({ kcal: expect.objectContaining({ value: 162, known: 1, of: 1 }) }),
          delta: expect.objectContaining({ kcal: 1538 }),
          coverage: expect.objectContaining({ kcal: { known: 1, of: 1 } }),
          incomplete: [],
        })],
      }),
    ]));
    expect(result.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ member: "Asha", days: [expect.objectContaining({ date: MONDAY, assessment: "unplanned", delta: null })] }),
    ]));
    const canonicalMembers = Object.fromEntries(Object.entries(oneMeal.members as Record<string, any>).map(([name, totals]) => [name, honestTotals(totals)]));
    expect((result.meals as any[])[0]).toMatchObject({ cooks: oneMeal.cooks, items: oneMeal.items, members: canonicalMembers });
  });

  it("requires explicit portions including [] and keeps unknown macros visibly incomplete", async () => {
    const x = setup();
    await seedCatalogue(x);
    const noPortions = sandwich();
    delete (noPortions.cooks[0] as { portions?: unknown }).portions;
    await expect(run(x, "preview_meal_plan", { entries: [noPortions] })).rejects.toThrow();

    const unallocated: any = await run(x, "preview_meal_plan", { entries: [{ ...sandwich(), cooks: [{ ...sandwich().cooks[0], portions: [] }] }] });
    expect(unallocated.meals[0]).toMatchObject({ members: {} });
    expect(unallocated.issues).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unallocated_remainder", date: MONDAY, meal_slot: "lunch", cook: "Pea sandwich", component: "whole" })]));

    const unknown: any = await run(x, "preview_meal_plan", {
      entries: [{ date: MONDAY, meal_slot: "breakfast", cooks: [], items: [{
        member: "Hritvik", source: "manual", kcal: 100, protein_g: 10, carbs_g: 10, fat_g: 2,
        reason: "package label", provenance: "estimated", confidence: "low",
      }] }],
    });
    expect(unknown.members[0].days[0]).toMatchObject({ coverage: { kcal: { known: 1, of: 1 } }, delta: null });
    expect(honestTotals({ carbs: { value: 0, known: 0, of: 1 } })).toEqual({ carbs: { value: null, known: 0, of: 1 } });
  });

  it("rejects duplicate slots, more than 14 inclusive days, and more than 84 entries", async () => {
    const x = setup();
    await seedCatalogue(x);
    const before = x.t.get("SELECT count(*) AS n FROM write_log");
    await expect(run(x, "preview_meal_plan", { entries: [sandwich(), sandwich()] })).rejects.toMatchObject({ code: "duplicate_meal" });
    await expect(run(x, "preview_meal_plan", { entries: [sandwich(MONDAY), sandwich("2026-10-19", "dinner")] })).rejects.toMatchObject({ code: "period_too_long" });
    expect(x.t.get("SELECT count(*) AS n FROM write_log")).toEqual(before);
    const tooMany = Array.from({ length: 85 }, (_, i) => sandwich(`2026-10-${String(5 + Math.floor(i / 6)).padStart(2, "0")}`, ["breakfast", "lunch", "dinner", "snack", "pre_workout", "post_workout"][i % 6]));
    const tool = MEAL_PLANNING_TOOLS.find((candidate) => candidate.name === "preview_meal_plan")!;
    expect(() => tool.input.parse({ entries: tooMany })).toThrow();
  });

  it("bounds every meal-level collection and text before doing any work", () => {
    const tool = MEAL_PLANNING_TOOLS.find((candidate) => candidate.name === "preview_meal_plan")!;
    const base = sandwich();
    const cook = base.cooks[0]!;
    const line = cook.lines[0]!;
    const portion = cook.portions[0]!;
    expect(() => tool.input.parse({ entries: [{ ...base, cooks: Array.from({ length: 13 }, () => base.cooks[0]) }] })).toThrow();
    expect(() => tool.input.parse({ entries: [{ ...base, cooks: [{ ...base.cooks[0], lines: Array.from({ length: 31 }, () => line) }] }] })).toThrow();
    expect(() => tool.input.parse({ entries: [{ ...base, cooks: [{ ...base.cooks[0], lines: undefined, components: Array.from({ length: 5 }, (_, i) => ({ name: `part ${i}`, lines: [line] })) }] }] })).toThrow();
    expect(() => tool.input.parse({ entries: [{ ...base, cooks: [{ ...base.cooks[0], portions: Array.from({ length: 21 }, () => portion) }] }] })).toThrow();
    expect(() => tool.input.parse({ entries: [{ ...base, items: Array.from({ length: 21 }, () => ({ member: "Hritvik", source: "manual", kcal: 1, protein_g: 1, carbs_g: 1, fat_g: 1, reason: "label", provenance: "estimated", confidence: "low" })) }] })).toThrow();
    expect(() => tool.input.parse({ entries: [{ ...base, note: "x".repeat(1_001) }] })).toThrow();
    const tenLines = Array.from({ length: 10 }, () => line);
    expect(() => tool.input.parse({ entries: Array.from({ length: 31 }, (_, i) => ({ ...sandwich(`2026-10-${String(5 + Math.floor(i / 6)).padStart(2, "0")}`, ["breakfast", "lunch", "dinner", "snack", "pre_workout", "post_workout"][i % 6]), cooks: [{ ...cook, lines: tenLines }] })) })).toThrow();
  });

  it("keeps the maximum 84-entry preview inside a fixed statement budget", async () => {
    const x = setup();
    const slots = ["breakfast", "lunch", "dinner", "snack", "pre_workout", "post_workout"];
    const entries = Array.from({ length: 84 }, (_, i) => ({
      date: `2026-10-${String(5 + Math.floor(i / 6)).padStart(2, "0")}`,
      meal_slot: slots[i % 6],
      cooks: [],
      items: [{ member: "Hritvik", source: "manual", kcal: 1, protein_g: 1, carbs_g: 1, fat_g: 1, reason: "label", provenance: "estimated", confidence: "high" }],
    }));
    x.counter.reset();
    const result = await run(x, "preview_meal_plan", { entries });
    expect(result.meals).toHaveLength(84);
    expect(x.counter.count).toBeLessThanOrEqual(20);
  });

  it("orders meals and members deterministically regardless of input order", async () => {
    const x = setup();
    await seedCatalogue(x);
    const result: any = await run(x, "preview_meal_plan", {
      entries: [
        { ...sandwich("2026-10-06", "dinner"), cooks: [], items: [{ member: "Asha", source: "manual", kcal: 2, protein_g: 1, carbs_g: 1, fat_g: 1, reason: "label", provenance: "estimated", confidence: "high" }] },
        sandwich(MONDAY, "lunch"),
      ],
    });
    expect(result.meals.map((meal: any) => `${meal.date}|${meal.meal_slot}`)).toEqual([`${MONDAY}|lunch`, "2026-10-06|dinner"]);
    expect(result.members.map((member: any) => member.member)).toEqual(["Hritvik", "Asha", "Kabir"]);
  });
});

describe("existing meal input safety", () => {
  it("applies the same bounded meal schema to preview_meal and household_meal", () => {
    const oversized = { ...sandwich(), cooks: Array.from({ length: 13 }, () => sandwich().cooks[0]) };
    for (const name of ["preview_meal", "household_meal"]) {
      const tool = NUTRITION_TOOLS.find((candidate) => candidate.name === name)!;
      expect(() => tool.input.parse(name === "household_meal" ? {
        ...oversized,
        idempotency_key: "bound-check",
        speaker: "Hritvik",
      } : oversized)).toThrow();
    }
  });
});
