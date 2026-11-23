import { describe, expect, it } from "vitest";
import { NOW, TestDb } from "./db";
import { exercise, gym, household, prescription, programme, session, set, template } from "./fixtures";

function setup() {
  const t = new TestDb();
  const h = household(t);
  t.run("UPDATE member SET week_anchor_date = '2026-07-26' WHERE id = ?", h.hritvik);
  const g = gym(t, h);
  const s = session(t, h.hritvik, g, { performed_on: "2026-10-05" });
  const e = exercise(t, h, { name: "Bench press", implement_kind: "barbell" });
  return { t, h, g, s, e };
}

const kg = (value: number) => ({ load_status: "entered", load_value: value, load_unit: "kg", load_basis: "total" });

describe("v_set", () => {
  it("computes the exact total load: a 20 kg bar plus 12.5 lb per side is 31.3398 kg, not 31.3", () => {
    const { t, s, e } = setup();
    const id = set(t, s, e, {
      reps: 8, load_status: "entered", load_value: 12.5, load_unit: "lb", load_basis: "per_side", bar_value: 20, bar_unit: "kg",
      rir_status: "recorded", rir_low: 0, rir_high: 0,
    });
    const row = t.get("SELECT total_load_kg, volume_kg, e1rm_kg FROM v_set WHERE id = ?", id)!;
    expect(row.total_load_kg).toBeCloseTo(31.33980925, 8);
    // The 12 Aug bench row: volume and e1RM from the same true load.
    expect(row.volume_kg).toBeCloseTo(250.718474, 6);
    expect(row.e1rm_kg).toBeCloseTo(39.6971, 4); // the whole bar (0021)
  });

  it("computes e1RM only at RIR 0 with 12 reps or fewer", () => {
    const { t, s, e } = setup();
    const rir = (low: number, high: number) => ({ rir_status: "recorded", rir_low: low, rir_high: high });
    const atZero = set(t, s, e, { ...kg(50), reps: 12, ...rir(0, 0) });
    const inReserve = set(t, s, e, { ...kg(50), reps: 10, ...rir(1, 2) });
    const tooMany = set(t, s, e, { ...kg(50), reps: 13, ...rir(0, 0) });
    const notRecorded = set(t, s, e, { ...kg(50), reps: 8, rir_status: "not_recorded" });
    const e1rm = (id: number) => t.get("SELECT e1rm_kg FROM v_set WHERE id = ?", id)!.e1rm_kg;
    expect(e1rm(atZero)).toBeCloseTo(70, 10);
    expect(e1rm(inReserve)).toBeNull();
    expect(e1rm(tooMany)).toBeNull();
    expect(e1rm(notRecorded)).toBeNull();
  });

  it("leaves volume and e1RM empty for assisted (negative) and bodyweight work", () => {
    const { t, s, e } = setup();
    const assisted = set(t, s, e, { ...kg(-25), reps: 8, rir_status: "recorded", rir_low: 0, rir_high: 0 });
    const bodyweight = set(t, s, e, { reps: 8 });
    expect(t.get("SELECT total_load_kg, volume_kg, e1rm_kg FROM v_set WHERE id = ?", assisted))
      .toEqual({ total_load_kg: -25, volume_kg: null, e1rm_kg: null });
    expect(t.get("SELECT total_load_kg, volume_kg FROM v_set WHERE id = ?", bodyweight))
      .toEqual({ total_load_kg: null, volume_kg: null });
  });

  it("doubles per-hand and per-leg loads, as the domain does, unless the set is unilateral", () => {
    const { t, s, e } = setup();
    const both = set(t, s, e, { load_status: "entered", load_value: 20, load_unit: "kg", load_basis: "per_hand", reps: 10 });
    const oneLeg = set(t, s, e, { load_status: "entered", load_value: 10, load_unit: "lb", load_basis: "per_leg", unilateral: 1, reps: 12 });
    expect(t.get("SELECT total_load_kg, volume_kg, unilateral FROM v_set WHERE id = ?", both)).toEqual({ total_load_kg: 40, volume_kg: 400, unilateral: 0 });
    expect(t.get("SELECT total_load_kg FROM v_set WHERE id = ?", oneLeg)!.total_load_kg).toBeCloseTo(4.5359237, 9);
  });

  it("allows unilateral only on a per-hand or per-leg load", () => {
    const { t, s, e } = setup();
    expect(() => set(t, s, e, { ...kg(20), unilateral: 1 })).toThrow(/CHECK/);
  });
});

describe("v_session", () => {
  it("sums volume over every set except warm-ups, and derives the week and phase", () => {
    const { t, h, s, e } = setup();
    t.insert("phase", {
      member_id: h.hritvik, name: "Base", starts_on: "2026-07-26", energy_stance: "maintenance", intent: "base",
    });
    set(t, s, e, { ...kg(20), reps: 10, set_type: "warm_up" });
    set(t, s, e, { ...kg(40), reps: 8 });
    set(t, s, e, { ...kg(40), reps: 7 });
    set(t, s, e, { reps: 10 });
    set(t, s, e, { load_status: "entered", load_value: 10, load_unit: "kg", load_basis: "per_hand", reps: 10 });
    const row = t.get("SELECT volume_kg, set_count, sets_load_uncomputed, week, phase_name FROM v_session WHERE id = ?", s);
    expect(row).toEqual({ volume_kg: 800, set_count: 5, sets_load_uncomputed: 0, week: 11, phase_name: "Base" });
  });
});

describe("v_prescription", () => {
  it("gives the current load as the latest load change, or the starting load", () => {
    const { t, h, e } = setup();
    const tpl = template(t, programme(t, h.hritvik));
    const p = prescription(t, tpl, e, { load_value: 30, load_unit: "kg", load_basis: "total" });
    const q = prescription(t, tpl, e, { load_value: 10, load_unit: "kg", load_basis: "total" });
    const change = { prescription_id: p, load_unit: "kg", load_basis: "total", reason: "rule fired" };
    t.insert("load_change", { ...change, changed_on: "2026-09-20", load_value: 32.5 });
    t.insert("load_change", { ...change, changed_on: "2026-10-01", load_value: 35 });
    expect(t.get("SELECT current_load_value, current_load_unit FROM v_prescription WHERE id = ?", p))
      .toEqual({ current_load_value: 35, current_load_unit: "kg" });
    expect(t.get("SELECT current_load_value FROM v_prescription WHERE id = ?", q)).toEqual({ current_load_value: 10 });
  });
});

describe("v_cardio_block", () => {
  it("derives pace in minutes per km from duration and distance", () => {
    const { t, h } = setup();
    const c = session(t, h.hritvik, null, { session_type: "cardio", state: "confirmed", confirmed_at: NOW });
    const km = t.insert("cardio_block", { session_id: c, position: 1, kind: "steady", duration_s: 1200, distance_value: 1.8, distance_unit: "km" });
    const m = t.insert("cardio_block", { session_id: c, position: 2, kind: "interval", duration_s: 300, distance_value: 1000, distance_unit: "m" });
    const none = t.insert("cardio_block", { session_id: c, position: 3, kind: "steady", duration_s: 300 });
    const pace = (id: number) => t.get("SELECT pace_min_per_km FROM v_cardio_block WHERE id = ?", id)!.pace_min_per_km;
    expect(pace(km)).toBeCloseTo(11.1111, 4);
    expect(pace(m)).toBeCloseTo(5, 10);
    expect(pace(none)).toBeNull();
  });
});
