/**
 * Varied inputs for the body-reading plan builders (ticket 67, part 2): a
 * new reading and a reading's Edit. Invariants: the value typed is the value
 * sent, the unit sent is the unit the field label shows (one the metric
 * offers), a sided metric always names its side, and a refused entry builds
 * no write.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { editReadingPlan, type ReadingEdit } from "../../src/fixes";
import { BODY_STATES, fieldLabel, readingInput, settle, type ReadingDraft } from "../../src/reading";
import type { ReadingMetric } from "../../src/types";
import { amount, anyText, AWKWARD, expectRefused, isError, isPlan, NOT_DECIMAL, onlyStep, typed } from "./arbitraries";

const DATE = "2026-10-08";
const metric: fc.Arbitrary<ReadingMetric> = fc.record({
  code: fc.constantFrom("weight", "waist_navel", "arm", "bp_systolic", "resting_hr"),
  label: fc.constantFrom("Test metric", "Waist at navel", "Arm"),
  dimension: fc.constantFrom("mass", "length", "pressure"),
  units: fc.uniqueArray(fc.constantFrom("kg", "lb", "cm", "in", "mm", "mmHg", "bpm"), { minLength: 1, maxLength: 3 }),
  sides: fc.constantFrom<("left" | "right")[][]>([], ["left", "right"]),
  usual_unit: fc.constant(null),
  last: fc.constant(null),
});
const bodyState = fc.constantFrom(...BODY_STATES.map((b) => b.value));
const draft = (over: Partial<ReadingDraft> = {}): ReadingDraft => ({ metric: "weight", value: "", unit: null, bodyState: "fasted", side: null, ...over });

describe("readingInput: a new reading", () => {
  it("sends the value typed in the unit the label shows, with the side for a sided metric", () => {
    fc.assert(
      fc.property(metric, typed(amount(0.1, 500)), fc.nat(), bodyState, fc.constantFrom("left" as const, "right" as const), (m, v, i, state, side) => {
        const u = m.units[i % m.units.length] as string;
        const r = readingInput("Asha", DATE, draft({ metric: m.code, value: v.text, unit: u, bodyState: state, side: m.sides.length ? side : null }), m);
        if (!("input" in r)) throw new Error(r.error);
        expect(r.input).toMatchObject({ metric: m.code, value: v.value, unit: u, body_state: state });
        expect(fieldLabel(m, u)).toContain(`in ${u}`);
        if (m.sides.length) expect(r.input.side).toBe(side);
        else expect(r.input).not.toHaveProperty("side");
      }),
    );
  });

  it("a unit the metric doesn't offer, or none, is refused (94 in a cm-only waist can't go in as inches)", () => {
    fc.assert(
      fc.property(metric, fc.option(fc.constantFrom("kg", "lb", "cm", "in", "mm", "mmHg", "bpm", "")), (m, u) => {
        fc.pre(u === null || !m.units.includes(u));
        expectRefused(readingInput("Asha", DATE, draft({ metric: m.code, value: "94", unit: u, side: "left" }), m));
      }),
    );
  });

  it("a sided metric without its side, or no body state, is refused", () => {
    fc.assert(
      fc.property(metric, (m) => {
        const u = m.units[0] as string;
        if (m.sides.length) expectRefused(readingInput("Asha", DATE, draft({ value: "30", unit: u, side: null }), m));
        expectRefused(readingInput("Asha", DATE, draft({ value: "30", unit: u, side: "left", bodyState: null }), m));
      }),
    );
  });

  it("settling a metric never picks a unit it doesn't offer, and never a side", () => {
    fc.assert(
      fc.property(metric, fc.option(fc.constantFrom("kg", "cm", "lb")), (m, usual) => {
        const s = settle(draft({ bodyState: null }), { ...m, usual_unit: usual });
        if (s.unit !== null) expect(m.units).toContain(s.unit);
        expect(s.side).toBeNull();
      }),
    );
  });

  it("any text is the reading as typed, above 0, or refused", () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const m: ReadingMetric = { code: "weight", label: "Body weight", dimension: "mass", units: ["kg", "lb"], sides: [], last: null };
        const r = readingInput("Asha", DATE, draft({ value: text, unit: "kg" }), m);
        if (isError(r)) return;
        const v = Number(text.trim());
        expect(Number.isFinite(v) && v > 0 && r.input.value === v).toBe(true);
      }),
    );
  });
});

describe("editReadingPlan: a reading's Edit", () => {
  const e: ReadingEdit = { id: 12, value: "80.4", unit: "cm", units: ["cm", "in"], date: "2026-10-05" };

  it("amends only what changed: the value typed, the unit chosen, the day", () => {
    fc.assert(
      fc.property(typed(amount(0.1, 300)), fc.constantFrom("cm", "in"), fc.constantFrom("2026-10-05", "2026-10-06", DATE), (v, u, date) => {
        const plan = editReadingPlan(e, { value: v.text, unit: u, date }, DATE);
        const want: Record<string, unknown> = {};
        if (v.value !== 80.4) want.value = v.value;
        if (u !== "cm") want.unit = u;
        if (date !== "2026-10-05") want.measured_on = date;
        if (Object.keys(want).length === 0) {
          expect(plan).toEqual({ error: "Nothing has changed." });
          return;
        }
        if (!isPlan(plan)) throw new Error(plan.error);
        expect(onlyStep(plan).input.changes).toEqual(want);
      }),
    );
  });

  it("any value text, unit or day is amended as given or refused; a day after today never goes in", () => {
    fc.assert(
      fc.property(anyText, fc.constantFrom("cm", "in", "kg", ""), fc.constantFrom("2026-10-05", "2026-10-09", "2026-13-40", "", "yesterday"), (text, u, date) => {
        const plan = editReadingPlan(e, { value: text, unit: u, date }, DATE);
        if (isError(plan)) return;
        const changes = onlyStep(plan).input.changes as Record<string, unknown>;
        if ("value" in changes) expect(changes.value).toBe(Number(text.trim()));
        expect(["cm", "in"]).toContain(u);
        expect(date <= DATE && /^\d{4}-\d{2}-\d{2}$/.test(date)).toBe(true);
      }),
    );
  });
});

describe("a reading, typed awkwardly", () => {
  const weight: ReadingMetric = { code: "weight", label: "Body weight", dimension: "mass", units: ["kg", "lb"], sides: [], last: null };
  const FORMS = [
    { form: "new reading", build: (t: string) => readingInput("Asha", DATE, draft({ value: t, unit: "kg" }), weight) },
    { form: "reading Edit", build: (t: string) => editReadingPlan({ id: 12, value: "80.4", unit: "kg", units: ["kg", "lb"], date: "2026-10-05" }, { value: t, unit: "kg", date: "2026-10-05" }, DATE) },
  ];
  describe.each(FORMS)("$form", ({ build }) => {
    it.each(AWKWARD.map((t) => [JSON.stringify(t.length > 20 ? `${t.slice(0, 12)}…(${t.length})` : t), t]))("%s is refused", (_label, text) => {
      expectRefused(build(text));
    });
    it.each(["77.6", " 78 ", "078.20", ".5"])("%j is taken", (text) => expect(isError(build(text))).toBe(false));
    // Ticket 67 B1: every form reads its numbers with typed.ts, so hex, exponents and a plus sign are refused.
    it.each([...NOT_DECIMAL])("%j, not a decimal, is refused", (text) => expectRefused(build(text)));
  });
});
