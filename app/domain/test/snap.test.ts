import { describe, expect, it } from "vitest";
import { producibleLoads, snapToImplement } from "../src/index";
import type { Implement } from "../src/index";

// Leg curl stack: irregular, which is why there are no start/step formulas.
const LEG_CURL: Implement = { id: "leg-curl", unit: "kg", loads: [5, 10, 14, 18, 23, 27, 32, 36] };
const LB_DUMBBELLS: Implement = { id: "db-lb", unit: "lb", loads: [5, 7.5, 10, 12.5, 15] };

describe("snapToImplement: a load against an implement's producible loads", () => {
  it("a load on the list is accepted as is", () => {
    expect(snapToImplement(23, "kg", LEG_CURL)).toEqual({ status: "on_list", value: 23, unit: "kg" });
  });

  it("a load off the list is flagged with its neighbours, never silently changed", () => {
    expect(snapToImplement(25, "kg", LEG_CURL)).toEqual({
      status: "off_list",
      value: 25,
      unit: "kg",
      below: { value: 23, unit: "kg" },
      above: { value: 27, unit: "kg" },
      nearest: { value: 23, unit: "kg" },
      mayExist: false,
    });
  });

  it("off the top of the list has no load above", () => {
    expect(snapToImplement(40, "kg", LEG_CURL)).toMatchObject({
      status: "off_list",
      below: { value: 36, unit: "kg" },
      above: null,
      nearest: { value: 36, unit: "kg" },
      mayExist: false,
    });
  });

  it("above the top of a list whose top is unknown, the load may exist", () => {
    expect(snapToImplement(40, "kg", { ...LEG_CURL, maxUnknown: true })).toMatchObject({ status: "off_list", mayExist: true });
  });

  it("reads a pound load written in kg as the pound load it is", () => {
    // A legacy 3.4 kg reading is the 7.5 lb dumbbell.
    expect(snapToImplement(3.4, "kg", LB_DUMBBELLS)).toEqual({ status: "on_list", value: 7.5, unit: "lb" });
  });

  it("a value that converts to a listed load within float noise is on the list", () => {
    expect(snapToImplement(12.5 * 0.45359237, "kg", LB_DUMBBELLS)).toEqual({ status: "on_list", value: 12.5, unit: "lb" });
  });

  it("an implement without an inventory logs loads as entered", () => {
    expect(snapToImplement(31, "kg", { id: "other-gym", unit: "kg" })).toEqual({ status: "no_inventory", value: 31, unit: "kg" });
    expect(snapToImplement(31, "kg", { id: "other-gym", unit: "kg", loads: [] })).toEqual({ status: "no_inventory", value: 31, unit: "kg" });
  });
});

describe("a load list may mix kg and lb, each load in its native unit", () => {
  // A stack with a 15 kg starter weight, then pound plates.
  const MIXED: Implement = { id: "stack", unit: "lb", loads: [{ value: 15, unit: "kg" }, 40, 50, { value: 60, unit: "lb" }] };

  it("lists the loads in order of what they weigh, each in its own unit", () => {
    expect(producibleLoads(MIXED).map(({ value, unit }) => `${value} ${unit}`)).toEqual(["15 kg", "40 lb", "50 lb", "60 lb"]);
  });

  it("snaps across units", () => {
    expect(snapToImplement(33.07, "lb", MIXED)).toEqual({ status: "on_list", value: 15, unit: "kg" });
    expect(snapToImplement(18.14, "kg", MIXED)).toEqual({ status: "on_list", value: 40, unit: "lb" });
    expect(snapToImplement(21, "kg", MIXED)).toMatchObject({
      status: "off_list",
      below: { value: 40, unit: "lb" },
      above: { value: 50, unit: "lb" },
    });
  });

  it("leaves out loads known not to exist", () => {
    const rack: Implement = { id: "db", unit: "kg", loads: [6, 8, 10, 12], absent: [{ value: 12, unit: "kg" }] };
    expect(producibleLoads(rack).map((l) => l.value)).toEqual([6, 8, 10]);
  });
});

describe("plate-loaded kit: producible loads are combinations of the gym's plates", () => {
  // Pound plates and a few kilo plates; loads are plates per side.
  const SLED: Implement = {
    id: "sled",
    unit: "kg",
    kind: "plate_loaded",
    plates: { available: [{ value: 20, unit: "kg" }, { value: 5, unit: "lb" }, { value: 10, unit: "lb" }], complete: true },
  };

  it("derives symmetric per-side combinations, mixed units allowed", () => {
    const loads = producibleLoads(SLED, { upToKg: 30 });
    const labels = loads.map((l) => (l.plates ?? []).map((p) => `${p.count}x${p.value}${p.unit}`).join("+"));
    expect(labels.slice(0, 4)).toEqual(["", "1x5lb", "1x10lb", "1x10lb+1x5lb"]);
    expect(labels).toContain("1x20kg+1x5lb");
    expect(loads.every((l, i) => i === 0 || l.kg > (loads[i - 1] as { kg: number }).kg)).toBe(true);
  });

  it("a single-unit combination reads as a value in that unit", () => {
    const fifteen = producibleLoads(SLED, { upToKg: 10 }).find((l) => Math.abs(l.kg - 15 * 0.45359237) < 1e-9);
    expect(fifteen).toMatchObject({ value: 15, unit: "lb" });
  });

  it("a mixed combination carries its plates", () => {
    const mixed = producibleLoads(SLED, { upToKg: 28 }).find((l) => Math.abs(l.kg - (20 + 5 * 0.45359237)) < 1e-9);
    expect(mixed).toMatchObject({ unit: "kg", plates: [{ value: 20, unit: "kg", count: 1 }, { value: 5, unit: "lb", count: 1 }] });
  });

  it("snaps a per-side value, or a composition, onto a combination", () => {
    expect(snapToImplement(31.75, "kg", SLED)).toMatchObject({ status: "on_list", value: 70, unit: "lb" });
    const composed = snapToImplement(0, "kg", SLED, [
      { value: 20, unit: "kg", count: 1 },
      { value: 5, unit: "lb", count: 1 },
    ]);
    expect(composed).toMatchObject({ status: "on_list", plates: [{ value: 20, unit: "kg", count: 1 }, { value: 5, unit: "lb", count: 1 }] });
  });

  it("a load no combination makes is off the list; with plates unknown it may still exist", () => {
    expect(snapToImplement(1, "kg", SLED)).toMatchObject({ status: "off_list", mayExist: false });
    expect(snapToImplement(1, "kg", { ...SLED, plates: { ...(SLED.plates as NonNullable<Implement["plates"]>), complete: false } })).toMatchObject({
      status: "off_list",
      mayExist: true,
    });
  });
});
