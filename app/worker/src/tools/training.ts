import {
  checkWeekday,
  daysBetween,
  fallbackCoverage,
  fromKg,
  layoffPolicy,
  neverPerformedGaps,
  producibleLoads,
  snapToImplement,
  toKg,
  weekOf,
  type LoadAmount,
  type SnapResult,
  type StimulusTags,
  type Weekday,
} from "@myfitnessguide/domain";
import { z } from "zod";
import type { Ctx, Member } from "../context";
import { all, allIn, first, type Row } from "../db";
import { Clarify, ToolError } from "../errors";
import { LOAD_ENTRY, RANGE, describeImplement, expandRanges } from "./equipment";
import {
  checkPrescription,
  nextSessionPlan,
  derive,
  domainImplement,
  findExercise,
  gymByRef,
  loadImplements,
  memberExerciseSets,
  parseRule,
  ruleShown,
  platesLoaded,
  prescribedLoad,
  prescriptionById,
  rirTargetOf,
  targetOf,
  sessionById,
  storedPlates,
  progressionsOf,
  volumeKgOf,
  type ImplementRow,
  type ExerciseSetRow,
  type PrescriptionState,
  type PrescriptionView,
  type Progression,
  type SetRow,
} from "../training";
import {
  describePlanned,
  describeSet,
  gymNeeded,
  loadSetScope,
  nativeLoad,
  planSet,
  RIR,
  runningOrder,
  sessionFor,
  SESSION_SET_FIELDS,
  SET_FIELDS,
  setInputFromRow,
  snapSet,
  stagedProgression,
  stageSets,
  type PlannedSet,
  type SessionWant,
} from "../sets";
import { workoutByRef } from "../workouts";
import { readTool, writeTool, type Tool } from "../tool";

const GROUP = "training";
const date = z.iso.date();
const weekday = z.enum(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "UTC, YYYY-MM-DDTHH:MM:SSZ");
const ACTIVE_ALTERNATIVE_LIMIT = 10;
const ACTIVE_DETAIL_LIMIT = 200;

async function templateByName(ctx: Ctx, member: Member, name: string, path: (string | number)[]) {
  const templates = await all<{ id: number; name: string; session_type: string }>(
    ctx.db,
    "SELECT t.id, t.name, t.session_type FROM session_template t JOIN programme p ON p.id = t.programme_id WHERE p.member_id = ? ORDER BY p.active DESC, t.id",
    member.id,
  );
  const found = templates.find((t) => t.name.toLowerCase() === name.trim().toLowerCase());
  if (!found) throw new Clarify("unknown_template", `${member.name} has no session called ${name}.`, templates.map((t) => t.name), path);
  return found;
}

function checkStatedWeekday(on: string, stated: Weekday | undefined): void {
  if (stated === undefined) return;
  const check = checkWeekday(on, stated);
  if (!check.consistent) {
    throw new Clarify("weekday_mismatch", `${on} is a ${check.actual}, not a ${stated}. Which is right, the date or the day?`, [check.actual], ["weekday"]);
  }
}

function weekFor(member: Member, on: string): number | null {
  if (!member.week_anchor_date) return null;
  try {
    return weekOf(on, member.week_anchor_date);
  } catch {
    return null;
  }
}

const startSession = writeTool({
  name: "start_session",
  group: GROUP,
  description:
    "Start or resume an open training session for a member on a date: strength (at a gym, by default the member's home gym), cardio or class, optionally following a session template. It stays a draft until end_session; use log_workout for a completed session reported after the fact.",
  input: {
    member: z.string().min(1),
    date,
    weekday: weekday.optional().describe("The weekday the member stated, checked against the date."),
    session_type: z.enum(["strength", "cardio", "class"]),
    gym: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
    template: z.string().optional(),
    started_at: timestamp.optional(),
    energy_kcal: z.number().min(0).max(5000).optional(),
    note: z.string().optional(),
    start_new: z.boolean().optional().describe("Default false: resume the one exact matching draft session that day. True explicitly starts another."),
  },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    ctx.onBehalfOf(member.id);
    checkStatedWeekday(input.date, input.weekday);
    let gym: { id: number; name: string } | null = null;
    if (input.gym !== undefined) gym = await gymByRef(ctx, input.gym, ["gym"]);
    else if (input.session_type === "strength") {
      if (member.home_gym_id === null) throw await gymNeeded(ctx, ["gym"]);
      gym = await gymByRef(ctx, member.home_gym_id, ["gym"]);
    }
    const template = input.template === undefined ? null : await templateByName(ctx, member, input.template, ["template"]);
    if (input.start_new !== true) {
      const matches = await all<{ id: number }>(
        ctx.db,
        `SELECT id FROM session
         WHERE member_id = ? AND performed_on = ? AND session_type = ?
           AND gym_id IS ? AND template_id IS ? AND state = 'draft' AND ended_at IS NULL
         ORDER BY id LIMIT 2`,
        member.id, input.date, input.session_type, gym?.id ?? null, template?.id ?? null,
      );
      if (matches.length === 1) {
        return {
          session: {
            id: matches[0]!.id, member: member.name, date: input.date, gym_id: gym?.id ?? null, gym: gym?.name ?? null,
            session_type: input.session_type, template_id: template?.id ?? null, template: template?.name ?? null,
            state: "draft", week: weekFor(member, input.date), resumed: true,
          },
        };
      }
      if (matches.length > 1) {
        throw new Clarify(
          "multiple_active_sessions",
          `${member.name} has multiple matching draft sessions. Continue one by session id, or explicitly start another?`,
          matches.map((match) => match.id),
          ["start_new"],
        );
      }
    }
    const activeCount = (await first<{ n: number }>(
      ctx.db,
      "SELECT count(*) AS n FROM session WHERE member_id = ? AND performed_on = ? AND state = 'draft' AND ended_at IS NULL",
      member.id, input.date,
    ))?.n ?? 0;
    if (activeCount >= ACTIVE_ALTERNATIVE_LIMIT) {
      throw new Clarify(
        "too_many_active_sessions",
        `${member.name} already has ${activeCount} open sessions on ${input.date}. End or remove one before starting another.`,
        [],
        ["start_new"],
      );
    }
    // start_session is a live-session lifecycle boundary, not an after-the-fact
    // record. It remains open until end_session regardless of caller surface.
    const stamp = ctx.stamp("draft");
    const row = {
      member_id: member.id, performed_on: input.date, gym_id: gym?.id ?? null, session_type: input.session_type,
      template_id: template?.id ?? null, started_at: input.started_at ?? null, energy_kcal: input.energy_kcal ?? null,
      note: input.note ?? null, ...stamp,
    };
    const id = await ctx.txOrThrow.create("session", row);
    return {
      session: {
        id, member: member.name, date: input.date, gym_id: row.gym_id, gym: gym?.name ?? null, session_type: input.session_type,
        template_id: row.template_id, template: template?.name ?? null, state: stamp.state, week: weekFor(member, input.date), resumed: false,
      },
    };
  },
});

type ActiveSessionRow = {
  id: number;
  performed_on: string;
  session_type: string;
  gym_id: number | null;
  gym_name: string | null;
  template_id: number | null;
  template_name: string | null;
  started_at: string | null;
  total_count?: number;
};

type ActiveSetRow = {
  id: number;
  session_id: number;
  prescription_id: number | null;
  substituted_prescription_id: number | null;
  prescription_position: number | null;
  exercise: string;
  set_number: number;
  position: number;
  set_type: string;
  reps: number | null;
  load_status: string;
  load_value: number | null;
  load_unit: string | null;
  load_basis: string | null;
  rir_status: string | null;
  rir_low: number | null;
  rir_high: number | null;
  duration_s: number | null;
  distance_value: number | null;
  distance_unit: string | null;
  steps: number | null;
  state: string;
  active_rank: number;
};

type ActivePrescriptionRow = {
  session_id: number;
  id: number;
  template_id: number;
  position: number;
  exercise: string;
  target_kind: "reps" | "duration" | "distance";
  sets: number | null;
  rep_low: number | null;
  rep_high: number | null;
  duration_low_s: number | null;
  duration_high_s: number | null;
  distance_value: number | null;
  distance_unit: "m" | "km" | "mi" | null;
  rir_target_low: number | null;
  rir_target_high: number | null;
  rest_s: number | null;
  cue: string | null;
  fallback_note: string | null;
  active_rank: number;
  completed_efforts: number;
};

const STALE_SESSION_LIMIT = 5;

const activeSession = readTool({
  name: "active_session",
  group: GROUP,
  description:
    "Resume-aware view of a member's draft training session for a date (today by default): zero, one, or multiple alternatives (at most 10, with alternatives_truncated); up to 200 ordered logged sets and prescriptions per alternative with truncation flags; the next unfinished prescription when meaningful; and up to five older stale drafts. Confirmed legacy sessions with no end timestamp are never treated as active. Coach cues and fallback prose are owner-only.",
  input: { member: z.string().min(1), date: date.optional().describe("Today, by default.") },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    const on = input.date ?? ctx.today();
    const current = await all<ActiveSessionRow>(
      ctx.db,
      `SELECT s.id, s.performed_on, s.session_type, s.gym_id, g.name AS gym_name,
              s.template_id, t.name AS template_name, s.started_at
       FROM session s
       LEFT JOIN gym g ON g.id = s.gym_id
       LEFT JOIN session_template t ON t.id = s.template_id
       WHERE s.member_id = ? AND s.state = 'draft' AND s.ended_at IS NULL AND s.performed_on = ?
       ORDER BY s.id LIMIT ?`,
      member.id, on, ACTIVE_ALTERNATIVE_LIMIT + 1,
    );
    const alternativesTruncated = current.length > ACTIVE_ALTERNATIVE_LIMIT;
    const visibleCurrent = current.slice(0, ACTIVE_ALTERNATIVE_LIMIT);
    const staleRows = await all<ActiveSessionRow>(
      ctx.db,
      `SELECT s.id, s.performed_on, s.session_type, s.gym_id, g.name AS gym_name,
              s.template_id, t.name AS template_name, s.started_at, count(*) OVER() AS total_count
       FROM session s
       LEFT JOIN gym g ON g.id = s.gym_id
       LEFT JOIN session_template t ON t.id = s.template_id
       WHERE s.member_id = ? AND s.state = 'draft' AND s.ended_at IS NULL AND s.performed_on < ?
       ORDER BY s.performed_on DESC, s.id LIMIT ?`,
      member.id, on, STALE_SESSION_LIMIT,
    );
    const currentIds = visibleCurrent.map((row) => row.id);
    const sets = await allIn<ActiveSetRow>(
      ctx.db,
      (ph) => `SELECT * FROM (
                 SELECT ss.id, ss.session_id, ss.prescription_id, ss.substituted_prescription_id,
                        p.position AS prescription_position,
                        e.name AS exercise, ss.set_number, ss.position, ss.set_type, ss.reps,
                        ss.load_status, ss.load_value, ss.load_unit, ss.load_basis,
                        ss.rir_status, ss.rir_low, ss.rir_high, ss.duration_s,
                        ss.distance_value, ss.distance_unit, ss.steps, ss.state,
                        row_number() OVER (
                          PARTITION BY ss.session_id
                          ORDER BY ss.position, ss.id
                        ) AS active_rank
                 FROM session_set ss
                 JOIN exercise e ON e.id = ss.exercise_id
                 LEFT JOIN prescription p ON p.id = coalesce(ss.prescription_id, ss.substituted_prescription_id)
                 WHERE ss.session_id IN (${ph})
               ) ranked WHERE active_rank <= ${ACTIVE_DETAIL_LIMIT + 1}
               ORDER BY session_id, active_rank`,
      currentIds,
    );
    const prescriptions = await allIn<ActivePrescriptionRow>(
      ctx.db,
      (ph) => `WITH ranked AS (
                 SELECT p.id, p.template_id, p.position, e.name AS exercise, p.target_kind, p.sets,
                        p.rep_low, p.rep_high, p.duration_low_s, p.duration_high_s,
                        p.distance_value, p.distance_unit,
                        p.rir_target_low, p.rir_target_high, p.rest_s,
                        p.cue, p.fallback_note,
                        row_number() OVER (PARTITION BY p.template_id ORDER BY p.position, p.id) AS active_rank
                 FROM prescription p JOIN exercise e ON e.id = p.exercise_id
               )
               SELECT s.id AS session_id, ranked.*,
                      count(ss.id) AS completed_efforts
               FROM session s JOIN ranked ON ranked.template_id = s.template_id
                 AND ranked.active_rank <= ${ACTIVE_DETAIL_LIMIT + 1}
               LEFT JOIN session_set ss ON ss.session_id = s.id
                 AND coalesce(ss.prescription_id, ss.substituted_prescription_id) = ranked.id
                 AND ss.set_type <> 'warm_up'
                 AND (ranked.target_kind = 'reps'
                      OR (ranked.target_kind = 'duration' AND ss.duration_s IS NOT NULL)
                      OR (ranked.target_kind = 'distance' AND ss.distance_value IS NOT NULL))
               WHERE s.id IN (${ph})
               GROUP BY s.id, ranked.id
               ORDER BY s.id, ranked.active_rank`,
      currentIds,
    );
    const own = ctx.canSee(member.id);
    const describeSession = (row: ActiveSessionRow) => {
      const allLogged = sets.filter((set) => set.session_id === row.id);
      const logged = allLogged.slice(0, ACTIVE_DETAIL_LIMIT);
      const templatePrescriptions = prescriptions.filter((prescription) => prescription.session_id === row.id);
      const visiblePrescriptions = templatePrescriptions.slice(0, ACTIVE_DETAIL_LIMIT);
      let next: Record<string, unknown> | null = null;
      if (member.programming_mode === "prescribed" && row.template_id !== null) {
        const remaining = visiblePrescriptions.find((prescription) => {
          return prescription.completed_efforts < (prescription.sets ?? 1);
        });
        if (remaining) {
          const completed = remaining.completed_efforts;
          const target = remaining.target_kind === "duration"
            ? { kind: "duration", low_s: remaining.duration_low_s, high_s: remaining.duration_high_s }
            : remaining.target_kind === "distance"
              ? { kind: "distance", value: remaining.distance_value, unit: remaining.distance_unit }
              : { kind: "reps", low: remaining.rep_low, high: remaining.rep_high };
          next = {
            prescription_id: remaining.id, position: remaining.position, exercise: remaining.exercise,
            completed_sets: completed, target_sets: remaining.sets, target,
            rir_target: remaining.rir_target_low === null ? null : { low: remaining.rir_target_low, high: remaining.rir_target_high },
            rest_s: remaining.rest_s, cue: own ? remaining.cue : null, fallback_note: own ? remaining.fallback_note : null,
          };
        }
      }
      return {
        id: row.id, date: row.performed_on, session_type: row.session_type,
        gym_id: row.gym_id, gym: row.gym_name, template_id: row.template_id, template: row.template_name,
        started_at: row.started_at, sets: logged, next,
        sets_truncated: allLogged.length > ACTIVE_DETAIL_LIMIT,
        prescriptions_truncated: templatePrescriptions.length > ACTIVE_DETAIL_LIMIT,
      };
    };
    const alternatives = visibleCurrent.map(describeSession);
    const stale = staleRows.map((row) => ({
      id: row.id, date: row.performed_on, session_type: row.session_type, gym: row.gym_name, template: row.template_name,
    }));
    const staleTotal = staleRows[0]?.total_count ?? 0;
    return {
      member: member.name, date: on, active_state: current.length === 0 ? "none" : current.length === 1 ? "one" : "multiple",
      session: current.length === 1 ? alternatives[0] : null,
      alternatives: current.length > 1 ? alternatives : [], alternatives_truncated: alternativesTruncated,
      stale, stale_more: Math.max(0, staleTotal - STALE_SESSION_LIMIT),
    };
  },
});

const logSet = writeTool({
  name: "log_set",
  group: GROUP,
  description:
    "Log one set: reps (flagged reps_inferred when reported in bulk), load as entered (value, unit, basis, implement, bar, unilateral) and RIR. Returns the exact total, volume and e1RM, the load checked against the gym's inventory (an off-list load stays a draft offering add_implement_load), and an implausible-load warning. A prescribed member's set needs RIR to confirm; in Coach mode sets are drafts until end_session. Give session_id, or member and date: the member's strength session that day is found, or created at the gym given or their home gym (with neither it asks which gym, from the household's gyms; a prescribed member's with their next programme session, or the one `template` names), in the same write; several sessions that day ask which.",
  input: {
    session_id: z.number().int().positive().optional().describe("The session; or give member and date."),
    member: z.string().min(1).optional().describe("With date: the member whose strength session that day takes the set (found or created)."),
    date: date.optional(),
    gym: z.union([z.number().int().positive(), z.string().min(1)]).optional().describe("With member and date, for a new session: the gym it is at (default the member's home gym; with none, it asks which)."),
    template: z.string().min(1).optional().describe("With member and date: the programme session a new session follows (default the member's next as of the date), so a set can start a later session early."),
    ...SET_FIELDS,
  },
  async run(ctx, input) {
    const byDate = input.session_id === undefined;
    // A new session and its set take their ids in one statement (decision 96).
    if (byDate) await ctx.txOrThrow.reserve(["session", "session_set"]);
    const target = await setSession(ctx, input, true);
    ctx.onBehalfOf(target.session.member_id);
    const scope = await loadSetScope(ctx, target.session, {
      fresh: target.fresh,
      names: [input.exercise],
      ...(target.prescriptions ? { prescriptions: target.prescriptions } : {}),
    });
    const planned = await planSet(ctx, scope, input, runningOrder(scope.existing));
    const { sets } = await stageSets(ctx, scope, [planned]);
    return {
      ...(sets[0] as Record<string, unknown>),
      ...(byDate ? { session: { id: target.session.id, created: target.created, template: target.template, workout: target.workout } } : {}),
    };
  },
});

const SOURCE = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("programme"), template: z.string().min(1).optional().describe("Default: the member's next programme session as of the date.") }).strict(),
  z.object({ kind: z.literal("workout"), workout: z.union([z.number().int().positive(), z.string().min(1)]).describe("Workout id, name or alias.") }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);

/** What the source asks of the session: a programme template (with its prescriptions), a workout, or neither. */
async function wantFor(ctx: Ctx, member: Member, on: string, source: z.infer<typeof SOURCE>): Promise<SessionWant> {
  if (source.kind === "none") return { template: null, workout: null };
  if (source.kind === "workout") return { template: null, workout: await workoutByRef(ctx, source.workout, ["source", "workout"]) };
  if (member.programming_mode !== "prescribed") {
    throw new Clarify("not_prescribed", `${member.name} is trainer-led: there is no programme session. Log it from a saved workout, or as free sets?`, ["workout", "none"], ["source", "kind"]);
  }
  const plan = await nextSessionPlan(ctx, member.id, on);
  if (!plan) throw new Clarify("no_programme", `${member.name} has no active programme. Log it from a saved workout, or as free sets?`, ["workout", "none"], ["source", "kind"]);
  const names = new Map<number, string>();
  for (const s of plan.slots) names.set(s.template_id, s.name);
  for (const p of plan.prescriptions) names.set(p.template_id, p.template_name);
  if (plan.last) names.set(plan.last.template_id, plan.last.name);
  let id: number | null;
  if (source.template === undefined) {
    // As of the date: a programme session the member already has that day is
    // the one these sets continue; otherwise the schedule's next.
    id = plan.last?.performed_on === on ? plan.last.template_id : plan.templateId;
    if (id === null) throw new Clarify("no_session_ahead", `${member.name}'s schedule has no training day ahead. Which session was it?`, [...names.values()], ["source", "template"]);
  } else {
    const key = source.template.trim().toLowerCase();
    id = [...names.entries()].find(([, n]) => n.toLowerCase() === key)?.[0] ?? null;
    if (id === null) throw new Clarify("unknown_template", `${member.name} has no session called ${source.template}.`, [...names.values()], ["source", "template"]);
  }
  const template = { id, name: names.get(id) as string, prescriptions: plan.prescriptions.filter((p) => p.template_id === id) };
  // A default is never attached to a plain session that day: that asks (as log_set never guesses one).
  return { template: source.template === undefined ? { ...template, ask: [...new Set(names.values())] } : template, workout: null };
}

/**
 * The session one set goes into (log_set, preview_set): with `template`, the
 * member's session that day following that programme session, else a lone
 * plain one (which takes it), else a new one beside the day's others
 * (click test P2-16), the template resolved as log_workout's programme
 * source is; else the session that day, or the schedule's next as of the
 * date. Questions about the template point at `template`.
 */
async function setSession(
  ctx: Ctx,
  input: { session_id?: number | undefined; member?: string | undefined; date?: string | undefined; gym?: number | string | undefined; template?: string | undefined },
  stage: boolean,
) {
  if (input.template === undefined) return sessionFor(ctx, input, { template: "next", workout: null }, stage);
  if (input.session_id !== undefined || input.member === undefined || input.date === undefined) {
    throw new ToolError("session_or_member", "a template goes with member and date, not session_id", 400);
  }
  const member = await ctx.member(input.member);
  try {
    const want = await wantFor(ctx, member, input.date, { kind: "programme", template: input.template });
    return await sessionFor(ctx, input, { ...want, alongside: true }, stage);
  } catch (e) {
    if (!(e instanceof Clarify) || e.path[0] !== "source") throw e;
    const question = e.reason === "session_source_conflict" ? e.question.replace(/ Log these sets into it as free sets\?$/, " Log the set into it, without the template?") : e.question;
    throw new Clarify(e.reason, question, e.reason === "unknown_template" ? e.options : [], ["template"], e.extra);
  }
}

const logWorkout = writeTool({
  name: "log_workout",
  group: GROUP,
  description:
    "Log a whole session's sets in one write: the member's strength session that day is found or created (from their next programme session or a named one, a saved workout, or neither), sets are linked to the programme's prescriptions, and each comes back as log_set returns it, with each linked prescription's progression state checked against these sets. A cardio machine's line with no reps (a treadmill's duration or distance) is stored as a cardio block in the session, not a set, and comes back in `cardio` (with its line's index). All or nothing: any question (it says which set) writes nothing. Same rules per set as log_set (RIR for prescribed members, inventory, drafts for other members).",
  input: {
    member: z.string().min(1),
    date,
    source: SOURCE,
    gym: z.union([z.number().int().positive(), z.string().min(1)]).optional().describe("For a new session: the gym it is at (default the member's home gym; with none, it asks which)."),
    sets: z.array(z.object(SESSION_SET_FIELDS).strict()).min(1).max(60),
  },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    ctx.onBehalfOf(member.id);
    await ctx.txOrThrow.reserve(["session", "session_set"]);
    const want = await wantFor(ctx, member, input.date, input.source);
    const target = await sessionFor(ctx, { member: member.name, date: input.date, gym: input.gym }, want, true);
    const scope = await loadSetScope(ctx, target.session, {
      fresh: target.fresh,
      names: input.sets.map((s) => s.exercise),
      ...(target.prescriptions ? { prescriptions: target.prescriptions } : {}),
    });
    const running = runningOrder(scope.existing);
    // A cardio machine's line with no reps (a treadmill's minutes or distance) is a cardio block in the
    // session, not a set (ticket 68): its work is blocks, as decision 73 counts it.
    // A line naming its prescription (or the one it substitutes) stays a set, so that prescription keeps its progression (review P1-2).
    const isBlock = (x: (typeof input.sets)[number], i: number) =>
      x.reps === undefined &&
      (x.duration_s !== undefined || x.distance !== undefined) &&
      x.prescription_id === undefined &&
      x.substituted_prescription_id === undefined &&
      scope.exercises.find(x.exercise, ["sets", i, "exercise"]).implement_kind === "cardio_machine";
    const lines = input.sets.map((x, i) => ({ x, i, block: isBlock(x, i) }));
    // Every set is planned (and may ask) before any is staged.
    const planned: PlannedSet[] = [];
    for (const { x, i } of lines.filter((l) => !l.block)) planned.push(await planSet(ctx, scope, x, running, ["sets", i]));
    const blockLines = lines.filter((l) => l.block);
    const after = target.fresh || blockLines.length === 0 ? 0 : ((await first<{ p: number }>(ctx.db, "SELECT coalesce(max(position), 0) AS p FROM cardio_block WHERE session_id = ?", target.session.id))?.p ?? 0);
    const { ids, sets } = planned.length > 0 ? await stageSets(ctx, scope, planned) : { ids: [], sets: [] };
    const cardio = [];
    for (const [k, { x, i }] of blockLines.entries()) {
      const activity = scope.exercises.find(x.exercise, ["sets", i, "exercise"]).name;
      const row = {
        // A warm-up line is a warm-up block; a block has no other set type, so the rest are steady.
        session_id: target.session.id, position: after + k + 1, kind: x.set_type === "warm_up" ? "warm_up" : "steady", activity, duration_s: x.duration_s ?? null,
        distance_value: x.distance?.value ?? null, distance_unit: x.distance?.unit ?? null, steps: x.steps ?? null, note: x.note ?? null,
      };
      const id = await ctx.txOrThrow.create("cardio_block", row);
      cardio.push({ index: i, id, activity, duration_s: row.duration_s, distance: x.distance ?? null, position: row.position });
    }
    return {
      session: { id: target.session.id, created: target.created, template: target.template, workout: target.workout, state: target.session.state },
      sets,
      cardio,
      progression: stagedProgression(scope, planned, ids),
    };
  },
});

const previewSet = readTool({
  name: "preview_set",
  group: GROUP,
  description:
    "What log_set would return for one set, without writing anything: the exact total, volume and e1RM, the load checked against the gym's inventory (off the list: a draft, with the offer), the implausible-load warning, and draft or confirmed. Same input as log_set; for member and date with no session yet, as the session log_set would create. Asks what log_set would ask.",
  input: {
    session_id: z.number().int().positive().optional(),
    member: z.string().min(1).optional(),
    date: date.optional(),
    gym: z.union([z.number().int().positive(), z.string().min(1)]).optional().describe("With member and date, for a new session: the gym it is at (default the member's home gym; with none, it asks which)."),
    template: z.string().min(1).optional().describe("With member and date: the programme session a new session follows (default the member's next as of the date), so a set can start a later session early."),
    ...SET_FIELDS,
  },
  async run(ctx, input) {
    await ctx.previewWrite();
    const target = await setSession(ctx, input, false);
    const scope = await loadSetScope(ctx, target.session, {
      fresh: target.fresh,
      names: [input.exercise],
      ...(target.prescriptions ? { prescriptions: target.prescriptions } : {}),
    });
    const planned = await planSet(ctx, scope, input, runningOrder(scope.existing));
    const out = describePlanned(planned, null);
    const sessionId = target.fresh ? null : target.session.id;
    return {
      ...out,
      set: { ...out.set, session_id: sessionId },
      state: planned.row.state,
      session: { id: sessionId, would_create: target.fresh, template: target.template, workout: target.workout },
    };
  },
});

const endSession = writeTool({
  name: "end_session",
  group: GROUP,
  description:
    "End your own session (or, for the household agent, a member's): records its end time, confirms it and its draft sets when authorized, filling not-recorded RIR for record-only members and asking for any missing RIR otherwise. Sets with an off-list load stay drafts. Returns volume and the progression check for each prescription trained.",
  input: { session_id: z.number().int().positive(), ended_at: timestamp.optional() },
  async run(ctx, input) {
    const tx = ctx.txOrThrow;
    const session = await sessionById(ctx, input.session_id);
    const member = await ctx.memberById(session.member_id);
    ctx.assertCanSee("session", member.id);
    ctx.onBehalfOf(member.id);
    const sets = await all<SetRow>(ctx.db, "SELECT * FROM session_set WHERE session_id = ? ORDER BY exercise_id, set_number", session.id);
    const impls = await loadImplements(ctx, { ids: [...new Set(sets.map((s) => s.load_implement_id).filter((x): x is number => x !== null))] });
    const implOf = (s: SetRow) => impls.find((i) => i.id === s.load_implement_id) ?? null;
    const confirm = ctx.stateFor(member.id) === "confirmed";
    const now = ctx.nowIso();
    if (input.ended_at === undefined && session.ended_at == null && session.performed_on > ctx.today()) {
      throw new Clarify(
        "cannot_end_future_session",
        `The session is dated ${session.performed_on}, after today. Give an ended_at on that date or later, or correct the session date.`,
        [],
        ["ended_at"],
      );
    }
    const existingEndedAt = typeof session.ended_at === "string" ? session.ended_at : null;
    const endedAt = input.ended_at ?? existingEndedAt ?? now;
    if (endedAt.slice(0, 10) < session.performed_on) {
      throw new ToolError("end_before_session_date", "ended_at must be on or after the session's performed_on date", 400, { path: ["ended_at"] });
    }
    const startedAt = session.started_at;
    if (typeof startedAt === "string" && endedAt < startedAt) {
      throw new ToolError("end_before_start", "ended_at must be at or after the session's started_at", 400, { path: ["ended_at"] });
    }
    const stillDraft: { id: number; reason: string }[] = [];
    let confirmed = 0;

    if (confirm) {
      const blank = sets.filter((s) => s.state === "draft" && s.rir_status === null);
      if (blank.length > 0 && member.programming_mode === "prescribed") {
        throw new Clarify("rir_needed", `RIR is missing on ${blank.length} set(s); give it with amend before ending the session.`, blank.map((s) => s.id), ["rir"]);
      }
      for (const s of sets.filter((x) => x.state === "draft")) {
        if (snapSet(s, implOf(s)).off_list) {
          stillDraft.push({ id: s.id, reason: "off_list" });
          continue;
        }
        const changes: Row = { state: "confirmed", confirmed_at: now, draft_reason: null };
        if (s.rir_status === null) changes.rir_status = "not_recorded";
        tx.update("session_set", s.id, changes, { ...s, ...changes }, "confirm");
        confirmed++;
      }
    } else {
      for (const s of sets.filter((x) => x.state === "draft")) stillDraft.push({ id: s.id, reason: "awaiting_member" });
    }
    const sessionChanges: Row = { ended_at: endedAt };
    let sessionState = session.state;
    if (confirm && session.state === "draft") {
      sessionChanges.state = "confirmed";
      sessionChanges.confirmed_at = now;
      sessionState = "confirmed";
    }
    if (Object.keys(sessionChanges).length > 0) {
      tx.update("session", session.id, sessionChanges, { ...session, ...sessionChanges }, sessionChanges.state ? "confirm" : "amend");
    }

    const volume = sets
      .filter((s) => s.set_type !== "warm_up")
      .reduce((sum, s) => sum + volumeKgOf(s, implOf(s)), 0);
    const progression = [];
    for (const pid of [...new Set(sets.map((s) => s.prescription_id).filter((x): x is number => x !== null))]) {
      const p = await prescriptionById(ctx, pid);
      progression.push({ prescription_id: pid, exercise: p.exercise_name, ...(await checkPrescription(ctx, p, session.id)) });
    }
    return { session: { id: session.id, state: sessionState }, confirmed_sets: confirmed, still_draft: stillDraft, volume_kg: volume, progression };
  },
});

/** The set a correction or re-check names, with its session, member, exercise and implement. */
async function setContext(ctx: Ctx, setId: number) {
  const set = await first<SetRow & { version: number; draft_reason: string | null }>(ctx.db, "SELECT * FROM session_set WHERE id = ?", setId);
  if (!set) throw new ToolError("set_not_found", `There is no set ${setId}.`, 404);
  const session = await sessionById(ctx, set.session_id);
  const member = await ctx.memberById(session.member_id);
  ctx.assertCanSee("session", member.id);
  if (ctx.write !== null) ctx.onBehalfOf(member.id);
  const scope = await loadSetScope(ctx, session, { fresh: false, names: [] });
  const exercise = scope.exercises.entries.find((e) => e.id === set.exercise_id);
  if (!exercise) throw new ToolError("set_exercise_missing", `Set ${setId} names exercise ${set.exercise_id}, which is not in this household.`, 409);
  const implement =
    set.load_implement_id === null ? null : ((await loadImplements(ctx, { ids: [set.load_implement_id] }))[0] ?? null);
  return { set, session, member, scope, exercise, implement };
}

/**
 * Confirm draft sets whose loads are now on the list (or, with reason set,
 * only those that were waiting on the inventory). A set still off the list
 * stays a draft, with the offer that would fix it.
 */
async function confirmDraftSets(
  ctx: Ctx,
  member: Member,
  sets: readonly SetRow[],
  options: { only_reason: "off_list" | null; confirm: boolean; implements?: ImplementRow[] },
): Promise<{ confirmed: number[]; still_draft: { id: number; reason: string; offer?: Record<string, unknown> }[] }> {
  const tx = ctx.txOrThrow;
  const now = ctx.nowIso();
  // A call that has just staged an inventory change passes the implement as it
  // will be, because the queued write is not visible to a read yet.
  const impls =
    options.implements ??
    (await loadImplements(ctx, {
      ids: [...new Set(sets.map((s) => s.load_implement_id).filter((x): x is number => x !== null))],
    }));
  const confirmed: number[] = [];
  const stillDraft: { id: number; reason: string; offer?: Record<string, unknown> }[] = [];
  for (const set of sets) {
    if (set.state !== "draft") continue;
    if (options.only_reason !== null && set.draft_reason !== options.only_reason) continue;
    const checked = snapSet(set, impls.find((i) => i.id === set.load_implement_id) ?? null);
    if (checked.off_list) {
      stillDraft.push({ id: set.id, reason: "off_list", ...(checked.offer ? { offer: checked.offer } : {}) });
      continue;
    }
    if (!options.confirm) {
      stillDraft.push({ id: set.id, reason: "awaiting_member" });
      continue;
    }
    if (set.rir_status === null && member.programming_mode === "prescribed") {
      stillDraft.push({ id: set.id, reason: "rir_needed" });
      continue;
    }
    const changes: Row = { state: "confirmed", confirmed_at: now, draft_reason: null };
    if (set.rir_status === null) changes.rir_status = "not_recorded";
    tx.update("session_set", set.id, changes, { ...set, ...changes }, "confirm");
    confirmed.push(set.id);
  }
  return { confirmed, still_draft: stillDraft };
}

/** The set fields a correction may change: everything log_set takes but the running position. */
const { position: _correctablePosition, ...CORRECTABLE_FIELDS } = SET_FIELDS;
const CORRECTION_FIELDS = { ...CORRECTABLE_FIELDS, exercise: z.string().min(1).optional() };

const updateSet = writeTool({
  name: "update_set",
  group: GROUP,
  description:
    "Correct one stored set in place, keeping its history: give the set's id, the version read with it (a stale version is refused, never overwritten) and the fields that change. Load, reps, RIR, type, note, number, exercise, a compound set's segments, a carry's sides and distance basis are all correctable. The corrected set is re-checked against the gym's inventory and the RIR rules; a confirmed set stays confirmed unless the correction makes it invalid (then it is a draft with the reason). Nothing is deleted: the previous version stays in the record's history with the reason.",
  input: {
    set_id: z.number().int().positive(),
    version: z.number().int().positive().describe("The version returned with the set; a correction made against an older one is refused."),
    changes: z
      .object(CORRECTION_FIELDS)
      .strict()
      .describe("Only the fields that change. A load is as entered; the server recomputes totals, volume and e1RM."),
  },
  async run(ctx, input) {
    if (input.reason === undefined || input.reason.trim() === "") {
      throw new Clarify("reason_needed", "Why is this set being corrected? The previous version stays in the set's history, and the reason is part of it.", [], ["reason"]);
    }
    if (Object.keys(input.changes).length === 0) {
      throw new Clarify("changes_needed", "Which fields of the set change?", [], ["changes"]);
    }
    const { set, scope, exercise, implement } = await setContext(ctx, input.set_id);
    if (set.version !== input.version) {
      throw new ToolError(
        "set_version_conflict",
        `Set ${set.id} is at version ${set.version}, not ${input.version}. Read it again before correcting it.`,
        409,
        { current_version: set.version, set: describeSet(set, exercise, implement) },
      );
    }
    const newExercise = input.changes.exercise === undefined ? exercise : scope.exercises.find(input.changes.exercise, ["changes", "exercise"]);
    const merged = setInputFromRow(set, exercise.name, input.changes);
    if (newExercise.id !== exercise.id) {
      // A different exercise brings its own implement and prescription.
      if (input.changes.load === undefined && typeof merged.load === "object" && merged.load !== null) {
        const { implement: _implement, ...load } = merged.load;
        merged.load = load;
      }
      if (input.changes.prescription_id === undefined && set.prescription_id !== null) {
        const prescription = await first<{ exercise_id: number }>(ctx.db, "SELECT exercise_id FROM prescription WHERE id = ?", set.prescription_id);
        if (prescription?.exercise_id !== newExercise.id) delete merged.prescription_id;
      }
    }
    const planned = await planSet(
      ctx,
      scope,
      merged,
      { end: (set.position as number) - 1, setNumbers: new Map([[exercise.id, set.set_number - 1]]) },
      ["changes"],
    );
    let state: "draft" | "confirmed" = planned.row.state === "draft" || set.state === "draft" ? "draft" : "confirmed";
    if (planned.row.rir_status === null) state = "draft";
    const after: Row = {
      ...set,
      ...planned.row,
      id: set.id,
      session_id: set.session_id,
      exercise_id: planned.exercise.id,
      version: set.version + 1,
      state,
      confirmed_at: state === "confirmed" ? ((set.confirmed_at as string | null) ?? ctx.nowIso()) : null,
      draft_reason: state === "draft" ? (planned.offer ? "off_list" : "awaiting_member") : null,
    };
    if (after.reps === null && after.duration_s === null && after.distance_value === null && after.steps === null) {
      throw new Clarify("effort_needed", "A set records reps, a duration, a distance or steps; give at least one.", [], ["changes"]);
    }
    if (after.exercise_id !== set.exercise_id || after.set_number !== set.set_number) {
      const clash = await first<{ id: number }>(
        ctx.db,
        "SELECT id FROM session_set WHERE session_id = ? AND exercise_id = ? AND set_number = ? AND id <> ?",
        set.session_id,
        after.exercise_id as number,
        after.set_number as number,
        set.id,
      );
      if (clash) {
        throw new ToolError(
          "set_number_taken",
          `Set ${after.set_number} of ${planned.exercise.name} already exists in this session (set ${clash.id}). Give this set a free number.`,
          409,
          { set_id: clash.id, set_number: after.set_number },
        );
      }
    }
    const patch: Row = {};
    for (const column of Object.keys(set)) {
      if (column === "id") continue;
      if (after[column] !== set[column]) patch[column] = after[column];
    }
    if (Object.keys(patch).length === 0) {
      return { set: describeSet(set, exercise, implement), changed: false, version: set.version };
    }
    ctx.txOrThrow.update("session_set", set.id, patch, after, "amend");
    return {
      set: describeSet(after as unknown as SetRow & { id: number }, planned.exercise, planned.implement),
      changed: true,
      changed_fields: Object.keys(patch),
      version: after.version,
      snap: planned.snap,
      offer: planned.offer,
      implausible: planned.implausible,
      ...(planned.segmentSnaps.length > 0 ? { segment_snaps: planned.segmentSnaps } : {}),
    };
  },
});

const revalidateSet = writeTool({
  name: "revalidate_set",
  group: GROUP,
  description:
    "Re-check one stored set's load (and a compound set's every segment) against its gym's inventory. A draft that was waiting on the inventory is confirmed when its load is now on the list and the caller may confirm; a set still off the list stays a draft with the offer to record the load. Returns the set, the check and what changed.",
  input: { set_id: z.number().int().positive(), confirm: z.boolean().optional().describe("Default true: confirm the set when it is now valid. False only re-checks.") },
  async run(ctx, input) {
    const { set, member, exercise, implement } = await setContext(ctx, input.set_id);
    const checked = snapSet(set, implement);
    const result = await confirmDraftSets(ctx, member, [set], { only_reason: "off_list", confirm: input.confirm !== false });
    const confirmed = result.confirmed.includes(set.id);
    const row = confirmed
      ? ({ ...set, state: "confirmed", confirmed_at: ctx.nowIso(), draft_reason: null, rir_status: set.rir_status ?? "not_recorded" } as SetRow & { id: number })
      : set;
    return {
      set: describeSet(row, exercise, implement),
      snap: checked.snap,
      segment_snaps: checked.segment_snaps,
      confirmed,
      ...(result.still_draft[0] ? { still_draft: result.still_draft[0] } : {}),
      ...(checked.offer ? { offer: checked.offer } : {}),
    };
  },
});

const revalidateSession = writeTool({
  name: "revalidate_session",
  group: GROUP,
  description:
    "Re-check every draft set in a session that was waiting on its gym's inventory, confirming the ones whose loads are now on the list (when authorized) and reporting the rest with the offer that would fix them. Use after add_implement_load or record_plates, or before end_session. Does not end the session or change its end time.",
  input: { session_id: z.number().int().positive(), confirm: z.boolean().optional().describe("Default true: confirm valid sets. False only re-checks.") },
  async run(ctx, input) {
    const session = await sessionById(ctx, input.session_id);
    const member = await ctx.memberById(session.member_id);
    ctx.assertCanSee("session", member.id);
    ctx.onBehalfOf(member.id);
    const sets = await all<SetRow>(ctx.db, "SELECT * FROM session_set WHERE session_id = ? ORDER BY exercise_id, set_number", session.id);
    const confirm = input.confirm !== false && ctx.stateFor(member.id) === "confirmed";
    const result = await confirmDraftSets(ctx, member, sets, { only_reason: "off_list", confirm });
    return {
      session_id: session.id,
      confirmed_sets: result.confirmed,
      still_draft: result.still_draft,
      draft_sets: sets.filter((s) => s.state === "draft").map((s) => ({ id: s.id, reason: s.draft_reason ?? "awaiting_member" })),
    };
  },
});

const validateSession = readTool({
  name: "validate_session",
  group: GROUP,
  description:
    "What would stop this session ending, without writing anything: sets missing RIR, draft sets still off the inventory (with the offer), a set with no reps/duration/distance, a session dated in the future, and a blank session. Also says whether end_session would confirm now. The same checks end_session runs, so a clean answer means end_session will not ask.",
  input: { session_id: z.number().int().positive() },
  async run(ctx, input) {
    const session = await sessionById(ctx, input.session_id);
    const member = await ctx.memberById(session.member_id);
    ctx.assertCanSee("session", member.id);
    const sets = await all<SetRow>(ctx.db, "SELECT * FROM session_set WHERE session_id = ? ORDER BY exercise_id, set_number", session.id);
    const impls = await loadImplements(ctx, {
      ids: [...new Set(sets.map((s) => s.load_implement_id).filter((x): x is number => x !== null))],
    });
    const blockers: { code: string; message: string; set_ids: number[]; offer?: Record<string, unknown> }[] = [];
    const blank = sets.filter((s) => s.state === "draft" && s.rir_status === null);
    if (blank.length > 0 && member.programming_mode === "prescribed") {
      blockers.push({ code: "rir_needed", message: `RIR is missing on ${blank.length} set(s).`, set_ids: blank.map((s) => s.id) });
    }
    const offList: number[] = [];
    let offer: Record<string, unknown> | undefined;
    for (const set of sets) {
      const checked = snapSet(set, impls.find((i) => i.id === set.load_implement_id) ?? null);
      if (checked.off_list) {
        offList.push(set.id);
        if (offer === undefined && checked.offer) offer = checked.offer;
      }
    }
    if (offList.length > 0) {
      blockers.push({ code: "off_list", message: `${offList.length} set(s) are still off the gym's inventory.`, set_ids: offList, ...(offer ? { offer } : {}) });
    }
    const noEffort = sets.filter((s) => s.reps === null && s.duration_s === null && s.distance_value === null && s.steps === null);
    if (noEffort.length > 0) blockers.push({ code: "effort_needed", message: "Some sets record no reps, duration, distance or steps.", set_ids: noEffort.map((s) => s.id) });
    if (sets.length === 0) blockers.push({ code: "empty_session", message: "The session has no sets.", set_ids: [] });
    if (input.session_id > 0 && session.performed_on > ctx.today() && session.ended_at == null) {
      blockers.push({ code: "future_session", message: `The session is dated ${session.performed_on}, after today.`, set_ids: [] });
    }
    // A read tool has no write context; the caller answers for itself.
    const canConfirm = ctx.caller.kind === "member" ? ctx.caller.memberId === member.id : true;
    return {
      session_id: session.id,
      member: member.name,
      date: session.performed_on,
      state: session.state,
      sets: sets.length,
      drafts: sets.filter((s) => s.state === "draft").map((s) => ({ id: s.id, reason: s.draft_reason ?? "awaiting_member" })),
      can_confirm: canConfirm,
      ready: blockers.length === 0 && canConfirm,
      blockers,
    };
  },
});

const getSetHistory = readTool({
  name: "get_set_history",
  group: GROUP,
  description:
    "One stored set as it stands and every version it has had, oldest first, each with the write that made it (who, on whose behalf, from where, why). Use after update_set, confirm or amend to show exactly what changed and when.",
  input: { set_id: z.number().int().positive() },
  async run(ctx, input) {
    const { set, exercise, implement } = await setContext(ctx, input.set_id);
    const versions = await all<Row>(
      ctx.db,
      `SELECT v.version, v.action, v.data, v.created_at, v.write_id, w.resolver, w.origin, w.channel, w.tool, w.reason,
              w.on_behalf_of_member_id, w.actor_member_id, a.name AS actor, s.name AS speaker, b.name AS on_behalf_of
       FROM record_version v JOIN write_log w ON w.id = v.write_id
       LEFT JOIN member a ON a.id = w.actor_member_id
       LEFT JOIN member s ON s.id = w.speaker_member_id
       LEFT JOIN member b ON b.id = w.on_behalf_of_member_id
       WHERE v.table_name = 'session_set' AND v.record_id = ? ORDER BY v.version`,
      set.id,
    );
    return {
      set: describeSet(set, exercise, implement),
      versions: versions.map((v) => ({ ...v, data: JSON.parse(v.data as string) })),
    };
  },
});

const nextPrescription = readTool({
  name: "next_prescription",
  group: GROUP,
  description:
    "The member's next session from their programme's schedule (weekday plan with swaps, or rotation), with each prescription's current load snapped to the gym's inventory, fallbacks, the layoff policy, and gaps (prescriptions never performed). Each prescription carries progression (as check_progression answers) and state: ready (with the next load), needs_confirmation (with the sets), check_at_gym (an unverified step, with the question and what to record either way), holding or cant_move (with the reason). Cues and fallback notes are owner-only: null for another member.",
  input: { member: z.string().min(1), date: date.optional().describe("Today, by default.") },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    const today = input.date ?? ctx.today();
    if (member.programming_mode === "record_only") {
      return { member: member.name, programming_mode: "record_only", session: null, prescriptions: [], gaps: [], message: `${member.name} is trainer-led: sessions are recorded, never prescribed.` };
    }
    const plan = await nextSessionPlan(ctx, member.id, today);
    if (!plan) return { member: member.name, programming_mode: "prescribed", session: null, prescriptions: [], gaps: [], message: "no active programme" };
    const { programme, next } = plan;
    const all_ = plan.prescriptions;
    const inProgramme = all_;
    const performed = await all<{ exercise_id: number; performed_on: string }>(
      ctx.db,
      `SELECT DISTINCT st.exercise_id, se.performed_on FROM session_set st JOIN session se ON se.id = st.session_id
       WHERE se.member_id = ? AND st.set_type = 'working'`,
      member.id,
    );
    // Work on a cardio machine is logged as cardio blocks, not sets: a cardio session, or a session with a block, performs it.
    const cardio = await all<{ exercise_id: number; performed_on: string }>(
      ctx.db,
      `SELECT DISTINCT e.id AS exercise_id, se.performed_on FROM session se JOIN exercise e ON e.household_id = ? AND e.implement_kind = 'cardio_machine'
       WHERE se.member_id = ? AND (se.session_type = 'cardio' OR EXISTS (SELECT 1 FROM cardio_block b WHERE b.session_id = se.id))`,
      ctx.householdId,
      member.id,
    );
    const gaps = neverPerformedGaps(
      inProgramme.map((p) => ({ id: String(p.id), exerciseId: String(p.exercise_id), prescribedOn: programme.started_on, template: p.template_name, p })),
      [...performed, ...cardio].map((s) => ({ exerciseId: String(s.exercise_id), date: s.performed_on })),
    ).map((g) => ({ prescription_id: g.p.id, exercise: g.p.exercise_name, template: g.template }));

    if (!next) return { member: member.name, programming_mode: "prescribed", session: null, prescriptions: [], gaps, message: "the schedule has no training day ahead" };
    const templateId = plan.templateId;
    const prescriptions = all_.filter((p) => p.template_id === templateId);
    const impls = await loadImplements(ctx, { ids: [...new Set(prescriptions.map((p) => p.current_load_implement_id).filter((x): x is number => x !== null))] });

    const lastAny = await first<{ performed_on: string }>(ctx.db, "SELECT max(performed_on) AS performed_on FROM session WHERE member_id = ? AND performed_on <= ?", member.id, today);
    const lastThis = templateId !== null
      ? await first<{ performed_on: string }>(ctx.db, "SELECT max(performed_on) AS performed_on FROM session WHERE member_id = ? AND template_id = ? AND performed_on <= ?", member.id, templateId, today)
      : null;
    const policy = lastAny?.performed_on
      ? layoffPolicy(daysBetween(lastAny.performed_on, today), lastThis?.performed_on ? daysBetween(lastThis.performed_on, today) : null)
      : null;

    // Every prescription's fallbacks in one statement (per 100), never one per prescription (decision 96).
    const fallbackRows = await allIn<{ prescription_id: number; name: string }>(
      ctx.db,
      (ph) =>
        `SELECT f.prescription_id, e.name FROM prescription_fallback f JOIN exercise e ON e.id = f.exercise_id
         WHERE f.prescription_id IN (${ph}) ORDER BY f.prescription_id, f.rank`,
      prescriptions.map((p) => p.id),
    );
    // Every prescription's progression at once (decision 96), the same call needs_you rule 4 makes.
    const progress = await progressionsOf(ctx, prescriptions);
    const own = ctx.canSee(member.id);
    const out = [];
    for (const p of prescriptions) {
      const impl = impls.find((i) => i.id === p.current_load_implement_id) ?? null;
      const prescribed = prescribedLoad(p);
      const snap: SnapResult | null =
        prescribed === null
          ? null
          : impl
            ? snapToImplement(prescribed.value, prescribed.unit, domainImplement(impl, { unit: impl.unit }), prescribed.plates ?? undefined)
            : { status: "no_inventory", value: prescribed.value, unit: prescribed.unit };
      const fallbacks = fallbackRows.filter((f) => f.prescription_id === p.id);
      const { progression, state } = progress.get(p.id) as { progression: Progression; state: PrescriptionState };
      out.push({
        prescription_id: p.id, position: p.position, exercise: p.exercise_name, sets: p.sets, target: targetOf(p), rep_low: p.rep_low, rep_high: p.rep_high,
        rir_target: rirTargetOf(p), rest_s: p.rest_s, progression_rule: ruleShown(parseRule(p.progression_rule), own),
        load: prescribed === null || snap === null ? null : {
          ...prescribed, implement: impl?.name ?? null,
          snap,
          // Above what the gym is known to have: propose it, but check it exists first.
          unverified: snap.status === "off_list" && snap.mayExist,
        },
        // Coach notes are owner-only (decision 135): they cite readings, BIA and bloods.
        cue: own ? p.cue : null, fallback_note: own ? p.fallback_note : null, fallbacks: fallbacks.map((f) => f.name),
        progression, state,
      });
    }
    return { member: member.name, programming_mode: "prescribed", session: next.session, date: next.date, layoff_policy: policy, prescriptions: out, gaps };
  },
});

const checkProgression = readTool({
  name: "check_progression",
  group: GROUP,
  description:
    "Whether a prescription's load moves: fired (with the next producible load), needs_confirmation (it would fire, but some sets' reps were inferred from a bulk report: confirm them with the member, amend those sets in confirm_set_ids, then check again), not_yet (with the reason, and any autoregulation hold or drop), or never (structurally impossible, with why). Uses the given session or the latest one with sets for it.",
  input: { prescription_id: z.number().int().positive(), session_id: z.number().int().positive().optional() },
  async run(ctx, input) {
    const p = await prescriptionById(ctx, input.prescription_id);
    return { prescription_id: p.id, exercise: p.exercise_name, ...(await checkPrescription(ctx, p, input.session_id)) };
  },
});

async function stimulusTags(ctx: Ctx, exerciseId: number): Promise<StimulusTags> {
  const rows = await all<{ tag: string }>(ctx.db, "SELECT tag FROM exercise_tag WHERE exercise_id = ? AND kind = 'stimulus'", exerciseId);
  const tags: StimulusTags = {};
  for (const { tag } of rows) {
    if (tag === "compound" || tag === "isolation") tags.mechanics = tag;
    if (tag === "lengthened" || tag === "shortened" || tag === "mid") tags.position = tag;
  }
  return tags;
}

const substitute = readTool({
  name: "substitute",
  group: GROUP,
  description:
    "Substitutes for a prescription: its ranked fallbacks, then other exercises with the same movement pattern, each saying whether it counts as coverage (stimulus tags match) and whether the gym has the implement.",
  input: { prescription_id: z.number().int().positive(), gym: z.union([z.number().int().positive(), z.string().min(1)]).optional() },
  async run(ctx, input) {
    const p = await prescriptionById(ctx, input.prescription_id);
    const member = await ctx.memberById(p.member_id);
    const gymRef = input.gym ?? member.home_gym_id;
    const gym = gymRef === null ? null : await gymByRef(ctx, gymRef, ["gym"]);
    const kinds = new Set(gym ? (await loadImplements(ctx, { gymId: gym.id })).map((i) => i.kind) : []);
    const prescribed = await stimulusTags(ctx, p.exercise_id);
    const fallbacks = await all<{ id: number; name: string; implement_kind: string; rank: number; note: string | null }>(
      ctx.db,
      "SELECT e.id, e.name, e.implement_kind, f.rank, f.note FROM prescription_fallback f JOIN exercise e ON e.id = f.exercise_id WHERE f.prescription_id = ? ORDER BY f.rank",
      p.id,
    );
    const samePattern = await all<{ id: number; name: string; implement_kind: string }>(
      ctx.db,
      `SELECT DISTINCT e.id, e.name, e.implement_kind FROM exercise e JOIN exercise_tag t ON t.exercise_id = e.id AND t.kind = 'movement_pattern'
       WHERE t.tag IN (SELECT tag FROM exercise_tag WHERE exercise_id = ? AND kind = 'movement_pattern') AND e.id <> ? ORDER BY e.name`,
      p.exercise_id,
      p.exercise_id,
    );
    const option = async (e: { id: number; name: string; implement_kind: string }, source: string, rank: number | null, note: string | null) => {
      const coverage = fallbackCoverage(prescribed, await stimulusTags(ctx, e.id));
      return {
        exercise: e.name, source, rank, note, covered: coverage.covered, mismatches: coverage.mismatches,
        available: e.implement_kind === "bodyweight" || kinds.has(e.implement_kind),
      };
    };
    const options = [];
    // A fallback's note is coach text: its member's alone (decision 137).
    for (const f of fallbacks) options.push(await option(f, "fallback", f.rank, ctx.canSee(member.id) ? f.note : null));
    const extra = [];
    for (const e of samePattern.filter((e) => !fallbacks.some((f) => f.id === e.id))) extra.push(await option(e, "same_pattern", null, null));
    extra.sort((a, b) => Number(b.covered) - Number(a.covered));
    return { prescription_id: p.id, exercise: p.exercise_name, gym: gym?.name ?? null, options: [...options, ...extra] };
  },
});

function patternRegex(pattern: string): RegExp {
  const escaped = pattern.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&");
  if (/[*?]/.test(pattern)) return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
  return new RegExp(escaped, "i");
}

const liftHistory = readTool({
  name: "lift_history",
  group: GROUP,
  description:
    "A member's sets of every exercise whose name or alias matches a pattern (* and ? wildcards; without them, a substring), newest session first, with exact total, volume and e1RM, and the best comparable e1RM.",
  input: {
    member: z.string().min(1),
    pattern: z.string().min(1),
    from: date.optional(),
    to: date.optional(),
    sessions: z.number().int().min(1).max(100).optional().describe("Most recent sessions per exercise; default 10."),
  },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    const re = patternRegex(input.pattern);
    const exercises = (
      await all<{ id: number; name: string; bodyweight_dominant: number; implement_kind: string; aliases: string | null }>(
        ctx.db,
        "SELECT e.id, e.name, e.bodyweight_dominant, e.implement_kind, (SELECT group_concat(alias, '|') FROM alias a WHERE a.kind = 'exercise' AND a.target_id = e.id) AS aliases FROM exercise e WHERE e.household_id = ? ORDER BY e.name",
        ctx.householdId,
      )
    ).filter((e) => [e.name, ...(e.aliases ? e.aliases.split("|") : [])].some((n) => re.test(n)));
    const { sets, implements: impls } = await memberExerciseSets(ctx, member.id, exercises.map((exercise) => exercise.id), {
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
    });
    const implById = new Map(impls.map((implement) => [implement.id, implement]));
    const setsByExercise = new Map<number, ExerciseSetRow[]>();
    for (const set of sets) setsByExercise.set(set.exercise_id, [...(setsByExercise.get(set.exercise_id) ?? []), set]);
    const out = [];
    for (const e of exercises) {
      const sessions = new Map<number, { session_id: number; date: string; sets: unknown[] }>();
      let best: number | null = null;
      for (const s of setsByExercise.get(e.id) ?? []) {
        const impl = s.load_implement_id === null ? null : (implById.get(s.load_implement_id) ?? null);
        const d = describeSet(s, e, impl);
        if (d.e1rm_kg !== null && impl?.loading !== "plates_only" && (best === null || d.e1rm_kg > best)) best = d.e1rm_kg;
        if (!sessions.has(s.session_id)) {
          if (sessions.size >= (input.sessions ?? 10)) continue;
          sessions.set(s.session_id, { session_id: s.session_id, date: s.performed_on, sets: [] });
        }
        sessions.get(s.session_id)?.sets.push(d);
      }
      out.push({ exercise: e.name, best_e1rm_kg: best, sessions: [...sessions.values()] });
    }
    return { member: member.name, pattern: input.pattern, exercises: out };
  },
});

const lastTrained = readTool({
  name: "last_trained",
  group: GROUP,
  description: "When a member last trained an exercise, a session template, or at all, and how many days ago.",
  input: { member: z.string().min(1), exercise: z.string().optional(), template: z.string().optional(), date: date.optional() },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    const today = input.date ?? ctx.today();
    let last: string | null;
    const extra: Record<string, unknown> = {};
    if (input.exercise !== undefined) {
      const e = await findExercise(ctx, input.exercise, ["exercise"]);
      extra.exercise = e.name;
      last = (await first<{ d: string | null }>(ctx.db, "SELECT max(se.performed_on) AS d FROM session_set st JOIN session se ON se.id = st.session_id WHERE se.member_id = ? AND st.exercise_id = ? AND se.performed_on <= ?", member.id, e.id, today))?.d ?? null;
    } else if (input.template !== undefined) {
      const t = await templateByName(ctx, member, input.template, ["template"]);
      extra.template = t.name;
      last = (await first<{ d: string | null }>(ctx.db, "SELECT max(performed_on) AS d FROM session WHERE member_id = ? AND template_id = ? AND performed_on <= ?", member.id, t.id, today))?.d ?? null;
    } else {
      last = (await first<{ d: string | null }>(ctx.db, "SELECT max(performed_on) AS d FROM session WHERE member_id = ? AND performed_on <= ?", member.id, today))?.d ?? null;
    }
    return { member: member.name, ...extra, last, days_since: last ? daysBetween(last, today) : null };
  },
});

const BLOCK = z
  .object({
    kind: z.enum(["warm_up", "steady", "interval", "recovery", "cool_down"]),
    activity: z.string().optional(),
    duration_s: z.number().int().positive().optional(),
    speed: z.object({ value: z.number().min(0).lt(100), unit: z.enum(["km/h", "mph"]) }).strict().optional(),
    incline_pct: z.number().min(-10).max(40).optional(),
    distance: z.object({ value: z.number().positive(), unit: z.enum(["m", "km", "mi"]) }).strict().optional(),
    steps: z.number().int().positive().optional(),
    avg_hr: z.number().int().min(30).max(250).optional(),
    max_hr: z.number().int().min(30).max(250).optional(),
    hr_device: z.string().optional(),
    rpe: z.number().min(0).max(10).optional(),
    conversational: z.boolean().optional(),
    rounds: z.number().int().min(1).optional(),
    recovery_hr: z.number().int().min(30).max(250).optional(),
    note: z.string().optional(),
  })
  .strict();

const KM: Record<string, number> = { m: 0.001, km: 1, mi: 1.609344 };

const logCardio = writeTool({
  name: "log_cardio",
  group: GROUP,
  description:
    "Log a cardio session or a class (dance) as blocks: duration, speed, incline, distance, steps, heart rate and device, RPE, conversational, rounds, recovery HR. Pace is derived, never stored. A class records its energy cost.",
  input: {
    member: z.string().min(1),
    date,
    weekday: weekday.optional(),
    session_type: z.enum(["cardio", "class"]),
    gym: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
    energy_kcal: z.number().min(0).max(5000).optional(),
    started_at: timestamp.optional(),
    ended_at: timestamp.optional(),
    note: z.string().optional(),
    blocks: z.array(BLOCK).min(1),
  },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    ctx.onBehalfOf(member.id);
    checkStatedWeekday(input.date, input.weekday);
    const gym = input.gym === undefined ? null : await gymByRef(ctx, input.gym, ["gym"]);
    const stamp = ctx.stamp(ctx.stateFor(member.id, { coach: true }));
    const tx = ctx.txOrThrow;
    const sessionId = await tx.create("session", {
      member_id: member.id, performed_on: input.date, gym_id: gym?.id ?? null, session_type: input.session_type, template_id: null,
      started_at: input.started_at ?? null, ended_at: input.ended_at ?? null, energy_kcal: input.energy_kcal ?? null, note: input.note ?? null, ...stamp,
    });
    const blocks = [];
    for (const [i, b] of input.blocks.entries()) {
      if (b.avg_hr !== undefined && b.max_hr !== undefined && b.avg_hr > b.max_hr) {
        throw new Clarify("hr_order", "Average heart rate is above the maximum; which is which?", [], ["blocks", i, "avg_hr"]);
      }
      const row = {
        session_id: sessionId, position: i + 1, kind: b.kind, activity: b.activity ?? null, duration_s: b.duration_s ?? null,
        speed_value: b.speed?.value ?? null, speed_unit: b.speed?.unit ?? null, incline_pct: b.incline_pct ?? null,
        distance_value: b.distance?.value ?? null, distance_unit: b.distance?.unit ?? null, steps: b.steps ?? null,
        avg_hr: b.avg_hr ?? null, max_hr: b.max_hr ?? null, hr_device: b.hr_device ?? null, rpe: b.rpe ?? null,
        conversational: b.conversational === undefined ? null : b.conversational ? 1 : 0, rounds: b.rounds ?? null,
        recovery_hr: b.recovery_hr ?? null, note: b.note ?? null,
      };
      const id = await tx.create("cardio_block", row);
      const km = b.distance ? b.distance.value * (KM[b.distance.unit] as number) : null;
      blocks.push({ id, ...row, pace_min_per_km: b.duration_s !== undefined && km ? b.duration_s / 60 / km : null });
    }
    const distanceKm = input.blocks.reduce((s, b) => s + (b.distance ? b.distance.value * (KM[b.distance.unit] as number) : 0), 0);
    return {
      session: { id: sessionId, member: member.name, date: input.date, session_type: input.session_type, gym_id: gym?.id ?? null, energy_kcal: input.energy_kcal ?? null, state: stamp.state },
      blocks,
      total_duration_s: input.blocks.reduce((s, b) => s + (b.duration_s ?? 0), 0),
      total_distance_km: distanceKm,
    };
  },
});

async function gymFor(ctx: Ctx, input: { gym?: number | string | undefined; member?: string | undefined }) {
  let ref: number | string | null = input.gym ?? null;
  if (ref === null) {
    const member = input.member !== undefined ? await ctx.member(input.member) : ctx.caller.kind === "member" ? await ctx.memberById(ctx.caller.memberId) : null;
    ref = member?.home_gym_id ?? null;
    if (ref === null) throw new Clarify("gym_needed", "Which gym?", (await all<{ name: string }>(ctx.db, "SELECT name FROM gym WHERE household_id = ?", ctx.householdId)).map((g) => g.name), ["gym"]);
  }
  return gymByRef(ctx, ref, ["gym"]);
}

async function platesOfGym(ctx: Ctx, gymId: number) {
  const sets = await all<{ id: number; unit: "kg" | "lb"; complete: number; note: string | null }>(ctx.db, "SELECT * FROM plate_set WHERE gym_id = ? ORDER BY unit", gymId);
  const out = [];
  for (const s of sets) {
    const plates = await all<{ value: number; status: string }>(ctx.db, "SELECT value, status FROM plate WHERE plate_set_id = ? ORDER BY value", s.id);
    out.push({ unit: s.unit, complete: s.complete === 1, note: s.note, plates });
  }
  return out;
}

const inventory = readTool({
  name: "inventory",
  group: GROUP,
  description:
    "A gym's equipment inventory: its plates per unit (each confirmed, inferred or absent, and whether the set is complete), and each implement with its unit, loading, bar or sled weight, its listed loads in their own units (a list may mix kg and lb) or, for barbells and plate-loaded machines, that its loads are combinations of the plates.",
  input: { gym: z.union([z.number().int().positive(), z.string().min(1)]).optional().describe("Default: the member's home gym."), member: z.string().optional() },
  async run(ctx, input) {
    const gym = await gymFor(ctx, input);
    return { gym: gym.name, gym_id: gym.id, plates: await platesOfGym(ctx, gym.id), implements: (await loadImplements(ctx, { gymId: gym.id })).map(describeImplement) };
  },
});

async function implementOf(ctx: Ctx, id: number): Promise<ImplementRow> {
  const [impl] = await loadImplements(ctx, { ids: [id] });
  const gym = impl ? await first<{ household_id: number }>(ctx.db, "SELECT household_id FROM gym WHERE id = ?", impl.gym_id) : null;
  if (!impl || gym?.household_id !== ctx.householdId) throw new ToolError("not_found", `no implement ${id}`, 404);
  return impl;
}

/** Each entry read in its native unit; a bare number is in the implement's unit. */
function readEntries(impl: ImplementRow, entries: z.infer<typeof LOAD_ENTRY>[], asStated: boolean | undefined): LoadAmount[] {
  if (impl.plates) {
    throw new Clarify("plates_loaded", `${impl.name} is loaded with plates: its loads are combinations of the gym's plates. Record the plates instead.`, [], ["implement_id"], { use: "record_plates" });
  }
  return entries.map((e, i) => {
    const a = typeof e === "number" ? { value: e, unit: impl.unit } : e;
    const { value, unit } = nativeLoad(a.value, a.unit, { asStated, implement: impl, path: ["loads", i] });
    return { value, unit };
  });
}

const kgOf = (a: LoadAmount) => toKg(a.value, a.unit);
const same = (a: LoadAmount, b: LoadAmount) => Math.abs(kgOf(a) - kgOf(b)) <= 1e-6;

const addImplementLoad = writeTool({
  name: "add_implement_load",
  group: GROUP,
  description:
    "Add loads an implement can produce (confirmed in use): explicit values, each in its own unit (a number is in the implement's unit; a list may mix kg and lb, read in each load's native unit), or stated ladders (`ranges`: \"5 to 100 lb in 5s\" is one range, and a ladder that changes step is more than one). Assistance is negative. Loads already listed are skipped; a load recorded as absent becomes available. Not for barbells and plate-loaded machines: use record_plates.",
  input: {
    implement_id: z.number().int().positive(),
    loads: z.array(LOAD_ENTRY).min(1).optional(),
    ranges: z.array(RANGE).min(1).optional().describe("Stated ladders, each every step from `from` to `to`, in its own unit."),
    as_stated: z.boolean().optional(),
  },
  async run(ctx, input) {
    const impl = await implementOf(ctx, input.implement_id);
    if ((input.loads ?? []).length === 0 && (input.ranges ?? []).length === 0) {
      throw new Clarify("loads_needed", `Which loads does ${impl.name} produce?`, [], ["loads"]);
    }
    const rows = await all<{ id: number; implement_id: number; load: number; unit: "kg" | "lb"; status: string }>(ctx.db, "SELECT * FROM implement_load WHERE implement_id = ?", impl.id);
    const added: LoadAmount[] = [];
    const entries = [...readEntries(impl, input.loads ?? [], input.as_stated), ...expandRanges(input.ranges, ["ranges"])];
    for (const load of entries) {
      if (impl.loads.some((l) => same(l, load)) || added.some((l) => same(l, load))) continue;
      const absent = rows.find((r) => r.status === "absent" && r.unit === load.unit && Math.abs(r.load - load.value) < 1e-9);
      if (absent) ctx.txOrThrow.update("implement_load", absent.id, { status: "available" }, { ...absent, status: "available" });
      else await ctx.txOrThrow.create("implement_load", { implement_id: impl.id, load: load.value, unit: load.unit, status: "available" });
      added.push(load);
    }
    const after = { ...impl, loads: [...impl.loads, ...added], absent: impl.absent.filter((a) => !added.some((l) => l.unit === a.unit && l.value === a.value)) };
    // A set left draft because its load was off the list is now valid: re-check
    // it (and confirm it when the caller may), so it never stays stale.
    const drafts = await all<SetRow & { member_id: number }>(
      ctx.db,
      `SELECT st.*, se.member_id FROM session_set st JOIN session se ON se.id = st.session_id
       WHERE st.load_implement_id = ? AND st.state = 'draft' AND st.draft_reason = 'off_list'
       ORDER BY st.session_id, st.position`,
      impl.id,
    );
    const byMember = new Map<number, SetRow[]>();
    for (const set of drafts) {
      if (!ctx.canSee(set.member_id)) continue;
      byMember.set(set.member_id, [...(byMember.get(set.member_id) ?? []), set]);
    }
    const revalidated: number[] = [];
    const stillDraft: { id: number; reason: string; member: string; offer?: Record<string, unknown> }[] = [];
    for (const [memberId, group] of byMember) {
      const member = await ctx.memberById(memberId);
      const result = await confirmDraftSets(ctx, member, group, {
        only_reason: "off_list",
        confirm: ctx.stateFor(memberId) === "confirmed",
        implements: [after],
      });
      revalidated.push(...result.confirmed);
      stillDraft.push(...result.still_draft.map((s) => ({ ...s, member: member.name })));
    }
    return { added, implement: describeImplement(after), state: "confirmed", revalidated_sets: revalidated, still_draft: stillDraft };
  },
});

const removeImplementLoad = writeTool({
  name: "remove_implement_load",
  group: GROUP,
  description:
    "Record that loads don't exist on an implement (\"there's no 15 kg dumbbell\", or a proposed unverified step that isn't there), each in its own unit as for add_implement_load, with the reason (required; it goes to the write log and the load's history). A listed load is removed; every load named is kept as absent, so it is never proposed again. Returns the implement, loads that weren't listed, and the prescriptions whose current load was removed, to move with programme_change.",
  input: { implement_id: z.number().int().positive(), loads: z.array(LOAD_ENTRY).min(1), as_stated: z.boolean().optional() },
  async run(ctx, input) {
    if (!input.reason) throw new Clarify("reason_needed", "Why is the load being removed (for example, the gym doesn't have it)?", [], ["reason"]);
    const impl = await implementOf(ctx, input.implement_id);
    const rows = await all<{ id: number; implement_id: number; load: number; unit: "kg" | "lb"; status: string }>(ctx.db, "SELECT * FROM implement_load WHERE implement_id = ? ORDER BY load", impl.id);
    const removed: LoadAmount[] = [];
    const notListed: LoadAmount[] = [];
    const absent: LoadAmount[] = [];
    for (const load of readEntries(impl, input.loads, input.as_stated)) {
      if ([...removed, ...notListed].some((l) => same(l, load))) continue;
      const row = rows.find((r) => r.status === "available" && same({ value: r.load, unit: r.unit }, load));
      const kept = row ? { value: row.load, unit: row.unit } : load;
      if (row) {
        ctx.txOrThrow.remove("implement_load", row.id, row, "delete");
        removed.push(kept);
      } else notListed.push(load);
      if (!rows.some((r) => r.status === "absent" && r.unit === kept.unit && Math.abs(r.load - kept.value) < 1e-9)) {
        await ctx.txOrThrow.create("implement_load", { implement_id: impl.id, load: kept.value, unit: kept.unit, status: "absent" });
        absent.push(kept);
      }
    }
    // Prescriptions now prescribing a load this implement can't produce.
    const prescriptions = await all<PrescriptionView>(ctx.db, "SELECT * FROM v_prescription WHERE current_load_implement_id = ? ORDER BY id", impl.id);
    const affected = prescriptions
      .filter((p) => p.current_load_value !== null && p.current_load_unit !== null)
      .filter((p) => removed.some((r) => same(r, { value: p.current_load_value as number, unit: p.current_load_unit as "kg" | "lb" })))
      .map((p) => ({ prescription_id: p.id, exercise: p.exercise_name, template: p.template_name, load: { value: p.current_load_value, unit: p.current_load_unit } }));
    const left = { ...impl, loads: impl.loads.filter((l) => !removed.some((r) => same(r, l))), absent: [...impl.absent, ...absent] };
    return { removed, not_listed: notListed, implement: describeImplement(left), affected_prescriptions: affected, state: "confirmed" };
  },
});

/** Plate denominations a gym commonly has, per unit: what to ask about when a plate set isn't complete. */
export const COMMON_PLATES: Record<"kg" | "lb", number[]> = { kg: [1.25, 2.5, 5, 10, 15, 20, 25], lb: [2.5, 5, 10, 25, 35, 45] };

/**
 * The member's active-programme prescriptions, the next session's first
 * (in order), then the rest; with the next session's name.
 */
async function upcomingPrescriptions(ctx: Ctx, member: Member, today: string): Promise<{ session: string | null; prescriptions: PrescriptionView[] }> {
  const plan = await nextSessionPlan(ctx, member.id, today);
  if (!plan) return { session: null, prescriptions: [] };
  const nextTemplate = plan.templateId;
  return {
    session: plan.next?.session ?? null,
    prescriptions: [...plan.prescriptions.filter((p) => p.template_id === nextTemplate), ...plan.prescriptions.filter((p) => p.template_id !== nextTemplate)],
  };
}

const inventoryGaps = readTool({
  name: "inventory_gaps",
  group: GROUP,
  description:
    "What isn't known yet about the equipment at a member's gym, most useful first: plate denominations not confirmed, stack tops and dumbbell rack ends unknown, bar and sled weights. Each gap names the prescriptions it serves; those in the next session come first. `ask` is the one small chunk to ask about this session, at a natural moment; never turn a session into an inventory survey.",
  input: { member: z.string().min(1), date: date.optional().describe("Today, by default.") },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    if (member.home_gym_id === null) return { member: member.name, gym: null, next_session: null, gaps: [], ask: null };
    const gym = await gymByRef(ctx, member.home_gym_id, ["member"]);
    const implements_ = await loadImplements(ctx, { gymId: gym.id });
    const upcoming = member.programming_mode === "prescribed" ? await upcomingPrescriptions(ctx, member, input.date ?? ctx.today()) : { session: null, prescriptions: [] };
    const exerciseKinds = new Map(
      (await all<{ id: number; implement_kind: string }>(ctx.db, "SELECT id, implement_kind FROM exercise WHERE household_id = ?", ctx.householdId)).map((e) => [e.id, e.implement_kind]),
    );
    // Which implement each upcoming prescription uses: its own, or the only one of its kind at the gym.
    const usedBy = (impl: ImplementRow) =>
      upcoming.prescriptions.filter((p) => {
        if (p.current_load_implement_id !== null) return p.current_load_implement_id === impl.id;
        const ofKind = implements_.filter((i) => i.kind === exerciseKinds.get(p.exercise_id));
        return ofKind.length === 1 && ofKind[0]?.id === impl.id;
      });
    const nextCount = upcoming.session === null ? 0 : upcoming.prescriptions.filter((p, i) => i === 0 || p.template_id === upcoming.prescriptions[0]?.template_id).length;
    const rankOf = (ps: PrescriptionView[]) => Math.min(...ps.map((p) => upcoming.prescriptions.indexOf(p)), Number.MAX_SAFE_INTEGER);
    const named = (ps: PrescriptionView[]) => ps.map((p) => ({ prescription_id: p.id, exercise: p.exercise_name, template: p.template_name, next_session: upcoming.prescriptions.indexOf(p) < nextCount }));

    const gaps: { kind: string; implement_id: number | null; implement: string | null; unit?: string; known?: unknown; unknown?: number[]; question: string; for_prescriptions: ReturnType<typeof named>; rank: number }[] = [];
    for (const impl of implements_) {
      const ps = usedBy(impl);
      if (impl.plates === null && platesLoaded(impl) === false && impl.load_list_complete === 0) {
        const known = producibleLoads(domainImplement(impl, { unit: impl.unit })).map(({ value, unit }) => ({ value, unit }));
        const kind = impl.kind === "dumbbell" || impl.kind === "kettlebell" || impl.kind === "fixed_bar" ? "rack_end" : "stack_top";
        const top = known.at(-1);
        gaps.push({
          kind, implement_id: impl.id, implement: impl.name, known,
          question: top ? `${impl.name}: what's the heaviest it goes to above ${top.value} ${top.unit}, and is any step missing?` : `${impl.name}: which loads does it have?`,
          for_prescriptions: named(ps), rank: rankOf(ps),
        });
      }
      if (platesLoaded(impl) && impl.bar_value === null) {
        const sled = impl.loading === "plates_only";
        gaps.push({
          kind: sled ? "sled_weight" : "bar_weight", implement_id: impl.id, implement: impl.name,
          question: sled ? `${impl.name}: is the sled's own weight marked on it?` : `${impl.name}: what does the bar weigh?`,
          for_prescriptions: named(ps), rank: rankOf(ps),
        });
      }
    }
    const plateKit = implements_.filter(platesLoaded);
    if (plateKit.length > 0) {
      const ps = plateKit.flatMap(usedBy);
      const sets = await platesOfGym(ctx, gym.id);
      if (sets.length === 0) {
        gaps.push({ kind: "plates", implement_id: null, implement: null, question: "Which plates are on the rack: kg, lb, and which sizes?", for_prescriptions: named(ps), rank: rankOf(ps) });
      }
      for (const set of sets.filter((x) => !x.complete)) {
        const known = new Map(set.plates.map((p) => [p.value, p.status]));
        const unknown = [...new Set([...COMMON_PLATES[set.unit], ...set.plates.filter((p) => p.status === "inferred").map((p) => p.value)])]
          .filter((v) => known.get(v) !== "confirmed" && known.get(v) !== "absent")
          .sort((a, b) => a - b);
        gaps.push({
          kind: "plate_denominations", implement_id: null, implement: null, unit: set.unit, known: set.plates, unknown,
          question: `Which ${set.unit} plates are on the rack? Not yet confirmed: ${unknown.join(", ")} ${set.unit}.`,
          for_prescriptions: named(ps), rank: rankOf(ps),
        });
      }
    }
    gaps.sort((a, b) => a.rank - b.rank);
    const out = gaps.map(({ rank: _rank, ...g }) => g);
    return { member: member.name, gym: gym.name, next_session: upcoming.session, gaps: out, ask: out[0] ?? null };
  },
});

const recordPlates = writeTool({
  name: "record_plates",
  group: GROUP,
  description:
    "Record a gym's plates of one unit, as a member reports them (\"the kg rack has 1.25, 2.5, 5, 10, 20\"; \"there's no 1.25 kg plate\"): denominations available (confirmed), absent, and whether that's every denomination (complete). Barbells and plate-loaded machines make their loads from these plates, in any mix of units.",
  input: {
    gym: z.union([z.number().int().positive(), z.string().min(1)]).optional().describe("Default: the speaker's or member's home gym."),
    member: z.string().optional(),
    unit: z.enum(["kg", "lb"]),
    available: z.array(z.number().gt(0).lt(100)).optional().describe("Denominations seen on the rack (each side needs a pair)."),
    absent: z.array(z.number().gt(0).lt(100)).optional().describe("Denominations the gym doesn't have."),
    complete: z.boolean().optional().describe("True when these are all the denominations of this unit."),
    note: z.string().optional(),
  },
  async run(ctx, input) {
    const gym = await gymFor(ctx, { gym: input.gym, member: input.member ?? ctx.writeInfo.speaker?.name });
    const both = (input.available ?? []).filter((v) => (input.absent ?? []).includes(v));
    if (both.length > 0) throw new Clarify("plate_both_ways", `${both.join(", ")} ${input.unit} is listed as both available and absent. Which is it?`, [], ["absent"]);
    if ((input.available ?? []).length === 0 && (input.absent ?? []).length === 0 && input.complete === undefined) {
      throw new Clarify("plates_needed", `Which ${input.unit} plates are there?`, [], ["available"]);
    }
    const tx = ctx.txOrThrow;
    let set = await first<{ id: number; gym_id: number; unit: string; complete: number; note: string | null }>(ctx.db, "SELECT * FROM plate_set WHERE gym_id = ? AND unit = ?", gym.id, input.unit);
    let setId: number;
    if (!set) {
      setId = await tx.create("plate_set", { gym_id: gym.id, unit: input.unit, complete: input.complete ? 1 : 0, note: input.note ?? null });
    } else {
      setId = set.id;
      const changes: Row = {};
      if (input.complete !== undefined && (input.complete ? 1 : 0) !== set.complete) changes.complete = input.complete ? 1 : 0;
      if (input.note !== undefined) changes.note = input.note;
      if (Object.keys(changes).length > 0) tx.update("plate_set", set.id, changes, { ...set, ...changes });
    }
    const existing = set ? await all<{ id: number; plate_set_id: number; value: number; status: string }>(ctx.db, "SELECT * FROM plate WHERE plate_set_id = ?", set.id) : [];
    const mark = async (value: number, status: "confirmed" | "absent") => {
      const row = existing.find((p) => Math.abs(p.value - value) < 1e-9);
      if (!row) await tx.create("plate", { plate_set_id: setId, value, status });
      else if (row.status !== status) tx.update("plate", row.id, { status }, { ...row, status });
    };
    for (const v of [...new Set(input.available ?? [])]) await mark(v, "confirmed");
    for (const v of [...new Set(input.absent ?? [])]) await mark(v, "absent");
    const plates = new Map(existing.map((p) => [p.value, p.status]));
    for (const v of input.available ?? []) plates.set(v, "confirmed");
    for (const v of input.absent ?? []) plates.set(v, "absent");
    set = set ?? null;
    return {
      gym: gym.name,
      unit: input.unit,
      complete: input.complete ?? set?.complete === 1,
      plates: [...plates.entries()].sort((a, b) => a[0] - b[0]).map(([value, status]) => ({ value, status })),
      state: "confirmed",
    };
  },
});

export const TRAINING_TOOLS: Tool[] = [
  startSession, logSet, logWorkout, previewSet, endSession, updateSet, revalidateSet, revalidateSession, validateSession, getSetHistory,
  activeSession, nextPrescription, checkProgression, substitute, liftHistory, lastTrained, logCardio, inventory, addImplementLoad,
  removeImplementLoad, recordPlates, inventoryGaps,
];
