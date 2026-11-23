/**
 * Progress: Trajectory (spec §6). The headline, its verdict and every value
 * come from body_trends; this only words them, and lays out the chart
 * (display geometry: which dates and values to draw where). No literal
 * target and no division: the ratio and its goals are the API's.
 */
import { dateTicks, extent, niceTicks } from "./charts/scale";
import { addDays } from "./dates";
import { atLeast, day, longDay, n, pct, plural, unknownCount, unknownTail } from "./format";
import type { ProgressView, Range } from "./route";
import type { BloodDraws, BodyTrends, Flags, GoalVerdict, LabResult, ProgressSignals, ProgressSummary, WeekSummary } from "./types";

export type ProgressSummaryData =
  | { private: true; message: string }
  | { private: false; today: string; range: Range; summary: ProgressSummary };

export type TrajectoryData =
  | { private: true; message: string }
  | { private: false; today: string; range: Range; from: string | null; lead: BodyTrends; weight: BodyTrends | null };

type Ready = Extract<TrajectoryData, { private: false }>;

export interface Point {
  date: string;
  value: number;
}

/** A planned goal point; `high` is set only when the goal is a range (low to high). */
export interface GoalMark extends Point {
  high?: number;
}

export interface ChartModel {
  title: string;
  from: string;
  to: string;
  /** Readings, cut at method changes: one line per segment. */
  segments: Point[][];
  /** Planned goal points up to `to`, drawn in ink at low emphasis. */
  goals: GoalMark[];
  /** The latest reading, marked in haldi. */
  current: Point | null;
  phase: { from: string; to: string; name: string } | null;
  y: { min: number; max: number; ticks: number[]; decimals: number };
  x: { ticks: string[] };
  summary: string;
  /** `iso` is the row's date as the API gave it; `date` is its label. */
  table: { iso: string; date: string; reading: string | null; goal: string | null }[];
}

export interface TrajectoryView {
  range: Range;
  headline: { title: string; value: string | null; target: string | null; verdict: { kind: GoalVerdict["verdict"]; text: string }; secondary: string | null; observation: string } | null;
  chart: ChartModel | null;
  weight: ChartModel | null;
  message: string | null;
}

const VERDICT: Record<GoalVerdict["verdict"], string> = {
  on_track: "On track",
  ahead: "Ahead",
  behind: "Behind",
  no_reading: "No reading this week",
  no_goal_point: "No goal point this week",
};

export function verdictText(v: GoalVerdict): string {
  return v.verdict === "behind" ? `Behind, ${v.weeksBehind} weeks running` : VERDICT[v.verdict];
}

const LABELS: Record<string, string> = { weight: "Body weight", waist_navel: "Waist at navel", waist_to_height: "Waist to height" };
const label = (metric: string) => LABELS[metric] ?? metric.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

const fixed = (decimals: number) => {
  const f = new Intl.NumberFormat("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return (v: number) => f.format(v);
};
const ratio = fixed(2);
export const one = fixed(1);

const latest = (segments: Point[][]): Point | null => segments.flat().at(-1) ?? null;

/** Describe only the visible readings. Direction comes from the API; this never attributes a cause. */
function observation(segments: Point[][], direction: BodyTrends["headline"]["direction"], decimals: number, unit = ""): string {
  const points = segments.flat();
  if (points.length === 0) return "No reading in this range.";
  if (points.length === 1) return "One reading in this range; there isn't a trend yet.";
  const first = points[0]!;
  const last = points.at(-1)!;
  const format = fixed(decimals);
  if (format(first.value) === format(last.value)) return `Held steady across ${plural(points.length, "reading", "readings")} since ${day(first.date)}.`;
  const delta = last.value - first.value;
  const intended = direction === "decrease" ? delta < 0 : direction === "increase" ? delta > 0 : null;
  const movement = intended === null ? (delta > 0 ? "Increased" : "Decreased") : intended ? "Moved in the intended direction" : "Moved away from the intended direction";
  return `${movement} by ${format(Math.abs(delta))}${unit} across ${plural(points.length, "reading", "readings")} since ${day(first.date)}.`;
}

/** Split a dated series where a method change falls between two points, so no line crosses one. */
function cut(points: Point[], changes: string[]): Point[][] {
  const out: Point[][] = [];
  let current: Point[] = [];
  for (const p of points) {
    const prev = current.at(-1);
    if (prev && changes.some((c) => c > prev.date && c <= p.date)) {
      out.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** A goal or range as words: 74 -> "74", 73.5 to 75 -> "73.5\u201375". Never a midpoint. */
const span = (low: number, high: number, f: (v: number) => string) => (low === high ? f(low) : `${f(low)}\u2013${f(high)}`);

function chart(title: string, segments: Point[][], goals: GoalMark[], phase: BodyTrends["current_phase"], data: Ready, decimals: number, from: string, unit = ""): ChartModel | null {
  const all = segments.flat();
  if (all.length === 0 && goals.length === 0) return null;
  const to = data.today;
  const shownGoals = goals.filter((g) => g.date >= from && g.date <= to);
  const [min, max] = extent([...all.map((p) => p.value), ...shownGoals.flatMap((g) => (g.high === undefined ? [g.value] : [g.value, g.high]))], 0.1) ?? [0, 1];
  const num = fixed(decimals);
  const fmt = (v: number) => `${num(v)}${unit}`;
  const current = latest(segments);
  const lastGoal = shownGoals.at(-1);
  const rows = new Map<string, { reading: string | null; goal: string | null }>();
  const goalText = (g: GoalMark) => (g.high === undefined ? fmt(g.value) : `${span(g.value, g.high, num)}${unit}`);
  for (const p of all) rows.set(p.date, { reading: fmt(p.value), goal: null });
  for (const g of shownGoals) rows.set(g.date, { reading: rows.get(g.date)?.reading ?? null, goal: goalText(g) });
  return {
    title,
    from,
    to,
    segments,
    goals: shownGoals,
    current,
    phase: phase ? { from: phase.starts_on > from ? phase.starts_on : from, to: phase.ends_on && phase.ends_on < to ? phase.ends_on : to, name: phase.name } : null,
    y: { min, max, ticks: niceTicks(min, max, 4), decimals },
    x: { ticks: dateTicks(from, to, 4) },
    summary: current
      ? `${title}: ${fmt(current.value)} on ${day(current.date)}${lastGoal ? `; latest goal ${goalText(lastGoal)}` : ""}. ${plural(all.length, "reading", "readings")} shown.`
      : `${title}: no reading in this range.`,
    table: [...rows.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, r]) => ({ iso: date, date: day(date), ...r })),
  };
}

export function buildTrajectory(data: Ready): TrajectoryView {
  const w = data.lead;
  // One x axis for both charts: the range's start, or for All the earliest of the lead's first reading,
  // its first drawn goal and the first weight reading drawn, so no mark falls before it.
  const ratioLead = w.headline.metric === "waist_to_height" && w.waist_to_height ? w.waist_to_height : null;
  const leadFirst: string | undefined = (ratioLead ? ratioLead.segments : w.segments).flatMap((s): { date: string }[] => s.readings)[0]?.date;
  const firstGoal = ratioLead ? ratioLead.goal_path[0]?.week_of : w.goal_points.find((g) => g.tier === "planned")?.week_of;
  const weightDrawn = ratioLead || (w.metric && w.headline.metric && w.metric !== "weight");
  const firstWeight = weightDrawn ? data.weight?.seven_day_averages?.find((a) => a.average_kg !== null)?.date : undefined;
  const earliest = [leadFirst, firstGoal, firstWeight].filter((d): d is string => !!d).sort()[0];
  const from = data.from ?? earliest ?? data.today;
  const weightChart = data.weight?.seven_day_averages
    ? chart(
        "7-day fasted weight",
        cut(data.weight.seven_day_averages.filter((a): a is { date: string; average_kg: number } => a.average_kg !== null).map((a) => ({ date: a.date, value: a.average_kg })), data.weight.method_changes.map((c) => c.date)),
        [],
        null,
        data,
        1,
        from,
        " kg",
      )
    : null;

  const ratioBlock = w.waist_to_height;
  if (w.headline.metric === "waist_to_height" && ratioBlock) {
    const segments = ratioBlock.segments.map((s) => s.readings);
    // The end target, never clipped by the range.
    const end = ratioBlock.end_target;
    const cm = latest(w.segments.map((s) => s.readings.map((r) => ({ date: r.date, value: r.value_canonical }))));
    const now = latest(segments);
    // The headline value, like the verdict, does not depend on the range.
    const cw = ratioBlock.current_week.reading;
    const reading = cw === null ? null : ratio(cw);
    return {
      range: data.range,
      headline: {
        title: "Waist to height",
        value: reading ?? (now ? ratio(now.value) : null),
        target: end ? `Target ${span(end.low, end.high, ratio)} by ${longDay(end.week_of)}` : null,
        verdict: { kind: ratioBlock.current_week.verdict, text: verdictText(ratioBlock.current_week) },
        secondary: cm ? `Waist ${one(cm.value)} cm on ${day(cm.date)}` : null,
        observation: observation(segments, w.headline.direction, 2),
      },
      chart: chart("Waist to height", segments, ratioBlock.goal_path.map((g) => ({ date: g.week_of, value: g.value })), w.current_phase, data, 2, from),
      weight: weightChart,
      message: null,
    };
  }

  // The headline fell back to another planned metric: the same call answered for it.
  const h = w;
  if (h.metric && h.headline.metric) {
    const unit = h.canonical_unit ? ` ${h.canonical_unit}` : "";
    const segments = h.segments.map((s) => s.readings.map((r) => ({ date: r.date, value: r.value_canonical })));
    const planned = h.goal_points.filter((g) => g.tier === "planned");
    const end = h.end_target;
    const now = latest(segments);
    const title = label(h.metric as string);
    return {
      range: data.range,
      headline: {
        title,
        value: h.current_week?.reading != null ? `${one(h.current_week.reading)}${unit}` : now ? `${one(now.value)}${unit}` : null,
        target: end ? `Target ${span(end.low, end.high, one)}${unit} by ${longDay(end.week_of)}` : null,
        verdict: h.current_week ? { kind: h.current_week.verdict, text: verdictText(h.current_week) } : { kind: "no_goal_point", text: VERDICT.no_goal_point },
        secondary: null,
        observation: observation(segments, h.headline.direction, 1, unit),
      },
      chart: chart(title, segments, planned.map((g) => (g.low === g.high ? { date: g.week_of, value: g.low } : { date: g.week_of, value: g.low, high: g.high })), h.current_phase, data, 1, from, unit),
      weight: h.metric === "weight" ? null : weightChart,
      message: null,
    };
  }

  return { range: data.range, headline: null, chart: null, weight: weightChart, message: "No goal set yet. The agent sets goal points from your Guide." };
}

// ------------------------------------------------------------ This week

export interface WeekDayView {
  date: string;
  label: string;
  kcal: string;
  /** Eaten over target, 0..1, for the track; null without a target. Display geometry, as Today's tracks. */
  fill: number | null;
  protein: string;
  status: string;
  training: string;
}

export interface WeekView {
  title: string;
  days: WeekDayView[];
  measured: string;
  energy: { text: string; flagged: boolean };
  prev: string;
  next: string | null;
}

const KIND_LABEL = { gym: "Gym", dance: "Dance", cardio: "Cardio" } as const;

function weekDay(d: WeekSummary["days"][number], today: string): WeekView["days"][number] {
  // A day still to come has nothing to say yet: not "Nothing logged · open", not "Rest" (ticket 68).
  if (d.date > today && d.kcal === null && d.training.length === 0) return { date: d.date, label: day(d.date), kcal: "Ahead", fill: null, protein: "", status: "", training: "" };
  const uk = d.unknown_items?.kcal ?? 0;
  const up = d.unknown_items?.protein ?? 0;
  return {
    date: d.date,
    label: day(d.date),
    // A day whose sums leave out unknown items reads "1,850+ of 2,000 kcal · 1 item unknown" (ticket 72, decision 118).
    // Items logged but none of their energy known: "kcal unknown · 2 items unknown", never "Nothing logged" (review P1-1).
    kcal:
      d.kcal === null
        ? d.item_count > 0
          ? `kcal unknown${unknownTail(unknownCount(d.unknown_items))}`
          : "Nothing logged"
        : `${d.kcal_target === null ? `${atLeast(d.kcal, uk)} kcal` : `${atLeast(d.kcal, uk)} of ${n(d.kcal_target)} kcal`}${d.item_count === 0 ? " · day total" : ""}${unknownTail(unknownCount(d.unknown_items))}`,
    fill: d.kcal !== null && d.kcal_target ? Math.round(Math.min(1, d.kcal / d.kcal_target) * 10_000) / 10_000 : null,
    protein: d.protein === null ? (d.item_count > 0 ? "P unknown" : "P —") : `P ${atLeast(d.protein, up)} g`,
    status: d.day_status,
    training: d.training.length === 0 ? "Rest" : d.training.map((t) => (t.template ? `${KIND_LABEL[t.kind]}, ${t.template}` : KIND_LABEL[t.kind])).join("; "),
  };
}

export function buildWeek(s: WeekSummary, today: string): WeekView {
  const next = addDays(s.week_start, 7);
  const ea = s.energy_availability;
  return {
    title: s.week_start <= today && today <= s.week_end ? "This week" : `Week of ${day(s.week_start)}`,
    days: s.days.map((d) => weekDay(d, today)),
    measured: s.measured.share === null ? "Nothing logged this week, so no measured share." : `${pct(s.measured.share)} of this week's energy was measured.`,
    energy: ea
      ? { text: `Energy availability ${one(ea.value)} kcal/kg fat-free mass, over ${plural(ea.days_counted, "day", "days")}.${ea.low ? ` Below ${ea.threshold}.` : ""}`, flagged: ea.low }
      : { text: `Energy availability: not known (${s.energy_availability_missing ?? "no data"}).`, flagged: false },
    prev: addDays(s.week_start, -7),
    next: next <= today ? next : null,
  };
}

// ------------------------------------------------------------ Health

export interface MarkerView {
  id: number;
  name: string;
  value: string;
  range: string | null;
  status: LabResult["status"];
  statusText: string;
  change: string | null;
  /** For the small range band: the lab's limits and the value (display geometry). */
  /** The draw it came from, e.g. "Thyrocare, 1 Oct 2026" (" (draft)" when unconfirmed). */
  draw: string;
  drawnOn: string;
  lab: string;
  band: { low: number | null; high: number | null; value: number } | null;
}

export interface FlagView {
  id: number;
  subject: string;
  due: string | null;
  note: string | null;
}

export interface HealthView {
  overview: {
    kind: "review" | "clear" | "empty";
    title: string;
    summary: string;
    note: string;
  };
  outOfRange: MarkerView[];
  panels: { title: string; markers: MarkerView[]; /** Set when every marker new in this draw is out of range and listed above. */ allOutOfRange: boolean }[];
  gaps: FlagView[];
  flags: FlagView[];
  empty: string | null;
}

const LAB = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 });
const STATUS_TEXT = { above: "above range", below: "below range", within: "in range" } as const;

/** A lab unit to print: the import stored "not recorded" where the report gave none, which is no unit, not a unit (click test P2-21). */
const labUnit = (u: string | null): string => (u && !/^not[ _]recorded$/i.test(u.trim()) ? ` ${u}` : "");

function marker(r: LabResult, d: BloodDraws["draws"][number]): MarkerView {
  const unit = labUnit(r.unit);
  const value = r.value_text ?? `${r.comparator ?? ""}${r.value === null ? "" : LAB.format(r.value)}${unit}`;
  const range =
    r.ref_text ??
    (r.ref_low !== null && r.ref_high !== null ? `${span(r.ref_low, r.ref_high, LAB.format)}${unit}`
      : r.ref_low !== null ? `≥ ${LAB.format(r.ref_low)}${unit}`
      : r.ref_high !== null ? `≤ ${LAB.format(r.ref_high)}${unit}`
      : null);
  return {
    id: r.id,
    name: r.marker,
    value,
    range,
    status: r.status,
    // The API compares only a numeric range; a range in words (or a value given as "<0.5") isn't checked.
    statusText: r.status ? STATUS_TEXT[r.status] : "not checked against the range",
    change: r.change ? `${r.change.delta > 0 ? "+" : ""}${LAB.format(r.change.delta)} since ${day(r.change.previous_on)}` : null,
    draw: drawLabel(d),
    drawnOn: d.drawn_on,
    lab: d.lab,
    band: r.value !== null && r.comparator === null && (r.ref_low !== null || r.ref_high !== null) ? { low: r.ref_low, high: r.ref_high, value: r.value } : null,
  };
}

const drawLabel = (d: BloodDraws["draws"][number]) => `${d.lab}, ${longDay(d.drawn_on)}${d.state === "draft" ? " (draft)" : ""}`;

const flagView = (f: Flags["flags"][number]): FlagView => ({ id: f.id, subject: f.subject, due: f.due_on ? `due ${day(f.due_on)}` : null, note: f.note });

/**
 * Health's two flag lists: data flags (a report never received, readings
 * that disagree) and every other open flag. A data flag isn't always a
 * missing report, so its list says "Data to check" (ticket 68).
 */
export const HEALTH_HEADINGS = { gaps: "Data to check", flags: "Flags and follow-ups" } as const;

const HEALTH_CONTEXT = "A lab range is context, not a diagnosis. Changes compare only with the previous recorded result.";

function healthOverview(draws: BloodDraws, outOfRange: MarkerView[], gaps: FlagView[], flags: FlagView[]): HealthView["overview"] {
  if (draws.draws.length === 0 && gaps.length === 0 && flags.length === 0) {
    return { kind: "empty", title: "No health records yet", summary: "Add a blood draw or follow-up to start this view.", note: HEALTH_CONTEXT };
  }
  const parts = [
    outOfRange.length > 0 ? plural(outOfRange.length, "result outside its reported range", "results outside their reported ranges") : null,
    gaps.length > 0 ? plural(gaps.length, "data item", "data items") : null,
    flags.length > 0 ? plural(flags.length, "open follow-up", "open follow-ups") : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0
    ? { kind: "review", title: "Review recorded items", summary: parts.join(" · "), note: HEALTH_CONTEXT }
    : { kind: "clear", title: "Nothing currently flagged", summary: "The latest recorded results are within their reported ranges or were not checked against one.", note: HEALTH_CONTEXT };
}

export function buildHealth(draws: BloodDraws, flags: Flags): HealthView {
  const seen = new Set<string>();
  const outOfRange: MarkerView[] = [];
  const panels: HealthView["panels"] = [];
  // Draws come newest first: the first time a marker appears is its latest value.
  for (const d of draws.draws) {
    const markers: MarkerView[] = [];
    let shown = 0;
    for (const r of d.results) {
      const key = r.marker.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      shown += 1;
      const m = marker(r, d);
      if (r.status === "above" || r.status === "below") outOfRange.push(m);
      else markers.push(m);
    }
    if (shown > 0) panels.push({ title: drawLabel(d), markers, allOutOfRange: markers.length === 0 });
  }
  const open = flags.flags.filter((f) => f.status === "open");
  const view = {
    outOfRange,
    panels,
    gaps: open.filter((f) => f.subtype === "data").map(flagView),
    flags: open.filter((f) => f.subtype !== "data").map(flagView),
  };
  const empty = draws.draws.length === 0 && open.length === 0 ? "No blood draws and no open flags." : null;
  return { overview: healthOverview(draws, view.outOfRange, view.gaps, view.flags), ...view, empty };
}

export interface ReadingRow {
  date: string;
  value: string;
  goal: string;
  weight: string | null;
}

/**
 * Progress's wide table (web decision 66): the lead chart's own text table
 * (each reading and planned goal point by date, as buildTrajectory formats
 * them), newest first, each with the latest 7-day fasted weight the weight
 * chart gives on or before that row's date, within 7 days (weigh-ins and
 * tape readings fall on different days); none in that window is blank. No
 * value is computed: it selects a point the API already gave.
 */
export function readingRows(view: TrajectoryView): ReadingRow[] {
  const weights = [...(view.weight?.table ?? [])].filter((r) => r.reading !== null).sort((a, b) => a.iso.localeCompare(b.iso));
  const weightOn = (iso: string) => weights.filter((w) => w.iso <= iso && w.iso >= addDays(iso, -7)).at(-1)?.reading ?? null;
  return [...(view.chart?.table ?? [])].reverse().map((r) => ({ date: r.date, value: r.reading ?? "no reading", goal: r.goal ?? "no goal point", weight: weightOn(r.iso) }));
}

export interface DrawRow {
  id: number;
  /** "Thyrocare, 1 Oct 2026" (" (draft)" when unconfirmed). */
  title: string;
  date: string;
  lab: string;
  results: string;
  out: string;
  /** Every result of the draw, as the panels word them: an earlier draw opens to its own values (click test P2-22). */
  markers: MarkerView[];
}
/** Health's blood draws, on both layouts: each draw, its result count, how many results the API marked outside the lab's range, and its results. */
export function drawRows(d: BloodDraws): DrawRow[] {
  return d.draws.map((w) => {
    const out = w.results.filter((r) => r.status === "below" || r.status === "above").length;
    // "None out of range" only when every result was checked against one (click test P2-21).
    const unchecked = w.results.filter((r) => r.status === null).length;
    const text =
      unchecked === 0 ? (out === 0 ? "None out of range" : `${out} out of range`)
      : out === 0 && unchecked === w.results.length ? `${unchecked} not checked against a range`
      : `${out === 0 ? "None" : out} out of range, ${unchecked} not checked`;
    return { id: w.id, title: drawLabel(w), date: longDay(w.drawn_on), lab: w.lab, results: plural(w.results.length, "result", "results"), out: text, markers: w.results.map((r) => marker(r, w)) };
  });
}

// ------------------------------------------------------------ The unified summary

/**
 * The Progress overview's view model (spec §Unified Progress read model, 20
 * Oct 2026). Every number comes from progress_summary; this words the signals
 * and chooses the direction hero. It never attributes a cause.
 */
export interface SummarySignal {
  name: "body" | "strength" | "nutrition" | "review";
  title: string;
  /** The one figure the signal leads with, or null when there is nothing to show. */
  value: string | null;
  /** A secondary line: rate, coverage, target. */
  detail: string | null;
  /** A plain note when the data is thin or missing; null when the value speaks. */
  note: string | null;
  /** True when the signal has no data worth showing. */
  empty: boolean;
}

export interface ProgressSummaryView {
  /** The Direction hero: whether the choices are moving the member the way they want. */
  direction: {
    kind: "moving" | "holding" | "away" | "waiting";
    title: string;
    observation: string;
    /** Where the body signal points next, if anywhere. */
    href: { view: ProgressView } | null;
  };
  signals: SummarySignal[];
  next: { view: ProgressView; reason: string };
  comparison: { label: string; from: string; to: string; days: number } | null;
  period: string;
  /** The empty-state words when the whole summary has nothing to show. */
  empty: string | null;
}

const METRIC_TITLES: Record<string, string> = { weight: "Body weight", waist_navel: "Waist at navel", waist_to_height: "Waist to height" };
export const metricTitle = (metric: string) => METRIC_TITLES[metric] ?? metric.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** The drill-down views the next signal can point at, keyed by the Worker's names. */
const DRILL_DOWN: Record<string, { view: ProgressView; label: string }> = {
  flags: { view: "health", label: "Health" },
  nutrition: { view: "nutrition", label: "Nutrition" },
  body: { view: "body", label: "Body" },
};

export const signed = (v: number, decimals = 1): string => `${v > 0 ? "+" : ""}${v.toFixed(decimals)}`;

const daysBetween = (from: string, to: string): number =>
  Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** The Direction hero: the body signal's own words, kinded by whether movement is toward the goal. */
function directionOf(body: ProgressSignals["body"], from: string, unit: string): ProgressSummaryView["direction"] {
  if (body.latest === null) return { kind: "waiting", title: "No reading yet", observation: "Log a reading to see a direction.", href: null };
  if (body.change === null || body.reading_count < 2) {
    return { kind: "waiting", title: "One reading so far", observation: `At ${one(body.latest.value)}${unit} on ${day(body.latest.date)}; there isn't a trend yet.`, href: { view: "body" } };
  }
  const rate = body.rate_per_week;
  const interval = rate === null ? "" : ` (${signed(rate)}${unit} a week)`;
  if (body.change === 0) return { kind: "holding", title: "Holding steady", observation: `${metricTitle(body.metric)} has held across ${plural(body.reading_count, "reading", "readings")}${interval}.`, href: { view: "body" } };
  const moved = body.change > 0 ? "Increased" : "Decreased";
  return {
    kind: "moving",
    // The direction is the member's own goal path; the API says which way is intended, so the hero never guesses.
    title: `${moved} by ${one(Math.abs(body.change))}${unit}`,
    observation: `${metricTitle(body.metric)} across ${plural(body.reading_count, "reading", "readings")}${interval} since ${day(from)}.`,
    href: { view: "body" },
  };
}

function bodySignal(s: ProgressSignals["body"]): SummarySignal {
  const unit = s.latest?.unit ? ` ${s.latest.unit}` : "";
  return {
    name: "body",
    title: metricTitle(s.metric),
    value: s.latest === null ? null : `${one(s.latest.value)}${unit}`,
    detail: s.change === null ? null : `${signed(s.change)}${unit} over the period`,
    note: s.note,
    empty: s.latest === null,
  };
}

function strengthSignal(s: ProgressSignals["strength"]): SummarySignal {
  const best = s.lifts[0];
  return {
    name: "strength",
    title: "Strength",
    value: best === undefined ? null : best.exercise,
    detail:
      best === undefined
        ? null
        : [best.best_e1rm_kg === null ? null : `best e1RM ${one(best.best_e1rm_kg)} kg`, best.change_kg === null ? null : `${signed(best.change_kg)} kg`, plural(best.sessions, "session", "sessions")].filter(Boolean).join(" · "),
    note: s.note ?? (s.lifts.length > 1 ? `${plural(s.lifts.length, "lift", "lifts")} moving.` : null),
    empty: s.lifts.length === 0,
  };
}

function nutritionSignal(s: ProgressSignals["nutrition"]): SummarySignal {
  const coverage = s.coverage === null ? null : pct(s.coverage);
  return {
    name: "nutrition",
    title: "Nutrition",
    value: coverage,
    detail:
      s.average_kcal === null
        ? null
        : `${n(s.average_kcal)} kcal a day${s.target_kcal === null ? "" : ` of ${n(s.target_kcal)}`}${s.adherence_gap_kcal === null ? "" : ` (${signed(s.adherence_gap_kcal, 0)} kcal)`}`,
    note: s.note ?? `${plural(s.logged_days, "logged day", "logged days")} of ${s.days_in_window}.`,
    empty: s.logged_days === 0,
  };
}

function reviewSignal(s: ProgressSignals["review"]): SummarySignal {
  const parts = [
    s.open_flags > 0 ? plural(s.open_flags, "open flag", "open flags") : null,
    s.blood_draws_in_period > 0 ? plural(s.blood_draws_in_period, "blood draw", "blood draws") : null,
  ].filter((p): p is string => p !== null);
  return {
    name: "review",
    title: "Worth reviewing",
    value: parts.length === 0 ? "Nothing outstanding" : parts.join(" · "),
    detail: s.latest_reading_on === null ? null : `latest reading ${day(s.latest_reading_on)}`,
    note: s.note,
    empty: false,
  };
}

/** The comparison strip: the equally long window immediately before the period (spec §Visualization baseline). */
function comparisonOf(range: Range, from: string, to: string): ProgressSummaryView["comparison"] {
  if (range === "all") return null;
  const days = daysBetween(from, to) + 1;
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  return { label: "Previous period", from: prevFrom, to: prevTo, days };
}

export function buildProgressSummary(data: Extract<ProgressSummaryData, { private: false }>): ProgressSummaryView {
  const s = data.summary;
  const body = s.signals.find((x) => x.name === "body") as { name: "body" } & ProgressSignals["body"];
  const strength = s.signals.find((x) => x.name === "strength") as { name: "strength" } & ProgressSignals["strength"];
  const nutrition = s.signals.find((x) => x.name === "nutrition") as { name: "nutrition" } & ProgressSignals["nutrition"];
  const review = s.signals.find((x) => x.name === "review") as { name: "review" } & ProgressSignals["review"];
  const next = s.signals.find((x) => x.name === "next") as { name: "next" } & ProgressSignals["next"];

  const unit = body.latest?.unit ? ` ${body.latest.unit}` : "";
  const signals = [bodySignal(body), strengthSignal(strength), nutritionSignal(nutrition), reviewSignal(review)];
  const everythingEmpty = body.latest === null && strength.lifts.length === 0 && nutrition.logged_days === 0;
  const target = DRILL_DOWN[next.drill_down] ?? DRILL_DOWN.body!;
  return {
    direction: directionOf(body, s.from, unit),
    signals,
    next: { view: target.view, reason: next.reason },
    comparison: comparisonOf(data.range, s.from, s.to),
    period: s.period,
    empty: everythingEmpty ? "Nothing recorded for this period yet. Log a reading or a meal to start the picture." : null,
  };
}
