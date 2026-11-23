import { describe, expect, it } from "vitest";
import { TestDb } from "./db";
import { exercise, household, prescription, programme, template } from "./fixtures";

const RULE = JSON.stringify({ kind: "rep_top", target_sets: 3, rep_top: 12, rir_floor: 1 });

describe("programmes and schedules", () => {
  it("a weekday programme maps weekdays to templates, with one-off swaps", () => {
    const t = new TestDb();
    const h = household(t);
    const p = programme(t, h.hritvik, { schedule_kind: "weekday" });
    const upper = template(t, p, { name: "Upper A" });
    const dance = template(t, p, { name: "Dance", session_type: "class" });
    t.insert("schedule_slot", { programme_id: p, weekday: 1, template_id: upper });
    t.insert("schedule_slot", { programme_id: p, weekday: 6, template_id: dance });
    expect(() => t.insert("schedule_slot", { programme_id: p, weekday: 1, template_id: dance })).toThrow(/UNIQUE/);
    expect(() => t.insert("schedule_slot", { programme_id: p, weekday: 8, template_id: dance })).toThrow(/CHECK/);
    t.insert("schedule_swap", { programme_id: p, on_date: "2026-10-06", template_id: dance, reason: "gym closed" });
    expect(t.insert("schedule_swap", { programme_id: p, on_date: "2026-10-07", template_id: null, reason: "rest" }))
      .toBeGreaterThan(0);
  });

  it("a schedule slot is a weekday or a rotation position, never both or neither", () => {
    const t = new TestDb();
    const h = household(t);
    const p = programme(t, h.hritvik, { schedule_kind: "rotation" });
    const a = template(t, p);
    expect(() => t.insert("schedule_slot", { programme_id: p, template_id: a })).toThrow(/CHECK/);
    expect(() => t.insert("schedule_slot", { programme_id: p, weekday: 2, rotation_position: 1, template_id: a }))
      .toThrow(/CHECK/);
    expect(t.insert("schedule_slot", { programme_id: p, rotation_position: 1, template_id: a })).toBeGreaterThan(0);
  });

  it("rejects an unknown schedule kind and a second active programme", () => {
    const t = new TestDb();
    const h = household(t);
    expect(() => programme(t, h.hritvik, { schedule_kind: "random" })).toThrow(/CHECK/);
    programme(t, h.hritvik);
    expect(() => programme(t, h.hritvik)).toThrow(/UNIQUE/);
    expect(programme(t, h.hritvik, { active: 0 })).toBeGreaterThan(0);
  });
});

describe("prescriptions", () => {
  it("are ordered within a template and hold a structured progression rule", () => {
    const t = new TestDb();
    const h = household(t);
    const tpl = template(t, programme(t, h.hritvik));
    const e = exercise(t, h);
    prescription(t, tpl, e, { position: 1, progression_rule: RULE });
    expect(() => prescription(t, tpl, e, { position: 1 })).toThrow(/UNIQUE/);
    expect(() => prescription(t, tpl, e, { position: 0 })).toThrow(/CHECK/);
  });

  it("rejects a progression rule that is not structured data", () => {
    const t = new TestDb();
    const h = household(t);
    const tpl = template(t, programme(t, h.hritvik));
    const e = exercise(t, h);
    expect(() => prescription(t, tpl, e, { progression_rule: "add 2.5 kg when easy" })).toThrow(/CHECK/);
    expect(() => prescription(t, tpl, e, { progression_rule: '{"kind":"vibes"}' })).toThrow(/CHECK/);
    expect(() =>
      prescription(t, tpl, e, { progression_rule: '{"kind":"rep_top","target_sets":"three","rep_top":12,"rir_floor":1}' }),
    ).toThrow(/CHECK/);
    const withBranch = JSON.stringify({
      kind: "rep_top", target_sets: 3, rep_top: 10, rir_floor: 1, autoregulation: { if_rir_below: 1, then: "hold" },
    });
    expect(prescription(t, tpl, e, { progression_rule: withBranch })).toBeGreaterThan(0);
  });

  it("rejects an inverted rep range or an RIR target outside 0-10", () => {
    const t = new TestDb();
    const h = household(t);
    const tpl = template(t, programme(t, h.hritvik));
    const e = exercise(t, h);
    expect(() => prescription(t, tpl, e, { rep_low: 12, rep_high: 8 })).toThrow(/CHECK/);
    expect(() => prescription(t, tpl, e, { rir_target_low: 1, rir_target_high: 11 })).toThrow(/CHECK/);
    expect(() => prescription(t, tpl, e, { rir_target_low: -1, rir_target_high: 2 })).toThrow(/CHECK/);
  });

  it("rejects a bare load number without a unit and basis", () => {
    const t = new TestDb();
    const h = household(t);
    const tpl = template(t, programme(t, h.hritvik));
    const e = exercise(t, h);
    expect(() => prescription(t, tpl, e, { load_value: 35 })).toThrow(/CHECK/);
    expect(() => prescription(t, tpl, e, { load_value: 35, load_unit: "kg" })).toThrow(/CHECK/);
    expect(() => prescription(t, tpl, e, { load_value: 35, load_unit: "kgs", load_basis: "total" })).toThrow(/CHECK/);
    expect(prescription(t, tpl, e, { load_value: 35, load_unit: "kg", load_basis: "total" })).toBeGreaterThan(0);
  });

  it("lists ranked fallbacks, and records load changes with a reason", () => {
    const t = new TestDb();
    const h = household(t);
    const tpl = template(t, programme(t, h.hritvik));
    const e = exercise(t, h);
    const alt = exercise(t, h);
    const p = prescription(t, tpl, e, { load_value: 30, load_unit: "kg", load_basis: "total" });
    t.insert("prescription_fallback", { prescription_id: p, exercise_id: alt, rank: 1 });
    expect(() => t.insert("prescription_fallback", { prescription_id: p, exercise_id: alt, rank: 2 })).toThrow(/UNIQUE/);
    const change = { prescription_id: p, changed_on: "2026-10-01", load_value: 32.5, load_unit: "kg", load_basis: "total" };
    expect(() => t.insert("load_change", { ...change, reason: "" })).toThrow(/CHECK/);
    expect(t.insert("load_change", { ...change, reason: "3x12 at RIR 2" })).toBeGreaterThan(0);
  });
});

describe("phases", () => {
  it("are dated periods with an energy stance and an intent", () => {
    const t = new TestDb();
    const h = household(t);
    const base = { member_id: h.hritvik, name: "Base", starts_on: "2026-07-26", intent: "build the habit" };
    expect(t.insert("phase", { ...base, energy_stance: "maintenance" })).toBeGreaterThan(0);
    expect(() => t.insert("phase", { ...base, energy_stance: "bulk-ish" })).toThrow(/CHECK/);
    expect(() => t.insert("phase", { ...base, energy_stance: "deficit", ends_on: "2026-07-01" })).toThrow(/CHECK/);
  });
});
