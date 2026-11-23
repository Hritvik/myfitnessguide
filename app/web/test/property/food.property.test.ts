/**
 * Varied inputs for the food plan builders (ticket 67, part 2): amounts,
 * units and measures on the Food tab, a pot share, a household meal, a
 * food's Edit, a share change and a leftover. Invariants: what is typed is
 * what is sent, the unit sent is the unit shown, a measure keeps meaning the
 * same food (never "118 of a measure"), and a refused entry builds no write.
 *
 * Seeds are random on purpose (a wider search over time). A failure prints
 * `{ seed, path }` with the shrunk counterexample; to reproduce, pass them to
 * that property: `fc.assert(fc.property(...), { seed: -129946175, path: "0:0" })`.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { amountChips, foodCheck, foodItem, newFoodPlan, potShare, switchMeasure, type AmountDraft, type MeasuredFood, type NewFoodDraft, type Pick } from "../../src/food";
import { editItemPlan, switchItemMeasure, type ItemEdit } from "../../src/fixes";
import { mealInput, newLine, type MealDraft } from "../../src/meal";
import { changeSharePlan, leftoverShare } from "../../src/writes";
import type { FoodSourceDetail } from "../../src/types";
import { amount, anyText, AWKWARD, expectRefused, isError, isPlan, NOT_DECIMAL, numbersIn, onlyStep, typed } from "./arbitraries";

const TODAY = "2026-10-08";
const food = (over: Partial<Extract<Pick, { kind: "food" }>> = {}): Extract<Pick, { kind: "food" }> => ({ kind: "food", ref: "FS900", name: "Test lentils", state: "dry", usual: null, ...over });
const recipe: Extract<Pick, { kind: "recipe" }> = { kind: "recipe", ref: "R900", name: "Test stew", usual: null };
const draft = (over: Partial<AmountDraft> = {}): AmountDraft => ({ value: "", unit: "g", measure: null, provenance: "weighed", uncertainty: "", uncertaintyKcal: "", ...over });

/** A food with a reference unit and up to four named measures, each with its size in that unit. */
const measuredFood: fc.Arbitrary<MeasuredFood> = fc.record({
  reference_unit: fc.constantFrom("g" as const, "ml" as const, "piece" as const),
  measures: fc.uniqueArray(fc.record({ name: fc.constantFrom("katori", "medium", "scoop", "cup", "slice", "tbsp"), amount: amount(1, 500) }), { maxLength: 4, selector: (m) => m.name }),
});

describe("foodItem: an amount on the Food tab", () => {
  it("sends the number typed, in the unit or measure picked, never scaled", () => {
    fc.assert(
      fc.property(typed(amount()), fc.oneof(fc.record({ unit: fc.constantFrom("g", "ml", "piece"), measure: fc.constant(null) }), fc.record({ unit: fc.constant(null), measure: fc.constantFrom("katori", "medium", "scoop") })), (t, u) => {
        const r = foodItem(food(), draft({ value: t.text, ...u }));
        if (!("item" in r)) throw new Error(r.error);
        expect(r.item.value).toBe(t.value);
        if (u.measure) {
          expect(r.item.measure).toBe(u.measure);
          expect(r.item).not.toHaveProperty("unit");
        } else {
          expect(r.item.unit).toBe(u.unit);
          expect(r.item).not.toHaveProperty("measure");
        }
      }),
    );
  });

  it("sends a recipe's servings as typed", () => {
    fc.assert(
      fc.property(typed(amount(0.01, 50)), (t) => {
        const r = foodItem(recipe, draft({ value: t.text, unit: null }));
        expect(r).toMatchObject({ item: { source: "recipe", recipe: "R900", servings: t.value } });
      }),
    );
  });

  it("takes any text as the number it reads as, or refuses it: never 0, negative, infinite, or a crash", () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const r = foodItem(food(), draft({ value: text }));
        if (isError(r)) return;
        const v = r.item.value as number;
        expect(Number.isFinite(v) && v > 0).toBe(true);
        expect(v).toBe(Number(text.trim()));
      }),
    );
  });

  it("refuses a food with neither a unit nor a measure, whatever the amount", () => {
    fc.assert(fc.property(typed(amount()), (t) => expectRefused(foodItem(food(), draft({ value: t.text, unit: null, measure: null })))));
  });

  it("refuses a ± that isn't kcal, and sends one that is as typed", () => {
    fc.assert(
      fc.property(anyText, (kcal) => {
        const r = foodItem(food(), draft({ value: "50", uncertainty: "the katori", uncertaintyKcal: kcal }));
        if (isError(r)) return;
        expect(r.item.dominant_uncertainty).toEqual({ description: "the katori", kcal: Number(kcal.trim()) });
        expect(Number(kcal.trim())).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});

describe("switchMeasure: picking another chip keeps the same food (click test P1-1)", () => {
  it("converts through the measure's size, so the food logged moves by at most the two-decimal rounding", () => {
    fc.assert(
      fc.property(
        measuredFood.filter((s) => s.reference_unit !== "piece" && s.measures.length > 0),
        typed(amount(0.5, 5000)),
        fc.nat(),
        (source, t, pick) => {
          const m = source.measures[pick % source.measures.length] as { name: string; amount: number };
          const inUnit = draft({ value: t.text, unit: source.reference_unit, measure: null });
          const next = switchMeasure(inUnit, source, { measure: m.name });
          expect(next.measure).toBe(m.name);
          expect(next.unit).toBeNull();
          const logged = Number(next.value) * m.amount;
          // "118 g" picked as "medium (118 g)" is 1 medium, never 118 mediums (12,390 kcal).
          expect(Math.abs(logged - t.value)).toBeLessThanOrEqual(0.005 * m.amount + 1e-9);
          // And back: the reference amount comes home within the same rounding.
          const back = switchMeasure(next, source, { unit: source.reference_unit });
          if (Number(next.value) > 0) expect(Math.abs(Number(back.value) - t.value)).toBeLessThanOrEqual(0.005 * m.amount + 0.005 + 1e-9);
        },
      ),
    );
  });

  it("between two measures, the food logged is the same within rounding", () => {
    fc.assert(
      fc.property(
        measuredFood.filter((s) => s.reference_unit !== "piece" && s.measures.length >= 2),
        typed(amount(0.25, 20)),
        (source, t) => {
          const [a, b] = source.measures as [{ name: string; amount: number }, { name: string; amount: number }];
          const next = switchMeasure(draft({ value: t.text, unit: null, measure: a.name }), source, { measure: b.name });
          expect(Math.abs(Number(next.value) * b.amount - t.value * a.amount)).toBeLessThanOrEqual(0.005 * b.amount + 1e-9);
        },
      ),
    );
  });

  it("a piece food's measures have no size in pieces, so a switch starts at 1, never at the count typed", () => {
    fc.assert(
      fc.property(measuredFood.filter((s) => s.reference_unit === "piece" && s.measures.length > 0), typed(amount(1, 500)), (source, t) => {
        const to = source.measures[0] as { name: string };
        expect(switchMeasure(draft({ value: t.text, unit: "piece" }), source, { measure: to.name }).value).toBe("1");
      }),
    );
  });

  it("the unit sent is the chip shown: every chip's own word is in its label", () => {
    fc.assert(
      fc.property(measuredFood, typed(amount(1, 500)), fc.nat(), (source, t, i) => {
        const chips = amountChips(source);
        const chip = chips[i % chips.length] as { label: string; unit?: string; measure?: string };
        const next = switchMeasure(draft({ value: t.text, unit: source.reference_unit }), source, chip.measure ? { measure: chip.measure } : { unit: chip.unit });
        const r = foodItem(food(), next);
        if (isError(r)) return; // a value rounded to 0 is refused, never sent
        const word = (r.item.measure ?? r.item.unit) as string;
        expect(word).toBe(chip.measure ?? chip.unit);
        expect(chip.label).toContain(word);
      }),
    );
  });

  it("any text typed before the switch leaves a usable amount: 1 for a measure, empty for a unit, or the converted number", () => {
    fc.assert(
      fc.property(measuredFood.filter((s) => s.measures.length > 0), anyText, (source, text) => {
        const m = source.measures[0] as { name: string };
        const next = switchMeasure(draft({ value: text, unit: source.reference_unit }), source, { measure: m.name });
        expect(next.value === "1" || (Number.isFinite(Number(next.value)) && Number(next.value) >= 0)).toBe(true);
      }),
    );
  });
});

describe("foodCheck: an implausible amount asks first", () => {
  it("100 times the usual in the same unit or measure always asks", () => {
    fc.assert(
      fc.property(amount(1, 500), fc.option(fc.constantFrom("katori", "medium")), fc.integer({ min: 4, max: 1000 }), (usual, measure, times) => {
        const u = measure ? { value: usual, measure } : { value: usual, unit: "g" };
        const d = draft({ value: String(usual * times), unit: measure ? null : "g", measure: measure ?? null });
        expect(foodCheck(null, d, u)).toMatch(/times your usual/);
      }),
    );
  });

  it("over the kcal line always asks, whatever the amount", () => {
    fc.assert(fc.property(fc.integer({ min: 1501, max: 1_000_000 }), anyText, (kcal, text) => {
      expect(foodCheck(kcal, draft({ value: text }), null)).toMatch(/kcal for one item/);
    }));
  });
});

describe("potShare: a share of a pot", () => {
  it("a percent from 1 to 100 is that fraction of the pot; grams are sent as grams", () => {
    fc.assert(
      fc.property(typed(amount(1, 100)), (t) => {
        const r = potShare("percent", t.text);
        if (!("fraction" in r)) throw new Error("refused");
        expect(r.fraction * 100).toBeCloseTo(t.value, 9);
        expect(potShare("grams", t.text)).toEqual({ weighed_g: t.value });
      }),
    );
  });

  it("any text is a share in range or refused; a percent may end in %", () => {
    fc.assert(
      fc.property(fc.oneof(anyText, typed(amount(1, 100)).map((t) => `${t.text}%`)), fc.constantFrom("percent" as const, "grams" as const), (text, mode) => {
        const r = potShare(mode, text);
        if (isError(r)) return;
        const v = Number(mode === "percent" ? text.trim().replace(/\s*%$/, "") : text.trim());
        if ("fraction" in r) expect(v >= 1 && v <= 100 && Math.abs(r.fraction - v / 100) < 1e-12).toBe(true);
        else expect(r).toEqual({ weighed_g: v });
      }),
    );
  });
});

describe("newFoodPlan (Food tab): a new food per 100 g or ml", () => {
  const f = (over: Partial<NewFoodDraft> = {}): NewFoodDraft => ({ name: "Test chikki", state: "as_sold", per: "g", kcal: "500", protein: "15", carbs: "55", fat: "25", measureName: "", measureAmount: "", ...over });

  it("sends the macros typed, per 100 of the unit shown", () => {
    fc.assert(
      fc.property(typed(amount(0, 900)), typed(amount(0, 100)), fc.constantFrom("g" as const, "ml" as const), (k, p, per) => {
        const plan = newFoodPlan(f({ kcal: k.text, protein: p.text, per }));
        if (!isPlan(plan)) throw new Error(plan.error);
        expect(onlyStep(plan).input).toMatchObject({ kcal: k.value, protein_g: p.value, reference_amount: 100, reference_unit: per });
      }),
    );
  });

  it("a measure named with an amount is sent as typed, or the form refuses: never silently dropped", () => {
    fc.assert(
      fc.property(fc.constantFrom("piece", "katori"), anyText, (name, amountText) => {
        const plan = newFoodPlan(f({ measureName: name, measureAmount: amountText }));
        if (isError(plan)) return;
        expect(onlyStep(plan).input.measures).toEqual([{ name, amount: Number(amountText.trim()) }]);
      }),
    );
  });

  it("any macro text is a number 0 or more as typed, or refused", () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const plan = newFoodPlan(f({ fat: text }));
        if (isError(plan)) return;
        expect(onlyStep(plan).input.fat_g).toBe(Number(text));
        expect(Number(text)).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});

// ---------------------------------------------------------------- a household meal

const source: FoodSourceDetail = { id: 900, ref: "FS900", name: "Test rice", state: "dry", reference_amount: 100, reference_unit: "g", measures: [{ name: "katori", amount: 60 }] };
const meal = (over: Partial<MealDraft> = {}): MealDraft => ({
  name: "Test pulao", recipe: null, cookedWeight: "",
  lines: [{ key: "l1", lineId: null, ref: "FS900", label: "Test rice", value: "120", unit: "g", measure: null, edited: true }],
  eaters: { Asha: { mode: "percent", value: "50" } },
  ...over,
});

describe("household meal: lines and shares", () => {
  it("a new line takes the chip's unit or measure and the number typed", () => {
    fc.assert(
      fc.property(typed(amount()), fc.integer({ min: 0, max: 1 }), (t, chip) => {
        const line = newLine(source, chip, t.text, "k");
        if ("error" in line) throw new Error(line.error);
        expect(Number(line.value)).toBe(t.value);
        const c = amountChips(source)[chip] as { measure?: string; unit?: string };
        expect(line.measure ?? line.unit).toBe(c.measure ?? c.unit);
      }),
    );
  });

  it("sends each line and each share as typed: a percent as its fraction, grams as grams", () => {
    fc.assert(
      fc.property(typed(amount(0.1, 5000)), typed(amount(1, 100)), typed(amount(1, 2000)), (line, pct, grams) => {
        const built = mealInput(meal({
          lines: [{ key: "l1", lineId: null, ref: "FS900", label: "Test rice", value: line.text, unit: null, measure: "katori", edited: true }],
          eaters: { Asha: { mode: "percent", value: pct.text }, Kabir: { mode: "grams", value: grams.text } },
        }), TODAY, "lunch");
        if (!("input" in built)) throw new Error(built.error);
        const cook = (built.input.cooks as Record<string, unknown>[])[0] as { lines: Record<string, unknown>[]; portions: Record<string, unknown>[] };
        expect(cook.lines[0]).toMatchObject({ food: "FS900", value: line.value, measure: "katori" });
        expect(cook.lines[0]).not.toHaveProperty("unit");
        expect(cook.portions[0]).toMatchObject({ member: "Asha" });
        expect((cook.portions[0] as { fraction: number }).fraction * 100).toBeCloseTo(pct.value, 9);
        expect(cook.portions[1]).toMatchObject({ member: "Kabir", weighed_g: grams.value });
      }),
    );
  });

  it("any text in a line, a share or the pot's weight is taken as typed or refused", () => {
    fc.assert(
      fc.property(anyText, fc.constantFrom("line", "share", "weight"), (text, where) => {
        const d =
          where === "line" ? meal({ lines: [{ key: "l1", lineId: null, ref: "FS900", label: "Test rice", value: text, unit: "g", measure: null, edited: true }] })
            : where === "share" ? meal({ eaters: { Asha: { mode: "percent", value: text } } })
              : meal({ eaters: { Asha: { mode: "grams", value: "200" } }, cookedWeight: text });
        const built = mealInput(d, TODAY, "lunch");
        if (isError(built)) return;
        const v = Number(text.trim());
        for (const x of numbersIn(built.input)) expect(Number.isFinite(x)).toBe(true);
        if (where === "line") expect(JSON.stringify(built.input)).toContain(`"value":${JSON.stringify(v)}`);
        if (where === "share") expect(v >= 1 && v <= 100).toBe(true);
        if (where === "weight" && text.trim() !== "") expect((built.input.cooks as { cooked_weight_g: number }[])[0]?.cooked_weight_g).toBe(v);
      }),
    );
  });
});

// ---------------------------------------------------------------- a food's Edit (food amend)

const edit = (over: Partial<ItemEdit["amount"] & object> = {}): ItemEdit => ({
  itemId: 41, slot: "lunch", date: "2026-10-07",
  amount: { table: "intake_item", id: 41, field: "amount_value", value: "118", unit: "g", ...over },
});
const withOptions = (): ItemEdit => {
  const f = { ref: "FS900", reference_unit: "g" as const, measures: [{ name: "medium", amount: 118 }, { name: "katori", amount: 60 }] };
  return edit({ options: amountChips(f), current: 2, food: f });
};

describe("editItemPlan: a food's Edit", () => {
  it("amends the amount to the number typed, never scaled; the same number sends nothing", () => {
    fc.assert(
      fc.property(typed(amount(0.01, 5000)), (t) => {
        const plan = editItemPlan(edit(), { amount: t.text, slot: "lunch", date: "2026-10-07" }, TODAY);
        if (t.value === 118) {
          expect(plan).toEqual({ error: "Nothing has changed." });
          return;
        }
        if (!isPlan(plan)) throw new Error(plan.error);
        expect(onlyStep(plan).input).toMatchObject({ record: { table: "intake_item", id: 41 }, changes: { amount_value: t.value } });
      }),
    );
  });

  it("a pot share's percent goes in as its fraction; grams as grams", () => {
    fc.assert(
      fc.property(typed(amount(1, 100)), (t) => {
        const plan = editItemPlan(edit({ table: "portion", id: 7, field: "fraction", value: "0.5", unit: "% of the pot" }), { amount: t.text, slot: "lunch", date: "2026-10-07" }, TODAY);
        if (!isPlan(plan)) throw new Error(plan.error);
        const changes = onlyStep(plan).input.changes as { fraction: number };
        expect(changes.fraction * 100).toBeCloseTo(t.value, 9);
        const grams = editItemPlan(edit({ table: "portion", id: 7, field: "weighed_g", value: "1", unit: "g" }), { amount: t.text, slot: "lunch", date: "2026-10-07" }, TODAY);
        if (t.value !== 1) expect(isPlan(grams) && onlyStep(grams).input.changes).toEqual({ weighed_g: t.value });
      }),
    );
  });

  it("another measure sends that measure with the converted amount, so the food stays the same (118 g is 1 medium)", () => {
    fc.assert(
      fc.property(typed(amount(1, 2000)), fc.integer({ min: 0, max: 1 }), (t, option) => {
        const e = withOptions();
        const a = e.amount as NonNullable<ItemEdit["amount"]>;
        const d = switchItemMeasure(a, { amount: t.text, slot: "lunch", date: "2026-10-07" }, option);
        const plan = editItemPlan(e, d, TODAY);
        const chosen = (a.options ?? [])[option] as { measure: string };
        const size = option === 0 ? 118 : 60;
        if (isError(plan)) {
          expect(Number(d.amount)).toBe(0); // rounded to nothing: refused, never sent
          return;
        }
        const changes = onlyStep(plan).input.changes as { amount_value: number; measure: string };
        expect(changes.measure).toBe(chosen.measure);
        expect(Math.abs(changes.amount_value * size - t.value)).toBeLessThanOrEqual(0.005 * size + 1e-9);
      }),
    );
  });

  it("any text is amended as typed or refused, and a refusal builds no step", () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const plan = editItemPlan(edit(), { amount: text, slot: "dinner", date: "2026-10-07" }, TODAY);
        if (isError(plan)) {
          expect(plan).not.toHaveProperty("steps");
          return;
        }
        const changes = onlyStep(plan).input.changes as Record<string, unknown>;
        expect(changes.meal_slot).toBe("dinner");
        if ("amount_value" in changes) expect(changes.amount_value).toBe(Number(text.trim()));
        for (const x of numbersIn(changes)) expect(Number.isFinite(x) && x > 0).toBe(true);
      }),
    );
  });
});

describe("a share change and a leftover", () => {
  it("changeSharePlan sends the percent typed as its fraction, or refuses", () => {
    fc.assert(
      fc.property(fc.oneof(typed(amount(1, 100)).map((t) => t.text), anyText), (text) => {
        const plan = changeSharePlan({ portionId: 3 }, text);
        if (isError(plan)) return;
        const v = Number(text.trim());
        expect(v >= 1 && v <= 100).toBe(true);
        expect((onlyStep(plan).input.changes as { fraction: number }).fraction).toBeCloseTo(v / 100, 12);
      }),
    );
  });

  it("leftoverShare: empty is all of it; else a share from 1% to what is left, as typed (a trailing % allowed)", () => {
    fc.assert(
      fc.property(fc.oneof(typed(amount(1, 100)).map((t) => t.text), anyText, typed(amount(1, 100)).map((t) => `${t.text.trim()}%`)), amount(0.01, 1), (text, left) => {
        const r = leftoverShare(text, left);
        if (isError(r) || "all" in r) return;
        const v = Number(text.trim().replace(/%$/, ""));
        expect(v >= 1 && v <= Math.round(left * 100)).toBe(true);
        expect(r.fraction).toBeCloseTo(v / 100, 12);
      }),
    );
  });
});

// ---------------------------------------------------------------- table-driven: every food form, every awkward input

/** Each food form with one field fed the awkward text: whether it may take it, and what it sent. */
const FORMS: { form: string; build: (text: string) => unknown; sent: (r: unknown) => number | undefined }[] = [
  { form: "Food tab amount", build: (t) => foodItem(food(), draft({ value: t })), sent: (r) => ((r as { item: { value: number } }).item.value) },
  { form: "Food tab servings", build: (t) => foodItem(recipe, draft({ value: t, unit: null })), sent: (r) => ((r as { item: { servings: number } }).item.servings) },
  { form: "pot share %", build: (t) => potShare("percent", t), sent: (r) => (r as { fraction: number }).fraction * 100 },
  { form: "pot share g", build: (t) => potShare("grams", t), sent: (r) => (r as { weighed_g: number }).weighed_g },
  { form: "meal line", build: (t) => newLine(source, 1, t, "k"), sent: (r) => Number((r as { value: string }).value) },
  { form: "food Edit amount", build: (t) => editItemPlan(edit(), { amount: t, slot: "lunch", date: "2026-10-07" }, TODAY), sent: (r) => ((onlyStep(r as never).input.changes as { amount_value: number }).amount_value) },
  { form: "share change", build: (t) => changeSharePlan({ portionId: 3 }, t), sent: (r) => ((onlyStep(r as never).input.changes as { fraction: number }).fraction * 100) },
];

describe.each(FORMS)("$form, typed awkwardly", ({ build, sent }) => {
  it.each(AWKWARD.map((t) => [JSON.stringify(t.length > 20 ? `${t.slice(0, 12)}…(${t.length})` : t), t]))("%s is refused", (_label, text) => {
    // Every awkward entry here is empty, 0, negative, signed, comma-decimal, a unit, an emoji, a word or huge: none is an amount.
    const r = build(text);
    expectRefused(r);
  });

  it.each([["12.5", 12.5], [" 42 ", 42], ["7.", 7], ["0050", 50], ["99.99", 99.99]])("%j is taken as %d", (text, value) => {
    const r = build(text);
    if (isError(r)) throw new Error(r.error);
    expect(sent(r)).toBeCloseTo(value, 9);
  });

  // Ticket 67 B1: every form reads its numbers with typed.ts, so hex, exponents and a plus sign are refused.
  it.each([...NOT_DECIMAL])("%j, not a decimal, is refused", (text) => expectRefused(build(text)));
});
