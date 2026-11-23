/**
 * Varied inputs for the Catalogue's plan builders (ticket 67, part 2): its
 * typed fields, a recipe line's amount, a measure, a yield, a bar, loads and
 * plates, and a workout line. The Catalogue reads numbers strictly (digits
 * and one point): what is typed is what is sent, or it is refused.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addLinePlan, addMeasurePlan, addWorkoutLinePlan, addYieldPlan, barPlan, editPlan, FOOD_FIELDS, lineAmountPlan, loadsPlan, newFoodPlan, NEW_FOOD_START, parseField, parseNumberList, recordPlatesPlan, type FieldKind } from "../../src/catalogue";
import { amount, anyText, AWKWARD, expectRefused, isError, isPlan, NOT_DECIMAL, numbersIn, onlyStep, PLAIN_DECIMAL, typed, whole } from "./arbitraries";

const WHY = "Checked the label";

describe("parseField: a Catalogue field as typed", () => {
  it("a number field takes a plain decimal as typed, and nothing else", () => {
    fc.assert(
      fc.property(fc.oneof(typed(amount(0, 100_000)).map((t) => t.text), anyText), fc.constantFrom<FieldKind>("number", "positive", "optional"), (text, kind) => {
        const r = parseField({ key: "k", label: "Value", kind }, text);
        if (isError(r)) return;
        if (r.value === null) {
          expect(kind === "optional" && text.trim() === "").toBe(true);
          return;
        }
        expect(text.trim()).toMatch(PLAIN_DECIMAL);
        expect(r.value).toBe(Number(text.trim()));
        expect(Number.isFinite(r.value)).toBe(true);
        if (kind === "positive") expect(r.value).toBeGreaterThan(0);
      }),
    );
  });

  it("a name or text field keeps the words as typed, trimmed, whatever they are", () => {
    fc.assert(
      fc.property(anyText, fc.constantFrom<FieldKind>("name", "text"), (text, kind) => {
        const r = parseField({ key: "k", label: "Name", kind }, text);
        if (isError(r)) { expect(kind === "name" && text.trim() === "").toBe(true); return; }
        expect(r.value).toBe(text.trim() === "" ? null : text.trim());
      }),
    );
  });
});

describe("the Catalogue's numeric writes", () => {
  it("a recipe line's amount, a measure, a bar and a yield send the number typed", () => {
    fc.assert(
      fc.property(typed(amount(0.001, 10_000)), (t) => {
        const line = lineAmountPlan(3, t.text, -1, WHY);
        const measure = addMeasurePlan("FS900", { name: "katori", amount: t.text }, WHY);
        const bar = barPlan(4, t.text, "lb", WHY);
        const yieldP = addYieldPlan("FS900", { from: "FS901", factor: t.text, discarded: "" }, WHY);
        for (const p of [line, measure, bar, yieldP]) if (!isPlan(p)) throw new Error(p.error);
        expect(onlyStep(line as never).input.changes).toEqual({ amount_value: t.value });
        expect(onlyStep(measure as never).input).toMatchObject({ name: "katori", amount: t.value });
        expect(onlyStep(bar as never).input.changes).toEqual({ bar_value: t.value, bar_unit: "lb" });
        expect(onlyStep(yieldP as never).input).toMatchObject({ factor: t.value });
      }),
    );
  });

  it("a recipe line goes in the unit chosen, and only g, ml or piece", () => {
    fc.assert(
      fc.property(typed(amount(0.001, 10_000)), fc.constantFrom("g", "ml", "piece", "kg", "cup", ""), (t, unit) => {
        const p = addLinePlan("R900", { food: "Test rice", value: t.text, unit }, WHY);
        if (!["g", "ml", "piece"].includes(unit)) return expectRefused(p);
        if (!isPlan(p)) throw new Error(p.error);
        expect(onlyStep(p).input.line).toEqual({ food: "Test rice", value: t.value, unit });
      }),
    );
  });

  it("any text in a numeric field is sent as typed, finite, or refused", () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const plans = [
          lineAmountPlan(3, text, -1, WHY),
          addMeasurePlan("FS900", { name: "katori", amount: text }, WHY),
          barPlan(4, text, "kg", WHY),
          addYieldPlan("FS900", { from: "FS901", factor: "2.5", discarded: text }, WHY),
          addLinePlan("R900", { food: "Test rice", value: text, unit: "g" }, WHY),
        ];
        for (const p of plans) {
          if (isError(p)) continue;
          if (text.trim() !== "") expect(text.trim()).toMatch(PLAIN_DECIMAL); // blank is only "thrown away: not known"
          for (const x of numbersIn(onlyStep(p).input)) expect(Number.isFinite(x)).toBe(true);
        }
      }),
    );
  });

  it("thrown away is a percent from 0 to 99, sent as its fraction", () => {
    fc.assert(
      fc.property(typed(amount(0, 120)), (t) => {
        const p = addYieldPlan("FS900", { from: "FS901", factor: "2", discarded: t.text }, WHY);
        if (t.value >= 100) return expectRefused(p);
        if (!isPlan(p)) throw new Error(p.error);
        expect((onlyStep(p).input.discarded_fraction as number) * 100).toBeCloseTo(t.value, 9);
      }),
    );
  });
});

describe("loads and plates as lists", () => {
  it("a list of decimals is each value once, as typed, in the unit chosen", () => {
    fc.assert(
      fc.property(fc.array(typed(amount(0.25, 200)), { minLength: 1, maxLength: 8 }), fc.constantFrom(", ", ",", " ", " , "), fc.constantFrom("kg" as const, "lb" as const), (vs, sep, unit) => {
        const text = vs.map((v) => v.text.trim()).join(sep);
        const want = [...new Set(vs.map((v) => v.value))];
        expect(parseNumberList(text)).toEqual({ values: want });
        const p = loadsPlan("add_implement_load", 4, unit, text, WHY);
        if (!isPlan(p)) throw new Error(p.error);
        expect(onlyStep(p).input.loads).toEqual(want.map((value) => ({ value, unit })));
      }),
    );
  });

  it("any list text is finite numbers as typed, or refused", () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const r = parseNumberList(text);
        if (isError(r)) return;
        for (const v of r.values) expect(Number.isFinite(v) && v >= 0).toBe(true);
      }),
    );
  });

  it("a plate both there and not there is refused", () => {
    fc.assert(
      fc.property(fc.array(amount(0.5, 50), { minLength: 1, maxLength: 5 }), (vs) => {
        const text = vs.join(", ");
        expectRefused(recordPlatesPlan(2, "kg", text, String(vs[0]), WHY));
      }),
    );
  });
});

describe("addWorkoutLinePlan: a workout line", () => {
  it("whole sets from 1 to 20 and a rep range low to high go in as typed; backwards is refused", () => {
    fc.assert(
      fc.property(whole(1, 20), whole(0, 200), whole(0, 200), (sets, a, b) => {
        const p = addWorkoutLinePlan(7, { exercise: "Test press", sets: String(sets), low: String(a), high: String(b) }, WHY);
        if (a > b) return expectRefused(p);
        if (!isPlan(p)) throw new Error(p.error);
        expect(onlyStep(p).input.line).toEqual({ exercise: "Test press", sets, reps: { low: a, high: b } });
      }),
    );
  });

  it("any text for sets or reps is a whole number in range, or refused", () => {
    fc.assert(
      fc.property(anyText, fc.constantFrom("sets", "low", "high"), (text, field) => {
        const fields = { exercise: "Test press", sets: "3", low: "8", high: "12", [field]: text };
        const p = addWorkoutLinePlan(7, fields, WHY);
        if (isError(p)) return;
        const line = onlyStep(p).input.line as { sets: number; reps: { low: number; high: number } };
        expect(Number.isInteger(line.sets) && line.sets >= 1 && line.sets <= 20).toBe(true);
        expect(line.reps.low).toBeLessThanOrEqual(line.reps.high);
      }),
    );
  });
});

describe("a food's Edit and a new food in the Catalogue", () => {
  const start = { name: "Test dal", kcal: "350", protein_g: "24", carbs_g: "60", fat_g: "1.5" };

  it("an Edit sends only the fields changed, each as typed", () => {
    fc.assert(
      fc.property(typed(amount(0, 900)), (k) => {
        const p = editPlan(FOOD_FIELDS, { table: "food_source", id: 1 }, { start, fields: { ...start, kcal: k.text }, reason: WHY, override: null }, false);
        if (k.value === 350) { expect(p).toMatchObject({ error: "Nothing changed." }); return; }
        if (!isPlan(p)) throw new Error(p.error);
        expect(onlyStep(p).input.changes).toEqual({ kcal: k.value });
      }),
    );
  });

  it("a new food sends every field typed, or refuses with the field named", () => {
    fc.assert(
      fc.property(anyText, fc.constantFrom("kcal", "protein_g", "reference_amount", "name"), (text, key) => {
        const p = newFoodPlan({ ...NEW_FOOD_START, name: "Test dal", kcal: "350", protein_g: "24", carbs_g: "60", fat_g: "1.5", [key]: text }, WHY, null);
        if (isError(p)) { expect((p as { field: string }).field).toBe(key); return; }
        const input = onlyStep(p).input as Record<string, unknown>;
        expect(input[key]).toBe(key === "name" ? text.trim() : Number(text.trim()));
      }),
    );
  });
});

describe("a Catalogue amount, typed awkwardly", () => {
  const FORMS = [
    { form: "recipe line amount", build: (t: string) => lineAmountPlan(3, t, -1, WHY) },
    { form: "new recipe line", build: (t: string) => addLinePlan("R900", { food: "Test rice", value: t, unit: "g" }, WHY) },
    { form: "measure", build: (t: string) => addMeasurePlan("FS900", { name: "katori", amount: t }, WHY) },
    { form: "bar", build: (t: string) => barPlan(4, t, "kg", WHY) },
    { form: "yield factor", build: (t: string) => addYieldPlan("FS900", { from: "FS901", factor: t, discarded: "" }, WHY) },
  ];
  describe.each(FORMS)("$form", ({ build }) => {
    it.each(AWKWARD.map((t) => [JSON.stringify(t.length > 20 ? `${t.slice(0, 12)}…(${t.length})` : t), t]))("%s is refused", (_label, text) => {
      expectRefused(build(text));
    });
    it.each([...NOT_DECIMAL])("%j, not a decimal, is refused", (text) => expectRefused(build(text)));
    it.each(["12.5", " 60 ", "7.", ".5", "0050"])("%j is taken", (text) => expect(isError(build(text))).toBe(false));
  });

  it("a list reads commas as separators, so \"2,5\" is 2 and 5 (documented: lists are comma-separated)", () => {
    expect(parseNumberList("2,5")).toEqual({ values: [2, 5] });
    expect(parseNumberList("120g")).toHaveProperty("error");
    expect(parseNumberList("💪")).toHaveProperty("error");
  });
});
