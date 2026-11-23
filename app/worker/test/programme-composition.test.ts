// A programme load as a composition: a bar plus plates on each side, units
// mixed (a kg bar with lb plates), as log_set takes. programme_change and
// the imported prescription accept it, and next_prescription and programme
// return it.
import { describe, expect, it } from "vitest";
import { importWrite } from "../src/importing";
import { setup } from "./harness";
import { seedTraining } from "./seed";

const MONDAY = "2026-10-05";
const LB = 0.45359237;

async function ready() {
  const x = setup();
  const s = seedTraining(x);
  const bar = x.t.insert("implement", { gym_id: s.gym, name: "Loadable bar", kind: "barbell", unit: "kg", loading: "per_side", load_list_complete: 0, bar_value: 20, bar_unit: "kg" });
  await x.ok("record_plates", { gym: s.gym, unit: "kg", available: [5, 10, 20], absent: [1.25, 2.5], complete: true });
  await x.ok("record_plates", { gym: s.gym, unit: "lb", available: [2.5, 5, 10], complete: true });
  const incline = x.t.insert("exercise", { household_id: x.h.id, name: "Incline barbell press", implement_kind: "barbell" });
  const programme = x.t.insert("programme", { member_id: x.h.hritvik, name: "Base", schedule_kind: "weekday", active: 1, started_on: "2026-09-01" });
  const upper = x.t.insert("session_template", { programme_id: programme, name: "Upper A", session_type: "strength" });
  x.t.insert("schedule_slot", { programme_id: programme, weekday: 1, template_id: upper });
  // Imported as a total (an invented one).
  const p = x.t.insert("prescription", {
    template_id: upper, position: 1, exercise_id: incline, sets: 3, rep_low: 8, rep_high: 10, rir_target_low: 1, rir_target_high: 2,
    load_value: 60, load_unit: "lb", load_basis: "total", load_implement_id: bar,
  });
  return { x, s, bar, p };
}

const change = (p: number, load: Record<string, unknown>) => ({
  member: "Hritvik", change: { kind: "load_change", prescription_id: p, date: MONDAY, load, reason: "re-expressed as the bar and plates loaded" },
});

describe("programme_change takes a composition", () => {
  it("a kg bar with mixed plates per side: stored as given, with the per-side sum, and next_prescription returns it", async () => {
    const { x, p } = await ready();
    const body = await x.ok("programme_change", change(p, { basis: "per_side", plates: [{ value: 10, unit: "kg" }, { value: 5, unit: "lb" }] }));
    expect(body.load_change.current).toMatchObject({
      basis: "per_side", unit: "kg", bar: { value: 20, unit: "kg" }, plates: [{ value: 10, unit: "kg", count: 1 }, { value: 5, unit: "lb", count: 1 }],
    });
    expect(body.load_change.current.value).toBeCloseTo(10 + 5 * LB, 9);
    expect(body.load_change.unverified).toBe(false);

    const next = await x.ok("next_prescription", { member: "Hritvik", date: MONDAY });
    expect(next.prescriptions[0].load).toMatchObject({
      basis: "per_side", bar: { value: 20, unit: "kg" }, plates: [{ value: 10, unit: "kg", count: 1 }, { value: 5, unit: "lb", count: 1 }],
      implement: "Loadable bar", unverified: false,
    });
    expect(next.prescriptions[0].load.snap.status).toBe("on_list");

    const programme = await x.ok("programme", { member: "Hritvik" });
    expect(programme.templates[0].prescriptions[0].current_load).toMatchObject({ basis: "per_side", bar: { value: 20, unit: "kg" }, plates: [{ value: 10, unit: "kg", count: 1 }, { value: 5, unit: "lb", count: 1 }] });
  });

  it("takes a bar other than the implement's own, and plates of one unit keep that unit", async () => {
    const { x, p } = await ready();
    const body = await x.ok("programme_change", change(p, { basis: "per_side", bar: { value: 15, unit: "kg" }, plates: [{ value: 5, unit: "lb", count: 2 }] }));
    expect(body.load_change.current).toMatchObject({ value: 10, unit: "lb", basis: "per_side", bar: { value: 15, unit: "kg" }, plates: [{ value: 5, unit: "lb", count: 2 }] });
  });

  it("a plain load carries no composition", async () => {
    const { x, p } = await ready();
    const body = await x.ok("programme_change", change(p, { value: 30, unit: "kg", basis: "total" }));
    expect(body.load_change.current).toEqual({ value: 30, unit: "kg", basis: "total", bar: null, plates: null });
    const next = await x.ok("next_prescription", { member: "Hritvik", date: MONDAY });
    expect(next.prescriptions[0].load).toMatchObject({ value: 30, unit: "kg", basis: "total", bar: null, plates: null });
  });

  it("plates go with a per-side load", async () => {
    const { x, p } = await ready();
    const reply = await x.call("programme_change", change(p, { basis: "total", plates: [{ value: 10, unit: "kg" }] }));
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "bar_only_per_side" });
  });

  it("a value or plates must be given", async () => {
    const { x, p } = await ready();
    const reply = await x.call("programme_change", change(p, { basis: "per_side" }));
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "load_value_needed" });
  });

  it("a plate the gym doesn't have can't be prescribed", async () => {
    const { x, p } = await ready();
    const reply = await x.call("programme_change", change(p, { basis: "per_side", plates: [{ value: 2.5, unit: "kg" }] }));
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "load_not_producible" });
  });
});

describe("an imported prescription's load may be a composition", () => {
  it("create_programme stores the bar and plates, and programme returns them", async () => {
    const x = setup();
    seedTraining(x);
    await importWrite(x.db, "create_exercise", { name: "Incline barbell press", implement_kind: "barbell" }, { at: "2026-10-05T19:07:21Z", origin: { file: "base", tab: "Log", row: 1 } });
    const r = await importWrite(x.db, "create_programme", {
      member: "Hritvik", name: "Programme", schedule_kind: "weekday", started_on: "2026-09-01",
      templates: [{ name: "Upper A", session_type: "strength", prescriptions: [
        { exercise: "Incline barbell press", sets: 3, rep_low: 8, rep_high: 10, rir_target_low: 1, rir_target_high: 2,
          load: { basis: "per_side", bar: { value: 20, unit: "kg" }, plates: [{ value: 10, unit: "lb" }, { value: 2.5, unit: "lb" }] } },
      ] }],
      slots: [{ weekday: 1, template: "Upper A" }],
    }, { at: "2026-10-05T19:07:21Z", origin: { file: "base", tab: "Programme", row: 1 } });
    expect(r.status).toBe("ok");
    const programme = await x.ok("programme", { member: "Hritvik" });
    expect(programme.templates[0].prescriptions[0].current_load).toMatchObject({
      value: 12.5, unit: "lb", basis: "per_side", bar: { value: 20, unit: "kg" }, plates: [{ value: 10, unit: "lb", count: 1 }, { value: 2.5, unit: "lb", count: 1 }],
    });
  });
});

describe("the composition columns", () => {
  it("hold plates only on a per-side load, and a bar with its unit", () => {
    const x = setup();
    const s = seedTraining(x);
    const programme = x.t.insert("programme", { member_id: x.h.hritvik, name: "Base", schedule_kind: "weekday", active: 1, started_on: "2026-09-01" });
    const upper = x.t.insert("session_template", { programme_id: programme, name: "Upper A", session_type: "strength" });
    const p = x.t.insert("prescription", { template_id: upper, position: 1, exercise_id: s.bench, sets: 3, rep_low: 8, rep_high: 10, rir_target_low: 1, rir_target_high: 2 });
    const plates = JSON.stringify([{ value: 10, unit: "kg", count: 1 }]);
    const lc = { prescription_id: p, changed_on: MONDAY, load_value: 10, load_unit: "kg", reason: "x" };
    expect(x.t.insert("load_change", { ...lc, load_basis: "per_side", bar_value: 20, bar_unit: "kg", plates })).toBeGreaterThan(0);
    expect(() => x.t.insert("load_change", { ...lc, load_basis: "total", plates })).toThrow(/CHECK/);
    expect(() => x.t.insert("load_change", { ...lc, load_basis: "per_side", bar_value: 20 })).toThrow(/CHECK/);
    expect(() => x.t.insert("load_change", { ...lc, load_basis: "per_side", plates: "[]" })).toThrow(/CHECK/);
    expect(() => x.t.run("UPDATE prescription SET load_value = 10, load_unit = 'kg', load_basis = 'total', plates = ? WHERE id = ?", plates, p)).toThrow(/CHECK/);
  });
});
