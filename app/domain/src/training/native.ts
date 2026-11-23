import type { LoadAmount, LoadUnit, NativeReading } from "../types";
import { KG_PER_LB } from "./units";

/** A stated value this close to a half number is one (float noise only). */
const EXACT = 1e-9;
/**
 * How close a stated clean value's conversion must land on a half number in
 * the other unit to be clean there too (22 kg is 48.502 lb). A whole kilo
 * load is never further than this from a half pound by accident of display
 * rounding, since the stated value is exact.
 */
const BOTH_TOL = 0.01;

const half = (x: number): number => Math.round(x * 2) / 2;

/** Decimal places the value was written with (9.1 -> 1, 9.07 -> 2). */
function decimals(v: number): number {
  const text = String(v);
  if (text.includes("e")) return 10;
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

function convert(value: number, from: LoadUnit): number {
  return from === "kg" ? value / KG_PER_LB : value * KG_PER_LB;
}

/**
 * The unit a load really is in: the one that makes it a whole or half
 * number. A value clean in its stated unit is as stated (25 kg); one that
 * isn't but is the rounding, at the decimals it was written with, of a
 * whole or half number in the other unit is that number (9.07 kg is 20 lb,
 * 33.07 lb is 15 kg). Clean in both (22 kg = 48.5 lb) or in neither
 * (13.33 kg) is ambiguous: the caller asks.
 */
export function readNativeLoad(value: number, unit: LoadUnit): NativeReading {
  if (value === 0) return { status: "clean", value: 0, unit, converted: false };
  const sign = value < 0 ? -1 : 1;
  const size = Math.abs(value);
  const other: LoadUnit = unit === "kg" ? "lb" : "kg";
  const inOther = convert(size, unit);
  const cleanStated = Math.abs(size - half(size)) <= EXACT;
  if (cleanStated) {
    if (Math.abs(inOther - half(inOther)) <= BOTH_TOL) {
      return {
        status: "ambiguous",
        reason: "clean_in_both",
        options: [
          { value, unit },
          { value: sign * half(inOther), unit: other },
        ],
      };
    }
    return { status: "clean", value, unit, converted: false };
  }
  const tolerance = 0.5 * 10 ** -decimals(size) + EXACT;
  const hits = [half(inOther) - 0.5, half(inOther), half(inOther) + 0.5].filter(
    (h) => h > 0 && Math.abs(size - convert(h, other)) <= tolerance,
  );
  if (hits.length === 1) return { status: "clean", value: sign * (hits[0] as number), unit: other, converted: true };
  return { status: "ambiguous", reason: "clean_in_neither", options: hits.map((h): LoadAmount => ({ value: sign * h, unit: other })) };
}
