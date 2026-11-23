import { dateTicks, extent, niceTicks } from "./charts/scale";
import { day, longDay, n, plural, qty } from "./format";
import type { LiftDetail, LiftGoal, LiftTrends, NoE1rm } from "./types";

export interface LiftChartModel {
  title: string; from: string; to: string;
  segments: { date: string; value: number }[][];
  goals: { date: string; value: number; high?: number }[];
  points: { date: string; value: number; draft: boolean }[];
  y: { min: number; max: number; ticks: number[] }; x: { ticks: string[] };
  summary: string;
  table: { date: string; e1rm: string; topSet: string; volume: string; note: string }[];
}
export interface VolumeChartModel {
  title: string; summary: string; from: string; to: string;
  bars: { date: string; value: number | null; incomplete: boolean }[];
  y: { min: number; max: number; ticks: number[] }; x: { ticks: string[] };
  table: { date: string; sessions: string; sets: string; volume: string; note: string }[];
}

const NO_E1RM: Record<NoE1rm, string> = {
  bodyweight_dominant: "Bodyweight-dominant: no comparable e1RM",
  plates_only: "Plate count is known, but total load is not",
  no_reps: "Reps are missing",
  no_rir: "RIR is missing",
  over_cap: "Sets are outside the comparable rep range",
};
const goalText = (goal: LiftGoal | null): string | null => {
  if (!goal) return null;
  if (goal.low !== undefined && goal.high !== undefined) return `Goal ${goal.low === goal.high ? qty(goal.low) : `${qty(goal.low)}–${qty(goal.high)}`} ${goal.unit ?? ""} · ${longDay(goal.week_of)}`.replace("  ", " ");
  if (goal.multiple_low !== undefined && goal.multiple_high !== undefined) return `Goal ${goal.multiple_low === goal.multiple_high ? qty(goal.multiple_low) : `${qty(goal.multiple_low)}–${qty(goal.multiple_high)}`}× bodyweight · ${longDay(goal.week_of)}`;
  return null;
};

export function buildLiftList(data: LiftTrends) {
  const rows = data.weekly_volume;
  const values = rows.flatMap((row) => row.volume_kg === null ? [] : [row.volume_kg]);
  const [, max] = extent([0, ...values], 0.08) ?? [0, 1];
  const latest = rows.at(-1);
  return {
    empty: data.lifts.length === 0 ? "No lifts logged yet." : null,
    lifts: data.lifts.map((lift) => ({
      id: lift.exercise_id, name: lift.exercise, slug: lift.slug, lastDone: day(lift.last_done), sessions: plural(lift.sessions, "session", "sessions"),
      signal: lift.best_e1rm ? `Best e1RM ${qty(lift.best_e1rm.kg)} kg` : lift.best_top_set ? `Best top set ${qty(lift.best_top_set.kg)} kg` : "Track reps and load",
      note: lift.no_e1rm ? NO_E1RM[lift.no_e1rm] : null, goal: goalText(lift.next_goal),
    })),
    volume: {
      title: "Weekly training volume", from: rows[0]?.week_start ?? "", to: latest?.week_start ?? "",
      bars: rows.map((row) => ({ date: row.week_start, value: row.volume_kg, incomplete: row.sets_without_volume > 0 })),
      y: { min: 0, max, ticks: niceTicks(0, max, 4) }, x: { ticks: rows.length ? dateTicks(rows[0]!.week_start, latest!.week_start, 4) : [] },
      summary: latest ? `Weekly training volume: latest week has ${plural(latest.sessions, "session", "sessions")} and ${plural(latest.working_sets, "working set", "working sets")}${latest.sets_without_volume ? `; ${plural(latest.sets_without_volume, "set", "sets")} has no comparable volume` : ""}.` : "No weekly training volume yet.",
      table: rows.map((row) => ({ date: day(row.week_start), sessions: String(row.sessions), sets: String(row.working_sets), volume: row.volume_kg === null ? "—" : `${n(row.volume_kg)} kg`, note: row.sets_without_volume ? `${plural(row.sets_without_volume, "set", "sets")} without comparable volume` : "" })),
    } satisfies VolumeChartModel,
  };
}

export function buildLiftDetail(data: LiftDetail) {
  const valid = data.points.flatMap((point) => point.e1rm ? [{ date: point.date, value: point.e1rm.kg, segment: point.segment, draft: point.state === "draft" }] : []);
  const segmentIds = [...new Set(valid.map((point) => point.segment))];
  const segments = segmentIds.map((id) => valid.filter((point) => point.segment === id).map(({ date, value }) => ({ date, value })));
  const absoluteGoals = data.goals.flatMap((goal) => goal.low === undefined || goal.high === undefined ? [] : [{ date: goal.week_of, value: goal.low, ...(goal.high === goal.low ? {} : { high: goal.high }) }]);
  const axisValues = [...valid.map((point) => point.value), ...absoluteGoals.flatMap((goal) => goal.high === undefined ? [goal.value] : [goal.value, goal.high])];
  const [min, max] = extent(axisValues, 0.1) ?? [0, 1];
  const first = valid[0];
  const last = valid.at(-1);
  const from = data.points[0]?.date ?? absoluteGoals[0]?.date ?? "";
  const to = [data.points.at(-1)?.date, absoluteGoals.at(-1)?.date].filter((value): value is string => !!value).sort().at(-1) ?? from;
  const insight = first && last
    ? last.value === first.value
      ? `Holding at ${qty(last.value)} kg across ${plural(data.points.length, "session", "sessions")}`
      : `${last.value > first.value ? "Up" : "Down"} ${qty(Math.abs(last.value - first.value))} kg across ${plural(data.points.length, "session", "sessions")}`
    : `${plural(data.points.length, "session", "sessions")} logged`;
  return {
    title: data.exercise, insight,
    chart: {
      title: "Estimated 1RM", from, to, segments, goals: absoluteGoals, points: valid.map(({ date, value, draft }) => ({ date, value, draft })),
      y: { min, max, ticks: niceTicks(min, max, 4) }, x: { ticks: from && to ? dateTicks(from, to, 4) : [] },
      summary: last ? `${data.exercise}: ${qty(last.value)} kg estimated 1RM on ${day(last.date)} across ${plural(data.points.length, "session", "sessions")}.` : `${data.exercise}: No comparable estimated 1RM. ${plural(data.points.length, "session", "sessions")} logged.`,
      table: data.points.map((point) => ({
        date: day(point.date), e1rm: point.e1rm ? `${qty(point.e1rm.kg)} kg` : "—", topSet: point.top_set ? `${qty(point.top_set.total_kg)} kg${point.top_set.reps === null ? "" : ` × ${point.top_set.reps}`}` : "—", volume: point.volume_kg === null ? "—" : `${n(point.volume_kg)} kg`,
        note: [point.state === "draft" ? "Draft" : "", point.e1rm?.reps_assumed ? "reps inferred" : "", point.sets_without_volume ? `${plural(point.sets_without_volume, "set", "sets")} without volume` : ""].filter(Boolean).join(" · "),
      })),
    } satisfies LiftChartModel,
    methodChanges: data.method_changes.map((change) => `${day(change.date)} · ${change.note}`),
    bodyweightGoals: data.goals.filter((goal) => goal.multiple_low !== undefined).map(goalText).filter((value): value is string => value !== null),
  };
}
