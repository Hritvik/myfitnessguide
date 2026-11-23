/** Display-only geometry for nutrition bars and weekly steps. */
import { dayIndex } from "./scale";

export function chartWidth(width: number): number {
  return Math.max(240, Math.round(Number.isFinite(width) ? width : 358));
}

export function dayWidth(from: string, to: string, left: number, right: number): number {
  const days = Math.max(1, dayIndex(to) - dayIndex(from) + 1);
  return (right - left) / days;
}

export function dayBar(x: (iso: string) => number, iso: string, width: number): { x: number; width: number } {
  const barWidth = Math.max(1, width * 0.7);
  return { x: x(iso) - barWidth / 2, width: barWidth };
}

export function breakAtFailedRanges<T extends { from: string; to: string; value: number | null }>(
  weeks: readonly T[],
  failed: readonly { from: string; to: string }[],
): ({ from: string; to: string; value: number | null } | T)[] {
  return weeks.flatMap((week, index) => {
    const previous = weeks[index - 1];
    const separates = previous && failed.some((gap) => dayIndex(gap.to) >= dayIndex(previous.to) + 1 && dayIndex(gap.from) <= dayIndex(week.from) - 1);
    return separates ? [{ from: previous.to, to: week.from, value: null }, week] : [week];
  });
}

export function stepPaths(
  weeks: readonly { from: string; to: string; value: number | null }[],
  x: (iso: string) => number,
  y: (value: number) => number,
  width: number,
): string[] {
  const folded = weeks.reduce<{ paths: string[][]; current: string[] }>((state, week) => {
    if (week.value === null) {
      return state.current.length ? { paths: [...state.paths, state.current], current: [] } : state;
    }
    const from = (x(week.from) - width / 2).toFixed(1);
    const to = (x(week.to) + width / 2).toFixed(1);
    const value = y(week.value).toFixed(1);
    return { ...state, current: [...state.current, `${state.current.length ? "L" : "M"}${from} ${value}`, `L${to} ${value}`] };
  }, { paths: [], current: [] });
  return [...folded.paths, ...(folded.current.length ? [folded.current] : [])].map((path) => path.join(" "));
}
