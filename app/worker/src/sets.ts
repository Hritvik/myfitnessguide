/**
 * One set's logic (spec §5), shared by log_set, preview_set, log_workout
 * and commit_route: RIR rules per programming mode, inventory snapping and
 * off-list handling, the implement, the prescription link, the
 * implausible-load check, and the running set number and position, carried
 * in memory so a call can plan many sets before writing any. Everything a
 * call needs is loaded once, up front (loadSetScope), never per set
 * (decision 96).
 */
import {
  compositionAmount,
  implausibleLoad,
  readNativeLoad,
  snapToImplement,
  type LoadAmount,
  type PlateGroup,
  type SnapResult,
} from "@myfitnessguide/domain";
import { z } from "zod";
import type { Ctx, Member, RecordState } from "./context";
import { all, allIn, first, type Row } from "./db";
import { Clarify, ToolError } from "./errors";
import {
  derive,
  deriveRirAdjusted,
  domainImplement,
  ExerciseIndex,
  gymByRef,
  loadImplements,
  nextSessionPlan,
  prescriptionState,
  progressionFrom,
  rirOf,
  sessionById,
  storedPlates,
  storedSegments,
  storedSides,
  volumeKgOf,
  type ExerciseRow,
  type ImplementRow,
  type PrescriptionState,
  type PrescriptionView,
  type Progression,
  type SessionRow,
  type SetRow,
  type StoredSegment,
  type StoredSide,
} from "./training";

export { storedSegments, storedSides };
export type { StoredSegment, StoredSide };

export const SET_TYPES = ["warm_up", "working", "back_off", "substitution", "calibration"] as const;
export const PLATE = z
  .object({
    value: z.number().gt(0).lt(100),
    unit: z.enum(["kg", "lb"]),
    count: z.number().int().min(1).max(10).optional().describe("How many of this plate on each side; default 1."),
  })
  .strict();

export const LOAD = z
  .object({
    value: z.number().gt(-1000).lt(1000).optional().describe("As entered, in its unit. Assistance is negative. Omit when giving plates."),
    unit: z.enum(["kg", "lb"]).optional(),
    basis: z.enum(["total", "per_side", "per_hand", "per_leg"]),
    implement: z.union([z.number().int().positive(), z.string().min(1)]).optional().describe("Implement id or name at the session's gym."),
    bar: z.object({ value: z.number().min(0).lt(100), unit: z.enum(["kg", "lb"]) }).strict().optional().describe("The bar or sled, for plates per side; default the implement's own."),
    plates: z.array(PLATE).min(1).optional().describe("Plates on each side, units may mix (10 kg + 5 lb): a per_side composition instead of value."),
    unilateral: z.boolean().optional().describe("per_hand / per_leg done one limb at a time: counted once, not doubled."),
    as_stated: z.boolean().optional().describe("The unit is exactly as stated: answers a unit_unclear question."),
  })
  .strict();

/**
 * A load's value read in its native unit: the one that makes it a whole or
 * half number (9.07 kg is the 20 lb dumbbell). Clean in neither unit or in
 * both asks (unit_unclear), unless the value is on the implement's list as
 * stated or the caller says the unit is as stated.
 */
export function nativeLoad(
  value: number,
  unit: "kg" | "lb",
  options: { asStated?: boolean | undefined; implement?: ImplementRow | null; path: (string | number)[] },
): LoadAmount & { read_from?: LoadAmount } {
  if (options.asStated) return { value, unit };
  const listed = options.implement?.loads.some((l) => l.unit === unit && Math.abs(l.value - value) < 1e-9);
  if (listed) return { value, unit };
  const r = readNativeLoad(value, unit);
  if (r.status === "clean") return r.converted ? { value: r.value, unit: r.unit, read_from: { value, unit } } : { value, unit };
  if (r.reason === "clean_in_both") {
    const options_ = r.options.map((o) => `${o.value} ${o.unit}`);
    throw new Clarify("unit_unclear", `${value} ${unit} is a whole or half number in both kg and lb. Which is it?`, options_, options.path, { candidates: r.options });
  }
  throw new Clarify(
    "unit_unclear",
    `${value} ${unit} isn't a whole or half number in kg or lb. What exactly was loaded (for plates, each plate on a side)?`,
    [],
    options.path,
  );
}

/** Plates as stored: every group with its count. */
export function platesOf(plates: readonly { value: number; unit: "kg" | "lb"; count?: number | undefined }[]): PlateGroup[] {
  return plates.map((p) => ({ value: p.value, unit: p.unit, count: p.count ?? 1 }));
}

export interface ResolvedLoad {
  value: number;
  unit: "kg" | "lb";
  basis: "total" | "per_side" | "per_hand" | "per_leg";
  plates: PlateGroup[] | null;
  bar: LoadAmount | null;
  unilateral: boolean;
  read_from?: LoadAmount;
}

/**
 * A load as it will be stored: a single value read in its native unit, or
 * a composition (plates per side, units mixed) whose value is the plates'
 * sum; the bar defaults to the implement's own.
 */
export function resolveLoad(load: z.infer<typeof LOAD>, implement: ImplementRow | null, path: (string | number)[]): ResolvedLoad {
  if (load.unilateral && load.basis !== "per_hand" && load.basis !== "per_leg") {
    throw new Clarify("unilateral_basis", "Unilateral applies to a per-hand or per-leg load. Which is it?", ["per_hand", "per_leg"], [...path, "basis"]);
  }
  if ((load.bar || load.plates) && load.basis !== "per_side") {
    throw new Clarify("bar_only_per_side", "A bar or plates go with a per-side load. Is the load per side?", [], [...path, "basis"]);
  }
  let amount: LoadAmount & { read_from?: LoadAmount };
  let plates: PlateGroup[] | null = null;
  if (load.plates) {
    plates = platesOf(load.plates);
    amount = compositionAmount(plates);
  } else {
    if (load.value === undefined || load.unit === undefined) {
      throw new Clarify("load_value_needed", "What was the load: a value with its unit, or the plates on each side?", [], [...path, "value"]);
    }
    amount = nativeLoad(load.value, load.unit, { asStated: load.as_stated, implement, path: [...path, "value"] });
  }
  const ownBar = implement && implement.bar_value !== null && implement.bar_unit !== null && implement.loading === "per_side" ? { value: implement.bar_value, unit: implement.bar_unit } : null;
  const bar = load.bar ?? (load.basis === "per_side" ? ownBar : null);
  if (load.basis === "per_side" && implement?.loading !== "plates_only" && !bar) {
    throw new Clarify("bar_needed", "What bar were the plates on (for example 20 kg)?", [], [...path, "bar"]);
  }
  const out: ResolvedLoad = { value: amount.value, unit: amount.unit, basis: load.basis, plates, bar, unilateral: load.unilateral === true };
  if (amount.read_from) out.read_from = amount.read_from;
  return out;
}

/** What to offer for a load off the inventory: add it to the list, or record the plates. */
export function offerFor(implement: ImplementRow, snap: Extract<SnapResult, { status: "off_list" }>): Record<string, unknown> {
  if (implement.plates) {
    return { tool: "record_plates", gym_id: implement.gym_id, plates: snap.plates ?? [{ value: snap.value, unit: snap.unit }], nearest: snap.nearest, may_exist: snap.mayExist };
  }
  return { tool: "add_implement_load", implement_id: implement.id, load: { value: snap.value, unit: snap.unit }, nearest: snap.nearest, may_exist: snap.mayExist };
}

export const RIR = z.union([
  z.number().int().min(0).max(10),
  z.object({ low: z.number().int().min(0).max(10), high: z.number().int().min(0).max(10) }).strict(),
  z.literal("not_recorded"),
]);

/** The shapes one logical set can take: one effort, or several physical segments. */
export const SET_STRUCTURES = ["simple", "drop_set", "rest_pause", "superset", "cluster"] as const;
export type SetStructure = (typeof SET_STRUCTURES)[number];

export const CARRY_TYPES = ["farmer", "suitcase", "front_rack", "other"] as const;

/** One physical segment of a compound set, in the order it was done. */
export const SEGMENT = z
  .object({
    load: z.union([LOAD, z.enum(["none", "not_recorded"])]).describe("This segment's load, as a set's load."),
    reps: z.number().int().min(0).max(200).optional(),
    duration_s: z.number().int().positive().optional(),
    distance: z.object({ value: z.number().positive(), unit: z.enum(["m", "km", "mi"]) }).strict().optional(),
    rir: RIR.optional().describe("This segment's own RIR, when it was measured per segment."),
    note: z.string().optional(),
  })
  .strict();
export type SegmentIn = z.infer<typeof SEGMENT>;

/** One side of a carry, when each side was measured separately. */
export const SIDE = z
  .object({
    side: z.enum(["left", "right"]),
    distance_m: z.number().positive().optional(),
    reps: z.number().int().min(0).max(200).optional(),
    duration_s: z.number().int().positive().optional(),
  })
  .strict();
export type SideIn = z.infer<typeof SIDE>;

export function rirColumns(rir: z.infer<typeof RIR> | undefined): { rir_status: string | null; rir_low: number | null; rir_high: number | null } {
  if (rir === undefined) return { rir_status: null, rir_low: null, rir_high: null };
  if (rir === "not_recorded") return { rir_status: "not_recorded", rir_low: null, rir_high: null };
  if (typeof rir === "number") return { rir_status: "recorded", rir_low: rir, rir_high: rir };
  return { rir_status: "recorded", rir_low: rir.low, rir_high: rir.high };
}

export function describeSet(set: SetRow & { id: number | null }, exercise: { name: string; bodyweight_dominant: number; implement_kind: string }, implement: ImplementRow | null) {
  const d = derive(set, implement, exercise);
  const rirEstimate = deriveRirAdjusted(set, implement, exercise);
  const exerciseName = exercise.name;
  return {
    id: set.id,
    session_id: set.session_id,
    exercise: exerciseName,
    set_number: set.set_number,
    position: set.position ?? null,
    set_type: set.set_type,
    prescription_id: set.prescription_id,
    reps: set.reps,
    reps_inferred: set.reps_inferred === 1,
    // A hold or a carry is counted in seconds or distance (decision 144).
    duration_s: (set.duration_s as number | null | undefined) ?? null,
    distance: set.distance_value == null ? null : { value: set.distance_value as number, unit: set.distance_unit as string },
    load_status: set.load_status,
    load_value: set.load_value,
    load_unit: set.load_unit,
    load_basis: set.load_basis,
    unilateral: set.unilateral === 1,
    implement: implement?.name ?? null,
    bar: set.bar_value === null ? null : { value: set.bar_value, unit: set.bar_unit },
    plates: storedPlates(set.plates),
    rir: rirOf(set),
    state: set.state,
    note: (set.note as string | null | undefined) ?? null,
    total_kg: d?.totalKg ?? null,
    volume_kg: set.structure !== undefined && set.structure !== "simple" ? volumeKgOf(set as SetRow, implement, exercise) : (d?.volumeKg ?? null),
    e1rm_kg: d?.e1rmKg ?? null,
    e1rm_rir_kg: rirEstimate?.e1rmKg ?? null,
    // A compound set: one logical set with several physical segments.
    structure: (set.structure as string | undefined) ?? "simple",
    segments: storedSegments(set.segments),
    rir_scope: (set.rir_scope as string | null | undefined) ?? null,
    total_reps: storedSegments(set.segments)?.reduce((n, s) => n + (s.reps ?? 0), 0) ?? set.reps,
    // A carry: how it was held, and each side when they were measured apart.
    carry_type: (set.carry_type as string | null | undefined) ?? null,
    sides: storedSides(set.sides),
    distance_basis: (set.distance_basis as string | null | undefined) ?? null,
    version: (set.version as number | undefined) ?? 1,
  };
}

export const SET_FIELDS = {
  exercise: z.string().min(1).describe("Exercise name or alias."),
  set_type: z.enum(SET_TYPES).optional().describe("Default working."),
  set_number: z.number().int().min(1).optional(),
  reps: z.number().int().min(0).max(200).optional(),
  reps_inferred: z
    .boolean()
    .optional()
    .describe("True when the reps weren't counted but taken from the prescription, because the set was reported in bulk (\"done\", \"as prescribed\"). A load never moves on inferred reps without a confirmation."),
  load: z.union([LOAD, z.enum(["none", "not_recorded"])]).optional().describe("none = bodyweight; not_recorded = never captured."),
  rir: RIR.optional(),
  prescription_id: z.number().int().positive().optional(),
  substituted_prescription_id: z.number().int().positive().optional(),
  duration_s: z.number().int().positive().optional(),
  distance: z.object({ value: z.number().positive(), unit: z.enum(["m", "km", "mi"]) }).strict().optional(),
  steps: z.number().int().positive().optional(),
  note: z.string().optional(),
  position: z.number().int().min(1).optional().describe("Place in the session's running order; default last. Later sets move down one."),
  structure: z
    .enum(SET_STRUCTURES)
    .optional()
    .describe("One logical set: simple (default), or drop_set / rest_pause / superset / cluster with `segments`."),
  segments: z.array(SEGMENT).min(2).optional().describe("A compound set's physical segments in order. The set's own load and reps default to the first segment's."),
  rir_scope: z
    .enum(["segment", "complete_set"])
    .optional()
    .describe("Whether `rir` belongs to the whole set (default for a compound set) or to one segment."),
  carry_type: z.enum(CARRY_TYPES).optional().describe("For a loaded carry: how it was held."),
  sides: z.array(SIDE).min(1).max(2).optional().describe("A carry measured per side (left, right)."),
  distance_basis: z.enum(["total", "per_side"]).optional().describe("Whether `distance` is the whole carry or the distance each side covered. Default total."),
};
export const SET_INPUT = z.object(SET_FIELDS).strict();
export type SetInput = z.infer<typeof SET_INPUT>;

/** The stored set's own fields as the input that would log it, with `changes` overlaid (update_set). */
export function setInputFromRow(row: SetRow, exerciseName: string, changes: Partial<SetInput> = {}): SetInput {
  const stored = storedSegments(row.segments);
  const sides = storedSides(row.sides);
  const rir = rirOf(row);
  const base: SetInput = {
    exercise: exerciseName,
    set_type: row.set_type as SetInput["set_type"],
    set_number: row.set_number,
    ...(row.reps === null ? {} : { reps: row.reps }),
    ...(row.reps_inferred === 1 ? { reps_inferred: true } : {}),
    load:
      row.load_status === "entered"
        ? {
            value: row.load_value as number,
            unit: row.load_unit as "kg" | "lb",
            basis: row.load_basis as NonNullable<SetInput["load"]> extends { basis?: infer B } ? B : never,
            ...(row.load_implement_id === null ? {} : { implement: row.load_implement_id }),
            ...(row.bar_value === null || row.bar_unit === null ? {} : { bar: { value: row.bar_value, unit: row.bar_unit } }),
            ...(row.plates ? { plates: storedPlates(row.plates) ?? undefined } : {}),
            ...(row.unilateral === 1 ? { unilateral: true } : {}),
          }
        : row.load_status,
    ...(rir === null ? {} : { rir }),
    ...(row.prescription_id === null ? {} : { prescription_id: row.prescription_id }),
    ...(row.substituted_prescription_id === null ? {} : { substituted_prescription_id: row.substituted_prescription_id }),
    ...(row.duration_s == null ? {} : { duration_s: row.duration_s as number }),
    ...(row.distance_value == null
      ? {}
      : { distance: { value: row.distance_value as number, unit: row.distance_unit as "m" | "km" | "mi" } }),
    ...(row.steps == null ? {} : { steps: row.steps as number }),
    ...(row.note == null ? {} : { note: row.note as string }),
    position: row.position as number,
    structure: ((row.structure as SetInput["structure"]) ?? "simple") as SetInput["structure"],
    ...(stored === null
      ? {}
      : {
          segments: stored.map((s) => ({
            load: s.load,
            ...(s.reps === null ? {} : { reps: s.reps }),
            ...(s.duration_s === undefined ? {} : { duration_s: s.duration_s }),
            ...(s.distance === undefined ? {} : { distance: s.distance as { value: number; unit: "m" | "km" | "mi" } }),
            ...(s.rir === undefined ? {} : { rir: s.rir as NonNullable<SetInput["rir"]> }),
            ...(s.note === undefined ? {} : { note: s.note }),
          })) as unknown as SetInput["segments"],
        }),
    ...(row.rir_scope == null ? {} : { rir_scope: row.rir_scope as "segment" | "complete_set" }),
    ...(row.carry_type == null ? {} : { carry_type: row.carry_type as SetInput["carry_type"] }),
    ...(sides === null ? {} : { sides: sides.map((s) => ({ ...s })) }),
    ...(row.distance_basis == null ? {} : { distance_basis: row.distance_basis as "total" | "per_side" }),
  };
  // A per-side carry stores the sides, not a second total distance.
  if (base.distance_basis === "per_side") delete base.distance;
  if (base.distance_basis === "total") delete base.sides;
  const merged = { ...base, ...changes };
  // A compound set takes its load and reps from its segments.
  if (merged.structure !== undefined && merged.structure !== "simple") {
    delete merged.load;
    delete merged.reps;
  }
  return merged;
}

export type ImplausibleResult = ReturnType<typeof implausibleLoad>;

/** Everything planning sets in one session reads, loaded once per call. */
export interface SetScope {
  session: SessionRow;
  /** True when the session is staged in this call (or only previewed), so it has no stored sets. */
  fresh: boolean;
  member: Member;
  exercises: ExerciseIndex;
  /** The implements at the session's gym. */
  atGym: ImplementRow[];
  /** The session's stored sets, last position first. */
  existing: SetRow[];
  /** The session template's prescriptions, in position order (empty without a template). */
  prescriptions: PrescriptionView[];
  /** The member's earlier loaded, non-warm-up sets of the exercises the call names, with their dates. */
  history: (SetRow & { performed_on: string })[];
  /** Implements that history used or the prescriptions load on, not at this gym. */
  elsewhere: ImplementRow[];
}

export async function loadSetScope(
  ctx: Ctx,
  session: SessionRow,
  options: { fresh: boolean; names: readonly string[]; prescriptions?: PrescriptionView[] },
): Promise<SetScope> {
  const member = await ctx.memberById(session.member_id);
  const exercises = await ExerciseIndex.load(ctx);
  const atGym = session.gym_id === null ? [] : await loadImplements(ctx, { gymId: session.gym_id });
  const existing = options.fresh ? [] : await all<SetRow>(ctx.db, "SELECT * FROM session_set WHERE session_id = ? ORDER BY position DESC", session.id);
  const prescriptions =
    options.prescriptions ??
    (session.template_id === null ? [] : await all<PrescriptionView>(ctx.db, "SELECT * FROM v_prescription WHERE template_id = ? ORDER BY position", session.template_id));
  const ids = [...new Set(options.names.map((n) => exercises.lookup(n)?.id).filter((x): x is number => x !== undefined))];
  const history = await allIn<SetRow & { performed_on: string }>(
    ctx.db,
    (ph) =>
      `SELECT st.*, se.performed_on FROM session_set st JOIN session se ON se.id = st.session_id
       WHERE se.member_id = ? AND st.exercise_id IN (${ph}) AND st.load_status = 'entered' AND st.set_type <> 'warm_up'`,
    ids,
    member.id,
  );
  // With the prescriptions' own implements, so a progression checked here
  // reads the implement check_progression reads, wherever it is.
  const otherIds = [...history.map((h) => h.load_implement_id), ...prescriptions.map((p) => p.current_load_implement_id)];
  const elsewhereIds = [...new Set(otherIds.filter((x): x is number => x !== null && !atGym.some((i) => i.id === x)))];
  const elsewhere = await loadImplements(ctx, { ids: elsewhereIds });
  return { session, fresh: options.fresh, member, exercises, atGym, existing, prescriptions, history, elsewhere };
}

/** Where the next set goes: the last position, and the highest set number of each exercise. */
export interface RunningOrder {
  end: number;
  setNumbers: Map<number, number>;
}

export function runningOrder(existing: readonly SetRow[]): RunningOrder {
  const setNumbers = new Map<number, number>();
  for (const s of existing) setNumbers.set(s.exercise_id, Math.max(setNumbers.get(s.exercise_id) ?? 0, s.set_number));
  return { end: existing.reduce((m, s) => Math.max(m, (s.position as number | null) ?? 0), 0), setNumbers };
}

async function chooseImplement(
  ctx: Ctx,
  scope: SetScope,
  exercise: ExerciseRow,
  ref: number | string | undefined,
  path: (string | number)[],
): Promise<ImplementRow | null> {
  const atGym = scope.atGym;
  if (ref !== undefined) {
    const key = typeof ref === "string" ? ref.trim().toLowerCase() : null;
    if (typeof ref === "number") {
      const found = atGym.find((i) => i.id === ref) ?? (await loadImplements(ctx, { ids: [ref] }))[0];
      if (found) return found;
    } else {
      const named = atGym.find((i) => i.name.toLowerCase() === key);
      if (named) return named;
      // The household's own word for an implement at this gym.
      const word = ref.trim();
      const alias = await first<{ id: number; name: string; gym: string }>(
        ctx.db,
        `SELECT i.id, i.name, g.name AS gym FROM alias a JOIN implement i ON i.id = a.target_id JOIN gym g ON g.id = i.gym_id
         WHERE a.household_id = ? AND a.kind = 'implement' AND a.alias = ? COLLATE NOCASE`,
        ctx.householdId,
        word,
      );
      if (alias) {
        const found = atGym.find((i) => i.id === alias.id);
        if (found) return found;
        throw new Clarify("implement_elsewhere", `"${word}" is ${alias.name} at ${alias.gym}, not at this session's gym. Which implement was it?`, atGym.map((i) => i.name), path);
      }
    }
    throw new Clarify("unknown_implement", `Which implement is ${ref}?`, atGym.map((i) => i.name), path);
  }
  const candidates = atGym.filter((i) => i.kind === exercise.implement_kind);
  // The session's template prescribes this exercise on a named implement: that one.
  if (candidates.length > 1) {
    const linked = scope.prescriptions.find((p) => p.exercise_id === exercise.id && p.current_load_implement_id !== null);
    const found = linked ? candidates.find((i) => i.id === linked.current_load_implement_id) : undefined;
    if (found) return found;
  }
  if (candidates.length > 1) {
    throw new Clarify("implement_needed", `Which ${exercise.implement_kind} was the ${exercise.name} done on?`, candidates.map((i) => i.name), path);
  }
  return candidates[0] ?? null;
}

/**
 * A stored set's load checked against its implement's inventory, including
 * every segment of a compound set. `off_list` is true when any part of the
 * set is off the list; `offer` says what to record.
 */
export function snapSet(set: SetRow, implement: ImplementRow | null) {
  const segmentSnaps: { sequence: number; status: string; value?: number; unit?: string; nearest?: unknown; mayExist?: boolean }[] = [];
  let snap: SnapResult | null = null;
  let offer: Record<string, unknown> | null = null;
  let offList = false;
  if (set.load_status === "entered" && implement && set.load_value !== null && set.load_unit !== null) {
    snap = snapToImplement(set.load_value, set.load_unit, domainImplement(implement, { unit: set.load_unit }), storedPlates(set.plates) ?? undefined);
    if (snap.status === "off_list") {
      offList = true;
      offer = offerFor(implement, snap);
    }
  }
  const segments = storedSegments(set.segments);
  if (segments !== null && implement) {
    for (const segment of segments) {
      if (typeof segment.load !== "object") continue;
      const load = segment.load;
      const segSnap = snapToImplement(load.value, load.unit, domainImplement(implement, { unit: load.unit }), load.plates as PlateGroup[] | undefined);
      segmentSnaps.push({
        sequence: segment.sequence,
        status: segSnap.status,
        ...(segSnap.status === "off_list" ? { value: load.value, unit: load.unit, nearest: segSnap.nearest, mayExist: segSnap.mayExist } : {}),
      });
      if (segSnap.status === "off_list") {
        offList = true;
        if (offer === null) offer = offerFor(implement, segSnap);
      }
    }
  }
  return { snap, offer, off_list: offList, segment_snaps: segmentSnaps };
}

export interface PlannedSet {
  row: Row & { exercise_id: number; set_number: number; position: number; prescription_id: number | null; state: RecordState };
  exercise: ExerciseRow;
  implement: ImplementRow | null;
  snap: SnapResult | null;
  offer: Record<string, unknown> | null;
  implausible: ImplausibleResult | null;
  read_from: LoadAmount | null;
  /** Stored sets an explicit position moves down one place. */
  moved: SetRow[];
  /** A compound set's per-segment inventory check (empty for a simple set). */
  segmentSnaps: { sequence: number; status: string; value?: number; unit?: string; nearest?: unknown; mayExist?: boolean }[];
}

/**
 * One set, planned against the scope, asking (Clarify, at `path`) on any
 * ambiguity, exactly as log_set always has. Advances `running`.
 */
/** A compound set's segment after planning: its load resolved as a set's is. */
interface PlannedSegment {
  sequence: number;
  load: ResolvedLoad | "none" | "not_recorded";
  reps: number | null;
  duration_s?: number;
  distance?: { value: number; unit: string };
  rir?: unknown;
  note?: string;
  /** The implement this segment's load was resolved against (its own, else the exercise's). */
  implementId?: number | null;
}

export async function planSet(ctx: Ctx, scope: SetScope, input: SetInput, running: RunningOrder, path: (string | number)[] = []): Promise<PlannedSet> {
  const at = (...p: (string | number)[]) => [...path, ...p];
  const { session, member } = scope;
  const exercise = scope.exercises.find(input.exercise, at("exercise"));
  const structure: SetStructure = input.structure ?? "simple";

  // A compound set: one logical effort made of several physical segments.
  // The row keeps the opening segment's load and reps, so a reader that
  // knows nothing of segments still sees the set it starts with.
  let segments: PlannedSegment[] | null = null;
  let firstSegment: PlannedSegment | null = null;
  if (structure !== "simple") {
    if (input.segments === undefined || input.segments.length < 2) {
      throw new Clarify("segments_needed", `A ${structure.replace("_", " ")} is one set made of more than one effort. Give its segments in order, each with a load and reps.`, [], at("segments"));
    }
    if (input.load !== undefined || input.reps !== undefined) {
      throw new Clarify("segments_replace_load", "For a compound set the segments carry the load and reps; leave the set's own load and reps out (they come from the first segment).", [], at("segments"));
    }
    const resolved: PlannedSegment[] = [];
    for (const [i, s] of input.segments.entries()) {
      const segLoad = typeof s.load === "object" ? s.load : null;
      const segImplement = segLoad ? await chooseImplement(ctx, scope, exercise, segLoad.implement, at("segments", i, "load", "implement")) : null;
      const plannedLoad: PlannedSegment["load"] = segLoad
        ? resolveLoad(segLoad, segImplement, at("segments", i, "load"))
        : (s.load as "none" | "not_recorded");
      resolved.push({
        sequence: i + 1,
        load: plannedLoad,
        reps: s.reps ?? null,
        implementId: segImplement?.id ?? null,
        ...(s.duration_s === undefined ? {} : { duration_s: s.duration_s }),
        ...(s.distance === undefined ? {} : { distance: s.distance }),
        ...(s.rir === undefined ? {} : { rir: s.rir }),
        ...(s.note === undefined ? {} : { note: s.note }),
      });
    }
    if (!resolved.some((s) => s.reps !== null || s.duration_s !== undefined || s.distance !== undefined)) {
      throw new Clarify("segment_effort_needed", "Each segment needs reps, a duration or a distance.", [], at("segments"));
    }
    segments = resolved;
    firstSegment = resolved[0] as PlannedSegment;
  }

  // The opening effort: the first segment of a compound set, or the set's own load.
  let implement: ImplementRow | null;
  let load: ResolvedLoad | null;
  if (firstSegment) {
    const first = firstSegment.load;
    load = typeof first === "object" ? first : null;
    // The first segment was resolved against its own implement, which is the set's.
    implement = load ? (scope.atGym.find((i) => i.id === firstSegment?.implementId) ?? null) : null;
  } else {
    if (input.load === undefined) {
      throw new Clarify("load_needed", `What load was the ${exercise.name} done with? Give it, or none for bodyweight.`, ["none", "not_recorded"], at("load"));
    }
    const inputLoad = typeof input.load === "object" ? input.load : null;
    implement = inputLoad ? await chooseImplement(ctx, scope, exercise, inputLoad.implement, at("load", "implement")) : null;
    load = inputLoad ? resolveLoad(inputLoad, implement, at("load")) : null;
  }
  const openingLoadStatus: "entered" | "none" | "not_recorded" = firstSegment
    ? typeof firstSegment.load === "object"
      ? "entered"
      : firstSegment.load
    : typeof input.load === "object"
      ? "entered"
      : (input.load as "none" | "not_recorded");
  const setType = input.set_type ?? "working";
  if ((setType === "substitution") !== (input.substituted_prescription_id !== undefined)) {
    throw new Clarify("substitution_needs_prescription", "Which prescription did this substitution replace?", [], at("substituted_prescription_id"));
  }
  const openingReps = firstSegment ? firstSegment.reps : input.reps;
  if (input.reps_inferred && openingReps === undefined) {
    throw new Clarify("reps_needed", "Inferred reps are the prescription's reps; how many does it prescribe?", [], at("reps"));
  }

  // Per-side carry: left/right performance, and whether `distance` is the
  // total or each side's distance.
  let sides: SideIn[] | null = null;
  let distanceBasis: "total" | "per_side" | null = null;
  if (input.sides !== undefined) {
    const seen = new Set<string>();
    for (const [i, s] of input.sides.entries()) {
      if (seen.has(s.side)) throw new Clarify("duplicate_side", `The ${s.side} side is given twice; give each side once.`, [], at("sides", i, "side"));
      seen.add(s.side);
      if (s.distance_m === undefined && s.reps === undefined && s.duration_s === undefined) {
        throw new Clarify("side_effort_needed", `What did the ${s.side} side do: a distance, reps or a duration?`, [], at("sides", i));
      }
    }
    sides = input.sides;
    distanceBasis = input.distance_basis ?? "per_side";
    if (distanceBasis === "per_side" && input.distance !== undefined) {
      throw new Clarify("distance_or_sides", "Give the distance per side in `sides`, or one total distance, not both.", [], at("distance"));
    }
    if (distanceBasis === "total" && input.distance === undefined) {
      throw new Clarify("distance_needed", "A total distance needs its value and unit.", [], at("distance"));
    }
  } else if (input.distance_basis === "per_side") {
    throw new Clarify("sides_needed", "A per-side distance needs each side's distance.", [], at("sides"));
  }
  const distance = input.distance ?? (sides && distanceBasis === "per_side"
    ? { value: sides.reduce((m, s) => m + (s.distance_m ?? 0), 0) || undefined, unit: "m" as const }
    : undefined);
  if (distance && distance.value === undefined) {
    throw new Clarify("distance_needed", "What distance did the carry cover?", [], at("distance"));
  }

  // RIR: required to confirm for prescribed members; record-only members may skip it.
  let rir = input.rir;
  let state: RecordState = ctx.stateFor(member.id, { coach: true });
  if (member.programming_mode === "record_only" && rir === undefined) rir = "not_recorded";
  // Reps in reserve belongs to counted reps: a hold or a carry (timed or measured, no reps) is not asked it (decision 144).
  const counted = openingReps !== undefined || (input.duration_s === undefined && distance === undefined);
  if (!counted && rir === undefined) rir = "not_recorded";
  // Only the importer may confirm a prescribed member's counted set as not recorded (the Sheets history).
  const notRecordedAllowed = ctx.writeInfo.origin === "import" || !counted;
  if (state === "confirmed" && member.programming_mode === "prescribed" && (rir === undefined || (rir === "not_recorded" && !notRecordedAllowed))) {
    throw new Clarify("rir_needed", `How many reps in reserve did ${member.name} have on that set?`, [], at("rir"));
  }
  if (rir !== undefined && typeof rir === "object" && rir.low > rir.high) {
    throw new Clarify("rir_range", "The RIR range runs low to high; which numbers?", [], at("rir"));
  }
  const rirScope = structure === "simple" ? null : (input.rir_scope ?? "complete_set");
  if (rirScope === "segment" && structure !== "simple") {
    if (rir !== undefined) throw new Clarify("rir_scope_conflict", "With a per-segment RIR, give each segment its own RIR instead of the set's.", [], at("rir"));
    if (!segments?.some((s) => s.rir !== undefined)) {
      throw new Clarify("segment_rir_needed", "Which segment's RIR is it? Give at least one segment an rir.", [], at("segments"));
    }
  }

  // The inventory check never changes the logged value; off the list, the set stays a flagged draft.
  let snap: SnapResult | null = null;
  let offer: Record<string, unknown> | null = null;
  if (load) {
    snap = implement
      ? snapToImplement(load.value, load.unit, domainImplement(implement, { unit: load.unit }), load.plates ?? undefined)
      : { status: "no_inventory", value: load.value, unit: load.unit };
    if (snap.status === "off_list" && implement) {
      state = "draft";
      offer = offerFor(implement, snap);
    }
  }
  // Every segment is checked too: a drop set is only as valid as its lightest load.
  const segmentSnaps: { sequence: number; status: string; value?: number; unit?: string; nearest?: unknown; mayExist?: boolean }[] = [];
  if (segments && implement) {
    for (const s of segments) {
      if (typeof s.load !== "object") continue;
      const segSnap = snapToImplement((s.load as ResolvedLoad).value, (s.load as ResolvedLoad).unit, domainImplement(implement, { unit: (s.load as ResolvedLoad).unit }), (s.load as ResolvedLoad).plates ?? undefined);
      segmentSnaps.push({ sequence: s.sequence, status: segSnap.status, ...(segSnap.status === "off_list" ? { value: (s.load as ResolvedLoad).value, unit: (s.load as ResolvedLoad).unit, nearest: segSnap.nearest, mayExist: segSnap.mayExist } : {}) });
      if (segSnap.status === "off_list") {
        state = "draft";
        if (!offer) offer = offerFor(implement, segSnap);
      }
    }
  }

  // Running order: append, or insert at an explicit position and move the later sets down.
  if (input.position !== undefined && input.position > running.end + 1) {
    throw new Clarify("position_past_end", `The session has ${running.end} sets; where in the order does this one go?`, [String(running.end + 1)], at("position"));
  }
  const position = input.position ?? running.end + 1;
  const moved = scope.existing.filter((x) => (x.position as number) >= position);
  const setNumber = input.set_number ?? (running.setNumbers.get(exercise.id) ?? 0) + 1;
  running.setNumbers.set(exercise.id, Math.max(running.setNumbers.get(exercise.id) ?? 0, setNumber));
  running.end += 1;

  let prescriptionId = input.prescription_id ?? null;
  if (prescriptionId === null && session.template_id !== null && setType !== "substitution") {
    prescriptionId = scope.prescriptions.find((p) => p.exercise_id === exercise.id)?.id ?? null;
  }
  const row = {
    session_id: session.id, exercise_id: exercise.id, set_number: setNumber, set_type: setType, prescription_id: prescriptionId,
    substituted_prescription_id: input.substituted_prescription_id ?? null, reps: openingReps ?? null, reps_inferred: input.reps_inferred ? 1 : 0,
    load_status: openingLoadStatus,
    load_value: load?.value ?? null, load_unit: load?.unit ?? null, load_basis: load?.basis ?? null, unilateral: load?.unilateral ? 1 : 0,
    load_implement_id: implement?.id ?? null, bar_value: load?.bar?.value ?? null, bar_unit: load?.bar?.unit ?? null,
    plates: load?.plates ? JSON.stringify(load.plates) : null,
    ...rirColumns(rir), duration_s: firstSegment?.duration_s ?? input.duration_s ?? null,
    distance_value: distance?.value ?? null, distance_unit: distance?.unit ?? null, steps: input.steps ?? null,
    note: input.note ?? null, position,
    structure, segments: segments ? JSON.stringify(segments) : null, rir_scope: rirScope,
    carry_type: input.carry_type ?? null, sides: sides ? JSON.stringify(sides) : null, distance_basis: distanceBasis,
    ...ctx.stamp(state), draft_reason: state === "draft" ? (offer ? "off_list" : "awaiting_member") : null,
  };

  // Implausible against this member's history of the exercise (same implement for plates-only loads).
  let implausible: ImplausibleResult | null = null;
  const totalKg = derive({ id: 0, ...row } as unknown as SetRow, implement, exercise)?.totalKg ?? null;
  if (totalKg !== null) {
    const impls = [...scope.atGym, ...scope.elsewhere];
    const history = scope.history.filter((h) => h.exercise_id === exercise.id);
    const comparable = implement?.loading === "plates_only" ? history.filter((h) => h.load_implement_id === implement.id) : history;
    const totals = comparable
      .map((h) => ({ date: h.performed_on, totalKg: derive(h, impls.find((i) => i.id === h.load_implement_id) ?? null)?.totalKg ?? null }))
      .filter((h): h is { date: string; totalKg: number } => h.totalKg !== null);
    implausible = implausibleLoad(totalKg, totals);
  }
  return { row, exercise, implement, snap, offer, implausible, read_from: load?.read_from ?? null, moved, segmentSnaps };
}

/** What log_set returns for a planned set; `id` is null for a preview. */
export function describePlanned(p: PlannedSet, id: number | null) {
  return {
    set: describeSet({ id, ...p.row } as unknown as SetRow & { id: number | null }, p.exercise, p.implement),
    snap: p.snap,
    offer: p.offer,
    implausible: p.implausible,
    read_from: p.read_from,
    ...(p.segmentSnaps.length > 0 ? { segment_snaps: p.segmentSnaps } : {}),
  };
}

/**
 * Write planned sets. Each set's position was planned against the running
 * order as it stood (stored sets plus the sets planned before it), so the
 * final positions are worked out in memory, as the same sets logged one by
 * one would land: a set at an explicit position moves every stored and
 * earlier-planned set at or after it down one. Then the stored sets that
 * moved go to their final positions in two UPDATEs (out of the way, then
 * into place, so no two sets ever share a position) with one version each,
 * and every set is inserted in one createMany statement (decision 96).
 */
export async function stageSets(ctx: Ctx, scope: SetScope, planned: readonly PlannedSet[]) {
  const tx = ctx.txOrThrow;
  const storedAt = new Map(scope.existing.map((s) => [s.id, s.position as number]));
  const plannedAt: number[] = [];
  for (const p of planned) {
    // An appended set is past every set so far, so it moves none.
    const at = p.row.position;
    for (const [id, q] of storedAt) if (q >= at) storedAt.set(id, q + 1);
    for (let i = 0; i < plannedAt.length; i++) if ((plannedAt[i] as number) >= at) plannedAt[i] = (plannedAt[i] as number) + 1;
    plannedAt.push(at);
  }
  const moved = scope.existing.filter((s) => storedAt.get(s.id) !== s.position);
  if (moved.length > 0) {
    const json = JSON.stringify(moved.map((s) => ({ id: s.id, position: storedAt.get(s.id) })));
    const ids = "SELECT json_extract(value, '$.id') FROM json_each(?)";
    tx.exec(`UPDATE session_set SET position = position + 1000000 WHERE session_id = ? AND id IN (${ids})`, scope.session.id, json);
    tx.exec(
      `UPDATE session_set SET position = (SELECT json_extract(j.value, '$.position') FROM json_each(?) AS j WHERE json_extract(j.value, '$.id') = session_set.id)
       WHERE session_id = ? AND id IN (${ids})`,
      json,
      scope.session.id,
      json,
    );
    tx.versions("session_set", "amend", moved.map((s) => ({ id: s.id, data: { ...s, position: storedAt.get(s.id) as number } })));
  }
  const placed = planned.map((p, i) => ({ ...p, row: { ...p.row, position: plannedAt[i] as number } }));
  const ids = await tx.createMany("session_set", placed.map((p) => p.row));
  return { ids, sets: placed.map((p, i) => describePlanned(p, ids[i] as number)) };
}

// ------------------------------------------------------------ the session

/** What a call wants of the member's session that day. */
export interface SessionWant {
  /** "next": a prescribed member's next programme session; a template; or none. */
  template: "next" | { id: number; name: string; prescriptions: PrescriptionView[]; /** A default, not named by the caller: a plain session that day asks among these instead of taking it. */ ask?: string[] } | null;
  workout: { id: number; name: string } | null;
  /**
   * log_set's `template` (click test P2-16): the session that day following
   * that template, else a plain one there to attach it to, else a new one
   * beside whatever else that day holds, rather than asking.
   */
  alongside?: boolean;
}

export interface SessionPick {
  existing: (SessionRow & { template_name: string | null; workout_name: string | null }) | null;
  /** The session to create when there is none. */
  plan: { gym_id: number; template_id: number | null; template: string | null; workout_id: number | null; workout: string | null } | null;
  /** A link to add to an existing session that has neither a template nor a workout. */
  attach: { template_id: number } | { workout_id: number } | null;
  /** The session template's prescriptions, when known without another statement. */
  prescriptions?: PrescriptionView[];
}

/**
 * The member's strength session on a date: the one there is, or the one to
 * create (spec §5). Several ask; a session that follows something other
 * than what the call logs asks. One statement, plus the next-session plan
 * when a prescribed member's session is created.
 */
/** The member-facing question for a session with no gym: the household's gyms are the options. */
export async function gymNeeded(ctx: Ctx, path: (string | number)[]): Promise<Clarify> {
  const gyms = await all<{ name: string }>(ctx.db, "SELECT name FROM gym WHERE household_id = ? ORDER BY id", ctx.householdId);
  return new Clarify("gym_needed", "Which gym are you at?", gyms.map((g) => g.name), path);
}

export async function pickSession(
  ctx: Ctx,
  member: Member,
  date: string,
  want: SessionWant,
  path: (string | number)[],
  gym?: number | string,
): Promise<SessionPick> {
  const found = await all<SessionRow & { template_name: string | null; workout_name: string | null; set_count: number }>(
    ctx.db,
    `SELECT se.*, t.name AS template_name, w.name AS workout_name, (SELECT count(*) FROM session_set st WHERE st.session_id = se.id) AS set_count
     FROM session se LEFT JOIN session_template t ON t.id = se.template_id LEFT JOIN workout w ON w.id = se.workout_id
     WHERE se.member_id = ? AND se.performed_on = ? AND se.session_type = 'strength' ORDER BY se.id`,
    member.id,
    date,
  );
  const named = typeof want.template === "object" && want.template !== null ? want.template : null;
  if (want.alongside && named) {
    const same = found.filter((s) => s.template_id === named.id);
    const plain = found.length === 1 && found[0]?.template_id === null && found[0]?.workout_id === null;
    // A new session beside the day's others; the one following it, or a lone plain one, is taken below.
    if (same.length === 1) found.splice(0, found.length, same[0] as (typeof found)[number]);
    else if (same.length === 0 && !plain) found.splice(0, found.length);
  }
  if (found.length > 1) {
    const options = found.map((s) => ({ session_id: s.id, template: s.template_name, workout: s.workout_name, sets: s.set_count }));
    throw new Clarify("session_choice", `${member.name} has ${found.length} strength sessions on ${date}. Which one is this in?`, options, [...path, "session_id"]);
  }
  const one = found[0];
  if (one) {
    const { set_count: _n, ...existing } = one;
    const wanted = typeof want.template === "object" && want.template !== null ? want.template : null;
    const conflict =
      (want.workout && (one.template_id !== null || (one.workout_id !== null && one.workout_id !== want.workout.id))) ||
      (wanted && (one.workout_id !== null || (one.template_id !== null && one.template_id !== wanted.id)));
    if (conflict) {
      const follows = one.template_name ?? one.workout_name ?? "something else";
      throw new Clarify(
        "session_source_conflict",
        `${member.name}'s session on ${date} follows ${follows}. Log these sets into it as free sets?`,
        ["none"],
        [...path, "source", "kind"],
      );
    }
    const plain = one.template_id === null && one.workout_id === null;
    if (plain && wanted?.ask && !want.workout) {
      throw new Clarify("which_template", `${member.name}'s session on ${date} follows no programme session. Which one was it?`, wanted.ask, [...path, "source", "template"]);
    }
    const attach = plain && want.workout ? { workout_id: want.workout.id } : plain && wanted ? { template_id: wanted.id } : null;
    return { existing, plan: null, attach, ...(wanted ? { prescriptions: wanted.prescriptions } : {}) };
  }
  // A new session goes to the gym the call names, else the member's home gym;
  // with neither, the member is asked which, from the household's gyms.
  let gymId: number;
  if (gym !== undefined) gymId = (await gymByRef(ctx, gym, [...path, "gym"])).id;
  else if (member.home_gym_id !== null) gymId = member.home_gym_id;
  else throw await gymNeeded(ctx, [...path, "gym"]);
  let template: { id: number; name: string } | null = null;
  let prescriptions: PrescriptionView[] = [];
  if (want.template === "next") {
    if (member.programming_mode === "prescribed") {
      const next = await nextSessionPlan(ctx, member.id, date);
      if (next && next.templateId !== null && next.next) {
        template = { id: next.templateId, name: next.next.session };
        prescriptions = next.prescriptions.filter((p) => p.template_id === next.templateId);
      }
    }
  } else if (want.template) {
    template = { id: want.template.id, name: want.template.name };
    prescriptions = want.template.prescriptions;
  }
  return {
    existing: null,
    plan: { gym_id: gymId, template_id: template?.id ?? null, template: template?.name ?? null, workout_id: want.workout?.id ?? null, workout: want.workout?.name ?? null },
    attach: null,
    prescriptions,
  };
}

export interface SessionTarget {
  session: SessionRow;
  /** True for a session created (or, in a preview, to be created) by this call: it has no stored sets. */
  fresh: boolean;
  created: boolean;
  template: string | null;
  workout: string | null;
  prescriptions?: PrescriptionView[];
}

/**
 * The session a call's sets go into: `session_id`, or the member's session
 * on `date`, found or created. With `stage`, a new session is staged in the
 * call's write (one createMany row) and a link is added to a plain one;
 * without, nothing is written and a new session has id 0 (previews).
 */
export async function sessionFor(
  ctx: Ctx,
  input: { session_id?: number | undefined; member?: string | undefined; date?: string | undefined; gym?: number | string | undefined },
  want: SessionWant,
  stage: boolean,
): Promise<SessionTarget> {
  if (input.session_id !== undefined) {
    if (input.member !== undefined || input.date !== undefined) throw new ToolError("session_or_member", "give session_id, or member and date, not both", 400);
    return { session: await sessionById(ctx, input.session_id), fresh: false, created: false, template: null, workout: null };
  }
  if (input.member === undefined || input.date === undefined) throw new ToolError("session_or_member", "give session_id, or member and date", 400);
  const member = await ctx.member(input.member);
  const pick = await pickSession(ctx, member, input.date, want, [], input.gym);
  if (pick.existing) {
    let session: SessionRow = pick.existing;
    if (stage && pick.attach) {
      const { template_name: _t, workout_name: _w, ...row } = pick.existing;
      ctx.txOrThrow.update("session", session.id, pick.attach, { ...row, ...pick.attach });
      session = { ...session, ...pick.attach };
    }
    return {
      session,
      fresh: false,
      created: false,
      template: pick.existing.template_name ?? (want.template && want.template !== "next" && "template_id" in (pick.attach ?? {}) ? want.template.name : null),
      workout: pick.existing.workout_name ?? (want.workout && pick.attach && "workout_id" in pick.attach ? want.workout.name : null),
      ...(pick.prescriptions ? { prescriptions: pick.prescriptions } : {}),
    };
  }
  const plan = pick.plan as NonNullable<SessionPick["plan"]>;
  const row = {
    member_id: member.id, performed_on: input.date, gym_id: plan.gym_id, session_type: "strength", template_id: plan.template_id, workout_id: plan.workout_id,
    started_at: null, ended_at: null, energy_kcal: null, note: null, ...ctx.stamp(ctx.stateFor(member.id, { coach: true })),
  };
  const id = stage ? ((await ctx.txOrThrow.createMany("session", [row]))[0] as number) : 0;
  return { session: { id, ...row } as unknown as SessionRow, fresh: true, created: stage, template: plan.template, workout: plan.workout, prescriptions: pick.prescriptions ?? [] };
}

const { position: _position, set_number: _setNumber, ...MANY_SET_FIELDS } = SET_FIELDS;
/** One set's fields when a call logs many sets into one session (log_workout, commit_route): the running order is the call's. */
export const SESSION_SET_FIELDS = MANY_SET_FIELDS;

/**
 * Each prescription these sets link to, checked against the session's
 * stored sets and the staged ones (spec §5: "checked against the staged
 * sets"), with the chip state Train shows. No statement: the scope holds
 * the prescriptions and implements.
 */
export function stagedProgression(scope: SetScope, planned: readonly PlannedSet[], ids: readonly number[]) {
  const staged = planned.map((p, i) => ({ id: ids[i], ...p.row }) as unknown as SetRow);
  const linked = [...new Set(staged.map((s) => s.prescription_id).filter((x): x is number => x !== null))];
  const impls = [...scope.atGym, ...scope.elsewhere];
  return linked.flatMap((pid) => {
    const p = scope.prescriptions.find((x) => x.id === pid);
    if (!p) return [];
    const implement = impls.find((i) => i.id === p.current_load_implement_id) ?? null;
    const sets = [...scope.existing, ...staged].filter((s) => s.prescription_id === pid).sort((a, b) => a.set_number - b.set_number);
    const progression: Progression = progressionFrom(p, implement, sets, scope.session.id);
    const state: PrescriptionState = prescriptionState(progression, implement?.name ?? null);
    return [{ prescription_id: pid, exercise: p.exercise_name, progression, state }];
  });
}

/**
 * A programme load's fields (a prescription's or a load change's): a value
 * with its unit, or a composition as log_set takes it (plates per side,
 * units mixed, on a bar or sled).
 */
export const PROGRAMME_LOAD = {
  value: z.number().gt(-1000).lt(1000).optional().describe("In its unit. Assistance is negative. Omit when giving plates."),
  unit: z.enum(["kg", "lb"]).optional(),
  basis: z.enum(["total", "per_side", "per_hand", "per_leg"]),
  bar: z.object({ value: z.number().min(0).lt(100), unit: z.enum(["kg", "lb"]) }).strict().optional().describe("The bar or sled, for plates per side; default the implement's own."),
  plates: z.array(PLATE).min(1).optional().describe("Plates on each side, units may mix (a 20 kg bar with 10 lb + 2.5 lb a side): a per_side composition instead of value."),
};

export interface ProgrammeLoad {
  value: number;
  unit: "kg" | "lb";
  basis: "total" | "per_side" | "per_hand" | "per_leg";
  bar: LoadAmount | null;
  plates: PlateGroup[] | null;
}

/**
 * A programme load as stored: a value as given, or a composition whose
 * value is the plates' per-side sum, with the bar (the implement's own
 * unless given).
 */
export function programmeLoad(
  load: { value?: number | undefined; unit?: "kg" | "lb" | undefined; basis: ProgrammeLoad["basis"]; bar?: LoadAmount | undefined; plates?: { value: number; unit: "kg" | "lb"; count?: number | undefined }[] | undefined },
  implement: ImplementRow | null,
  path: (string | number)[],
): ProgrammeLoad {
  if ((load.bar || load.plates) && load.basis !== "per_side") {
    throw new Clarify("bar_only_per_side", "A bar or plates go with a per-side load. Is the load per side?", [], [...path, "basis"]);
  }
  if (load.plates) {
    const plates = platesOf(load.plates);
    const amount = compositionAmount(plates);
    const ownBar = implement && implement.bar_value !== null && implement.bar_unit !== null && implement.loading === "per_side" ? { value: implement.bar_value, unit: implement.bar_unit } : null;
    const bar = load.bar ?? ownBar;
    if (!bar && implement?.loading !== "plates_only") throw new Clarify("bar_needed", "What bar are the plates on (for example 20 kg)?", [], [...path, "bar"]);
    return { value: amount.value, unit: amount.unit, basis: load.basis, bar, plates };
  }
  if (load.value === undefined || load.unit === undefined) {
    throw new Clarify("load_value_needed", "What is the load: a value with its unit, or the plates on each side?", [], [...path, "value"]);
  }
  return { value: load.value, unit: load.unit, basis: load.basis, bar: load.bar ?? null, plates: null };
}

/** A programme load's columns, as prescription and load_change store them. */
export function programmeLoadColumns(load: ProgrammeLoad | null) {
  return {
    load_value: load?.value ?? null, load_unit: load?.unit ?? null, load_basis: load?.basis ?? null,
    bar_value: load?.bar?.value ?? null, bar_unit: load?.bar?.unit ?? null, plates: load?.plates ? JSON.stringify(load.plates) : null,
  };
}
