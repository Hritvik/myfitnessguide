import { describe, expect, it } from "vitest";
import { fieldLabel, lastLine, metricOptions, readingDraft, readingInput, readingPlan, readingResult, releasesHeld, settle } from "../src/reading";
import type { LoggedReading, ReadingMetric, ReadingMetrics } from "../src/types";

const weight: ReadingMetric = { code: "weight", label: "Body weight", dimension: "mass", units: ["kg", "lb"], sides: [], usual_unit: "kg", last: { date: "2026-10-04", value: 77.6, unit: "kg", body_state: "fasted", side: null } };
const arm: ReadingMetric = { code: "arm", label: "Arm", dimension: "length", units: ["cm", "in", "mm"], sides: ["left", "right"], last: null };
const bp: ReadingMetric = { code: "bp_systolic", label: "Blood pressure, systolic", dimension: "pressure", units: ["mmHg"], sides: [], last: null };
const metrics: ReadingMetrics = { member: "Asha", metrics: [arm, bp, weight] };

describe("metricOptions", () => {
  it("puts the metrics you have logged first, most recent first, then the rest by label", () => {
    expect(metricOptions(metrics).map((m) => m.code)).toEqual(["weight", "arm", "bp_systolic"]);
  });
});

describe("settle", () => {
  it("takes your usual unit for that metric, not the last one used (click test P1-2)", () => {
    const waist: ReadingMetric = { code: "waist_navel", label: "Waist at navel", dimension: "length", units: ["cm", "in", "mm"], sides: [], usual_unit: "cm", last: { date: "2026-10-04", value: 37.8, unit: "in", body_state: "not_recorded", side: null } };
    expect(settle(readingDraft("waist_navel", null), waist).unit).toBe("cm");
    // A Worker without usual_unit: the only unit, else the member chooses; never the last reading's unit.
    const { usual_unit: _gone, ...older } = waist;
    expect(settle(readingDraft("waist_navel", null), older).unit).toBeNull();
  });

  it("shows the unit beside the field, or asks for one", () => {
    expect(fieldLabel(weight, "kg")).toBe("Body weight, in kg");
    expect(fieldLabel(arm, null)).toBe("Arm (choose the unit)");
  });

  it("takes your usual unit, or the only one, but never a weight's body state or a side", () => {
    expect(settle(readingDraft("weight", null), weight)).toEqual({ metric: "weight", value: "", unit: "kg", bodyState: null, side: null });
    expect(settle(readingDraft("weight", "fasted"), weight).bodyState).toBe("fasted");
    expect(settle(readingDraft("bp_systolic", null), bp)).toMatchObject({ unit: "mmHg", bodyState: "not_recorded" });
    expect(settle(readingDraft("arm", null), arm)).toMatchObject({ unit: null, side: null, bodyState: "not_recorded" });
  });

  it("keeps what the member chose", () => {
    expect(settle({ ...readingDraft("weight", null), unit: "lb" }, weight).unit).toBe("lb");
  });
});

describe("readingInput", () => {
  const ready = { ...settle(readingDraft("weight", "fasted"), weight), value: "77.4" };

  it("asks for each missing part, one at a time, in the form's order", () => {
    expect(readingInput("Asha", "2026-10-06", readingDraft(null, null), undefined)).toEqual({ error: "Choose what you measured." });
    for (const value of ["", "0", "-2", "abc"]) expect(readingInput("Asha", "2026-10-06", { ...ready, value }, weight)).toEqual({ error: "Enter the reading as a number above 0." });
    expect(readingInput("Asha", "2026-10-06", { ...settle(readingDraft("arm", null), arm), value: "31.5" }, arm)).toEqual({ error: "Choose the unit." });
    expect(readingInput("Asha", "2026-10-06", { ...settle(readingDraft("arm", null), arm), value: "31.5", unit: "cm" }, arm)).toEqual({ error: "Choose the side." });
    expect(readingInput("Asha", "2026-10-06", { ...ready, bodyState: null }, weight)).toEqual({ error: "Choose fasted, fed, after exercise or not recorded." });
  });

  it("gives log_reading's input, with a side only when there is one", () => {
    expect(readingInput("Asha", "2026-10-06", ready, weight)).toEqual({ input: { member: "Asha", date: "2026-10-06", metric: "weight", value: 77.4, unit: "kg", body_state: "fasted" } });
    const left = { ...settle(readingDraft("arm", null), arm), value: "31.5", unit: "cm", side: "left" as const };
    expect(readingInput("Asha", "2026-10-06", left, arm)).toEqual({ input: { member: "Asha", date: "2026-10-06", metric: "arm", value: 31.5, unit: "cm", body_state: "not_recorded", side: "left" } });
  });

  it("is one log_reading write with its own key", () => {
    const plan = readingPlan({ member: "Asha" });
    expect(plan.done).toBe("Logged.");
    expect(plan.steps).toEqual([{ tool: "log_reading", input: { member: "Asha", idempotency_key: expect.any(String) } }]);
  });
});

describe("lastLine and readingResult", () => {
  it("says your last reading of the metric", () => {
    expect(lastLine(weight)).toBe("Last: 77.6 kg on Sun 4 Oct.");
    expect(lastLine(arm)).toBeNull();
  });

  const logged = (over: Partial<LoggedReading["computed"]>, metric = "weight", unit = "kg"): LoggedReading => ({
    reading: { id: 9, metric, value: 77.2, unit, measured_on: "2026-10-06", state: "confirmed", value_canonical: 77.2, canonical_unit: unit },
    computed: { change: null, ...over },
  });

  it("words what log_reading returned: the change, the 7-day fasted average, waist to height", () => {
    expect(readingResult(logged({ change: { previous: 77.6, previous_on: "2026-10-04", delta: -0.3999999999999915, real_change: null }, seven_day_average_kg: 77.2333 }))).toEqual([
      "Down 0.4 kg since Sun 4 Oct.",
      "7-day fasted average: 77.2 kg.",
    ]);
    expect(readingResult(logged({ seven_day_average_kg: null }))).toEqual(["No 7-day fasted average yet: none of the last 7 days has a fasted weight."]);
    expect(readingResult(logged({ change: { previous: 88, previous_on: "2026-10-01", delta: 0.5, real_change: null }, waist_to_height: 0.5057 }, "waist_navel", "cm"))).toEqual([
      "Up 0.5 cm since Thu 1 Oct.",
      "Waist to height: 0.51.",
    ]);
    expect(readingResult(logged({ change: { previous: 77.2, previous_on: "2026-10-05", delta: 0, real_change: null } }, "arm", "cm"))).toEqual(["Same as on Mon 5 Oct."]);
  });
});

describe("releasesHeld", () => {
  const held = { member: "Asha", date: "2026-10-06", metric: "weight", value: 77.4, unit: "kg", body_state: "fasted" };
  const draft = { ...settle(readingDraft("weight", "fasted"), weight), value: "77.4" };
  const next = (d: typeof draft) => readingInput("Asha", "2026-10-06", d, weight);

  it("keeps a failed Save held while the form holds the same reading, however it got there", () => {
    // A chip tapped again, a digit typed and deleted, the value written another way: the same input.
    expect(releasesHeld(held, next(draft))).toBe(false);
    expect(releasesHeld(held, next({ ...draft, value: "77.40" }))).toBe(false);
    expect(releasesHeld(held, next({ ...draft, value: " 77.4 " }))).toBe(false);
    // The held step's own key doesn't make it differ.
    expect(releasesHeld({ ...held, idempotency_key: "k1" }, next(draft))).toBe(false);
  });

  it("keeps it held while the entry is incomplete, and when nothing is held", () => {
    expect(releasesHeld(held, next({ ...draft, value: "" }))).toBe(false);
    expect(releasesHeld(null, next({ ...draft, value: "78" }))).toBe(false);
  });

  it("lets it go for a different complete reading: another value, unit, body state, side or day", () => {
    expect(releasesHeld(held, next({ ...draft, value: "77.5" }))).toBe(true);
    expect(releasesHeld(held, next({ ...draft, unit: "lb" }))).toBe(true);
    expect(releasesHeld(held, next({ ...draft, bodyState: "fed" }))).toBe(true);
    expect(releasesHeld(held, readingInput("Asha", "2026-10-05", draft, weight))).toBe(true);
    const left = { member: "Asha", date: "2026-10-06", metric: "arm", value: 31.5, unit: "cm", body_state: "not_recorded", side: "left" };
    const right = { ...settle(readingDraft("arm", null), arm), value: "31.5", unit: "cm", side: "right" as const };
    expect(releasesHeld(left, readingInput("Asha", "2026-10-06", right, arm))).toBe(true);
    expect(releasesHeld(left, readingInput("Asha", "2026-10-06", { ...right, side: "left" }, arm))).toBe(false);
  });
});

