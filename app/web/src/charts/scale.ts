/**
 * Scales, ticks and paths for the hand-drawn SVG charts (spec §9). Display
 * geometry only: where a value sits on the drawing, never the value itself.
 * Degenerate data (one point, identical values, one day) never divides by
 * zero, and clamp keeps every mark inside the drawing.
 */

export function linear(domain: readonly [number, number], range: readonly [number, number], clamped = false): (v: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  if (d1 === d0) return () => (r0 + r1) / 2;
  if (clamped) {
    return (v) => {
      const scaled = r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
      return clamp(scaled, r0, r1);
    };
  }
  return (v) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
}

export function clamp(v: number, a: number, b: number): number {
  return Math.min(Math.max(v, Math.min(a, b)), Math.max(a, b));
}

/** The values' span, padded by `pad` of itself; a single value opens by 5% of itself (or 1 at zero). */
export function extent(values: readonly number[], pad = 0): [number, number] | null {
  if (values.length === 0) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (lo === hi) {
    const p = Math.abs(lo) * 0.05 || 1;
    return [round(lo - p), round(hi + p)];
  }
  const span = hi - lo;
  return [round(lo - span * pad), round(hi + span * pad)];
}

const round = (v: number) => Number(v.toPrecision(12));
const STEPS = [1, 2, 2.5, 5, 10];

export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = (STEPS.find((s) => s >= raw / mag - 1e-9) ?? 10) * mag;
  const first = Math.ceil(min / step - 1e-9);
  const out: number[] = [];
  for (let i = first; i * step <= max + step * 1e-9; i++) out.push(round(i * step));
  return out;
}

const MS_PER_DAY = 86_400_000;

export function dayIndex(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

const isoOf = (day: number) => new Date(day * MS_PER_DAY).toISOString().slice(0, 10);

export function dateScale(from: string, to: string, range: readonly [number, number], clamped = false): (iso: string) => number {
  const x = linear([dayIndex(from), dayIndex(to)], range, clamped);
  return (iso) => x(dayIndex(iso));
}

export function dateTicks(from: string, to: string, count = 4): string[] {
  const a = dayIndex(from);
  const b = dayIndex(to);
  if (b <= a) return [from];
  const n = Math.max(2, count);
  const days = Array.from({ length: n }, (_, i) => Math.round(a + ((b - a) * i) / (n - 1)));
  return [...new Set(days)].map(isoOf);
}

export function linePath(points: readonly { x: number; y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
}

export interface Plot {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The drawing area inside the axis margins (left for the value labels, bottom for the dates). */
export function plot(width: number, height: number, margin: Partial<{ left: number; right: number; top: number; bottom: number }> = {}): Plot {
  const m = { left: 40, right: 12, top: 12, bottom: 28, ...margin };
  return { width, height, left: m.left, right: width - m.right, top: m.top, bottom: height - m.bottom };
}
