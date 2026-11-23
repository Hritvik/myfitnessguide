/**
 * Varied inputs for the training plan builders (ticket 67, part 2): RIR, a
 * set (counted or timed, a load or plates), a workout's rows, a set's Edit,
 * cardio and a cardio block's Edit, and the bar field. Invariants: what is
 * typed is what is sent, a RIR range runs low to high, a timed set sends
 * seconds and never reps, a load goes in the unit and basis shown, and a
 * refused entry builds no write.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { editSetPlan, type SetEdit } from "../../src/fixes";
import { parseBarValue, plateLoad, type PlateGroup } from "../../src/plateBuilder";
import { cardioPlan, loadInput, parseRir, setInput, type Basis, type CardioDraft, type LoadDraft, type SetDraft } from "../../src/setEntry";
import { editCardioPlan } from "../../src/train";
import { workoutInput, type Block, type RowDraft } from "../../src/workout";
import { amount, anyText, AWKWARD, expectRefused, isError, isPlan, NOT_DECIMAL, onlyStep, typed, whole } from "./arbitraries";

const DATE = "2026-10-08";
const rirText = fc
  .tuple(whole(0, 10), whole(0, 10), fc.constantFrom("-", " - ", "- ", " -"), fc.constantFrom("", " "), fc.boolean())
  .map(([a, b, dash, pad, single]) => {
    const [low, high] = a <= b ? [a, b] : [b, a];
    return single ? { low, high: low, text: `${pad}${low}${pad}` } : { low, high, text: `${pad}${low}${dash}${high}${pad}` };
  });
const unit = fc.constantFrom("kg" as const, "lb" as const);
const basis = fc.constantFrom<Basis>("total", "per_side", "per_hand", "per_leg");
/** A load as typed: assistance is negative (Worker decision), so any sign. */
const loadValue = fc.integer({ min: -100_000, max: 500_000 }).map((k) => k / 1000);
const set = (over: Partial<SetDraft> = {}): SetDraft => ({ exercise: "Test row", setType: "working", reps: "10", rir: "2", load: { kind: "value", value: "40", unit: "kg", basis: "total" }, ...over });

describe("parseRir: reps in reserve", () => {
  it("reads a number or a range as typed, low to high", () => {
    fc.assert(fc.property(rirText, (r) => {
      expect(parseRir(r.text)).toEqual({ low: r.low, high: r.high });
    }));
  });

  it("a range that runs backwards is bad, never swapped", () => {
    fc.assert(
      fc.property(whole(0, 10), whole(0, 10), (a, b) => {
        fc.pre(a !== b);
        expect(parseRir(`${Math.max(a, b)}-${Math.min(a, b)}`)).toBe("bad");
      }),
    );
  });

  it("any text is empty, bad, or a range from 0 to 10 with low ≤ high", () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const r = parseRir(text);
        if (r === null) { expect(text.trim()).toBe(""); return; }
        if (r === "bad") return;
        expect(Number.isInteger(r.low) && Number.isInteger(r.high) && r.low >= 0 && r.low <= r.high && r.high <= 10).toBe(true);
      }),
    );
  });
});

describe("setInput: a set on the Set tab", () => {
  it("a counted set sends the reps, RIR and load typed, in the unit and basis shown; never seconds", () => {
    fc.assert(
      fc.property(typed(whole(0, 200)), rirText, loadValue, unit, basis, (reps, rir, v, u, b) => {
        const r = setInput("Asha", DATE, set({ reps: reps.text, rir: rir.text, load: { kind: "value", value: ` ${v} `, unit: u, basis: b } }), "prescribed");
        if (!("input" in r)) throw new Error(r.error);
        expect(r.input).toMatchObject({ reps: reps.value, rir: { low: rir.low, high: rir.high }, load: { value: v, unit: u, basis: b } });
        expect(r.input).not.toHaveProperty("duration_s");
      }),
    );
  });

  it("a timed set sends seconds, never reps, whatever the reps field still holds", () => {
    fc.assert(
      fc.property(typed(whole(1, 3600)), fc.oneof(anyText, typed(whole(0, 200)).map((t) => t.text)), fc.oneof(fc.constant(""), rirText.map((r) => r.text)), (secs, reps, rir) => {
        const r = setInput("Asha", DATE, set({ kind: "duration", secs: secs.text, reps, rir, load: { kind: "none" } }), "prescribed");
        if (!("input" in r)) throw new Error(r.error);
        expect(r.input.duration_s).toBe(secs.value);
        expect(r.input).not.toHaveProperty("reps");
      }),
    );
  });

  it("any text for reps, seconds, RIR or load is sent as typed or refused, and a refusal is an error, never a set", () => {
    fc.assert(
      fc.property(anyText, fc.constantFrom("reps", "secs", "rir", "load"), (text, field) => {
        const d =
          field === "reps" ? set({ reps: text })
            : field === "secs" ? set({ kind: "duration", secs: text, load: { kind: "none" } })
              : field === "rir" ? set({ rir: text })
                : set({ load: { kind: "value", value: text, unit: "lb", basis: "per_hand" } });
        const r = setInput("Asha", DATE, d, "record_only");
        if (isError(r)) { expect(r).not.toHaveProperty("input"); return; }
        const v = Number(text.trim());
        if (field === "reps") expect(r.input.reps === v && Number.isInteger(v) && v >= 0 && v <= 200).toBe(true);
        if (field === "secs") expect(r.input.duration_s === v && Number.isInteger(v) && v > 0).toBe(true);
        if (field === "rir") {
          const rir = r.input.rir as { low: number; high: number } | undefined;
          if (rir) expect(rir.low).toBeLessThanOrEqual(rir.high);
          else expect(text.trim()).toBe("");
        }
        if (field === "load") expect(r.input.load).toEqual({ value: v, unit: "lb", basis: "per_hand" });
      }),
    );
  });

  it("a working set in a programme without RIR is refused; a timed one is not asked for it", () => {
    fc.assert(
      fc.property(typed(whole(0, 200)), fc.constantFrom("", " ", "\t"), (reps, blank) => {
        expectRefused(setInput("Asha", DATE, set({ reps: reps.text, rir: blank }), "prescribed"));
        expect(setInput("Asha", DATE, set({ kind: "duration", secs: "30", rir: blank, load: { kind: "none" } }), "prescribed")).toHaveProperty("input");
      }),
    );
  });

  it("plates go as built, per side, in each plate's own unit; never totalled", () => {
    const plate = fc.record({ value: amount(0.25, 50), unit, count: whole(1, 8) });
    fc.assert(
      fc.property(fc.array(plate, { minLength: 1, maxLength: 5 }), fc.option(fc.record({ value: amount(0, 30), unit })), (plates, bar) => {
        const load: LoadDraft = { kind: "plates", build: { bar, plates: plates as PlateGroup[] } };
        const r = setInput("Asha", DATE, set({ load }), "prescribed");
        if (!("input" in r)) throw new Error(r.error);
        expect(r.input.load).toEqual({ basis: "per_side", plates, ...(bar ? { bar } : {}) });
        expect(plateLoad({ bar, plates: [] })).toHaveProperty("error");
      }),
    );
  });

  it("the implement chosen goes with a load object, and never turns bodyweight into an object", () => {
    fc.assert(
      fc.property(fc.constantFrom<LoadDraft>({ kind: "none" }, { kind: "not_recorded" }, { kind: "value", value: "20", unit: "kg", basis: "total" }), (load) => {
        const r = setInput("Asha", DATE, { ...set({ load }), implement: "Test dumbbells" }, "prescribed");
        if (!("input" in r)) throw new Error(r.error);
        const sent = loadInput(load);
        if (!("load" in sent)) throw new Error(sent.error);
        expect(r.input.load).toEqual(typeof sent.load === "object" ? { ...(sent.load as object), implement: "Test dumbbells" } : sent.load);
      }),
    );
  });
});

describe("parseBarValue: the bar field", () => {
  it("reads a decimal as typed, empty as the implement's own bar; anything else is bad", () => {
    fc.assert(
      fc.property(fc.oneof(typed(amount(0.5, 60)).map((t) => t.text), anyText), (text) => {
        const r = parseBarValue(text);
        if (r === null) { expect(text.trim()).toBe(""); return; }
        if (r === "bad") return;
        expect(Number.isFinite(r) && r > 0 && r === Number(text.trim())).toBe(true);
        expect(text.trim()).toMatch(/^(\d+\.?\d*|\.\d+)$/);
      }),
    );
  });
});

// ---------------------------------------------------------------- a workout's rows

const row = (over: Partial<RowDraft>): RowDraft => ({ id: "r", setType: "working", kind: "reps", reps: "", secs: "", dist: "", distUnit: "m", rir: "", load: { kind: "none" }, ...over });
const block = (rows: RowDraft[], exercise = "Test carry"): Block => ({ key: "b", exercise, prescriptionId: null, substitutes: null, lineId: null, target: null, rows });

describe("workoutInput: a workout's rows", () => {
  const rowArb = fc.oneof(
    fc.tuple(typed(whole(0, 200)), rirText).map(([reps, rir]) => ({ row: row({ kind: "reps", reps: reps.text, rir: rir.text }), want: { reps: reps.value, rir: { low: rir.low, high: rir.high } } })),
    typed(whole(1, 600)).map((s) => ({ row: row({ kind: "duration", secs: s.text, reps: "12" }), want: { duration_s: s.value } })),
    fc.tuple(typed(amount(0.01, 5000)), fc.constantFrom("m" as const, "km" as const, "mi" as const)).map(([d, u]) => ({ row: row({ kind: "distance", dist: d.text, distUnit: u, reps: "8" }), want: { distance: { value: d.value, unit: u } } })),
  );

  it("each row is sent in what it is counted in: reps, seconds or distance in the unit shown, never another", () => {
    fc.assert(
      fc.property(fc.array(rowArb, { minLength: 1, maxLength: 8 }), (rows) => {
        const r = workoutInput("Asha", DATE, { kind: "none" }, [block(rows.map((x) => x.row))], "prescribed");
        if (!("input" in r)) throw new Error(r.error);
        const sets = r.input.sets as Record<string, unknown>[];
        expect(sets).toHaveLength(rows.length);
        for (const [i, x] of rows.entries()) {
          const s = sets[i] as Record<string, unknown>;
          expect(s).toMatchObject(x.want);
          const counted = ["reps", "duration_s", "distance"].filter((k) => k in s);
          expect(counted).toEqual(Object.keys(x.want).filter((k) => k !== "rir"));
        }
      }),
    );
  });

  it("any text in a row's field is sent as typed or the whole workout is refused", () => {
    fc.assert(
      fc.property(anyText, fc.constantFrom("reps", "duration", "distance", "load"), (text, kind) => {
        const r0 =
          kind === "reps" ? row({ reps: text, rir: "2" })
            : kind === "duration" ? row({ kind: "duration", secs: text })
              : kind === "distance" ? row({ kind: "distance", dist: text, distUnit: "km" })
                : row({ reps: "5", rir: "1", load: { kind: "value", value: text, unit: "kg", basis: "total" } });
        const r = workoutInput("Asha", DATE, { kind: "none" }, [block([row({ reps: "10", rir: "2" }), r0])], "prescribed");
        if (isError(r)) { expect(r).not.toHaveProperty("input"); return; }
        const s = (r.input.sets as Record<string, unknown>[])[1] as Record<string, unknown>;
        const v = Number(text.trim());
        if (kind === "reps") expect(s.reps).toBe(v);
        if (kind === "duration") expect(s.duration_s === v && v > 0).toBe(true);
        if (kind === "distance") expect(s.distance).toEqual({ value: v, unit: "km" });
        if (kind === "load") expect(s.load).toEqual({ value: v, unit: "kg", basis: "total" });
      }),
    );
  });
});

// ---------------------------------------------------------------- a set's Edit

describe("editSetPlan: a set's Edit", () => {
  const counted: SetEdit = { id: 5, setType: "working", reps: "10", rir: "2" };
  const timed: SetEdit = { id: 6, setType: "working", reps: "", rir: "", counted: "seconds", secs: "45" };

  it("amends only what changed, RIR as a range low to high", () => {
    fc.assert(
      fc.property(typed(whole(0, 200)), rirText, (reps, rir) => {
        const plan = editSetPlan(counted, { reps: reps.text, rir: rir.text }, "prescribed");
        const want: Record<string, unknown> = {};
        if (reps.value !== 10) want.reps = reps.value;
        if (!(rir.low === 2 && rir.high === 2)) Object.assign(want, { rir_status: "recorded", rir_low: rir.low, rir_high: rir.high });
        if (Object.keys(want).length === 0) { expect(plan).toEqual({ error: "Nothing has changed." }); return; }
        if (!isPlan(plan)) throw new Error(plan.error);
        expect(onlyStep(plan).input.changes).toEqual(want);
      }),
    );
  });

  it("a timed set's Edit sends seconds, never reps", () => {
    fc.assert(
      fc.property(typed(whole(1, 3600)), fc.oneof(anyText, fc.constant("12")), (secs, reps) => {
        const plan = editSetPlan(timed, { reps, rir: "", secs: secs.text }, "prescribed");
        if (secs.value === 45) { expect(plan).toEqual({ error: "Nothing has changed." }); return; }
        if (!isPlan(plan)) throw new Error(plan.error);
        expect(onlyStep(plan).input.changes).toEqual({ duration_s: secs.value });
      }),
    );
  });

  it("any text is amended as typed or refused", () => {
    fc.assert(
      fc.property(anyText, fc.constantFrom("reps", "rir", "secs"), (text, field) => {
        const plan = field === "secs" ? editSetPlan(timed, { reps: "", rir: "", secs: text }, "record_only") : editSetPlan(counted, field === "reps" ? { reps: text, rir: "2" } : { reps: "10", rir: text }, "record_only");
        if (isError(plan)) return;
        const changes = onlyStep(plan).input.changes as Record<string, unknown>;
        const v = Number(text.trim());
        if (field === "reps") expect(changes).toEqual({ reps: v });
        if (field === "secs") expect(changes).toEqual({ duration_s: v });
        if (field === "rir" && changes.rir_status === "recorded") expect(changes.rir_low as number).toBeLessThanOrEqual(changes.rir_high as number);
      }),
    );
  });
});

// ---------------------------------------------------------------- cardio

const cardio = (over: Partial<CardioDraft> = {}): CardioDraft => ({ activity: "", minutes: "30", km: "", avgHr: "", ...over });
const block0 = (p: unknown) => ((onlyStep(p as never).input.blocks as Record<string, unknown>[])[0] as Record<string, unknown>);

describe("cardioPlan: cardio on the Set tab", () => {
  it("sends the minutes as seconds, the km and heart rate as typed", () => {
    fc.assert(
      fc.property(typed(amount(0.5, 600)), typed(amount(0.01, 100)), typed(whole(30, 250)), (min, km, hr) => {
        const plan = cardioPlan("Asha", DATE, cardio({ minutes: min.text, km: km.text, avgHr: hr.text }));
        if (!isPlan(plan)) throw new Error(plan.error);
        expect(block0(plan)).toEqual({ kind: "steady", duration_s: Math.round(min.value * 60), distance: { value: km.value, unit: "km" }, avg_hr: hr.value });
      }),
    );
  });

  it("any text in a field is sent as typed or refused: never a 0-second block, never a typed value silently dropped", () => {
    fc.assert(
      fc.property(anyText, fc.constantFrom("minutes", "km", "avgHr"), (text, field) => {
        const plan = cardioPlan("Asha", DATE, cardio({ [field]: text }));
        if (isError(plan)) return;
        const b = block0(plan);
        expect(b.duration_s as number).toBeGreaterThan(0);
        const v = Number(text.trim());
        if (field === "km" && text.trim() !== "") expect(b.distance).toEqual({ value: v, unit: "km" });
        if (field === "avgHr" && text.trim() !== "") expect(b.avg_hr).toBe(v);
      }),
    );
  });

  it("minutes too few to be a second are refused, never sent as 0 s", () => {
    fc.assert(fc.property(fc.double({ min: Number.MIN_VALUE, max: 0.0083, noNaN: true }) /* under half a second */, (m) => expectRefused(cardioPlan("Asha", DATE, cardio({ minutes: String(m) })))));
  });
});

describe("editCardioPlan: a cardio block's minutes", () => {
  it("amends to the minutes typed, as seconds; the same minutes, however written, send nothing", () => {
    fc.assert(
      fc.property(typed(amount(0.5, 600)), whole(1, 600), (min, was) => {
        const plan = editCardioPlan({ id: 9, minutes: String(was) }, min.text);
        if (Math.round(min.value * 60) === was * 60) { expect(plan).toEqual({ error: "Nothing changed." }); return; }
        if (!isPlan(plan)) throw new Error(plan.error);
        expect(onlyStep(plan).input.changes).toEqual({ duration_s: Math.round(min.value * 60) });
      }),
    );
  });

  it("any text is a duration of at least a second and at most 600 minutes, or refused", () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const plan = editCardioPlan({ id: 9, minutes: "30" }, text);
        if (isError(plan)) return;
        const s = (onlyStep(plan).input.changes as { duration_s: number }).duration_s;
        expect(s >= 1 && s <= 36000 && s === Math.round(Number(text.trim()) * 60)).toBe(true);
      }),
    );
  });
});

// ---------------------------------------------------------------- table-driven: every training form, every awkward input

const FORMS: { form: string; build: (text: string) => unknown; ok: [string, unknown][]; sent: (r: unknown) => unknown }[] = [
  { form: "Set tab reps", build: (t) => setInput("Asha", DATE, set({ reps: t }), "prescribed"), ok: [["12", 12], [" 8 ", 8], ["0", 0]], sent: (r) => (r as { input: { reps: number } }).input.reps },
  { form: "Set tab seconds", build: (t) => setInput("Asha", DATE, set({ kind: "duration", secs: t, load: { kind: "none" } }), "prescribed"), ok: [["45", 45], [" 90 ", 90]], sent: (r) => (r as { input: { duration_s: number } }).input.duration_s },
  { form: "Set tab RIR", build: (t) => setInput("Asha", DATE, set({ rir: t }), "prescribed"), ok: [["2", { low: 2, high: 2 }], ["1-2", { low: 1, high: 2 }], [" 0 - 3 ", { low: 0, high: 3 }]], sent: (r) => (r as { input: { rir: unknown } }).input.rir },
  { form: "workout row reps", build: (t) => workoutInput("Asha", DATE, { kind: "none" }, [block([row({ reps: t, rir: "2" })])], "prescribed"), ok: [["10", 10]], sent: (r) => ((r as { input: { sets: { reps: number }[] } }).input.sets[0]?.reps) },
  { form: "workout row distance", build: (t) => workoutInput("Asha", DATE, { kind: "none" }, [block([row({ kind: "distance", dist: t, distUnit: "m" })])], "prescribed"), ok: [["40", { value: 40, unit: "m" }], ["2.5", { value: 2.5, unit: "m" }]], sent: (r) => ((r as { input: { sets: { distance: unknown }[] } }).input.sets[0]?.distance) },
  { form: "set Edit reps", build: (t) => editSetPlan({ id: 5, setType: "working", reps: "10", rir: "2" }, { reps: t, rir: "2" }, "prescribed"), ok: [["11", { reps: 11 }]], sent: (r) => onlyStep(r as never).input.changes },
  { form: "cardio minutes", build: (t) => cardioPlan("Asha", DATE, cardio({ minutes: t })), ok: [["30", 1800], ["12.5", 750]], sent: (r) => block0(r).duration_s },
  { form: "cardio block Edit", build: (t) => editCardioPlan({ id: 9, minutes: "30" }, t), ok: [["45", { duration_s: 2700 }]], sent: (r) => onlyStep(r as never).input.changes },
];

/** A few awkward entries a form may take: RIR "0" is a valid RIR and a set may have 0 reps. */
const MAY_TAKE: Record<string, readonly string[]> = { "Set tab reps": ["0", "0.0", "-0"], "Set tab RIR": ["0"], "workout row reps": ["0", "0.0", "-0"], "set Edit reps": ["0", "0.0", "-0"] };

describe.each(FORMS)("$form, typed awkwardly", ({ form, build, ok, sent }) => {
  it.each(AWKWARD.filter((t) => !(MAY_TAKE[form] ?? []).includes(t)).map((t) => [JSON.stringify(t.length > 20 ? `${t.slice(0, 12)}…(${t.length})` : t), t]))("%s is refused", (_label, text) => {
    expectRefused(build(text));
  });

  it.each(ok)("%j is taken as %j", (text, want) => {
    const r = build(text);
    if (isError(r)) throw new Error(r.error);
    expect(sent(r)).toEqual(want);
  });

  // Ticket 67 B1: every form reads its numbers with typed.ts (RIR with its own pattern), so hex, exponents and a plus sign are refused.
  it.each([...NOT_DECIMAL])("%j, not a decimal, is refused", (text) => expectRefused(build(text)));
});

describe("a load, typed awkwardly", () => {
  it.each(AWKWARD.filter((t) => !["0", "0.0", "-0", "-1", "-12.5"].includes(t)))("%j is refused", (text) => {
    expectRefused(loadInput({ kind: "value", value: text, unit: "kg", basis: "total" }));
  });

  it.each([["0", 0], ["-12.5", -12.5], [" 22.5 ", 22.5]])("%j is taken as %d (assistance is negative)", (text, v) => {
    expect(loadInput({ kind: "value", value: text, unit: "lb", basis: "total" })).toEqual({ load: { value: v, unit: "lb", basis: "total" } });
  });
});
