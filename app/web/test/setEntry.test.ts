import { describe, expect, it } from "vitest";
import { cardioPlan, draftForExercise, exerciseChoices, LOAD_CHIPS, parseRir, setFeedback, setInput, setPlan, type SetDraft } from "../src/setEntry";
import type { NextForEntry, PreviewSet, RecentItems } from "../src/types";

const recent: RecentItems = {
  member: "Asha", from: "2026-09-07", to: "2026-10-06", items: [],
  exercises: [
    { exercise: "Cable row", count: 3, last_on: "2026-10-06", today: true, usual: { load: { value: 35, unit: "kg", basis: "total" }, reps: 12 } },
    { exercise: "Goblet squat", count: 9, last_on: "2026-10-01", today: false, usual: { load: null, reps: 10 } },
  ],
};
const next: NextForEntry = { programming_mode: "prescribed", session: "Upper A", prescriptions: [{ prescription_id: 1, exercise: "Barbell bench press", sets: 3, target: { kind: "reps", low: 8, high: 12 }, rir_target: { low: 1, high: 2 }, load: null }, { prescription_id: 2, exercise: "Cable row", sets: 3, target: { kind: "reps", low: 10, high: 12 }, rir_target: { low: 1, high: 2 }, load: null }] };
const draft = (over: Partial<SetDraft> = {}): SetDraft => ({ exercise: "Cable row", setType: "working", reps: "12", rir: "2", load: { kind: "value", value: "35", unit: "kg", basis: "total" }, ...over });

describe("exerciseChoices", () => {
  it("lists today's exercises, then the next session's, then recents, each once", () => {
    expect(exerciseChoices(recent, next, null).map((c) => [c.group, c.name])).toEqual([
      ["Today", "Cable row"], ["Next session", "Barbell bench press"], ["Recent", "Goblet squat"],
    ]);
  });

  it("shows search results instead while typing", () => {
    expect(exerciseChoices(recent, next, [{ kind: "exercise", id: 4, name: "Hack squat", implement_kind: "machine", aliases: ["hack"], score: 80 }]).map((c) => c.name)).toEqual(["Hack squat"]);
  });
});

describe("setInput", () => {
  it("names the card's template when the sheet carries one (click test P2-16)", () => {
    expect(setInput("Asha", "2026-10-06", draft(), "prescribed", "Lower A")).toMatchObject({ input: { member: "Asha", date: "2026-10-06", template: "Lower A" } });
    expect("input" in setInput("Asha", "2026-10-06", draft(), "prescribed") && Object.keys((setInput("Asha", "2026-10-06", draft(), "prescribed") as { input: object }).input)).not.toContain("template");
  });

  it("carries the implement the member chose for \"Which cable?\", so the next set doesn't ask again (click test P1-6)", () => {
    expect(setInput("Asha", "2026-10-06", draft({ implement: "Cable A" }), "prescribed")).toMatchObject({ input: { load: { value: 35, unit: "kg", basis: "total", implement: "Cable A" } } });
    const plates = draft({ implement: "Cable A", load: { kind: "plates", build: { bar: null, plates: [{ value: 10, unit: "kg", count: 1 }] } } });
    expect(setInput("Asha", "2026-10-06", plates, "prescribed")).toMatchObject({ input: { load: { implement: "Cable A" } } });
    // Bodyweight has no implement to name.
    expect(setInput("Asha", "2026-10-06", draft({ implement: "Cable A", load: { kind: "none" } }), "prescribed")).toMatchObject({ input: { load: "none" } });
  });

  it("builds log_set by member and date", () => {
    expect(setInput("Asha", "2026-10-06", draft(), "prescribed")).toEqual({
      input: { member: "Asha", date: "2026-10-06", exercise: "Cable row", set_type: "working", reps: 12, rir: { low: 2, high: 2 }, load: { value: 35, unit: "kg", basis: "total" } },
    });
    expect(setPlan({ member: "Asha" }).steps[0]?.tool).toBe("log_set");
  });

  it("reads an RIR range, and needs RIR on a prescribed member's working set only", () => {
    expect(parseRir("1-2")).toEqual({ low: 1, high: 2 });
    expect(parseRir("")).toBeNull();
    expect(parseRir("2-1")).toBe("bad");
    expect(setInput("Asha", "2026-10-06", draft({ rir: "" }), "prescribed")).toEqual({ error: "Enter the reps in reserve." });
    expect(setInput("Asha", "2026-10-06", draft({ rir: "", setType: "warm_up" }), "prescribed")).toMatchObject({ input: { set_type: "warm_up" } });
    expect(setInput("Noor", "2026-10-06", draft({ rir: "" }), "record_only")).toMatchObject({ input: { reps: 12 } });
  });

  it("takes plates or bodyweight as the load, and asks for reps", () => {
    const plates = draft({ load: { kind: "plates", build: { bar: { value: 20, unit: "kg" }, plates: [{ value: 10, unit: "kg", count: 1 }] } } });
    expect((setInput("Asha", "2026-10-06", plates, "prescribed") as { input: { load: unknown } }).input.load).toEqual({ basis: "per_side", plates: [{ value: 10, unit: "kg", count: 1 }], bar: { value: 20, unit: "kg" } });
    expect((setInput("Asha", "2026-10-06", draft({ load: { kind: "none" } }), "prescribed") as { input: { load: unknown } }).input.load).toBe("none");
    expect(setInput("Asha", "2026-10-06", draft({ reps: "" }), "prescribed")).toEqual({ error: "Enter the reps." });
    expect(setInput("Asha", "2026-10-06", draft({ load: { kind: "value", value: "", unit: "kg", basis: "total" } }), "prescribed")).toEqual({ error: "Enter the load." });
  });
});

describe("setFeedback", () => {
  it("words preview_set's checks", () => {
    const p: PreviewSet = {
      set: { total_kg: 47.5, exercise: "Cable row" }, state: "draft",
      snap: { status: "off_list", value: 47.5, unit: "kg", below: { value: 45, unit: "kg" }, above: { value: 50, unit: "kg" } },
      offer: { tool: "add_implement_load" }, implausible: { ratio: 1.9, referenceKg: 25, likelyCause: "unknown" }, read_from: null,
      session: { id: null, would_create: true, template: "Upper A", workout: null },
    };
    expect(setFeedback(p)).toEqual([
      "47.5 kg in all.",
      "47.5 kg isn't on the gym's list (nearest 45 kg, 50 kg). It will wait as a draft until the load is added.",
      "That is far from last time's 25 kg. Check the unit and the basis.",
      "This starts today's Upper A session.",
    ]);
    // In a workout the Save decides the session, so a set's guess at it is left out.
    expect(setFeedback(p, { session: false })).not.toContain("This starts today's Upper A session.");
  });
});

describe("cardio", () => {
  it("logs a cardio session as one steady block", () => {
    const plan = cardioPlan("Asha", "2026-10-06", { activity: "incline walk", minutes: "30", km: "2.4", avgHr: "128" });
    expect("steps" in plan && plan.steps[0]).toEqual({ tool: "log_cardio", input: { member: "Asha", date: "2026-10-06", session_type: "cardio", blocks: [{ kind: "steady", activity: "incline walk", duration_s: 1800, distance: { value: 2.4, unit: "km" }, avg_hr: 128 }], idempotency_key: expect.any(String) } });
    expect(cardioPlan("Asha", "2026-10-06", { activity: "", minutes: "", km: "", avgHr: "" })).toEqual({ error: "Enter how long." });
  });

  it("refuses minutes too few to be a second, and a distance or heart rate typed but not a number (ticket 67, property test)", () => {
    const c = { activity: "", minutes: "30", km: "", avgHr: "" };
    expect(cardioPlan("Asha", "2026-10-06", { ...c, minutes: "0.001" })).toEqual({ error: "Enter how long." });
    expect(cardioPlan("Asha", "2026-10-06", { ...c, km: "2.4km" })).toEqual({ error: "Enter the distance in km above 0, or leave it blank if not known." });
    expect(cardioPlan("Asha", "2026-10-06", { ...c, km: "-2" })).toEqual({ error: "Enter the distance in km above 0, or leave it blank if not known." });
    expect(cardioPlan("Asha", "2026-10-06", { ...c, km: "0" })).toEqual({ error: "Enter the distance in km above 0, or leave it blank if not known." });
    expect(cardioPlan("Asha", "2026-10-06", { ...c, km: "2,5" })).toEqual({ error: "Use a point for the distance's decimal: 2.5, not 2,5." });
    expect(cardioPlan("Asha", "2026-10-06", { ...c, avgHr: "fast" })).toEqual({ error: "Enter the average heart rate as a whole number above 0, or leave it blank if not known." });
    expect(cardioPlan("Asha", "2026-10-06", { ...c, avgHr: "-5" })).toEqual({ error: "Enter the average heart rate as a whole number above 0, or leave it blank if not known." });
    expect(cardioPlan("Asha", "2026-10-06", { ...c, avgHr: "0" })).toEqual({ error: "Enter the average heart rate as a whole number above 0, or leave it blank if not known." });
    expect("steps" in cardioPlan("Asha", "2026-10-06", { ...c, km: " ", avgHr: " " })).toBe(true);
  });
});

describe("the Set tab's load chips", () => {
  it("offer Not recorded beside Weight, Plates and Bodyweight, and a not-recorded set sends load not_recorded", () => {
    expect(LOAD_CHIPS.map((c) => [c.kind, c.label])).toEqual([["value", "Weight"], ["plates", "Plates"], ["none", "Bodyweight"], ["not_recorded", "Not recorded"]]);
    const out = setInput("Asha", "2026-10-06", draft({ load: { kind: "not_recorded" } }), "record_only") as { input: Record<string, unknown> };
    expect(out.input.load).toBe("not_recorded");
  });
});


describe("picking an exercise (click test P2-16, P2-17)", () => {
  const prescribed: NextForEntry = { programming_mode: "prescribed", session: "Upper A", prescriptions: [
    { prescription_id: 1, exercise: "Barbell bench press", sets: 3, target: { kind: "reps", low: 8, high: 12 }, rir_target: { low: 1, high: 2 }, load: { value: 12.27, unit: "kg", basis: "per_side", bar: { value: 20, unit: "kg" }, plates: [{ value: 10, unit: "kg", count: 1 }] } },
    { prescription_id: 2, exercise: "Cable row", sets: 3, target: { kind: "reps", low: 10, high: 12 }, rir_target: null, load: { value: 40, unit: "kg", basis: "total", bar: null, plates: null } },
    { prescription_id: 3, exercise: "Dead hang", sets: 2, target: { kind: "duration", low_s: 30, high_s: 45 }, rir_target: null, load: null },
  ] };

  it("starts from the prescription's load, bar and plates included, and nothing else carried over", () => {
    expect(draftForExercise("Barbell bench press", prescribed)).toEqual({ exercise: "Barbell bench press", setType: "working", kind: "reps", reps: "", secs: "", rir: "", load: { kind: "plates", build: { bar: { value: 20, unit: "kg" }, plates: [{ value: 10, unit: "kg", count: 1 }] } } });
    expect(draftForExercise("Cable row", prescribed).load).toEqual({ kind: "value", value: "40", unit: "kg", basis: "total" });
    expect(draftForExercise("Goblet squat", prescribed)).toMatchObject({ kind: "reps", load: { kind: "value", value: "", unit: "kg", basis: "total" } });
  });

  it("counts a timed prescription in seconds, with no load and no RIR asked", () => {
    const hang = draftForExercise("Dead hang", prescribed);
    expect(hang).toMatchObject({ kind: "duration", load: { kind: "none" } });
    expect(setInput("Asha", "2026-10-06", { ...hang, secs: "" }, "prescribed")).toEqual({ error: "Enter the seconds." });
    expect(setInput("Asha", "2026-10-06", { ...hang, secs: "40" }, "prescribed")).toEqual({ input: { member: "Asha", date: "2026-10-06", exercise: "Dead hang", set_type: "working", duration_s: 40, load: "none" } });
  });
});
