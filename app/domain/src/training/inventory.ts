import type { Implement, ListedLoad, LoadAmount, LoadUnit, PlateGroup, ProducibleLoad, SnapResult } from "../types";
import { toKg } from "./load";
import { readNativeLoad } from "./native";

/** Loads equal within this (in kg) are the same load (float noise from unit conversion). */
const SAME_LOAD = 1e-6;
/** Plate arithmetic runs in steps of this, in a plate's own unit (1.25 kg and 2.5 lb plates both fit). */
const QUANTUM = 0.05;
/** How far above a value plate combinations are worked out by default, per side in kg. */
const DEFAULT_PLATE_CAP_KG = 100;
/** A sleeve holds only so many plates: combinations needing more per side are not producible. */
export const MAX_PLATES_PER_SIDE = 8;

export function sameLoad(a: number, b: number): boolean {
  return Math.abs(a - b) <= SAME_LOAD;
}

export function amountKg(a: LoadAmount): number {
  return toKg(a.value, a.unit);
}

/** The per-side load of a composition, in kg. */
export function platesKg(plates: readonly PlateGroup[]): number {
  return plates.reduce((sum, p) => sum + p.count * amountKg(p), 0);
}

/** A composition as one value: in its unit when the plates share one, else in kg. */
export function compositionAmount(plates: readonly PlateGroup[]): LoadAmount {
  const units = new Set(plates.map((p) => p.unit));
  if (units.size === 1) {
    const unit = plates[0]?.unit as LoadUnit;
    return { value: round9(plates.reduce((s, p) => s + p.count * p.value, 0)), unit };
  }
  return { value: platesKg(plates), unit: "kg" };
}

function round9(x: number): number {
  return Math.round(x * 1e9) / 1e9;
}

function isAbsent(a: LoadAmount, absent: readonly LoadAmount[] | undefined): boolean {
  return (absent ?? []).some((x) => x.unit === a.unit && Math.abs(x.value - a.value) < 1e-9);
}

/** Whether the implement has any inventory to check loads against. */
export function hasInventory(implement: Implement): boolean {
  if (implement.plates) return implement.plates.available.length > 0;
  return (implement.loads ?? []).length > 0;
}

/**
 * Every per-side amount one unit's plates make, with the fewest plates for
 * each, up to `cap` in that unit. Index = amount / QUANTUM.
 */
function amountsOf(denominations: number[], cap: number): { value: number; plates: PlateGroup[]; count: number }[] {
  const steps = denominations.map((d) => Math.round(d / QUANTUM)).filter((d) => d > 0);
  const n = Math.floor(cap / QUANTUM + 1e-9);
  const best: ({ count: number; plate: number } | null)[] = new Array(n + 1).fill(null);
  best[0] = { count: 0, plate: 0 };
  const heaviestFirst = [...new Set(steps)].sort((a, b) => b - a);
  for (let i = 1; i <= n; i++) {
    for (const d of heaviestFirst) {
      const prev = i - d >= 0 ? best[i - d] : null;
      if (prev && (best[i] === null || prev.count + 1 < (best[i] as { count: number }).count)) best[i] = { count: prev.count + 1, plate: d };
    }
  }
  const out: { value: number; plates: PlateGroup[]; count: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const b = best[i];
    if (!b) continue;
    const counts = new Map<number, number>();
    for (let j = i; j > 0; ) {
      const step = (best[j] as { plate: number }).plate;
      counts.set(step, (counts.get(step) ?? 0) + 1);
      j -= step;
    }
    const plates = [...counts.entries()].sort((a, c) => c[0] - a[0]).map(([d, count]) => ({ value: round9(d * QUANTUM), unit: "kg" as LoadUnit, count }));
    out.push({ value: round9(i * QUANTUM), plates, count: b.count });
  }
  return out;
}

/** Every symmetric per-side combination of the plates, up to `capKg` per side, lightest first. */
function plateCombinations(implement: Implement, capKg: number): ProducibleLoad[] {
  const inv = implement.plates;
  if (!inv) return [];
  const usable = inv.available.filter((p) => p.value > 0 && !isAbsent(p, inv.absent));
  const byUnit = (unit: LoadUnit) => {
    const denominations = usable.filter((p) => p.unit === unit).map((p) => p.value);
    if (denominations.length === 0) return [{ value: 0, plates: [] as PlateGroup[], count: 0 }];
    const cap = unit === "kg" ? capKg : capKg / toKg(1, "lb");
    return amountsOf(denominations, cap).map((a) => ({ ...a, plates: a.plates.map((p) => ({ ...p, unit })) }));
  };
  const kg = byUnit("kg");
  const lb = byUnit("lb");
  const found: (ProducibleLoad & { count: number })[] = [];
  for (const a of kg) {
    for (const b of lb) {
      const total = a.value + toKg(b.value, "lb");
      if (total > capKg + SAME_LOAD) continue;
      const plates = [...a.plates, ...b.plates];
      const count = a.count + b.count;
      if (count > MAX_PLATES_PER_SIDE) continue;
      let load: ProducibleLoad;
      if (b.count === 0) load = { value: a.value, unit: a.count === 0 ? implement.unit : "kg", kg: total, plates };
      else if (a.count === 0) load = { value: b.value, unit: "lb", kg: total, plates };
      else load = { value: total, unit: "kg", kg: total, plates };
      found.push({ ...load, count });
    }
  }
  found.sort((x, y) => x.kg - y.kg || x.count - y.count);
  const out: ProducibleLoad[] = [];
  for (const f of found) {
    const last = out[out.length - 1];
    if (last && sameLoad(last.kg, f.kg)) continue;
    const { count: _count, ...load } = f;
    out.push(load);
  }
  return out;
}

/**
 * The implement's producible loads, lightest first, each in its native
 * unit: its explicit list (less any known to be absent), or for plate-loaded
 * kit every per-side combination of the gym's plates up to `upToKg`.
 * Empty when it has no inventory.
 */
export function producibleLoads(implement: Implement, options: { upToKg?: number } = {}): ProducibleLoad[] {
  if (implement.plates) return plateCombinations(implement, options.upToKg ?? DEFAULT_PLATE_CAP_KG);
  return (implement.loads ?? [])
    .map((l): LoadAmount => (typeof l === "number" ? { value: l, unit: implement.unit } : l))
    .filter((l) => !isAbsent(l, implement.absent))
    .map((l) => ({ ...l, kg: amountKg(l) }))
    .sort((a, b) => a.kg - b.kg);
}

/** Whether loads above what is known may exist: an unknown list top, or plates not all known. */
export function inventoryOpen(implement: Implement): boolean {
  return implement.plates ? !implement.plates.complete : implement.maxUnknown === true;
}

export function listed(l: ProducibleLoad): ListedLoad {
  return l.plates === undefined ? { value: l.value, unit: l.unit } : { value: l.value, unit: l.unit, plates: l.plates };
}

/**
 * Check an entered load against an implement's producible loads. A single
 * value is first read in its native unit (9.07 kg is the 20 lb dumbbell); a
 * composition (plates per side) is its plates' sum. The logged value is
 * never changed: off the list it comes back with its neighbours so the
 * draft can offer the nearest load or offer to add it, and `mayExist` says
 * the inventory isn't fully known. Ties for nearest go to the lighter load.
 */
export function snapToImplement(value: number, unit: LoadUnit, implement: Implement, plates?: readonly PlateGroup[]): SnapResult {
  let entered: LoadAmount;
  if (plates && plates.length > 0) entered = compositionAmount(plates);
  else {
    const native = readNativeLoad(value, unit);
    entered = native.status === "clean" ? { value: native.value, unit: native.unit } : { value, unit };
  }
  if (!hasInventory(implement)) return { status: "no_inventory", ...entered };
  const kg = plates && plates.length > 0 ? platesKg(plates) : amountKg(entered);
  const loads = producibleLoads(implement, { upToKg: Math.max(Math.abs(kg) * 1.5, Math.abs(kg) + 25) });
  const match = loads.find((l) => sameLoad(l.kg, kg));
  if (match) return { status: "on_list", ...listed(match) };

  const below = [...loads].reverse().find((l) => l.kg < kg) ?? null;
  const above = loads.find((l) => l.kg > kg) ?? null;
  let nearest: ProducibleLoad;
  if (below === null) nearest = above as ProducibleLoad;
  else if (above === null) nearest = below;
  else nearest = kg - below.kg <= above.kg - kg ? below : above;
  const top = loads[loads.length - 1];
  const mayExist = implement.plates ? !implement.plates.complete : implement.maxUnknown === true && top !== undefined && kg > top.kg;
  const composition = plates && plates.length > 0 ? { plates: [...plates] } : {};
  return {
    status: "off_list",
    ...entered,
    ...composition,
    below: below && listed(below),
    above: above && listed(above),
    nearest: listed(nearest),
    mayExist,
  };
}
