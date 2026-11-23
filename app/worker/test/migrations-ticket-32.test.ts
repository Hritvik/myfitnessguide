// Migrations 0025-0027 go onto a live database that already holds data.
// They only add nullable columns and recreate views, so every row must
// come through unchanged, with the new columns NULL, and the views still
// read it.
import { describe, expect, it } from "vitest";
import { NOW, TestDb } from "./db";
import { exercise, household, prescription, programme, template, writeLog } from "./fixtures";

function populated() {
  const t = new TestDb({ through: "0024" });
  const h = household(t);
  const w = writeLog(t, { resolver: "member", origin: "app", actor_member_id: h.asha });
  const cook = t.insert("cook", { household_id: h.id, cooked_on: "2026-10-05", name: "Pot", state: "confirmed", confirmed_at: NOW });
  const component = t.insert("component", { cook_id: cook, position: 1, name: "whole" });
  const portion = t.insert("portion", { component_id: component, member_id: h.hritvik, kind: "fraction", fraction: 0.4, provenance: "estimated", state: "draft" });
  t.insert("intake_item", { member_id: h.hritvik, eaten_on: "2026-10-05", meal_slot: "lunch", source_kind: "portion", portion_id: portion, confidence: "medium", state: "draft" });
  t.insert("intake_item", {
    member_id: h.hritvik, eaten_on: "2026-10-05", meal_slot: "snack", source_kind: "manual", manual_kcal: 200, manual_protein_g: 5, manual_carbs_g: 30, manual_fat_g: 6,
    manual_reason: "a snack", provenance: "estimated", confidence: "low", dominant_uncertainty: "size", dominant_uncertainty_kcal: 50, state: "confirmed", confirmed_at: NOW,
  });
  const p = prescription(t, template(t, programme(t, h.hritvik)), exercise(t, h), { load_value: 40, load_unit: "kg", load_basis: "total" });
  t.insert("load_change", { prescription_id: p, changed_on: "2026-10-01", load_value: 45, load_unit: "kg", load_basis: "total", reason: "progressed" });
  return { t, h, w, portion, p };
}

const snapshot = (t: TestDb) => ({
  write_log: t.all("SELECT id, at, resolver, actor_member_id, origin, tool, reason FROM write_log ORDER BY id"),
  portion: t.all("SELECT id, component_id, member_id, kind, fraction, provenance, state FROM portion ORDER BY id"),
  // 0029 adds intake_item.leftover_serving_id (NULL on every existing row; migration-0029.test.ts pins it): compare the columns before it.
  intake_item: t.all("SELECT * FROM intake_item ORDER BY id").map(({ leftover_serving_id: _l, ...r }) => r),
  prescription: t.all("SELECT id, load_value, load_unit, load_basis FROM prescription ORDER BY id"),
  load_change: t.all("SELECT id, prescription_id, load_value, load_unit, load_basis, reason FROM load_change ORDER BY id"),
  day: t.all("SELECT * FROM v_day_intake ORDER BY member_id, day"),
});

describe("migrations 0025-0027 on a database holding data", () => {
  it("keep every row, add the new columns empty, and the views still read the data", () => {
    const { t, w, portion, p } = populated();
    const before = snapshot(t);
    t.migrateAfter("0024");
    expect(snapshot(t)).toEqual(before);
    expect(t.get("SELECT speaker_member_id FROM write_log WHERE id = ?", w)).toEqual({ speaker_member_id: null });
    expect(t.get("SELECT dominant_uncertainty, dominant_uncertainty_kcal FROM portion WHERE id = ?", portion)).toEqual({ dominant_uncertainty: null, dominant_uncertainty_kcal: null });
    expect(t.get("SELECT current_load_value, current_bar_value, current_plates FROM v_prescription WHERE id = ?", p)).toEqual({ current_load_value: 45, current_bar_value: null, current_plates: null });
    expect(t.all("SELECT source_kind, dominant_uncertainty_kcal FROM v_intake_item ORDER BY id")).toEqual([
      { source_kind: "portion", dominant_uncertainty_kcal: null },
      { source_kind: "manual", dominant_uncertainty_kcal: 50 },
    ]);
    expect(t.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(t.get("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
  });
});
