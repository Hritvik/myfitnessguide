/**
 * A Log row's load as the plates on the bar: where its note states the
 * composition ("20 kg bar + 2.5 lb per side", "20 kg + 2.5 lb per side",
 * "Bar + 5 lb per side"), and it adds up to the typed load, the set is
 * imported as that composition. A row with no such note whose load matches
 * a composition stated on another row of the same exercise (the same load,
 * rounded as typed) takes that composition: Sheets typed the rounded kg
 * total, the note said what was loaded.
 */
import { readNativeLoad, toKg, type LoadAmount, type PlateGroup } from "@myfitnessguide/domain";
import type { Row } from "../grid";
import type { Loader } from "./context";

export interface Composition {
  /** The bar, when the note names it; null leaves it to the typed total (or none: a sled). */
  bar: LoadAmount | null;
  plates: PlateGroup[];
}

const NUM = String.raw`\d+(?:\.\d+)?`;
const SIDE = String.raw`(?:per side|\/\s*side|a side|each side)`;
const unitOf = (u: string) => u.toLowerCase().replace(/s$/, "") as "kg" | "lb";

/** Every composition a note states, in the order written. */
export function compositionsInNote(note: string): Composition[] {
  const out: Composition[] = [];
  let rest = note;
  // "20 kg bar + 2.5 lb per side"
  rest = rest.replace(new RegExp(String.raw`(${NUM})\s*kg\s*bar\s*\+\s*(${NUM})\s*(kg|lbs?)\b\s*${SIDE}`, "gi"), (_m, bar: string, v: string, u: string) => {
    out.push({ bar: { value: Number(bar), unit: "kg" }, plates: [{ value: Number(v), unit: unitOf(u), count: 1 }] });
    return " ";
  });
  // "Bar + 5 lb per side": the bar's weight comes from the typed total.
  rest = rest.replace(new RegExp(String.raw`\bbar\s*\+\s*(${NUM})\s*(kg|lbs?)\b\s*${SIDE}`, "gi"), (_m, v: string, u: string) => {
    out.push({ bar: null, plates: [{ value: Number(v), unit: unitOf(u), count: 1 }] });
    return " ";
  });
  // "20 kg + 2.5 lb per side": plates of both units on each side.
  rest.replace(new RegExp(String.raw`(${NUM})\s*(kg|lbs?)\s*\+\s*(${NUM})\s*(kg|lbs?)\b\s*${SIDE}`, "gi"), (_m, a: string, ua: string, b: string, ub: string) => {
    out.push({ bar: null, plates: [{ value: Number(a), unit: unitOf(ua), count: 1 }, { value: Number(b), unit: unitOf(ub), count: 1 }] });
    return " ";
  });
  return out;
}

/** The decimals a value was typed with, as a tolerance: 21.13 matches 21.134, 21.1 matches 21.134. */
export function typedTolerance(v: number): number {
  const text = String(v);
  const dot = text.indexOf(".");
  const decimals = dot === -1 ? 0 : text.length - dot - 1;
  return 0.5 * 10 ** -decimals + 1e-9;
}

const platesKg = (plates: readonly PlateGroup[]) => plates.reduce((s, p) => s + p.count * toKg(p.value, p.unit), 0);
const half = (x: number) => Math.round(x * 2) / 2;

/**
 * A stated composition fitted to a row's typed weight: per side, the plates
 * add up to it; as a total, the bar and both sides do (a bar the note
 * doesn't weigh is the typed total less the plates, to the half kg).
 * Null when it doesn't fit: the note was about another load.
 */
export function fit(c: Composition, basis: "per_side" | "total", weight: number): Composition | null {
  const side = platesKg(c.plates);
  const tol = typedTolerance(weight);
  if (basis === "per_side") return Math.abs(side - weight) <= tol ? c : null;
  const bar = c.bar ?? { value: half(weight - 2 * side), unit: "kg" as const };
  if (bar.value <= 0) return null;
  return Math.abs(toKg(bar.value, bar.unit) + 2 * side - weight) <= tol ? { bar, plates: c.plates } : null;
}

interface Stated {
  exercise: string;
  basis: "per_side" | "total";
  /** The composition's own load: per side, or the bar and both sides. */
  kg: number;
  composition: Composition;
}

const statedByFile = new WeakMap<Loader, Map<string, Stated[]>>();

function basisOf(text: string): "per_side" | "total" | null {
  const t = text.toLowerCase();
  if (t === "per side" || t === "per side added") return "per_side";
  if (t === "total" || t === "") return "total";
  return null;
}

/** The compositions a file's Log notes state and fit, oldest row first. */
function stated(ld: Loader, file: string): Stated[] {
  let byFile = statedByFile.get(ld);
  if (!byFile) statedByFile.set(ld, (byFile = new Map()));
  const cached = byFile.get(file);
  if (cached) return cached;
  const out: Stated[] = [];
  for (const row of ld.sheet(file, "Log")?.rows() ?? []) {
    const basis = basisOf(row.text("K"));
    const weight = Number(row.raw("J"));
    if (!basis || !Number.isFinite(weight) || weight <= 0) continue;
    for (const c of compositionsInNote(row.text("P"))) {
      const f = fit(c, basis, weight);
      if (!f) continue;
      const side = platesKg(f.plates);
      out.push({ exercise: row.text("E").toLowerCase(), basis, kg: basis === "per_side" ? side : toKg(f.bar?.value ?? 0, f.bar?.unit ?? "kg") + 2 * side, composition: f });
      break;
    }
  }
  byFile.set(file, out);
  return out;
}

/**
 * The composition of a Log row: the one its note states and fits, else the
 * earliest one stated for the same exercise whose load the typed weight is
 * (as rounded). Null when there is none.
 */
export function rowComposition(ld: Loader, file: string, row: Row, basis: "per_side" | "total", weight: number): { composition: Composition; carried: boolean } | null {
  for (const c of compositionsInNote(row.text("P"))) {
    const f = fit(c, basis, weight);
    if (f) return { composition: f, carried: false };
  }
  const exercise = row.text("E").toLowerCase();
  const tol = typedTolerance(weight);
  const match = stated(ld, file).find((s) => s.exercise === exercise && s.basis === basis && Math.abs(s.kg - weight) <= tol);
  return match ? { composition: match.composition, carried: true } : null;
}

/** A typed kg load read in its native unit; null when it is clean in neither unit or in both. */
export function nativeOf(weight: number): LoadAmount | null {
  const r = readNativeLoad(weight, "kg");
  return r.status === "clean" ? { value: r.value, unit: r.unit } : null;
}
