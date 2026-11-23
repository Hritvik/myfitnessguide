import { dateTicks, dayIndex, extent, niceTicks } from "./charts/scale";
import { addDays } from "./dates";
import { day, n, pct, plural } from "./format";
import { RANGE_DAYS, type Range } from "./route";
import type { NutritionDayOut, NutritionTrends, NutritionWeekOut, TrendMacro } from "./types";

export type NutritionPage = { from: string; to: string; data: NutritionTrends } | { from: string; to: string; failed: true };
export interface NutritionData { viewing: string; today: string; range: Range; first: NutritionTrends; pages: NutritionPage[] }
export function nutritionFrom(range: Range, today: string): string | null {
  // Nutrition opens on whole weeks ending before today, so it starts 7 days in from the period's own span.
  return range === "all" ? null : addDays(today, 7 - RANGE_DAYS[range]);
}

type Span = { kind: "ok"; days: NutritionDayOut[]; weeks: NutritionWeekOut[] } | { kind: "failed"; from: string; to: string };
type BarMark = "filled" | "outline" | "open" | "unlogged";
export interface DailyChartModel {
  key: TrendMacro; title: string; unit: string; from: string; to: string; withTarget: boolean; weeklyOnly: boolean;
  bars: { date: string; value: number | null; mark: BarMark; label: "so far" | "at least" | null }[];
  weeks: { from: string; to: string; value: number | null; target: number | null }[];
  failed: { from: string; to: string }[];
  y: { min: number; max: number; ticks: number[] }; x: { ticks: string[] }; summary: string;
  table: { iso: string; date: string; value: string; target: string; note: string }[];
}
export interface SplitModel { title: string; summary: string; weeks: { key: string; label: string; shares: { protein: number; carbs: number; fat: number } | null; text: string; failed: boolean }[] }
export interface CostModel {
  empty: string | null;
  daily: { title: string; summary: string; from: string; to: string; bars: { date: string; min: number; max: number; atLeast: boolean }[]; weeks: { from: string; to: string; min: number | null; max: number | null }[]; failed: { from: string; to: string }[]; y: { min: number; max: number; ticks: number[] }; x: { ticks: string[] }; table: { iso: string; date: string; cost: string; note: string }[] };
  per25: { title: string; summary: string; from: string; to: string; weeks: { from: string; to: string; min: number | null; max: number | null }[]; points: { date: string; min: number; max: number }[]; failed: { from: string; to: string }[]; y: { min: number; max: number; ticks: number[] }; x: { ticks: string[] }; table: { key: string; week: string; value: string }[] };
}
export interface WeeklyRow { key: string; week: string; failed: boolean; days: string; kcal: string; protein: string; carbs: string; fat: string; split: string; cost: string; per25: string }
export interface NutritionView { empty: string | null; notice: string | null; charts: DailyChartModel[]; split: SplitModel; cost: CostModel; weekly: WeeklyRow[] }

const SERIES: { key: TrendMacro; title: string; unit: string; withTarget: boolean }[] = [
  { key: "kcal", title: "Calories vs target", unit: " kcal", withTarget: true },
  { key: "protein", title: "Protein vs target", unit: " g", withTarget: true },
  { key: "carbs", title: "Carbs", unit: " g", withTarget: false },
  { key: "fat", title: "Fat", unit: " g", withTarget: false },
];
const FAILED = "Couldn't load these weeks";
const spans = (data: NutritionData): Span[] => [
  ...[...data.pages].reverse().map((p): Span => "failed" in p ? { kind: "failed", from: p.from, to: p.to } : { kind: "ok", days: p.data.days, weeks: p.data.weeks }),
  { kind: "ok", days: data.first.days, weeks: data.first.weeks },
];
const yAxis = (values: readonly number[]) => {
  const [, max] = extent([0, ...values], 0.08) ?? [0, 1];
  return { min: 0, max, ticks: niceTicks(0, max, 4) };
};
const weekLabel = (from: string, to: string) => `${day(from)} – ${day(to)}`;
const rupees = (value: number) => `₹${n(value)}`;
const rupeeSpan = (min: number, max: number) => n(min) === n(max) ? rupees(min) : `${rupees(min)}–${rupees(max)}`;

function dayNote(value: NutritionDayOut): string {
  if (value.not_counted === "unlogged") return "Not logged";
  if (value.not_counted === "partial") return "Partial: not in the average";
  if (value.not_counted === "today_open") return "Today so far";
  if (value.source === "manual_day_total") return "Day total";
  return value.status === "open" ? "Not closed" : "";
}

function dailyChart(series: (typeof SERIES)[number], parts: Span[]): DailyChartModel {
  const days = parts.flatMap((part) => part.kind === "ok" ? part.days.filter((value) => value.status !== "future") : []);
  const failed = parts.flatMap((part) => part.kind === "failed" ? [{ from: part.from, to: part.to }] : []);
  const weeks = parts.flatMap((part) => part.kind === "ok" ? part.weeks.map((week) => ({ from: week.week_start, to: week.week_end, value: week.average[series.key]?.value ?? null, target: series.withTarget ? week.target_average[series.key] : null })) : []);
  const first = parts[0];
  const last = parts.at(-1);
  const from = first?.kind === "failed" ? first.from : (first?.weeks[0]?.week_start ?? first?.days[0]?.date ?? "");
  const to = last?.kind === "failed" ? last.to : (last?.weeks.at(-1)?.week_end ?? last?.days.at(-1)?.date ?? from);
  const weekCount = weeks.length + failed.reduce((sum, gap) => sum + Math.round((dayIndex(gap.to) - dayIndex(gap.from) + 1) / 7), 0);
  const weeklyOnly = weekCount > 12;
  const bars = weeklyOnly ? [] : days.map((value) => {
    const nutrient = value[series.key];
    if (!value.logged) return { date: value.date, value: null, mark: "unlogged" as const, label: null };
    if (!value.counted) return { date: value.date, value: nutrient?.value ?? null, mark: "outline" as const, label: value.not_counted === "today_open" ? "so far" as const : null };
    if (nutrient && !nutrient.complete) return { date: value.date, value: nutrient.value, mark: "open" as const, label: "at least" as const };
    return { date: value.date, value: nutrient?.value ?? null, mark: "filled" as const, label: null };
  });
  const values = [...bars.flatMap((bar) => bar.value === null ? [] : [bar.value]), ...weeks.flatMap((week) => [week.value, week.target].filter((value): value is number => value !== null))];
  const latest = [...parts].reverse().flatMap((part) => part.kind === "ok" ? [...part.weeks].reverse() : []).find((week) => week.average[series.key] !== null);
  const average = latest?.average[series.key];
  const target = latest && series.withTarget ? latest.target_average[series.key] : null;
  const summary = [
    average && latest ? `${series.title}: the week of ${day(latest.week_start)} averages ${n(average.value)}${series.unit} over ${plural(average.days, "day", "days")}${target != null ? `, target ${n(target)}${series.unit}` : ""}.` : `${series.title}: no complete day in this range.`,
    weeklyOnly ? "Weekly averages; daily values in the table." : "",
    failed.length ? `${FAILED}: ${failed.map((gap) => weekLabel(gap.from, gap.to)).join(", ")}.` : "",
  ].filter(Boolean).join(" ");
  return {
    key: series.key, title: series.title, unit: series.unit, from, to, withTarget: series.withTarget, weeklyOnly, bars, weeks, failed, y: yAxis(values), x: { ticks: from && to ? dateTicks(from, to, 4) : [] }, summary,
    table: days.map((value) => ({ iso: value.date, date: day(value.date), value: value[series.key] === null ? "—" : `${value[series.key]!.complete ? "" : "≥ "}${n(value[series.key]!.value)}${series.unit}`, target: value.target ? `${n(value.target[series.key])}${series.unit}` : "No target", note: dayNote(value) })),
  };
}

function splitModel(parts: Span[]): SplitModel {
  const weeks = parts.flatMap((part) => part.kind === "failed"
    ? [{ key: part.from, label: weekLabel(part.from, part.to), shares: null, text: FAILED, failed: true }]
    : part.weeks.map((week) => ({ key: week.week_start, label: day(week.week_start), shares: week.macro_split, text: week.macro_split ? `Protein ${pct(week.macro_split.protein)} · carbs ${pct(week.macro_split.carbs)} · fat ${pct(week.macro_split.fat)}` : "Not enough complete days", failed: false })));
  const latest = [...weeks].reverse().find((week) => week.shares !== null);
  return { title: "Macro split", summary: `Of the kcal from protein, carbs and fat, by week. ${latest ? `Week of ${latest.label}: ${latest.text}.` : "No week with enough complete days."}`, weeks };
}

function costModel(parts: Span[]): CostModel {
  const days = parts.flatMap((part) => part.kind === "ok" ? part.days.filter((value) => value.status !== "future") : []);
  const weeks = parts.flatMap((part) => part.kind === "ok" ? part.weeks : []);
  const failed = parts.flatMap((part) => part.kind === "failed" ? [{ from: part.from, to: part.to }] : []);
  const from = parts[0]?.kind === "failed" ? parts[0].from : (weeks[0]?.week_start ?? "");
  const to = weeks.at(-1)?.week_end ?? from;
  const bars = days.flatMap((value) => value.cost ? [{ date: value.date, min: value.cost.min, max: value.cost.max, atLeast: !value.cost.complete }] : []);
  const latest = [...weeks].reverse().find((week) => week.cost !== null || week.cost_items !== null);
  const latestPer = [...weeks].reverse().find((week) => week.cost_per_25g_protein !== null);
  const points = days.flatMap((value) => value.cost_per_25g_protein ? [{ date: value.date, min: value.cost_per_25g_protein.min, max: value.cost_per_25g_protein.max }] : []);
  const steps = weeks.map((week) => ({ from: week.week_start, to: week.week_end, min: week.cost_per_25g_protein?.min ?? null, max: week.cost_per_25g_protein?.max ?? null }));
  return {
    empty: failed.length > 0 || days.some((value) => value.cost && value.cost.priced_items > 0) ? null : "No prices in the catalogue for what was eaten in this range",
    daily: {
      title: "Daily cost", summary: latest ? `Daily cost, the week of ${day(latest.week_start)}: ${latest.cost ? `${rupeeSpan(latest.cost.min, latest.cost.max)} a day over ${plural(latest.cost.days, "fully priced day", "fully priced days")}` : "no fully priced day"}${latest.cost_items ? `; priced ${latest.cost_items.priced} of ${latest.cost_items.of} items` : ""}.` : "Daily cost: nothing priced in this range.",
      from, to, bars, weeks: weeks.map((week) => ({ from: week.week_start, to: week.week_end, min: week.cost?.min ?? null, max: week.cost?.max ?? null })), failed, y: yAxis(bars.flatMap((bar) => [bar.min, bar.max])), x: { ticks: from ? dateTicks(from, to, 4) : [] },
      table: days.map((value) => ({ iso: value.date, date: day(value.date), cost: value.cost && value.cost.priced_items > 0 ? (value.cost.complete ? rupeeSpan(value.cost.min, value.cost.max) : `≥ ${rupees(value.cost.min)}, priced ${value.cost.priced_items} of ${value.cost.items}`) : value.cost_missing === "manual_day_total" ? "Day total: no cost" : value.cost_missing === "nothing_priced" ? "Nothing priced" : "—", note: dayNote(value) })),
    },
    per25: {
      title: "Cost per 25 g protein", summary: `Cost per 25 g protein, over the items with a price${latestPer?.cost_per_25g_protein ? `: the week of ${day(latestPer.week_start)} ${rupeeSpan(latestPer.cost_per_25g_protein.min, latestPer.cost_per_25g_protein.max)}` : ": none in this range"}.`, from, to, weeks: steps, points, failed,
      y: yAxis([...points.flatMap((point) => [point.min, point.max]), ...steps.flatMap((step) => [step.min, step.max].filter((value): value is number => value !== null))]), x: { ticks: from ? dateTicks(from, to, 4) : [] },
      table: weeks.map((week) => ({ key: week.week_start, week: day(week.week_start), value: week.cost_per_25g_protein ? rupeeSpan(week.cost_per_25g_protein.min, week.cost_per_25g_protein.max) : "—" })),
    },
  };
}

function weeklyRows(parts: Span[]): WeeklyRow[] {
  const average = (week: NutritionWeekOut, key: TrendMacro, unit: string, withTarget: boolean) => {
    const value = week.average[key];
    if (value === null) return "— (no complete day)";
    const target = withTarget ? week.target_average[key] : null;
    return target === null ? `${n(value.value)}${unit}` : `${n(value.value)} / ${n(target)}${unit}`;
  };
  return parts.flatMap((part): WeeklyRow[] => part.kind === "failed"
    ? [{ key: part.from, week: weekLabel(part.from, part.to), failed: true, days: FAILED, kcal: "", protein: "", carbs: "", fat: "", split: "", cost: "", per25: "" }]
    : part.weeks.map((week) => ({ key: week.week_start, week: day(week.week_start), failed: false, days: `${week.days.counted} of ${week.days.in_range}`, kcal: average(week, "kcal", " kcal", true), protein: average(week, "protein", " g", true), carbs: average(week, "carbs", " g", false), fat: average(week, "fat", " g", false), split: week.macro_split ? `${pct(week.macro_split.protein)} · ${pct(week.macro_split.carbs)} · ${pct(week.macro_split.fat)}` : "—", cost: week.cost ? rupeeSpan(week.cost.min, week.cost.max) : "—", per25: week.cost_per_25g_protein ? rupeeSpan(week.cost_per_25g_protein.min, week.cost_per_25g_protein.max) : "—" }))).reverse();
}

export function buildNutrition(data: NutritionData): NutritionView {
  const parts = spans(data);
  return { empty: data.first.first_logged_on === null ? "Nothing logged yet." : null, notice: data.first.capped ? "Showing the last 2 years" : null, charts: SERIES.map((series) => dailyChart(series, parts)), split: splitModel(parts), cost: costModel(parts), weekly: weeklyRows(parts) };
}
