/**
 * The plate builder (spec §5): one side's plates from the gym's known
 * plates, kg and lb mixed. It never adds them up: the API computes the
 * load from the plates and the bar.
 */
import { loadText, qty } from "./format";
import type { Inventory } from "./types";
import { planStep, type Plan } from "./writes";

export interface Plate {
  value: number;
  unit: "kg" | "lb";
}
export interface PlateGroup extends Plate {
  count: number;
}
export interface PlateBuild {
  bar: Plate | null;
  plates: PlateGroup[];
}

/** The plates on the rack (confirmed or inferred), kg then lb, heaviest first. */
export function availablePlates(inv: Inventory | null): Plate[] {
  if (!inv) return [];
  const order = (u: "kg" | "lb") => (u === "kg" ? 0 : 1);
  return inv.plates
    .flatMap((s) => s.plates.filter((p) => p.status !== "absent").map((p) => ({ value: p.value, unit: s.unit })))
    .sort((a, b) => order(a.unit) - order(b.unit) || b.value - a.value);
}

export function addPlate(b: PlateBuild, p: Plate): PlateBuild {
  const i = b.plates.findIndex((g) => g.value === p.value && g.unit === p.unit);
  if (i === -1) return { ...b, plates: [...b.plates, { ...p, count: 1 }] };
  return { ...b, plates: b.plates.map((g, j) => (j === i ? { ...g, count: g.count + 1 } : g)) };
}

/** The bar: a weight and unit, or null for the implement'"'"'s own (the API reads it, or asks). */
export function setBar(b: PlateBuild, bar: Plate | null): PlateBuild {
  return { ...b, bar };
}

/** "No bar at all": the API's bar is optional, and a zero bar is how a build says none. */
export const NO_BAR: Plate = { value: 0, unit: "kg" };

/** The bar field's text: empty is the implement's own bar (null); "17.5", "7." and "0.5" read as typed; anything else is bad. */
export function parseBarValue(text: string): number | null | "bad" {
  const t = text.trim();
  if (!t) return null;
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return "bad";
  const v = Number(t);
  return Number.isFinite(v) && v > 0 ? v : "bad";
}

/** The bar field's text after the build's bar changed: kept while it still reads as the bar (so "17." stays), otherwise reset to it. */
export function nextBarText(text: string, bar: Plate | null): string {
  const want = bar && bar.value > 0 ? bar.value : null;
  const have = parseBarValue(text);
  if (have === "bad") return want === null ? "" : text;
  return have === want ? text : want === null ? "" : String(want);
}

/** A new build starts with no bar named: the API uses the implement'"'"'s own bar or asks. */
export const newBuild = (): PlateBuild => ({ bar: null, plates: [] });

export function removePlate(b: PlateBuild, index: number): PlateBuild {
  const g = b.plates[index];
  if (!g) return b;
  return { ...b, plates: g.count > 1 ? b.plates.map((x, j) => (j === index ? { ...x, count: x.count - 1 } : x)) : b.plates.filter((_, j) => j !== index) };
}

/**
 * "20 kg bar + 2 × 10 kg + 5 lb a side": what goes on the bar, in each
 * plate's own unit, worded by Today's loadText. With plates given, loadText
 * reads only the bar and the plates, so the value is a placeholder and the
 * build is never totalled here.
 */
export function plateText(b: PlateBuild): string {
  if (b.plates.length === 0) return b.bar ? `${qty(b.bar.value)} ${b.bar.unit} bar, no plates yet` : "No plates yet";
  return loadText({ value: 0, unit: "kg", basis: "per_side", bar: b.bar && b.bar.value > 0 ? b.bar : null, plates: b.plates });
}

export function plateLoad(b: PlateBuild): { load: { basis: "per_side"; plates: PlateGroup[]; bar?: Plate } } | { error: string } {
  if (b.plates.length === 0) return { error: "Add the plates on one side." };
  return { load: { basis: "per_side", plates: b.plates, ...(b.bar ? { bar: b.bar } : {}) } };
}

/** "Other plate…": the rack has a plate the list doesn't; record it. */
export function otherPlatePlan(gym: string, plate: Plate): Plan {
  return { steps: [planStep("record_plates", { gym, unit: plate.unit, available: [plate.value] })], done: `Added the ${qty(plate.value)} ${plate.unit} plate.` };
}
