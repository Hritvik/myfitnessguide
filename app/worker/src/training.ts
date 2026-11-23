import {
  addDays,
  fromKg,
  nextSession,
  progressionCheck,
  readNativeLoad,
  rirAdjustedE1rm,
  setDerived,
  toKg,
  weekStart,
  WEEKDAYS,
  type Implement,
  type ImplementKind,
  type LoadAmount,
  type PlateGroup,
  type PlateInventory,
  type Load,
  type LoadBasis,
  type NextLoad,
  type NextSession,
  type ProgressionResult,
  type ProgressionRule,
  type ProgressionSet,
  type Rir,
  type SetDerived,
  type Schedule,
  type SetType,
  type Weekday,
} from "@myfitnessguide/domain";
import type { Ctx } from "./context";
import { all, allIn, first } from "./db";
import { Clarify, ToolError } from "./errors";
import { fuzzyRank } from "./fuzzy";

export interface ExerciseRow {
  id: number;
  name: string;
  implement_kind: string;
  /** 1 when bodyweight is most of what moves, so a set has no e1RM. */
  bodyweight_dominant: number;
}

export interface ImplementRow {
  id: number;
  gym_id: number;
  name: string;
  kind: string;
  unit: "kg" | "lb";
  loading: "total" | "per_side" | "plates_only";
  load_list_complete: number;
  /** The bar's or sled's own weight; null when unknown. */
  bar_value: number | null;
  bar_unit: "kg" | "lb" | null;
  /** Listed loads, each in its native unit. */
  loads: LoadAmount[];
  /** Loads known not to exist. */
  absent: LoadAmount[];
  /** Barbell and plate-loaded kit at a gym with plate sets: the gym's plates. */
  plates: PlateInventory | null;
  /** Retired equipment: kept for history, left out of a gym's inventory and gaps. */
  archived_at: string | null;
  archived_reason: string | null;
  /** The member's own words about the piece. */
  note?: string | null;
}

/** Kit loaded with plates: its loads are combinations of the gym's plates. */
export function platesLoaded(row: Pick<ImplementRow, "kind" | "loading">): boolean {
  return (row.kind === "barbell" || row.kind === "plate_loaded") && row.loading !== "total";
}

/** A gym's plates, or null when it has no plate set. */
export async function gymPlates(ctx: Ctx, gymId: number): Promise<PlateInventory | null> {
  return (await gymsPlates(ctx, [gymId])).get(gymId) ?? null;
}

/**
 * Several gyms' plates in one statement per 100 gyms: each set with its
 * plates (a set with none still says whether it is complete). A gym with
 * no plate set is absent from the map.
 */
async function gymsPlates(ctx: Ctx, gymIds: readonly number[]): Promise<Map<number, PlateInventory>> {
  const rows = await allIn<{ gym_id: number; set_id: number; unit: "kg" | "lb"; complete: number; value: number | null; status: string | null }>(
    ctx.db,
    (ids) =>
      `SELECT s.gym_id, s.id AS set_id, s.unit, s.complete, p.value, p.status FROM plate_set s LEFT JOIN plate p ON p.plate_set_id = s.id
       WHERE s.gym_id IN (${ids}) ORDER BY s.gym_id, s.unit, p.value`,
    gymIds,
  );
  const out = new Map<number, { available: LoadAmount[]; absent: LoadAmount[]; complete: boolean }>();
  for (const r of rows) {
    let inv = out.get(r.gym_id);
    if (!inv) out.set(r.gym_id, (inv = { available: [], absent: [], complete: true }));
    if (r.complete !== 1) inv.complete = false;
    if (r.value === null) continue;
    (r.status === "absent" ? inv.absent : inv.available).push({ value: r.value, unit: r.unit });
  }
  return out as Map<number, PlateInventory>;
}

export interface SetRow {
  id: number;
  session_id: number;
  exercise_id: number;
  set_number: number;
  set_type: string;
  prescription_id: number | null;
  substituted_prescription_id: number | null;
  reps: number | null;
  /** 1 when the reps came from a bulk report ("done", "as prescribed"), not a count. */
  reps_inferred: number;
  load_status: "entered" | "none" | "not_recorded";
  load_value: number | null;
  load_unit: "kg" | "lb" | null;
  load_basis: "total" | "per_side" | "per_hand" | "per_leg" | null;
  unilateral: number;
  load_implement_id: number | null;
  bar_value: number | null;
  bar_unit: "kg" | "lb" | null;
  /** A composition: the plates on each side, as JSON [{value, unit, count}]. */
  plates?: string | null;
  rir_status: "recorded" | "not_recorded" | null;
  rir_low: number | null;
  rir_high: number | null;
  state: string;
  [key: string]: unknown;
}

export interface SessionRow {
  id: number;
  member_id: number;
  performed_on: string;
  gym_id: number | null;
  session_type: string;
  template_id: number | null;
  state: string;
  [key: string]: unknown;
}

export interface ExerciseEntry extends ExerciseRow {
  aliases: string[];
}

/** The household's exercises with their aliases, loaded in one statement; looked up in memory. */
export class ExerciseIndex {
  private constructor(readonly entries: ExerciseEntry[]) {}

  static async load(ctx: Ctx): Promise<ExerciseIndex> {
    const rows = await all<ExerciseRow & { aliases: string }>(
      ctx.db,
      `SELECT e.id, e.name, e.implement_kind, e.bodyweight_dominant,
         (SELECT json_group_array(a.alias) FROM alias a WHERE a.household_id = e.household_id AND a.kind = 'exercise' AND a.target_id = e.id) AS aliases
       FROM exercise e WHERE e.household_id = ? ORDER BY e.id`,
      ctx.householdId,
    );
    return new ExerciseIndex(rows.map((r) => ({ ...r, aliases: JSON.parse(r.aliases) as string[] })));
  }

  /** An exercise by its name or an alias, ignoring case; null when none. */
  lookup(name: string): ExerciseRow | null {
    const key = name.trim().toLowerCase();
    const hit = this.entries.find((e) => e.name.toLowerCase() === key || e.aliases.some((a) => a.toLowerCase() === key));
    return hit ? { id: hit.id, name: hit.name, implement_kind: hit.implement_kind, bodyweight_dominant: hit.bodyweight_dominant } : null;
  }

  /** As lookup, but an unknown name asks, offering the closest names. */
  find(name: string, path: (string | number)[]): ExerciseRow {
    const hit = this.lookup(name);
    if (hit) return hit;
    const options = fuzzyRank(name, this.entries.map((e) => ({ item: e.name, names: [e.name, ...e.aliases] }))).slice(0, 5);
    throw new Clarify("unknown_exercise", `Which exercise is "${name}"?`, options, path);
  }
}

export async function findExercise(ctx: Ctx, name: string, path: (string | number)[]): Promise<ExerciseRow> {
  return (await ExerciseIndex.load(ctx)).find(name, path);
}

export async function loadImplements(ctx: Ctx, where: { gymId?: number; ids?: number[] }): Promise<ImplementRow[]> {
  type LoadRow = { implement_id: number; load: number; unit: "kg" | "lb"; status: string };
  let rows: Omit<ImplementRow, "loads" | "absent" | "plates">[];
  let loadRows: LoadRow[];
  // Every implement's loads in one statement (per 100 ids), never one per implement (decision 96).
  if (where.gymId !== undefined) {
    rows = await all(ctx.db, "SELECT * FROM implement WHERE gym_id = ? AND archived_at IS NULL ORDER BY id", where.gymId);
    if (rows.length === 0) return [];
    loadRows = await all<LoadRow>(
      ctx.db,
      "SELECT l.implement_id, l.load, l.unit, l.status FROM implement_load l JOIN implement i ON i.id = l.implement_id WHERE i.gym_id = ? AND i.archived_at IS NULL ORDER BY l.implement_id, l.load, l.unit",
      where.gymId,
    );
  } else {
    const ids = where.ids ?? [];
    if (ids.length === 0) return [];
    rows = (await allIn<Omit<ImplementRow, "loads" | "absent" | "plates">>(ctx.db, (ph) => `SELECT * FROM implement WHERE id IN (${ph})`, ids)).sort((a, b) => a.id - b.id);
    if (rows.length === 0) return [];
    loadRows = await allIn<LoadRow>(
      ctx.db,
      (ph) => `SELECT implement_id, load, unit, status FROM implement_load WHERE implement_id IN (${ph}) ORDER BY implement_id, load, unit`,
      rows.map((r) => r.id),
    );
  }
  const loadsOf = new Map<number, LoadRow[]>();
  for (const l of loadRows) {
    const list = loadsOf.get(l.implement_id);
    if (list) list.push(l);
    else loadsOf.set(l.implement_id, [l]);
  }
  // Plates once per gym, and only when some implement is loaded with them.
  const plateGyms = [...new Set(rows.filter((r) => platesLoaded(r)).map((r) => r.gym_id))];
  const plates = plateGyms.length === 0 ? new Map<number, PlateInventory>() : await gymsPlates(ctx, plateGyms);
  return rows.map((r) => {
    const loads = loadsOf.get(r.id) ?? [];
    return {
      ...r,
      loads: loads.filter((l) => l.status === "available").map((l) => ({ value: l.load, unit: l.unit })),
      absent: loads.filter((l) => l.status === "absent").map((l) => ({ value: l.load, unit: l.unit })),
      plates: platesLoaded(r) ? (plates.get(r.gym_id) ?? null) : null,
    };
  });
}

/** A member's set of an exercise with its session's date (lift_history, lift_trends). */
export type ExerciseSetRow = SetRow & { performed_on: string; note: string | null };

/** Load many exercises without introducing a query per exercise or session. */
export async function memberExerciseSets(
  ctx: Ctx,
  memberId: number,
  exerciseIds: readonly number[],
  range: { from?: string; to?: string } = {},
): Promise<{ sets: ExerciseSetRow[]; implements: ImplementRow[] }> {
  if (exerciseIds.length === 0) return { sets: [], implements: [] };
  const sets = (
    await allIn<ExerciseSetRow>(
      ctx.db,
      (ids) =>
        `SELECT st.*, se.performed_on FROM session_set st JOIN session se ON se.id = st.session_id
         WHERE se.member_id = ? AND se.performed_on >= ? AND se.performed_on <= ? AND st.exercise_id IN (${ids})`,
      exerciseIds,
      memberId,
      range.from ?? "0000-01-01",
      range.to ?? "9999-12-31",
    )
  ).sort((a, b) => b.performed_on.localeCompare(a.performed_on) || b.session_id - a.session_id || a.set_number - b.set_number || a.id - b.id);
  const implementIds = [...new Set(sets.map((set) => set.load_implement_id).filter((id): id is number => id !== null))];
  return { sets, implements: await loadImplements(ctx, { ids: implementIds }) };
}

export type LiftGrouping = "session" | "week";

export interface LiftGroup {
  session_id: number | null;
  week_start: string;
  date: string;
  exercise_id: number;
  has_draft: boolean;
  working_sets: number;
  sets_without_volume: number;
  volume_kg: number | null;
  loaded_sets: number;
  rep_sets: number;
  rir_sets: number;
  plates_only_estimates: number;
  e1rm: { kg: number; set_id: number; session_id: number; on: string; implement: string | null; reps: number; rir_low: number; reps_assumed: boolean } | null;
  top_set: { set_id: number; session_id: number; on: string; total_kg: number; reps: number | null } | null;
}

const LIFT_GROUP_KEY: Record<LiftGrouping, string> = {
  session: "session_id",
  week: "date(performed_on, '-' || strftime('%w', performed_on) || ' days')",
};

interface LiftGroupRow {
  grp: number | string;
  exercise_id: number;
  last_on: string;
  week_start: string;
  working_sets: number;
  sets_without_volume: number;
  volume_kg: number | null;
  has_draft: number;
  loaded_sets: number | null;
  rep_sets: number | null;
  rir_sets: number | null;
  plates_only_estimates: number | null;
  e1rm_kg: number | null;
  e1rm_set_id: number | null;
  e1rm_session_id: number | null;
  e1rm_on: string | null;
  e1rm_implement: string | null;
  e1rm_reps: number | null;
  e1rm_rir_low: number | null;
  e1rm_reps_inferred: number | null;
  top_kg: number | null;
  top_set_id: number | null;
  top_session_id: number | null;
  top_on: string | null;
  top_reps: number | null;
}

/** Fold working sets by session or Sunday week in one v_set statement. */
export async function liftGroups(
  ctx: Ctx,
  memberId: number,
  grouping: LiftGrouping,
  options: { exerciseId?: number; from?: string; to?: string } = {},
): Promise<LiftGroup[]> {
  const oneExercise = options.exerciseId !== undefined;
  const pick = (rank: "e_rank" | "t_rank", condition: string, column: string) => `max(CASE WHEN ${rank} = 1 AND ${condition} THEN ${column} END)`;
  const isEstimate = "e1rm IS NOT NULL";
  const platesOnlyEstimate = "coalesce(plates_only = 1 AND reps >= 1 AND rir_status = 'recorded' AND reps + rir_low <= 12, 0) = 1";
  const isTop = `e1rm_rir_kg IS NULL AND NOT (${platesOnlyEstimate}) AND total_load_kg > 0`;
  const rows = await all<LiftGroupRow>(
    ctx.db,
    `WITH s AS (
       SELECT v.id, v.session_id, v.member_id, v.performed_on, v.exercise_id, v.state, v.reps, v.reps_inferred, v.rir_low, v.rir_status,
              v.total_load_kg, v.volume_kg, v.e1rm_kg, v.e1rm_rir_kg, v.load_implement_id,
              v.comparable = 0 AS not_comparable, im.loading = 'plates_only' AS plates_only,
              CASE WHEN v.comparable = 1 THEN v.e1rm_rir_kg END AS e1rm
       FROM v_set v LEFT JOIN implement im ON im.id = v.load_implement_id
       WHERE v.member_id = ? AND v.set_type <> 'warm_up' AND v.performed_on BETWEEN ? AND ?${oneExercise ? " AND v.exercise_id = ?" : ""}
     ), g AS (
       SELECT s.*, ${LIFT_GROUP_KEY[grouping]} AS grp,
              (SELECT count(*) FROM v_exercise_method_change c
               WHERE c.member_id = s.member_id AND c.exercise_id = s.exercise_id AND c.changed_on <= s.performed_on) AS segment_key
       FROM s
     ), r AS (
       SELECT g.*,
              row_number() OVER (PARTITION BY grp, exercise_id, segment_key ORDER BY e1rm DESC NULLS LAST, performed_on, id) AS e_rank,
              row_number() OVER (PARTITION BY grp, exercise_id, segment_key ORDER BY CASE WHEN ${isTop} THEN total_load_kg END DESC NULLS LAST, performed_on, id) AS t_rank
       FROM g
     ), a AS (
       SELECT grp, exercise_id, max(performed_on) AS last_on,
              date(min(performed_on), '-' || strftime('%w', min(performed_on)) || ' days') AS week_start,
              count(*) AS working_sets, count(*) - count(volume_kg) AS sets_without_volume, sum(volume_kg) AS volume_kg,
              max(state = 'draft') AS has_draft, sum(total_load_kg > 0) AS loaded_sets,
              sum(total_load_kg > 0 AND NOT not_comparable AND reps >= 1) AS rep_sets,
              sum(total_load_kg > 0 AND NOT not_comparable AND reps >= 1 AND rir_status = 'recorded') AS rir_sets,
              sum(${platesOnlyEstimate}) AS plates_only_estimates,
              ${pick("e_rank", isEstimate, "e1rm")} AS e1rm_kg,
              ${pick("e_rank", isEstimate, "id")} AS e1rm_set_id,
              ${pick("e_rank", isEstimate, "session_id")} AS e1rm_session_id,
              ${pick("e_rank", isEstimate, "performed_on")} AS e1rm_on,
              ${pick("e_rank", isEstimate, "load_implement_id")} AS e1rm_implement_id,
              ${pick("e_rank", isEstimate, "reps")} AS e1rm_reps,
              ${pick("e_rank", isEstimate, "rir_low")} AS e1rm_rir_low,
              ${pick("e_rank", isEstimate, "reps_inferred")} AS e1rm_reps_inferred,
              ${pick("t_rank", isTop, "total_load_kg")} AS top_kg,
              ${pick("t_rank", isTop, "id")} AS top_set_id,
              ${pick("t_rank", isTop, "session_id")} AS top_session_id,
              ${pick("t_rank", isTop, "performed_on")} AS top_on,
              ${pick("t_rank", isTop, "reps")} AS top_reps
       FROM r GROUP BY grp, exercise_id, segment_key
     )
     SELECT a.*, im.name AS e1rm_implement FROM a LEFT JOIN implement im ON im.id = a.e1rm_implement_id`,
    memberId,
    options.from ?? "0000-01-01",
    options.to ?? "9999-12-31",
    ...(oneExercise ? [options.exerciseId as number] : []),
  );
  return rows.map((row) => ({
    session_id: grouping === "session" ? Number(row.grp) : null,
    week_start: row.week_start,
    date: row.last_on,
    exercise_id: row.exercise_id,
    has_draft: row.has_draft === 1,
    working_sets: row.working_sets,
    sets_without_volume: row.sets_without_volume,
    volume_kg: row.volume_kg,
    loaded_sets: row.loaded_sets ?? 0,
    rep_sets: row.rep_sets ?? 0,
    rir_sets: row.rir_sets ?? 0,
    plates_only_estimates: row.plates_only_estimates ?? 0,
    e1rm: row.e1rm_kg === null ? null : {
      kg: row.e1rm_kg, set_id: row.e1rm_set_id as number, session_id: row.e1rm_session_id as number,
      on: row.e1rm_on as string, implement: row.e1rm_implement, reps: row.e1rm_reps as number,
      rir_low: row.e1rm_rir_low as number, reps_assumed: row.e1rm_reps_inferred === 1,
    },
    top_set: row.top_kg === null ? null : {
      set_id: row.top_set_id as number, session_id: row.top_session_id as number, on: row.top_on as string,
      total_kg: row.top_kg, reps: row.top_reps,
    },
  }));
}

export interface LiftPoint extends LiftGroup { segment: number }
export interface LiftSeries {
  exercise_id: number;
  points: LiftPoint[];
  best_e1rm: { kg: number; on: string; session_id: number; implement: string | null; reps: number; rir_low: number } | null;
  best_top_set: { kg: number; on: string; session_id: number } | null;
  last_done: string;
  loaded_sets: number;
  rep_sets: number;
  rir_sets: number;
  plates_only_estimates: number;
}

export function foldLifts(groups: readonly LiftGroup[], changes: readonly { exercise_id: number; date: string }[]): Map<number, LiftSeries> {
  const changesByExercise = new Map<number, string[]>();
  for (const change of changes) changesByExercise.set(change.exercise_id, [...(changesByExercise.get(change.exercise_id) ?? []), change.date]);
  const ordered = [...groups].sort((a, b) => a.date.localeCompare(b.date) || (a.session_id ?? 0) - (b.session_id ?? 0) || a.exercise_id - b.exercise_id);
  const seriesByExercise = new Map<number, LiftSeries>();
  for (const group of ordered) {
    const series = seriesByExercise.get(group.exercise_id) ?? {
      exercise_id: group.exercise_id, points: [], best_e1rm: null, best_top_set: null, last_done: group.date,
      loaded_sets: 0, rep_sets: 0, rir_sets: 0, plates_only_estimates: 0,
    };
    series.points.push({ ...group, segment: (changesByExercise.get(group.exercise_id) ?? []).filter((date) => date <= group.date).length });
    if (group.e1rm && (series.best_e1rm === null || group.e1rm.kg > series.best_e1rm.kg)) {
      series.best_e1rm = { kg: group.e1rm.kg, on: group.e1rm.on, session_id: group.e1rm.session_id, implement: group.e1rm.implement, reps: group.e1rm.reps, rir_low: group.e1rm.rir_low };
    }
    if (group.top_set && (series.best_top_set === null || group.top_set.total_kg > series.best_top_set.kg)) {
      series.best_top_set = { kg: group.top_set.total_kg, on: group.top_set.on, session_id: group.top_set.session_id };
    }
    series.last_done = group.date > series.last_done ? group.date : series.last_done;
    series.loaded_sets += group.loaded_sets;
    series.rep_sets += group.rep_sets;
    series.rir_sets += group.rir_sets;
    series.plates_only_estimates += group.plates_only_estimates;
    seriesByExercise.set(group.exercise_id, series);
  }
  return seriesByExercise;
}

export type NoE1rm = "bodyweight_dominant" | "plates_only" | "no_reps" | "no_rir" | "over_cap";

export function noE1rmReason(
  series: Pick<LiftSeries, "best_e1rm" | "loaded_sets" | "rep_sets" | "rir_sets" | "plates_only_estimates">,
  exercise: { bodyweight_dominant: number },
): NoE1rm | null {
  if (series.best_e1rm !== null) return null;
  if (exercise.bodyweight_dominant === 1 || series.loaded_sets === 0) return "bodyweight_dominant";
  if (series.rir_sets === 0 && series.plates_only_estimates > 0) return "plates_only";
  if (series.rep_sets === 0) return "no_reps";
  if (series.rir_sets === 0) return "no_rir";
  return "over_cap";
}

export function weeklyVolume(groups: readonly LiftGroup[], today: string) {
  if (groups.length === 0) return [];
  const byWeek = new Map<string, { sessions: Set<number>; working: number; volume: number | null; without: number }>();
  for (const group of groups) {
    const week = byWeek.get(group.week_start) ?? { sessions: new Set<number>(), working: 0, volume: null, without: 0 };
    if (group.session_id !== null) week.sessions.add(group.session_id);
    week.working += group.working_sets;
    week.without += group.sets_without_volume;
    if (group.volume_kg !== null) week.volume = (week.volume ?? 0) + group.volume_kg;
    byWeek.set(group.week_start, week);
  }
  const firstWeek = [...byWeek.keys()].sort()[0] as string;
  const rows = [];
  for (let start = firstWeek; start <= weekStart(today); start = addDays(start, 7)) {
    const week = byWeek.get(start);
    rows.push({ week_start: start, sessions: week?.sessions.size ?? 0, working_sets: week?.working ?? 0, volume_kg: week?.volume ?? null, sets_without_volume: week?.without ?? 0 });
  }
  return rows;
}

/** The domain's implement: its producible loads, the bar of this set, and whether it assists. */
export function domainImplement(row: ImplementRow | null, options: { unit: "kg" | "lb"; barKg?: number; assisted?: boolean; kind?: string }): Implement {
  const implement: Implement = { id: row ? String(row.id) : "none", unit: row?.unit ?? options.unit };
  // The set's implement says what it is; without one, the exercise's kind of implement does.
  const kind = row?.kind ?? options.kind;
  if (kind !== undefined) implement.kind = kind as ImplementKind;
  if (row?.plates) implement.plates = row.plates;
  else if (row) implement.loads = row.loads;
  if (row && row.absent.length > 0) implement.absent = row.absent;
  if (row && row.load_list_complete === 0) implement.maxUnknown = true;
  if (options.barKg !== undefined) implement.barKg = options.barKg;
  else if (row && row.bar_value !== null && row.bar_unit !== null && row.loading === "per_side") implement.barKg = toKg(row.bar_value, row.bar_unit);
  if (options.assisted) implement.assisted = true;
  return implement;
}

/**
 * A stored set's load as the domain sees it. Assisted loads are stored
 * negative (schema decision 16); the domain takes the size and an assisted
 * implement. Plates on a plates-only implement have no known sled.
 */
export function domainLoad(
  set: Pick<SetRow, "load_value" | "load_unit" | "load_basis" | "unilateral" | "bar_value" | "bar_unit" | "plates">,
  implement: ImplementRow | null,
  exerciseKind?: string,
): Load | null {
  if (set.load_value === null || set.load_unit === null || set.load_basis === null) return null;
  const assisted = set.load_value < 0;
  const barKg = set.bar_value !== null && set.bar_unit !== null ? toKg(set.bar_value, set.bar_unit) : undefined;
  const basis: LoadBasis = set.load_basis === "per_side" && implement?.loading === "plates_only" ? "plates_only" : set.load_basis;
  const domainImpl = domainImplement(implement, {
    unit: set.load_unit,
    assisted,
    ...(barKg === undefined ? {} : { barKg }),
    ...(exerciseKind === undefined ? {} : { kind: exerciseKind }),
  });
  const load: Load = { value: Math.abs(set.load_value), unit: set.load_unit, basis, implement: domainImpl, unilateral: set.unilateral === 1 };
  const plates = storedPlates(set.plates);
  if (plates) load.plates = plates;
  return load;
}

/** A stored composition, or null. */
export function storedPlates(json: string | null | undefined): PlateGroup[] | null {
  if (!json) return null;
  return (JSON.parse(json) as { value: number; unit: "kg" | "lb"; count?: number }[]).map((p) => ({ value: p.value, unit: p.unit, count: p.count ?? 1 }));
}

export function rirOf(set: Pick<SetRow, "rir_status" | "rir_low" | "rir_high">): Rir {
  if (set.rir_status === "recorded") return { low: set.rir_low as number, high: set.rir_high as number };
  if (set.rir_status === "not_recorded") return "not_recorded";
  return null;
}

/** One physical segment of a compound set, as stored. */
export interface StoredSegment {
  sequence: number;
  load: { value: number; unit: "kg" | "lb"; basis?: string; plates?: unknown; bar?: unknown; unilateral?: boolean } | "none" | "not_recorded";
  reps: number | null;
  duration_s?: number;
  distance?: { value: number; unit: string };
  rir?: unknown;
  note?: string;
}

/** A stored compound set's segments, or null for a simple set. */
export function storedSegments(json: unknown): StoredSegment[] | null {
  if (typeof json !== "string" || json === "") return null;
  return JSON.parse(json) as StoredSegment[];
}

/** One side of a carry, as stored. */
export interface StoredSide {
  side: "left" | "right";
  distance_m?: number;
  reps?: number;
  duration_s?: number;
}

/** A stored carry's sides, or null. */
export function storedSides(json: unknown): StoredSide[] | null {
  if (typeof json !== "string" || json === "") return null;
  return JSON.parse(json) as StoredSide[];
}

/** A set's exact total, volume and e1RM; the exercise says whether it is bodyweight-dominant and its kind of implement. */
export function derive(set: SetRow, implement: ImplementRow | null, exercise?: { bodyweight_dominant: number; implement_kind?: string }): SetDerived | null {
  const load = domainLoad(set, implement, exercise?.implement_kind);
  if (!load) return null;
  return setDerived({ load, reps: set.reps, rir: rirOf(set), bodyweightDominant: exercise?.bodyweight_dominant === 1 });
}

/**
 * A set's volume in kg, summing a compound set's segments (a drop set's
 * light back-off segments count too). A simple set is exactly derive()'s
 * volume, and a set with no computable load is 0.
 */
export function volumeKgOf(
  set: SetRow,
  implement: ImplementRow | null,
  exercise?: { bodyweight_dominant: number; implement_kind?: string },
): number {
  const segments = storedSegments(set.segments);
  if (segments === null) return derive(set, implement, exercise)?.volumeKg ?? 0;
  let total = 0;
  for (const segment of segments) {
    if (typeof segment.load !== "object") continue;
    const segLoad = segment.load as { value: number; unit: "kg" | "lb"; basis?: string; plates?: unknown; bar?: { value: number; unit: "kg" | "lb" }; unilateral?: boolean };
    const row = {
      ...set,
      load_value: segLoad.value,
      load_unit: segLoad.unit,
      load_basis: (segLoad.basis ?? set.load_basis) as SetRow["load_basis"],
      unilateral: segLoad.unilateral ? 1 : 0,
      plates: segLoad.plates ? JSON.stringify(segLoad.plates) : null,
      bar_value: segLoad.bar?.value ?? null,
      bar_unit: segLoad.bar?.unit ?? null,
    };
    const load = domainLoad(row, implement, exercise?.implement_kind);
    if (!load) continue;
    const rir = segment.rir === undefined ? rirOf(set) : typeof segment.rir === "object" && segment.rir !== null ? (segment.rir as Rir) : rirOf(set);
    total += setDerived({ load, reps: segment.reps, rir, bodyweightDominant: exercise?.bodyweight_dominant === 1 }).volumeKg ?? 0;
  }
  return total;
}

/** The charts estimate from reps plus the low end of RIR, with inferred reps retained as provenance. */
export function deriveRirAdjusted(
  set: SetRow,
  implement: ImplementRow | null,
  exercise?: { bodyweight_dominant: number; implement_kind?: string },
) {
  return rirAdjustedE1rm({
    load: domainLoad(set, implement, exercise?.implement_kind),
    reps: set.reps,
    rir: rirOf(set),
    repsConfirmed: set.reps_inferred !== 1,
    bodyweightDominant: exercise?.bodyweight_dominant === 1,
  });
}

const SET_TYPE: Record<string, SetType> = {
  working: "working",
  warm_up: "warm-up",
  back_off: "back-off",
  substitution: "substitution",
  calibration: "calibration",
};

export function domainSetType(t: string): SetType {
  return SET_TYPE[t] ?? "working";
}

/** A stored progression rule, as the snake_case JSON in `prescription.progression_rule`. */
export interface StoredRule {
  kind: "rep_top" | "manual";
  target_sets?: number;
  rep_top?: number;
  /** A number, or the prescription's own RIR target low end, read when the check runs. */
  rir_floor?: number | "from_prescription";
  /**
   * The step: in the implement's unit and the load's basis unless `unit` /
   * `basis` say otherwise; or the next producible load.
   */
  increment?: { min: number; max?: number; unit?: "kg" | "lb"; basis?: LoadBasis } | "smallest_step";
  /** Reps are counted per leg (a single-leg exercise). */
  per_leg?: boolean;
  /** How to progress, in words the member acts on. */
  cue?: string;
  autoregulation?: { reps_under?: number };
}

/** The stored rule's JSON, parsed; throws on JSON that isn't a rule. */
/** A stored rule as the caller may see it: its cue is coach text, its member's alone (decision 138). */
export function ruleShown(rule: StoredRule | null, own: boolean): StoredRule | null {
  if (!rule || own) return rule;
  const { cue: _cue, ...rest } = rule;
  return rest as StoredRule;
}

export function parseRule(json: string | null): StoredRule | null {
  if (!json) return null;
  const r = JSON.parse(json) as StoredRule;
  if (r === null || typeof r !== "object" || (r.kind !== "rep_top" && r.kind !== "manual")) throw new SyntaxError("not a progression rule");
  return r;
}

/** One limb's or side's share of a total, or the total of both (0017's implements). */
const PER_IMPLEMENT = new Set(["per_side", "per_hand", "per_leg", "plates_only"]);

/**
 * An increment stated in another unit or basis, in the load's own terms:
 * a total step is halved for a per-hand or per-side load and a per-limb
 * step doubled for a total load, then converted and rounded to 0.01 of the
 * unit (2.268 kg is 5 lb, as the rule meant).
 */
export function incrementIn(step: number, from: { unit: "kg" | "lb"; basis: string }, to: { unit: "kg" | "lb"; basis: string }): number {
  const fromPer = PER_IMPLEMENT.has(from.basis);
  const toPer = PER_IMPLEMENT.has(to.basis);
  const scaled = fromPer === toPer ? step : fromPer ? step * 2 : step / 2;
  return Math.round(fromKg(toKg(scaled, from.unit), to.unit) * 100) / 100;
}

/**
 * The stored rule as the domain's ProgressionRule; null for manual or none.
 * `p` gives what the rule may defer to: the prescription's RIR target and
 * its load's unit and basis (the implement's unit wins for the unit).
 */
export function progressionRule(
  json: string | null,
  p?: { rirTargetLow: number | null; unit: "kg" | "lb" | null; basis: string | null },
): ProgressionRule | null {
  const r = parseRule(json);
  if (!r || r.kind !== "rep_top") return null;
  const rirTarget = r.rir_floor === "from_prescription" ? p?.rirTargetLow : r.rir_floor;
  if (rirTarget === null || rirTarget === undefined) return null;
  const rule: ProgressionRule = { targetSets: r.target_sets as number, repTop: r.rep_top as number, rirTarget };
  const inc = r.increment;
  if (inc === "smallest_step") rule.increment = "smallest_step";
  else if (inc) {
    const to = { unit: p?.unit ?? inc.unit ?? "kg", basis: p?.basis ?? inc.basis ?? "total" };
    const from = { unit: inc.unit ?? to.unit, basis: inc.basis ?? to.basis };
    const min = incrementIn(inc.min, from, to);
    rule.increment = inc.max === undefined ? { min } : { min, max: incrementIn(inc.max, from, to) };
  }
  if (r.autoregulation?.reps_under !== undefined) rule.autoregulationRepsUnder = r.autoregulation.reps_under;
  return rule;
}

export interface PrescriptionView {
  id: number;
  member_id: number;
  template_id: number;
  template_name: string;
  position: number;
  exercise_id: number;
  exercise_name: string;
  target_kind: "reps" | "duration" | "distance";
  sets: number | null;
  rep_low: number | null;
  rep_high: number | null;
  rir_target_low: number | null;
  rir_target_high: number | null;
  duration_low_s: number | null;
  duration_high_s: number | null;
  distance_value: number | null;
  distance_unit: "m" | "km" | "mi" | null;
  rest_s: number | null;
  progression_rule: string | null;
  cue: string | null;
  fallback_note: string | null;
  current_load_value: number | null;
  current_load_unit: "kg" | "lb" | null;
  current_load_basis: string | null;
  current_load_implement_id: number | null;
  load_changed_on: string | null;
  /** A composition (migration 0027): the bar and the plates per side, JSON. */
  current_bar_value: number | null;
  current_bar_unit: "kg" | "lb" | null;
  current_plates: string | null;
}

/** A prescription's current load as an API value: the amount and basis, with the bar and plates when it is a composition. */
export function prescribedLoad(p: PrescriptionView) {
  if (p.current_load_value === null || p.current_load_unit === null) return null;
  return {
    value: p.current_load_value,
    unit: p.current_load_unit,
    basis: p.current_load_basis,
    bar: p.current_bar_value !== null && p.current_bar_unit !== null ? { value: p.current_bar_value, unit: p.current_bar_unit } : null,
    plates: storedPlates(p.current_plates),
  };
}

/** What a prescription asks for besides its load: a rep range, a duration or a distance. */
export function targetOf(p: Pick<PrescriptionView, "target_kind" | "rep_low" | "rep_high" | "duration_low_s" | "duration_high_s" | "distance_value" | "distance_unit">) {
  if (p.target_kind === "duration") return { kind: "duration" as const, low_s: p.duration_low_s, high_s: p.duration_high_s };
  if (p.target_kind === "distance") return { kind: "distance" as const, value: p.distance_value, unit: p.distance_unit };
  return { kind: "reps" as const, low: p.rep_low, high: p.rep_high };
}

export function rirTargetOf(p: Pick<PrescriptionView, "rir_target_low" | "rir_target_high">) {
  return p.rir_target_low === null ? null : { low: p.rir_target_low, high: p.rir_target_high };
}

export async function prescriptionById(ctx: Ctx, id: number): Promise<PrescriptionView> {
  const p = await first<PrescriptionView>(ctx.db, "SELECT * FROM v_prescription WHERE id = ?", id);
  if (!p) throw new ToolError("not_found", `no prescription ${id}`, 404);
  await ctx.memberById(p.member_id);
  return p;
}

export type CheckResult =
  | Exclude<ProgressionResult, { verdict: "needs_confirmation" }>
  | (Extract<ProgressionResult, { verdict: "needs_confirmation" }> & { confirm_set_ids: number[] })
  | { verdict: "never"; reason: "no_rule" | "manual_rule"; message: string };

/** The progression check from loaded data: the domain's verdict, the sets to confirm, and the offer for an unverified step. */
export function progressionFrom(p: PrescriptionView, implement: ImplementRow | null, sets: SetRow[], sid: number | null): Progression {
  if (!p.progression_rule) return { verdict: "never", reason: "no_rule", message: "this prescription has no progression rule", session_id: null };
  const rule = progressionRule(p.progression_rule, { rirTargetLow: p.rir_target_low, unit: implement?.unit ?? p.current_load_unit, basis: p.current_load_basis });
  if (!rule) {
    const stored = parseRule(p.progression_rule);
    const message = stored?.kind === "rep_top" ? "the rule reads its RIR floor from the prescription, which has no RIR target" : "the load moves only by hand (manual rule)";
    return { verdict: "never", reason: "manual_rule", message, session_id: null };
  }
  const context: Parameters<typeof progressionCheck>[2] = {};
  if (p.rep_low !== null && p.rep_high !== null) context.prescription = { repLow: p.rep_low, repHigh: p.rep_high };
  if (implement) context.implement = domainImplement(implement, { unit: implement.unit });
  if (p.current_load_value !== null && p.current_load_unit !== null) {
    // The prescribed load in its native unit (a 9.07 kg prescription is the 20 lb dumbbell).
    const native = readNativeLoad(p.current_load_value, p.current_load_unit);
    context.currentLoad = native.status === "clean" ? { value: native.value, unit: native.unit } : { value: p.current_load_value, unit: p.current_load_unit };
  }
  const progressionSets: ProgressionSet[] = sets.map((s) => ({ reps: s.reps, rir: rirOf(s), repsConfirmed: s.reps_inferred !== 1, setType: domainSetType(s.set_type) }));
  const result = progressionCheck(progressionSets, rule, context);
  // A step above what the gym is known to have: ask once at the gym, then record the answer.
  const offer =
    (result.verdict === "fired" || result.verdict === "needs_confirmation") && result.unverified && implement
      ? implement.plates
        ? { if_exists: { tool: "record_plates", gym_id: implement.gym_id }, if_not: { tool: "record_plates", gym_id: implement.gym_id } }
        : {
            if_exists: { tool: "add_implement_load", implement_id: implement.id, loads: [{ value: result.nextLoad, unit: result.nextLoadUnit }] },
            if_not: { tool: "remove_implement_load", implement_id: implement.id, loads: [{ value: result.nextLoad, unit: result.nextLoadUnit }] },
          }
      : null;
  if (result.verdict === "needs_confirmation") {
    // The domain counts qualifying (working) sets; name the stored sets to confirm.
    const working = sets.filter((s) => domainSetType(s.set_type) === "working");
    const confirm_set_ids = result.inferredSets.map((n) => (working[n - 1] as SetRow).id);
    return { ...result, confirm_set_ids, session_id: sid, ...(offer ? { offer } : {}) };
  }
  return { ...result, session_id: sid, ...(offer ? { offer } : {}) };
}

/**
 * The progression check for one prescription, through the domain. Sets are
 * the working sets of the given session, or of the latest session that has
 * sets linked to this prescription.
 */
export async function checkPrescription(ctx: Ctx, p: PrescriptionView, sessionId?: number): Promise<Progression> {
  if (sessionId === undefined) return (await checkPrescriptions(ctx, [p])).get(p.id) as Progression;
  const implement = p.current_load_implement_id ? ((await loadImplements(ctx, { ids: [p.current_load_implement_id] }))[0] ?? null) : null;
  const sets = await all<SetRow>(ctx.db, "SELECT * FROM session_set WHERE session_id = ? AND prescription_id = ? ORDER BY set_number", sessionId, p.id);
  return progressionFrom(p, implement, sets, sessionId);
}

export async function sessionById(ctx: Ctx, id: number): Promise<SessionRow> {
  const s = await first<SessionRow>(ctx.db, "SELECT * FROM session WHERE id = ?", id);
  if (!s) throw new ToolError("not_found", `no session ${id}`, 404);
  const m = (await ctx.members()).find((x) => x.id === s.member_id);
  if (!m) throw new ToolError("not_found", `no session ${id}`, 404);
  return s;
}

export async function gymByRef(ctx: Ctx, ref: string | number, path: (string | number)[]): Promise<{ id: number; name: string }> {
  const gyms = await all<{ id: number; name: string }>(ctx.db, "SELECT id, name FROM gym WHERE household_id = ? ORDER BY id", ctx.householdId);
  const found = gyms.find((g) => (typeof ref === "number" ? g.id === ref : g.name.toLowerCase() === ref.trim().toLowerCase()));
  if (!found) throw new Clarify("unknown_gym", `Which gym is ${ref}?`, gyms.map((g) => g.name), path);
  return found;
}

// ------------------------------------------------------------ next session

export interface ProgrammeRow {
  id: number;
  member_id: number;
  name: string;
  schedule_kind: "weekday" | "rotation";
  started_on: string;
  active: number;
}

export interface SlotRow {
  weekday: number | null;
  rotation_position: number | null;
  name: string;
  template_id: number;
}

export async function activeProgramme(ctx: Ctx, memberId: number): Promise<ProgrammeRow | null> {
  return first<ProgrammeRow>(ctx.db, "SELECT * FROM programme WHERE member_id = ? AND active = 1", memberId);
}

export function scheduleFrom(kind: "weekday" | "rotation", slots: SlotRow[], swaps: { on_date: string; name: string | null }[]): Schedule {
  if (kind === "rotation") {
    return { kind: "rotation", order: [...slots].sort((a, b) => (a.rotation_position ?? 0) - (b.rotation_position ?? 0)).map((s) => s.name) };
  }
  const days: Partial<Record<Weekday, string>> = {};
  for (const s of slots) if (s.weekday !== null) days[WEEKDAYS[s.weekday % 7] as Weekday] = s.name;
  return { kind: "weekday", days, swaps: swaps.map((s) => ({ date: s.on_date, session: s.name })) };
}

export interface NextSessionPlan {
  programme: ProgrammeRow;
  slots: SlotRow[];
  /** The next session by the schedule, or null when it has no training day ahead. */
  next: NextSession | null;
  /** The next session's template, or null. */
  templateId: number | null;
  /** Every prescription in the programme, by template then position. */
  prescriptions: PrescriptionView[];
  /** The member's latest programme session on or before `today`, or null. */
  last: { template_id: number; name: string; performed_on: string } | null;
}

/**
 * Which session is next for a member on `today`. The one place this is
 * decided: next_prescription, inventory_gaps and needs_you all read it.
 * Null when the member has no active programme.
 */
export async function nextSessionPlan(ctx: Ctx, memberId: number, today: string): Promise<NextSessionPlan | null> {
  const programme = await activeProgramme(ctx, memberId);
  if (!programme) return null;
  // The schedule's slots and swaps in one statement (commit_route's worst case sat at the 30 budget).
  const rows = await all<SlotRow & { kind: "slot" | "swap"; on_date: string | null }>(
    ctx.db,
    `SELECT 'slot' AS kind, s.weekday, s.rotation_position, t.name, t.id AS template_id, NULL AS on_date
       FROM schedule_slot s JOIN session_template t ON t.id = s.template_id WHERE s.programme_id = ?1
     UNION ALL
     SELECT 'swap', NULL, NULL, t.name, NULL, w.on_date
       FROM schedule_swap w LEFT JOIN session_template t ON t.id = w.template_id WHERE w.programme_id = ?1`,
    programme.id,
  );
  const slots: SlotRow[] = rows.filter((r) => r.kind === "slot").map(({ weekday, rotation_position, name, template_id }) => ({ weekday, rotation_position, name, template_id }));
  const swaps = rows.filter((r) => r.kind === "swap").map((r) => ({ on_date: r.on_date as string, name: r.name as string | null }));
  const last = await first<{ template_id: number; name: string; performed_on: string }>(
    ctx.db,
    `SELECT t.id AS template_id, t.name, se.performed_on FROM session se JOIN session_template t ON t.id = se.template_id
     WHERE se.member_id = ? AND t.programme_id = ? AND se.performed_on <= ? ORDER BY se.performed_on DESC, se.id DESC LIMIT 1`,
    memberId,
    programme.id,
    today,
  );
  const next = nextSession(scheduleFrom(programme.schedule_kind, slots, swaps), { today, last: last ? { session: last.name, date: last.performed_on } : null });
  const prescriptions = await all<PrescriptionView>(
    ctx.db,
    "SELECT v.* FROM v_prescription v JOIN session_template t ON t.id = v.template_id WHERE t.programme_id = ? ORDER BY v.template_id, v.position",
    programme.id,
  );
  const templateId = next ? (slots.find((s) => s.name === next.session)?.template_id ?? null) : null;
  return { programme, slots, next, templateId, prescriptions, last };
}

// ---------------------------------------------------------------- cadences

export interface CadenceRow {
  id: number;
  member_id: number;
  name: string;
  every_days: number;
  source: "reading" | "cardio_hr" | "exercise" | "manual";
  metric: string | null;
  body_state: string | null;
  exercise_id: number | null;
  last_done_on: string | null;
  message: string;
  active: number;
}

/**
 * A member's active cadences, in id order, each with when it was last done
 * on or before `today` (null = never). Load-once: the cadences, then one
 * grouped query per kind of source in use (at most 4 statements).
 */
export async function cadenceStatus(ctx: Ctx, memberId: number, today: string): Promise<{ cadence: CadenceRow; last: string | null }[]> {
  const rows = await all<CadenceRow>(ctx.db, "SELECT * FROM measurement_cadence WHERE member_id = ? AND active = 1 ORDER BY id", memberId);
  const uses = (source: CadenceRow["source"]) => rows.some((c) => c.source === source);
  const readings = uses("reading")
    ? await all<{ metric: string; body_state: string; d: string }>(
        ctx.db,
        "SELECT metric, body_state, max(measured_on) AS d FROM reading WHERE member_id = ? AND state = 'confirmed' AND measured_on <= ? GROUP BY metric, body_state",
        memberId,
        today,
      )
    : [];
  const hr = uses("cardio_hr")
    ? ((await first<{ d: string | null }>(
        ctx.db,
        `SELECT max(se.performed_on) AS d FROM cardio_block b JOIN session se ON se.id = b.session_id
         WHERE se.member_id = ? AND (b.avg_hr IS NOT NULL OR b.max_hr IS NOT NULL) AND se.performed_on <= ?`,
        memberId,
        today,
      ))?.d ?? null)
    : null;
  const lifted = uses("exercise")
    ? await all<{ exercise_id: number; d: string }>(
        ctx.db,
        `SELECT st.exercise_id, max(se.performed_on) AS d FROM session_set st JOIN session se ON se.id = st.session_id
         WHERE se.member_id = ? AND st.set_type <> 'warm_up' AND se.performed_on <= ? GROUP BY st.exercise_id`,
        memberId,
        today,
      )
    : [];
  const latest = (ds: string[]) => [...ds].sort().at(-1) ?? null;
  return rows.map((c) => {
    let last: string | null = null;
    switch (c.source) {
      case "reading":
        last = latest(readings.filter((r) => r.metric === c.metric && (c.body_state === null || r.body_state === c.body_state)).map((r) => r.d));
        break;
      case "cardio_hr":
        last = hr;
        break;
      case "exercise":
        last = lifted.find((l) => l.exercise_id === c.exercise_id)?.d ?? null;
        break;
      case "manual":
        last = c.last_done_on !== null && c.last_done_on <= today ? c.last_done_on : null;
        break;
    }
    return { cadence: c, last };
  });
}

// ------------------------------------------------------- progression state

export interface NextLoadOut {
  value: number;
  unit: "kg" | "lb";
  plates: PlateGroup[] | null;
}

/** The chip the app shows for a prescription, mapped once here so Train, Today, needs_you and chat agree. */
export type PrescriptionState =
  | { kind: "ready"; next_load: NextLoadOut | null }
  | { kind: "needs_confirmation"; set_ids: number[]; next_load: NextLoadOut | null }
  | { kind: "check_at_gym"; question: string; next_load: NextLoadOut; offer: unknown }
  | { kind: "holding"; reason: string }
  | { kind: "cant_move"; reason: string };

function nextLoadOf(r: NextLoad): NextLoadOut | null {
  if (r.nextLoad === null || r.nextLoadUnit === null) return null;
  return { value: r.nextLoad, unit: r.nextLoadUnit, plates: r.nextLoadPlates ?? null };
}

/**
 * fired → ready (or check at the gym when the step is unverified);
 * needs_confirmation → needs confirmation, naming the sets; not_yet →
 * holding with the reason; never → can't move with why.
 */
export function prescriptionState(check: CheckResult & { offer?: unknown }, implement: string | null): PrescriptionState {
  switch (check.verdict) {
    case "needs_confirmation":
      return { kind: "needs_confirmation", set_ids: check.confirm_set_ids, next_load: nextLoadOf(check) };
    case "fired": {
      const next = nextLoadOf(check);
      if (check.unverified && next) {
        const where = implement ? `on the ${implement}` : "at the gym";
        return { kind: "check_at_gym", question: `Is there a ${next.value} ${next.unit} ${where}?`, next_load: next, offer: check.offer ?? null };
      }
      return { kind: "ready", next_load: next };
    }
    case "not_yet":
      return { kind: "holding", reason: check.message };
    case "never":
      return { kind: "cant_move", reason: check.message };
  }
}

export type Progression = CheckResult & { session_id: number | null; offer?: unknown };

/**
 * check_progression for many prescriptions at once, each against its
 * latest session with sets for it. Load-once: the implements, the latest
 * session per prescription (a window), and those sessions' sets.
 */
export async function checkPrescriptions(ctx: Ctx, ps: readonly PrescriptionView[]): Promise<Map<number, Progression>> {
  return (await loadChecks(ctx, ps)).checks;
}

async function loadChecks(ctx: Ctx, ps: readonly PrescriptionView[]): Promise<{ checks: Map<number, Progression>; impls: ImplementRow[] }> {
  const checks = new Map<number, Progression>();
  if (ps.length === 0) return { checks, impls: [] };
  const impls = await loadImplements(ctx, { ids: [...new Set(ps.map((p) => p.current_load_implement_id).filter((x): x is number => x !== null))] });
  // Through allIn: one statement per 100 keys, never one per prescription (decision 96).
  const latest = await allIn<{ prescription_id: number; session_id: number }>(
    ctx.db,
    (ph) =>
      `SELECT prescription_id, session_id FROM (
         SELECT st.prescription_id, st.session_id,
                row_number() OVER (PARTITION BY st.prescription_id ORDER BY se.performed_on DESC, se.id DESC) AS rn
         FROM session_set st JOIN session se ON se.id = st.session_id WHERE st.prescription_id IN (${ph})
       ) WHERE rn = 1`,
    ps.map((p) => p.id),
  );
  // Every prescribed set of those sessions; a session's sets all come back in one chunk, by set number.
  const sets = await allIn<SetRow>(
    ctx.db,
    (ph) => `SELECT * FROM session_set WHERE session_id IN (${ph}) AND prescription_id IS NOT NULL ORDER BY session_id, set_number`,
    latest.map((l) => l.session_id),
  );
  for (const p of ps) {
    const sid = latest.find((l) => l.prescription_id === p.id)?.session_id ?? null;
    const implement = impls.find((i) => i.id === p.current_load_implement_id) ?? null;
    checks.set(p.id, progressionFrom(p, implement, sets.filter((x) => x.session_id === sid && x.prescription_id === p.id), sid));
  }
  return { checks, impls };
}

/** check_progression's answers and the chip state, for many prescriptions, with the same statements as checkPrescriptions. */
export async function progressionsOf(ctx: Ctx, ps: readonly PrescriptionView[]): Promise<Map<number, { progression: Progression; state: PrescriptionState }>> {
  const { checks, impls } = await loadChecks(ctx, ps);
  const out = new Map<number, { progression: Progression; state: PrescriptionState }>();
  for (const p of ps) {
    const progression = checks.get(p.id) as Progression;
    out.set(p.id, { progression, state: prescriptionState(progression, impls.find((i) => i.id === p.current_load_implement_id)?.name ?? null) });
  }
  return out;
}

/** One prescription's progression and state. */
export async function progressionOf(ctx: Ctx, p: PrescriptionView): Promise<{ progression: Progression; state: PrescriptionState }> {
  return (await progressionsOf(ctx, [p])).get(p.id) as { progression: Progression; state: PrescriptionState };
}
