/**
 * The plate diagram's layout: the bar, then each plate on one side in the
 * order given, each labelled in its own unit. Heights come from a table of
 * standard plate sizes per unit (display geometry only; no load is
 * converted or summed here). Stacks and dumbbells have no diagram.
 */
import { loadText, qty } from "./format";
import type { PrescribedLoad } from "./types";

export interface PlateGlyph {
  label: string;
  unit: "kg" | "lb";
  value: number;
  /** Drawn height as a share of the tallest plate, 0..1. */
  height: number;
}

export interface PlateLayout {
  bar: string | null;
  plates: PlateGlyph[];
  /** Plates beyond MAX_DRAWN, said as "+N". */
  hidden: number;
  /** The whole load in words, for the label and screen readers. */
  text: string;
}

export const MAX_DRAWN = 8;
const KG_HEIGHT: Record<number, number> = { 25: 1, 20: 1, 15: 0.88, 10: 0.76, 5: 0.6, 2.5: 0.48, 1.25: 0.4 };
const LB_HEIGHT: Record<number, number> = { 45: 1, 35: 0.92, 25: 0.8, 10: 0.62, 5: 0.5, 2.5: 0.42 };
const DEFAULT_HEIGHT = 0.45;

export function plateLayout(load: PrescribedLoad): PlateLayout | null {
  if (!load.plates || load.plates.length === 0) return null;
  const glyphs = load.plates.flatMap((p) =>
    Array.from({ length: p.count }, () => ({
      label: `${qty(p.value)} ${p.unit}`,
      unit: p.unit,
      value: p.value,
      height: (p.unit === "kg" ? KG_HEIGHT : LB_HEIGHT)[p.value] ?? DEFAULT_HEIGHT,
    })),
  );
  return {
    bar: load.bar ? `${qty(load.bar.value)} ${load.bar.unit} bar` : null,
    plates: glyphs.slice(0, MAX_DRAWN),
    hidden: Math.max(0, glyphs.length - MAX_DRAWN),
    text: loadText(load),
  };
}
