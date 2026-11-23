import { goalVerdict, implausibleReading, isRealChange, sevenDayAverage, trendSegments, waistToHeight, weekStart } from "@myfitnessguide/domain";
import { z } from "zod";
import type { Ctx, Member } from "../context";
import { all, first } from "../db";
import { draftsAbout, householdDrafts } from "../drafts";
import { Clarify, ToolError } from "../errors";
import { findGoalPoint, goalPointRow } from "../goals";
import { fuzzyRank } from "../fuzzy";
import { readTool, writeTool, type Tool } from "../tool";

/** Who took a reading (migration 0008's CHECK); log_reading and amend both take these. */
export const MEASURERS = ["self", "member", "professional", "not_recorded"] as const;

const GROUP = "body";
const date = z.iso.date();

/** The same conversion v_reading uses: to kg, cm, mmHg, bpm, h, pct or score. */
const FACTOR: Record<string, number> = { lb: 0.45359237, mm: 0.1, in: 2.54, min: 1 / 60 };
const CANONICAL: Record<string, string> = { mass: "kg", length: "cm", pressure: "mmHg", heart_rate: "bpm", duration: "h", percent: "pct", score: "score", energy: "kcal" };
export const canonical = (value: number, unit: string) => value * (FACTOR[unit] ?? 1);

interface ReadingRow {
  id: number;
  member_id: number;
  metric: string;
  measured_on: string;
  value: number;
  unit: string;
  body_state: string;
  resolution: number | null;
  state: string;
  [key: string]: unknown;
}

/** Owner-only: a member may read and write only their own; the agent anything. */
async function ownMember(ctx: Ctx, ref: string, kind: "reading" | "blood_draw" | "flag"): Promise<Member> {
  const member = await ctx.member(ref);
  ctx.assertCanSee(kind, member.id);
  return member;
}

async function methodChanges(ctx: Ctx, memberId: number, metric: string) {
  return all<{ changed_on: string; note: string }>(ctx.db, "SELECT changed_on, note FROM method_change WHERE member_id = ? AND metric = ? ORDER BY changed_on", memberId, metric);
}

/** A number as a question says it: at most one decimal. */
const said = (v: number) => String(Math.round(v * 10) / 10);

/**
 * The plausibility question for a reading (click test P1-2), or null: the
 * domain's bounds and last-reading ratio (implausibleReading), worded with
 * the unit that would have fitted when one does ("Did you mean 94 cm?").
 * Answered by sending the same reading with implausible_ok: true. Used by
 * log_reading and by amend of a reading's value or unit.
 */
export async function readingQuestion(
  ctx: Ctx,
  r: { member_id: number; metric: string; label: string; dimension: string; value: number; unit: string; side: string | null; measured_on: string; id?: number; newSegment?: boolean },
  path: (string | number)[],
): Promise<Clarify | null> {
  const value = canonical(r.value, r.unit);
  let previous: { value: number; unit: string; measured_on: string } | null = null;
  if (!r.newSegment) {
    const changes = (await methodChanges(ctx, r.member_id, r.metric)).map((c) => c.changed_on).filter((d) => d <= r.measured_on);
    const segmentStart = changes.sort().at(-1) ?? "0000-01-01";
    previous =
      (await first<{ value: number; unit: string; measured_on: string }>(
        ctx.db,
        `SELECT value, unit, measured_on FROM reading WHERE member_id = ? AND metric = ? AND state = 'confirmed' AND measured_on <= ? AND measured_on >= ?
           AND coalesce(side, '') = ? AND id <> ? ORDER BY measured_on DESC, id DESC LIMIT 1`,
        r.member_id, r.metric, r.measured_on, segmentStart, r.side ?? "", r.id ?? -1,
      )) ?? null;
  }
  const prev = previous ? canonical(previous.value, previous.unit) : null;
  const found = implausibleReading(r.metric, value, prev);
  if (!found) return null;
  const canon = CANONICAL[r.dimension] ?? r.unit;
  const typed = `${said(r.value)} ${r.unit}${r.unit === canon ? "" : ` (${said(value)} ${canon})`}`;
  const name = r.label.charAt(0).toLowerCase() + r.label.slice(1);
  const units = (await all<{ code: string }>(ctx.db, "SELECT code FROM unit WHERE dimension = ? ORDER BY code", r.dimension)).map((u) => u.code);
  const fits = units.find((u) => u !== r.unit && implausibleReading(r.metric, canonical(r.value, u), prev) === null);
  // Readings are owner-only: a speaker who isn't the reading's member (the agent logging a draft for
  // someone else) is never told the earlier value or its date.
  const own = ctx.writeInfo.speaker?.id === r.member_id;
  const why =
    found.kind === "out_of_range"
      ? `${typed} is outside the range a ${name} can be (${said(found.low)} to ${said(found.high)} ${canon}).`
      : own
        ? `${typed} is far from the last ${name}, ${said(previous!.value)} ${previous!.unit} on ${previous!.measured_on}.`
        : `${typed} is far from the last ${name} reading.`;
  const ask = fits ? ` Did you mean ${said(r.value)} ${fits}? If ${said(r.value)} ${r.unit} is right, say so.` : " Is it right?";
  const shown = found.kind === "far_from_last" && !own ? { kind: found.kind } : found;
  return new Clarify("implausible_reading", why + ask, [], path, { implausible: shown });
}

const logReading = writeTool({
  name: "log_reading",
  group: GROUP,
  description:
    "Log one body reading (weight, tape sites, skinfolds, BIA, BP, resting HR, sleep, height) with its unit, body state, resolution, measurer and method. method_change starts a new method segment from this date. Returns the canonical value, the 7-day fasted average for weight, whether it is a real change (beyond one resolution step), and waist:height from the stored height. Owner-only.",
  input: {
    member: z.string().min(1),
    date,
    time: z.string().regex(/^\d{2}:\d{2}:\d{2}$/, "HH:MM:SS").optional(),
    metric: z.string().min(1),
    value: z.number(),
    unit: z.string().min(1),
    body_state: z.enum(["fasted", "fed", "post_exercise", "not_recorded"]),
    side: z.enum(["left", "right"]).optional(),
    resolution: z.number().positive().optional().describe("The instrument's step, in the reading's unit."),
    measurer: z.enum(MEASURERS).optional().describe("Default self."),
    measurer_member: z.string().optional(),
    method: z.string().optional(),
    conditions: z.string().optional(),
    suspect_reason: z.string().min(1).optional(),
    method_change: z.string().min(1).optional().describe("Note for a method change starting on this date."),
    note: z.string().optional(),
    implausible_ok: z.literal(true).optional().describe("The member says a value outside its metric's plausible range (or far from their last reading) is right; without it such a value asks first."),
  },
  async run(ctx, input) {
    const member = await ownMember(ctx, input.member, "reading");
    ctx.onBehalfOf(member.id);
    const metrics = await all<{ code: string; label: string; dimension: string }>(ctx.db, "SELECT code, label, dimension FROM metric ORDER BY code");
    const metric = metrics.find((m) => m.code === input.metric.trim().toLowerCase());
    if (!metric) {
      const options = fuzzyRank(input.metric, metrics.map((m) => ({ item: m.code, names: [m.code, m.code.replace(/_/g, " ")] })));
      throw new Clarify("unknown_metric", `Which metric is ${input.metric}?`, options.length > 0 ? options : metrics.map((m) => m.code), ["metric"]);
    }
    if (metric.code === "waist_to_height") {
      throw new Clarify("computed_metric", "Waist to height is computed from the waist and the stored height; log the waist (waist_navel) or the height instead.", ["waist_navel", "height"], ["metric"]);
    }
    const units = (await all<{ code: string }>(ctx.db, "SELECT code FROM unit WHERE dimension = ? ORDER BY code", metric.dimension)).map((u) => u.code);
    if (!units.includes(input.unit)) throw new Clarify("unit_mismatch", `${metric.code} is measured in ${units.join(" or ")}; which was it?`, units, ["unit"]);
    const measurer = input.measurer ?? "self";
    let measurerMember: Member | null = null;
    if (measurer === "member") {
      if (!input.measurer_member) throw new Clarify("measurer_needed", "Which member took the measurement?", (await ctx.members()).map((m) => m.name), ["measurer_member"]);
      measurerMember = await ctx.member(input.measurer_member, ["measurer_member"]);
    }
    // An implausible value asks before anything is written (click test P1-2); the importer's history is taken as it is.
    if (!input.implausible_ok && ctx.writeInfo.origin !== "import") {
      const ask = await readingQuestion(
        ctx,
        { member_id: member.id, metric: metric.code, label: metric.label, dimension: metric.dimension, value: input.value, unit: input.unit, side: input.side ?? null, measured_on: input.date, newSegment: input.method_change !== undefined },
        ["implausible_ok"],
      );
      if (ask) throw ask;
    }
    const tx = ctx.txOrThrow;
    const stamp = ctx.stamp(ctx.stateFor(member.id));
    const row = {
      member_id: member.id, metric: metric.code, measured_on: input.date, measured_at_time: input.time ?? null, value: input.value,
      unit: input.unit, side: input.side ?? null, body_state: input.body_state, resolution: input.resolution ?? null, measurer,
      measurer_member_id: measurerMember?.id ?? null, method: input.method ?? null, conditions: input.conditions ?? null,
      suspect: input.suspect_reason ? 1 : 0, suspect_reason: input.suspect_reason ?? null, note: input.note ?? null, ...stamp,
    };
    const id = await tx.create("reading", row);
    if (input.method_change) {
      await tx.create("method_change", { member_id: member.id, metric: metric.code, exercise_id: null, changed_on: input.date, note: input.method_change });
    }

    // Computed from history plus this reading, within its method segment.
    const changes = (await methodChanges(ctx, member.id, metric.code)).map((c) => c.changed_on);
    if (input.method_change) changes.push(input.date);
    const segmentStart = changes.filter((d) => d <= input.date).sort().at(-1) ?? null;
    const history = await all<ReadingRow>(
      ctx.db,
      "SELECT * FROM reading WHERE member_id = ? AND metric = ? AND state = 'confirmed' AND measured_on <= ? ORDER BY measured_on, id",
      member.id,
      metric.code,
      input.date,
    );
    const value = canonical(input.value, input.unit);
    const previous = history.filter((h) => (segmentStart === null || h.measured_on >= segmentStart) && (h.side ?? null) === (input.side ?? null)).at(-1);
    let change = null;
    if (previous) {
      const prev = canonical(previous.value, previous.unit);
      const resolution = input.resolution !== undefined ? canonical(input.resolution, input.unit) : null;
      change = {
        previous: prev, previous_on: previous.measured_on, delta: value - prev,
        real_change: resolution === null ? null : isRealChange(prev, value, resolution),
      };
    }
    const computed: Record<string, unknown> = { change };
    if (metric.code === "weight") {
      const fasted = [...history, row as unknown as ReadingRow]
        .filter((h) => h.body_state === "fasted")
        .map((h) => ({ date: h.measured_on, value: canonical(h.value, h.unit), fasted: true }));
      computed.seven_day_average_kg = sevenDayAverage(fasted, input.date, changes);
    }
    if (metric.code === "waist_navel") {
      const height = await first<{ value: number; unit: string }>(
        ctx.db,
        "SELECT value, unit FROM reading WHERE member_id = ? AND metric = 'height' AND state = 'confirmed' AND measured_on <= ? ORDER BY measured_on DESC, id DESC LIMIT 1",
        member.id,
        input.date,
      );
      computed.waist_to_height = height ? waistToHeight(value, canonical(height.value, height.unit)) : null;
    }
    return {
      reading: { id, member: member.name, ...row, value_canonical: value, canonical_unit: CANONICAL[metric.dimension] },
      computed,
    };
  },
});

interface GoalRow {
  week_of: string;
  tier: "planned" | "stretch";
  value_low: number;
  value_high: number;
  unit: string | null;
  note: string | null;
}

async function goalRows(ctx: Ctx, memberId: number, metric: string): Promise<GoalRow[]> {
  return all<GoalRow>(
    ctx.db,
    "SELECT week_of, tier, value_low, value_high, unit, note FROM goal_point WHERE member_id = ? AND metric = ? AND basis = 'absolute' ORDER BY week_of, tier, id",
    memberId,
    metric,
  );
}

/** A goal point's middle, in the metric's canonical unit. */
const goalMid = (g: GoalRow) => canonical((g.value_low + g.value_high) / 2, g.unit ?? "");

/** The latest confirmed height on or before a date, in cm. */
async function heightOn(ctx: Ctx, memberId: number, on: string): Promise<{ cm: number; measured_on: string } | null> {
  const h = await first<{ value: number; unit: string; measured_on: string }>(
    ctx.db,
    "SELECT value, unit, measured_on FROM reading WHERE member_id = ? AND metric = 'height' AND state = 'confirmed' AND measured_on <= ? ORDER BY measured_on DESC, id DESC LIMIT 1",
    memberId,
    on,
  );
  return h ? { cm: canonical(h.value, h.unit), measured_on: h.measured_on } : null;
}

async function currentPhase(ctx: Ctx, memberId: number, on: string) {
  return (
    (await first<{ name: string; starts_on: string; ends_on: string | null; energy_stance: string }>(
      ctx.db,
      "SELECT name, starts_on, ends_on, energy_stance FROM phase WHERE member_id = ? AND starts_on <= ? AND coalesce(ends_on, '9999-12-31') >= ? ORDER BY starts_on DESC LIMIT 1",
      memberId,
      on,
      on,
    )) ?? null
  );
}

/** Which metric Progress leads with (spec §6): waist:height, else the first planned goal metric, else none. */
async function headlineOf(ctx: Ctx, memberId: number, height: { cm: number } | null) {
  const ratioGoal = await first<{ id: number }>(ctx.db, "SELECT id FROM goal_point WHERE member_id = ? AND metric = 'waist_to_height' LIMIT 1", memberId);
  if (height && ratioGoal) return { metric: "waist_to_height", direction: "decrease" as const, reason: null };
  const firstPlanned = await first<{ metric: string }>(
    ctx.db,
    `SELECT metric FROM goal_point WHERE member_id = ? AND metric IS NOT NULL AND metric <> 'waist_to_height' AND tier = 'planned' AND basis = 'absolute'
     ORDER BY headline DESC, week_of, id LIMIT 1`,
    memberId,
  );
  if (!firstPlanned) return { metric: null, direction: null, reason: "No planned goal points yet." };
  const path = (await goalRows(ctx, memberId, firstPlanned.metric)).filter((g) => g.tier === "planned");
  const start = path[0];
  const end = path.at(-1);
  const direction = start && end && goalMid(end) > goalMid(start) ? ("increase" as const) : ("decrease" as const);
  return { metric: firstPlanned.metric, direction, reason: height ? "No waist:height goal is stored." : "No height is stored." };
}

const bodyTrends = readTool({
  name: "body_trends",
  group: GROUP,
  description:
    "A member's readings of one metric over time in canonical units, split into segments at method changes (no trend crosses one), with 7-day fasted averages for weight and the goal verdict against the week's goal point when a direction is given. metric may be omitted or \"headline\": the metric Progress leads with is resolved here (waist:height reads the waist) and the answer is for it. Also: goal_points (planned and stretch), current_week (this week's verdict whatever the range: no_goal_point, no_reading, on_track, ahead or behind), current_phase, headline, canonical_unit, and for waist_navel a waist_to_height block (ratio per reading from the stored height, goal path, stored ratio goals, band, and its own current_week). Owner-only.",
  input: {
    member: z.string().min(1),
    metric: z.string().min(1).optional().describe('A metric code, or "headline" (the default): the metric Progress leads with, resolved here.'),
    from: date.optional(),
    to: date.optional(),
    direction: z.enum(["increase", "decrease"]).optional().describe("Which way is good, for the goal verdict."),
    band: z.number().positive().optional(),
  },
  async run(ctx, input) {
    const member = await ownMember(ctx, input.member, "reading");
    const today = ctx.today();
    // The stored height is read once: for the headline and the waist:height block.
    const height = await heightOn(ctx, member.id, today);
    const headline = await headlineOf(ctx, member.id, height);
    const asked = (input.metric ?? "headline").trim().toLowerCase();
    // "headline": the metric Progress leads with, answered in this same call (waist:height reads the waist).
    const resolved = asked === "headline" ? (headline.metric === "waist_to_height" ? "waist_navel" : headline.metric) : asked;
    const direction = input.direction ?? (asked === "headline" ? (headline.direction ?? undefined) : undefined);
    if (resolved === null) {
      return { member: member.name, metric: null, headline, segments: [], method_changes: [], goal_points: [], end_target: null, current_phase: await currentPhase(ctx, member.id, today), canonical_unit: null, waist_to_height: null };
    }
    const metric = resolved;
    // Confirmed readings only: a draft (someone else's unconfirmed reading) lives in Drafts to check, and
    // moves no trend, headline or verdict until it is confirmed (decision 122).
    const rows = await all<ReadingRow>(
      ctx.db,
      "SELECT * FROM reading WHERE member_id = ? AND metric = ? AND state = 'confirmed' AND measured_on >= ? AND measured_on <= ? ORDER BY measured_on, id",
      member.id,
      metric,
      input.from ?? "0000-01-01",
      input.to ?? "9999-12-31",
    );
    const changes = await methodChanges(ctx, member.id, metric);
    const readings = rows.map((r) => ({
      id: r.id, date: r.measured_on, value: r.value, unit: r.unit, value_canonical: canonical(r.value, r.unit),
      body_state: r.body_state, suspect: r.suspect === 1, state: r.state, note: r.note,
    }));
    const segments = trendSegments(readings, changes.map((c) => c.changed_on)).map((s) => ({ start: s[0]?.date ?? null, readings: s }));
    const out: Record<string, unknown> = {
      member: member.name, metric, segments, method_changes: changes.map((c) => ({ date: c.changed_on, note: c.note })),
    };
    if (metric === "weight") {
      const fasted = readings.filter((r) => r.body_state === "fasted").map((r) => ({ date: r.date, value: r.value_canonical, fasted: true }));
      const days = [...new Set(fasted.map((f) => f.date))];
      out.seven_day_averages = days.map((d) => ({ date: d, average_kg: sevenDayAverage(fasted, d, changes.map((c) => c.changed_on)) }));
    }
    out.headline = headline;
    const fromWeek = input.from ? weekStart(input.from) : "0000-01-01";
    const toWeek = input.to ?? "9999-12-31";
    const inRange = (week: string) => week >= fromWeek && week <= toWeek;
    const goals = await goalRows(ctx, member.id, metric);
    const planned = goals.filter((g) => g.tier === "planned").map((g) => ({ date: g.week_of, value: goalMid(g) }));
    out.goal_points = goals.filter((g) => inRange(g.week_of)).map((g) => ({
      week_of: g.week_of, tier: g.tier, low: canonical(g.value_low, g.unit ?? ""), high: canonical(g.value_high, g.unit ?? ""), note: g.note,
    }));
    // The end target, whatever range is asked: the last planned goal point.
    const lastPlanned = goals.filter((g) => g.tier === "planned").at(-1);
    out.end_target = lastPlanned
      ? { week_of: lastPlanned.week_of, low: canonical(lastPlanned.value_low, lastPlanned.unit ?? ""), high: canonical(lastPlanned.value_high, lastPlanned.unit ?? "") }
      : null;
    out.current_phase = await currentPhase(ctx, member.id, today);
    const dimension = (await first<{ dimension: string }>(ctx.db, "SELECT dimension FROM metric WHERE code = ?", metric))?.dimension;
    out.canonical_unit = dimension ? (CANONICAL[dimension] ?? null) : null;

    // The old verdict, unchanged: the latest week with a reading in the range (input.direction only, as before).
    if (input.direction) {
      out.goal = goalVerdict(
        readings.map((r) => ({ date: r.date, value: r.value_canonical })),
        planned,
        input.band === undefined ? { direction: input.direction } : { direction: input.direction, band: input.band },
      );
    }

    // Every reading up to today, whatever the range: the current week's verdict reads these.
    const everything = (
      await all<ReadingRow>(ctx.db, "SELECT * FROM reading WHERE member_id = ? AND metric = ? AND state = 'confirmed' AND measured_on <= ? ORDER BY measured_on, id", member.id, metric, today)
    ).map((r) => ({ date: r.measured_on, value: canonical(r.value, r.unit) }));
    if (direction) {
      out.current_week = goalVerdict(everything, planned, input.band === undefined ? { direction, asOf: today } : { direction, band: input.band, asOf: today });
    }

    if (metric === "waist_navel") out.waist_to_height = null;
    if (metric === "waist_navel" && height) {
      const ratio = (cm: number) => waistToHeight(cm, height.cm);
      const stored = await goalRows(ctx, member.id, "waist_to_height");
      const path = new Map<string, number>();
      for (const g of planned) path.set(weekStart(g.date), ratio(g.value));
      for (const g of stored.filter((s) => s.tier === "planned")) path.set(weekStart(g.week_of), (g.value_low + g.value_high) / 2);
      const fullPath = [...path.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([week_of, value]) => ({ week_of, value }));
      const band = (input.band ?? 1.0) / height.cm;
      const lastStored = stored.filter((g) => g.tier === "planned").at(-1);
      out.waist_to_height = {
        height_cm: height.cm,
        height_measured_on: height.measured_on,
        segments: trendSegments(readings.map((r) => ({ date: r.date, value: ratio(r.value_canonical) })), changes.map((c) => c.changed_on)).map((s) => ({ start: s[0]?.date ?? null, readings: s })),
        goal_path: fullPath.filter((g) => inRange(g.week_of)),
        goal_points: stored.filter((g) => inRange(g.week_of)).map((g) => ({ week_of: g.week_of, tier: g.tier, low: g.value_low, high: g.value_high })),
        end_target: lastStored ? { week_of: lastStored.week_of, low: lastStored.value_low, high: lastStored.value_high } : null,
        band,
        current_week: goalVerdict(
          everything.map((r) => ({ date: r.date, value: ratio(r.value) })),
          fullPath.map((g) => ({ date: g.week_of, value: g.value })),
          { direction: direction ?? "decrease", band, asOf: today },
        ),
      };
    }

    return out;
  },
});

/** Computed from other readings, so never logged: log_reading refuses it. */
export const COMPUTED_METRICS: readonly string[] = ["waist_to_height"];
/**
 * Units only a computed metric uses. 0028 put `ratio` under the `score`
 * dimension for waist to height alone, so joining units by dimension would
 * offer it for every score metric (bia_visceral_fat: ratio, score).
 */
const COMPUTED_UNITS = ["ratio"];

/** How many of the member's latest readings reading_metrics lists to fix. */
const RECENT_READINGS = 30;

const readingMetrics = readTool({
  name: "reading_metrics",
  group: GROUP,
  description:
    "What a member can log with log_reading: every metric with its label and the units the metric table allows for it (computed metrics, such as waist to height, and their ratio unit left out), the sides the member has logged it on, their last reading of it, and their usual unit for it (the unit their readings of it use most, the more recent on a tie; with none, the canonical unit). Also `recent`: their latest 30 confirmed readings, newest first, with ids, to amend or retract. Five statements, whatever the history. Owner-only.",
  input: { member: z.string().min(1) },
  async run(ctx, input) {
    const member = await ownMember(ctx, input.member, "reading");
    const rows = await all<{ code: string; label: string; dimension: string; unit: string }>(
      ctx.db,
      `SELECT m.code, m.label, m.dimension, u.code AS unit FROM metric m JOIN unit u ON u.dimension = m.dimension
       WHERE m.code NOT IN (${COMPUTED_METRICS.map(() => "?").join(", ")})
         AND u.code NOT IN (${COMPUTED_UNITS.map(() => "?").join(", ")})
       ORDER BY m.code, u.code`,
      ...COMPUTED_METRICS,
      ...COMPUTED_UNITS,
    );
    const last = await all<{ metric: string; measured_on: string; value: number; unit: string; body_state: string; side: "left" | "right" | null }>(
      ctx.db,
      `SELECT metric, measured_on, value, unit, body_state, side FROM (
         SELECT r.*, row_number() OVER (PARTITION BY r.metric ORDER BY r.measured_on DESC, r.id DESC) AS rn FROM reading r WHERE r.member_id = ? AND r.state = 'confirmed'
       ) WHERE rn = 1`,
      member.id,
    );
    // The usual unit per metric (click test P1-2): the one the member's readings of it use most, the more recent on a tie.
    const used = await all<{ metric: string; unit: string; n: number; latest: string }>(
      ctx.db,
      "SELECT metric, unit, count(*) AS n, max(measured_on) AS latest FROM reading WHERE member_id = ? AND state = 'confirmed' GROUP BY metric, unit",
      member.id,
    );
    const sides = await all<{ metric: string; side: "left" | "right" }>(
      ctx.db,
      "SELECT DISTINCT metric, side FROM reading WHERE member_id = ? AND side IS NOT NULL ORDER BY metric, side",
      member.id,
    );
    // The member's latest confirmed readings with their ids, for the app's Edit and Remove (click test P1-3).
    const recent = await all<{ id: number; metric: string; date: string; value: number; unit: string; side: "left" | "right" | null; body_state: string; note: string | null }>(
      ctx.db,
      `SELECT id, metric, measured_on AS date, value, unit, side, body_state, note FROM reading
       WHERE member_id = ? AND state = 'confirmed' ORDER BY measured_on DESC, id DESC LIMIT ${RECENT_READINGS}`,
      member.id,
    );
    const metrics = new Map<string, { code: string; label: string; dimension: string; units: string[] }>();
    for (const r of rows) {
      const m = metrics.get(r.code) ?? { code: r.code, label: r.label, dimension: r.dimension, units: [] };
      m.units.push(r.unit);
      metrics.set(r.code, m);
    }
    return {
      member: member.name,
      metrics: [...metrics.values()].map((m) => {
        const l = last.find((x) => x.metric === m.code);
        const usual = used
          .filter((u) => u.metric === m.code && m.units.includes(u.unit))
          .sort((a, b) => b.n - a.n || b.latest.localeCompare(a.latest))[0]?.unit;
        const canon = CANONICAL[m.dimension];
        return {
          ...m,
          sides: sides.filter((s) => s.metric === m.code).map((s) => s.side),
          usual_unit: usual ?? (canon && m.units.includes(canon) ? canon : (m.units.length === 1 ? m.units[0] : null)),
          last: l ? { date: l.measured_on, value: l.value, unit: l.unit, body_state: l.body_state, side: l.side } : null,
        };
      }),
      recent,
    };
  },
});


const RESULT = z
  .object({
    marker: z.string().min(1),
    value: z.number().optional(),
    comparator: z.enum(["<", "<=", ">", ">="]).optional(),
    value_text: z.string().min(1).optional().describe("A qualitative result."),
    unit: z.string().min(1).optional(),
    ref_low: z.number().optional(),
    ref_high: z.number().optional(),
    ref_text: z.string().optional(),
    note: z.string().optional(),
  })
  .strict();

/** The same status v_lab_result gives: only plain numeric values against that lab's range. */
function labStatus(r: { value?: number | null; comparator?: string | null; ref_low?: number | null; ref_high?: number | null }): string | null {
  if (r.value === undefined || r.value === null || (r.comparator ?? null) !== null) return null;
  if (r.ref_low !== undefined && r.ref_low !== null && r.value < r.ref_low) return "below";
  if (r.ref_high !== undefined && r.ref_high !== null && r.value > r.ref_high) return "above";
  if ((r.ref_low ?? null) !== null || (r.ref_high ?? null) !== null) return "within";
  return null;
}

/** SQLite's NOCASE and lower() fold ASCII only; so does this key, so a marker matches as it did. */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * Each marker's latest plain numeric result before a date, for every
 * marker at once: one statement, whatever the panel (decision 96).
 */
async function previousResults(ctx: Ctx, memberId: number, markers: readonly string[], before: string): Promise<Map<string, { value: number; drawn_on: string }>> {
  if (markers.length === 0) return new Map();
  const rows = await all<{ key: string; value: number; drawn_on: string }>(
    ctx.db,
    `SELECT key, value, drawn_on FROM (
       SELECT lower(r.marker) AS key, r.value, d.drawn_on,
              row_number() OVER (PARTITION BY lower(r.marker) ORDER BY d.drawn_on DESC, r.id DESC) AS rn
       FROM lab_result r JOIN blood_draw d ON d.id = r.draw_id
       WHERE d.member_id = ? AND d.drawn_on < ? AND r.value IS NOT NULL AND r.comparator IS NULL
         AND r.marker COLLATE NOCASE IN (SELECT value FROM json_each(?))
     ) WHERE rn = 1`,
    memberId,
    before,
    JSON.stringify([...new Set(markers)]),
  );
  return new Map(rows.map((r) => [r.key, { value: r.value, drawn_on: r.drawn_on }]));
}

const logBloodDraw = writeTool({
  name: "log_blood_draw",
  group: GROUP,
  description: "Log a blood draw (date, lab, fasting) and its results, each with that lab's reference range. Returns each result's status and its change from the previous draw. Owner-only.",
  input: { member: z.string().min(1), date, lab: z.string().min(1), fasting: z.boolean().optional(), note: z.string().optional(), results: z.array(RESULT).min(1) },
  async run(ctx, input) {
    const member = await ownMember(ctx, input.member, "blood_draw");
    ctx.onBehalfOf(member.id);
    const tx = ctx.txOrThrow;
    const stamp = ctx.stamp(ctx.stateFor(member.id));
    // Every question before anything is staged, in the results' order, as before.
    const seen = new Set<string>();
    for (const [i, r] of input.results.entries()) {
      if (r.value === undefined && r.value_text === undefined) throw new Clarify("result_value_needed", `What was the ${r.marker} result?`, [], ["results", i]);
      if (r.value !== undefined && r.unit === undefined) throw new Clarify("result_unit_needed", `In what unit was ${r.marker}?`, [], ["results", i, "unit"]);
      if (seen.has(r.marker.toLowerCase())) throw new Clarify("duplicate_marker", `${r.marker} appears twice; which value is right?`, [], ["results", i]);
      seen.add(r.marker.toLowerCase());
    }
    const plain = (r: (typeof input.results)[number]) => r.value !== undefined && r.comparator === undefined;
    // A constant number of statements, whatever the panel (decision 96): every previous result in one
    // read, both tables' ids in one, the draw, every result in one insert, their versions at finish().
    const previous = await previousResults(ctx, member.id, input.results.filter(plain).map((r) => r.marker), input.date);
    await tx.reserve(["blood_draw", "lab_result"]);
    const draw = { member_id: member.id, drawn_on: input.date, lab: input.lab, fasting: input.fasting === undefined ? null : input.fasting ? 1 : 0, note: input.note ?? null, ...stamp };
    const drawId = await tx.create("blood_draw", draw);
    // Every row names every column (nulls included), so createMany makes one statement.
    const rows = input.results.map((r) => ({
      draw_id: drawId, marker: r.marker, value: r.value ?? null, comparator: r.comparator ?? null, value_text: r.value_text ?? null,
      unit: r.unit ?? null, ref_low: r.ref_low ?? null, ref_high: r.ref_high ?? null, ref_text: r.ref_text ?? null, note: r.note ?? null,
    }));
    const ids = await tx.createMany("lab_result", rows);
    const results = input.results.map((r, i) => {
      const prev = plain(r) ? (previous.get(asciiLower(r.marker)) ?? null) : null;
      return {
        id: ids[i] as number, ...(rows[i] as (typeof rows)[number]), status: labStatus(r),
        change: prev ? { previous: prev.value, previous_on: prev.drawn_on, delta: (r.value as number) - prev.value } : null,
      };
    });
    return { draw: { id: drawId, member: member.name, drawn_on: input.date, lab: input.lab, state: stamp.state }, results };
  },
});

const bloodDraws = readTool({
  name: "blood_draws",
  group: GROUP,
  description: "A member's blood draws, newest first, with each result's status against that lab's range and its change since the previous draw. Owner-only.",
  input: { member: z.string().min(1), marker: z.string().optional() },
  async run(ctx, input) {
    const member = await ownMember(ctx, input.member, "blood_draw");
    const draws = await all<{ id: number; drawn_on: string; lab: string; fasting: number | null; state: string; note: string | null }>(
      ctx.db,
      "SELECT id, drawn_on, lab, fasting, state, note FROM blood_draw WHERE member_id = ? ORDER BY drawn_on DESC, id DESC",
      member.id,
    );
    const results = await all<Record<string, unknown> & { draw_id: number; marker: string; value: number | null; comparator: string | null }>(
      ctx.db,
      "SELECT r.* FROM lab_result r JOIN blood_draw d ON d.id = r.draw_id WHERE d.member_id = ? ORDER BY r.id",
      member.id,
    );
    const plain = (r: { value: number | null; comparator: string | null }) => typeof r.value === "number" && r.comparator === null;
    const out = [];
    for (const d of draws) {
      const own = results.filter((r) => r.draw_id === d.id);
      const filtered = input.marker ? own.filter((r) => r.marker.toLowerCase() === input.marker?.toLowerCase()) : own;
      out.push({
        ...d,
        results: filtered.map((r) => {
          let change = null;
          if (plain(r)) {
            const earlier = draws.filter((o) => o.drawn_on < d.drawn_on);
            for (const o of earlier) {
              const prev = results.find((x) => x.draw_id === o.id && x.marker.toLowerCase() === r.marker.toLowerCase() && plain(x));
              if (prev) {
                change = { previous: prev.value as number, previous_on: o.drawn_on, delta: (r.value as number) - (prev.value as number) };
                break;
              }
            }
          }
          return { ...r, status: labStatus(r as never), change };
        }),
      });
    }
    return { member: member.name, draws: out };
  },
});

const healthDrafts = readTool({
  name: "health_drafts",
  group: GROUP,
  description:
    "A member's draft body readings and draft blood draws (logged about them by someone else, or from the Inbox), oldest first, each with its record id, who logged it and when it confirms by itself, for the member to confirm or reject. Owner-only.",
  input: { member: z.string().min(1) },
  async run(ctx, input) {
    const member = await ownMember(ctx, input.member, "reading");
    // Who logged each and its deadline: the one-statement draft query the strip reads.
    const info = new Map(
      draftsAbout(await householdDrafts(ctx), member.id)
        .filter((d) => d.table === "reading" || d.table === "blood_draw")
        .map((d) => [`${d.table}:${d.id}`, d]),
    );
    const readings = await all<{ id: number; metric: string; label: string; measured_on: string; value: number; unit: string; side: string | null; body_state: string }>(
      ctx.db,
      `SELECT r.id, r.metric, m.label, r.measured_on, r.value, r.unit, r.side, r.body_state FROM reading r JOIN metric m ON m.code = r.metric
       WHERE r.member_id = ? AND r.state = 'draft' ORDER BY r.measured_on, r.id`,
      member.id,
    );
    const draws = await all<{ id: number; drawn_on: string; lab: string; fasting: number | null; results: number }>(
      ctx.db,
      `SELECT d.id, d.drawn_on, d.lab, d.fasting, (SELECT count(*) FROM lab_result x WHERE x.draw_id = d.id) AS results FROM blood_draw d
       WHERE d.member_id = ? AND d.state = 'draft' ORDER BY d.drawn_on, d.id`,
      member.id,
    );
    const names = new Map((await ctx.members()).map((m) => [m.id, m.name]));
    const about = (table: string, id: number) => {
      const d = info.get(`${table}:${id}`);
      return { logged_by: d && d.loggedBy !== null ? (names.get(d.loggedBy) ?? null) : null, deadline: d?.deadline ?? null };
    };
    return {
      member: member.name,
      readings: readings.map((r) => ({
        id: r.id, metric: r.metric, label: r.label, date: r.measured_on, value: r.value, unit: r.unit, side: r.side, body_state: r.body_state,
        ...about("reading", r.id),
      })),
      draws: draws.map((d) => ({ ...d, ...about("blood_draw", d.id) })),
    };
  },
});

const flags = readTool({
  name: "flags",
  group: GROUP,
  description: "Open (default) or resolved flags. A member sees only their own; the agent sees every member's.",
  input: { member: z.string().optional(), status: z.enum(["open", "resolved", "all"]).optional(), subtype: z.enum(["health_watch", "restriction", "event", "data"]).optional() },
  async run(ctx, input) {
    let memberIds: number[];
    if (input.member !== undefined) memberIds = [(await ownMember(ctx, input.member, "flag")).id];
    else memberIds = (await ctx.members()).filter((m) => ctx.canSee(m.id)).map((m) => m.id);
    const status = input.status ?? "open";
    const rows = await all<Record<string, unknown> & { member_id: number; status: string; subtype: string }>(
      ctx.db,
      `SELECT f.*, m.name AS member FROM flag f JOIN member m ON m.id = f.member_id WHERE f.member_id IN (${memberIds.map(() => "?").join(",") || "NULL"}) ORDER BY coalesce(f.due_on, '9999-12-31'), f.raised_on, f.id`,
      ...memberIds,
    );
    return { flags: rows.filter((r) => (status === "all" || r.status === status) && (input.subtype === undefined || r.subtype === input.subtype)) };
  },
});

const raiseFlag = writeTool({
  name: "raise_flag",
  group: GROUP,
  description: "Raise a flag that must not be lost (health watch, restriction, event, data such as a report never received), optionally with a due date. Confirmed on write. Owner-only.",
  input: {
    member: z.string().min(1),
    subtype: z.enum(["health_watch", "restriction", "event", "data"]),
    subject: z.string().min(1),
    raised_on: date.optional().describe("Default today."),
    due_on: date.optional(),
    note: z.string().optional(),
  },
  async run(ctx, input) {
    const member = await ownMember(ctx, input.member, "flag");
    ctx.onBehalfOf(member.id);
    const raised = input.raised_on ?? ctx.today();
    if (input.due_on !== undefined && input.due_on < raised) throw new Clarify("due_before_raised", "The due date is before the flag was raised; which is right?", [], ["due_on"]);
    const row = { member_id: member.id, subtype: input.subtype, subject: input.subject, raised_on: raised, due_on: input.due_on ?? null, status: "open", resolved_on: null, resolution: null, note: input.note ?? null };
    const id = await ctx.txOrThrow.create("flag", row);
    return { flag: { id, member: member.name, ...row }, state: "confirmed" };
  },
});

const resolveFlag = writeTool({
  name: "resolve_flag",
  group: GROUP,
  description: "Resolve an open flag with how it was resolved. Owner-only.",
  input: { flag_id: z.number().int().positive(), resolution: z.string().min(1), resolved_on: date.optional().describe("Default today.") },
  async run(ctx, input) {
    const flag = await first<Record<string, unknown> & { id: number; member_id: number; status: string; raised_on: string }>(ctx.db, "SELECT * FROM flag WHERE id = ?", input.flag_id);
    if (!flag || !(await ctx.members()).some((m) => m.id === flag.member_id)) throw new ToolError("not_found", `no flag ${input.flag_id}`, 404);
    ctx.assertCanSee("flag", flag.member_id);
    ctx.onBehalfOf(flag.member_id);
    if (flag.status === "resolved") throw new Clarify("already_resolved", "That flag is already resolved.", [], ["flag_id"]);
    const resolvedOn = input.resolved_on ?? ctx.today();
    if (resolvedOn < flag.raised_on) throw new Clarify("resolved_before_raised", `The flag was raised on ${flag.raised_on}; when was it resolved?`, [], ["resolved_on"]);
    const changes = { status: "resolved", resolved_on: resolvedOn, resolution: input.resolution };
    ctx.txOrThrow.update("flag", flag.id, changes, { ...flag, ...changes });
    return { flag: { ...flag, ...changes } };
  },
});

const setGoalPoint = writeTool({
  name: "set_goal_point",
  group: GROUP,
  description:
    "Set a member's planned or stretch goal point for a body metric in a week: a value or a range, with the reason (required; it goes to the write log). The week is stored as its Sunday; setting the same metric, week and tier again changes it (a goal stored on another day of that week, as the import did, is found too). waist_to_height is a unitless ratio (0.50); other metrics take a unit that fits them. Owner-only.",
  input: {
    member: z.string().min(1),
    metric: z.string().min(1),
    week_of: date.describe("Any date in the week."),
    value: z.number().optional(),
    range: z.object({ low: z.number(), high: z.number() }).strict().optional(),
    unit: z.string().min(1).optional().describe("Required unless the metric is unitless (waist_to_height)."),
    tier: z.enum(["planned", "stretch"]),
    headline: z.boolean().optional(),
    note: z.string().optional(),
  },
  async run(ctx, input) {
    const member = await ownMember(ctx, input.member, "reading");
    ctx.onBehalfOf(member.id);
    if (!input.reason) throw new Clarify("reason_needed", "Why is this goal being set (for example, the Guide's end target)?", [], ["reason"]);
    if ((input.value === undefined) === (input.range === undefined)) {
      throw new Clarify("value_or_range", "Give the goal as either one value or a range (low and high); exactly one of the two.", [], ["value"]);
    }
    const low = input.range?.low ?? (input.value as number);
    const high = input.range?.high ?? (input.value as number);
    const row = await goalPointRow(ctx, member, {
      metric: input.metric, week_of: input.week_of, tier: input.tier, basis: "absolute", low, high, unit: input.unit, headline: input.headline, note: input.note,
    });
    const existing = await findGoalPoint(ctx, row);
    // An omitted headline or note keeps what the stored goal point has; an explicit one changes it.
    const headline = input.headline === undefined && existing ? existing.headline : row.headline;
    const note = input.note === undefined && existing ? existing.note : row.note;
    const tx = ctx.txOrThrow;
    let id: number;
    if (existing) {
      id = existing.id;
      const changes = { week_of: row.week_of, value_low: row.value_low, value_high: row.value_high, unit: row.unit, headline, note };
      tx.update("goal_point", id, changes, { ...existing, ...changes });
    } else {
      id = await tx.create("goal_point", { ...row });
    }
    return {
      action: existing ? "updated" : "created",
      goal_point: {
        id, member: member.name, metric: row.metric, week_of: row.week_of, tier: row.tier, basis: row.basis,
        value_low: row.value_low, value_high: row.value_high, unit: row.unit, headline: headline === 1, note,
      },
      state: "confirmed",
    };
  },
});

const heartRateZones = readTool({
  name: "heart_rate_zones",
  group: GROUP,
  description: "A member's heart-rate zones, newest first: the zone, its bpm range, whether it is provisional or tested, the day it was set, and the basis it was set from (how the numbers were arrived at). Owner-only.",
  input: { member: z.string().min(1) },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    ctx.assertCanSee("reading", member.id);
    const zones = await all<{ id: number; zone: number; low_bpm: number; high_bpm: number; status: string; set_on: string; basis: string | null }>(
      ctx.db,
      "SELECT id, zone, low_bpm, high_bpm, status, set_on, basis FROM hr_zone WHERE member_id = ? ORDER BY set_on DESC, zone, id",
      member.id,
    );
    return { member: member.name, zones };
  },
});

export const HEALTH_TOOLS: Tool[] = [logReading, bodyTrends, readingMetrics, logBloodDraw, bloodDraws, healthDrafts, flags, raiseFlag, resolveFlag, setGoalPoint, heartRateZones];
