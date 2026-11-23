import { describe, expect, it } from "vitest";
import { NOW, TestDb } from "./db";
import { exercise, gym, household, implement, prescription, programme, session, set, template } from "./fixtures";

function setup() {
  const t = new TestDb();
  const h = household(t);
  const g = gym(t, h);
  const s = session(t, h.hritvik, g);
  const e = exercise(t, h);
  return { t, h, g, s, e };
}

describe("sessions", () => {
  it("are strength, cardio or class, and a strength session needs a gym", () => {
    const { t, h, g } = setup();
    expect(() => session(t, h.hritvik, g, { session_type: "yoga" })).toThrow(/CHECK/);
    expect(() => session(t, h.hritvik, null, { session_type: "strength" })).toThrow(/CHECK/);
    expect(session(t, h.hritvik, null, { session_type: "class", energy_kcal: 350 })).toBeGreaterThan(0);
  });

  it("are draft until confirmed, and a confirmed session carries its confirmation time", () => {
    const { t, h, g } = setup();
    expect(() => session(t, h.hritvik, g, { state: "saved" })).toThrow(/CHECK/);
    expect(() => session(t, h.hritvik, g, { state: "confirmed" })).toThrow(/CHECK/);
    expect(() => session(t, h.hritvik, g, { state: "draft", confirmed_at: NOW })).toThrow(/CHECK/);
    expect(session(t, h.hritvik, g, { state: "confirmed", confirmed_at: NOW })).toBeGreaterThan(0);
  });

  it("cannot end before it starts", () => {
    const { t, h, g } = setup();
    expect(() =>
      session(t, h.hritvik, g, { started_at: "2026-10-05T08:00:00Z", ended_at: "2026-10-05T07:00:00Z" }),
    ).toThrow(/CHECK/);
  });
});

describe("sets", () => {
  it("store the load as entered: value, unit, basis, implement and bar", () => {
    const { t, h, g, s, e } = setup();
    const plates = implement(t, g, { name: "Plates", kind: "plates", unit: "lb", loading: "per_side" });
    const id = set(t, s, e, {
      load_status: "entered", load_value: 12.5, load_unit: "lb", load_basis: "per_side", load_implement_id: plates,
      bar_value: 20, bar_unit: "kg",
    });
    expect(t.get("SELECT load_value, load_unit, load_basis, bar_value, bar_unit FROM session_set WHERE id = ?", id))
      .toEqual({ load_value: 12.5, load_unit: "lb", load_basis: "per_side", bar_value: 20, bar_unit: "kg" });
    expect(h.hritvik).toBeGreaterThan(0);
  });

  it("reject a bare load number without its unit and basis", () => {
    const { t, s, e } = setup();
    expect(() => set(t, s, e, { load_status: "entered", load_value: 35 })).toThrow(/CHECK/);
    expect(() => set(t, s, e, { load_status: "entered", load_value: 35, load_unit: "kg" })).toThrow(/CHECK/);
    expect(() => set(t, s, e, { load_status: "entered", load_value: 35, load_unit: "KG", load_basis: "total" })).toThrow(/CHECK/);
    expect(() => set(t, s, e, { load_status: "entered", load_value: "35 kg", load_unit: "kg", load_basis: "total" }))
      .toThrow(/cannot store TEXT value in REAL column/);
  });

  it("keep no load, not recorded and an entered zero distinct", () => {
    const { t, s, e } = setup();
    expect(set(t, s, e, { load_status: "none" })).toBeGreaterThan(0);
    expect(set(t, s, e, { load_status: "not_recorded" })).toBeGreaterThan(0);
    expect(set(t, s, e, { load_status: "entered", load_value: 0, load_unit: "kg", load_basis: "total" })).toBeGreaterThan(0);
    expect(() => set(t, s, e, { load_status: "none", load_value: 0, load_unit: "kg", load_basis: "total" })).toThrow(/CHECK/);
    expect(() => set(t, s, e, { load_status: "entered" })).toThrow(/CHECK/);
    expect(() => set(t, s, e, { load_status: "blank" })).toThrow(/CHECK/);
  });

  it("allow a bar only with a per-side load", () => {
    const { t, s, e } = setup();
    expect(() =>
      set(t, s, e, { load_status: "entered", load_value: 30, load_unit: "kg", load_basis: "total", bar_value: 20, bar_unit: "kg" }),
    ).toThrow(/CHECK/);
    expect(() =>
      set(t, s, e, { load_status: "entered", load_value: 10, load_unit: "kg", load_basis: "per_side", bar_value: 20 }),
    ).toThrow(/CHECK/);
  });

  it("store assisted work as a negative load", () => {
    const { t, s, e } = setup();
    expect(set(t, s, e, { load_status: "entered", load_value: -25, load_unit: "kg", load_basis: "total" })).toBeGreaterThan(0);
  });

  it("store RIR as a range within 0-10", () => {
    const { t, s, e } = setup();
    expect(set(t, s, e, { rir_status: "recorded", rir_low: 1, rir_high: 2 })).toBeGreaterThan(0);
    expect(() => set(t, s, e, { rir_status: "recorded", rir_low: 2, rir_high: 1 })).toThrow(/CHECK/);
    expect(() => set(t, s, e, { rir_status: "recorded", rir_low: 9, rir_high: 11 })).toThrow(/CHECK/);
    expect(() => set(t, s, e, { rir_status: "recorded", rir_low: -1, rir_high: 0 })).toThrow(/CHECK/);
    expect(() => set(t, s, e, { rir_status: "recorded", rir_low: 1 })).toThrow(/CHECK/);
  });

  it("keep blank RIR (draft only) and not recorded RIR distinct", () => {
    const { t, s, e } = setup();
    expect(set(t, s, e, { rir_status: null })).toBeGreaterThan(0);
    expect(set(t, s, e, { rir_status: "not_recorded", state: "confirmed", confirmed_at: NOW })).toBeGreaterThan(0);
    expect(() => set(t, s, e, { rir_status: "not_recorded", rir_low: 1, rir_high: 1 })).toThrow(/CHECK/);
    expect(() => set(t, s, e, { rir_status: null, state: "confirmed", confirmed_at: NOW })).toThrow(/CHECK/);
    expect(() => set(t, s, e, { rir_status: "unknown" })).toThrow(/CHECK/);
  });

  it("have a known set type, and a substitution names the prescription it replaced", () => {
    const { t, h, s, e } = setup();
    const p = prescription(t, template(t, programme(t, h.hritvik)), e);
    expect(() => set(t, s, e, { set_type: "drop" })).toThrow(/CHECK/);
    expect(() => set(t, s, e, { set_type: "substitution" })).toThrow(/CHECK/);
    expect(() => set(t, s, e, { set_type: "working", substituted_prescription_id: p })).toThrow(/CHECK/);
    expect(set(t, s, e, { set_type: "substitution", substituted_prescription_id: p })).toBeGreaterThan(0);
    for (const kind of ["warm_up", "working", "back_off", "calibration"]) expect(set(t, s, e, { set_type: kind })).toBeGreaterThan(0);
  });

  it("record reps, a duration or a distance, with steps kept apart from metres", () => {
    const { t, s, e } = setup();
    expect(() => set(t, s, e, { reps: null })).toThrow(/CHECK/);
    expect(set(t, s, e, { reps: null, duration_s: 45 })).toBeGreaterThan(0);
    expect(set(t, s, e, { reps: null, distance_value: 40, distance_unit: "m" })).toBeGreaterThan(0);
    expect(set(t, s, e, { reps: null, steps: 60 })).toBeGreaterThan(0);
    expect(() => set(t, s, e, { reps: null, distance_value: 40 })).toThrow(/CHECK/);
    expect(() => set(t, s, e, { reps: null, distance_value: 40, distance_unit: "steps" })).toThrow(/CHECK/);
    expect(() => set(t, s, e, { reps: -1 })).toThrow(/CHECK/);
  });

  it("number sets uniquely per exercise within a session", () => {
    const { t, s, e } = setup();
    set(t, s, e, { set_number: 1 });
    expect(() => set(t, s, e, { set_number: 1 })).toThrow(/UNIQUE/);
  });
});

describe("cardio blocks", () => {
  it("hold duration, speed, incline, distance and heart rate, with typed units", () => {
    const { t, h } = setup();
    const c = session(t, h.hritvik, null, { session_type: "cardio" });
    const block = {
      session_id: c, position: 1, kind: "steady", activity: "treadmill walk", duration_s: 1200, speed_value: 5.5,
      speed_unit: "km/h", incline_pct: 8, distance_value: 1.8, distance_unit: "km", avg_hr: 128, max_hr: 141,
      hr_device: "chest strap", rpe: 4, conversational: 1,
    };
    expect(t.insert("cardio_block", block)).toBeGreaterThan(0);
    expect(() => t.insert("cardio_block", { ...block, position: 2, speed_unit: null })).toThrow(/CHECK/);
    expect(() => t.insert("cardio_block", { ...block, position: 2, distance_unit: "steps" })).toThrow(/CHECK/);
    expect(() => t.insert("cardio_block", { ...block, position: 2, avg_hr: 150, max_hr: 141 })).toThrow(/CHECK/);
    expect(() => t.insert("cardio_block", { ...block, position: 2, rpe: 11 })).toThrow(/CHECK/);
    expect(() => t.insert("cardio_block", { ...block, position: 2, kind: "jog" })).toThrow(/CHECK/);
    expect(() => t.insert("cardio_block", { ...block, position: 2, conversational: 2 })).toThrow(/CHECK/);
    expect(() => t.insert("cardio_block", block)).toThrow(/UNIQUE/);
  });

  it("never store pace", () => {
    const { t } = setup();
    const cols = t.all("SELECT name FROM pragma_table_info('cardio_block')").map((r) => r.name);
    expect(cols.some((c) => String(c).includes("pace"))).toBe(false);
  });
});
