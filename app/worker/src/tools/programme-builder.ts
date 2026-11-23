import { z } from "zod";
import type { Ctx } from "../context";
import { first, type Row } from "../db";
import { Clarify } from "../errors";
import { PLATE, PROGRAMME_LOAD, programmeLoad, programmeLoadColumns } from "../sets";
import { ExerciseIndex, loadImplements, type ImplementRow } from "../training";

const date = z.iso.date();
const BASIS = z.enum(["total", "per_side", "per_hand", "per_leg"]);
// Keeps one createMany JSON bind safely below D1's 2 MB bound-value cap even
// when every bounded coaching field is filled with multibyte text.
const MAX_PROGRAMME_PRESCRIPTIONS = 180;
const MAX_FALLBACKS_PER_PRESCRIPTION = 10;
// Leaves ample room below D1's 2 MB per-bound-value limit for JSON escaping
// and the other columns in the same batch.
export const MAX_PROGRAMME_FALLBACK_BYTES = 1_000_000;

export const PROGRAMME_RULE = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rep_top"),
    target_sets: z.number().int().min(1),
    rep_top: z.number().int().min(1),
    rir_floor: z.union([z.number().min(0), z.literal("from_prescription")]),
    increment: z.union([
      z.object({ min: z.number().positive(), max: z.number().positive().optional(), unit: z.enum(["kg", "lb"]).optional(), basis: BASIS.optional() }).strict(),
      z.literal("smallest_step"),
    ]).optional(),
    per_leg: z.boolean().optional(),
    cue: z.string().trim().min(1).max(1_000).optional(),
    autoregulation: z.object({ reps_under: z.number().int().min(1) }).strict().optional(),
  }).strict(),
  z.object({ kind: z.literal("manual"), cue: z.string().trim().min(1).max(1_000).optional() }).strict(),
]);

const TARGET = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reps") }).strict(),
  z.object({ kind: z.literal("duration"), low_s: z.number().int().positive().optional(), high_s: z.number().int().positive().optional() }).strict(),
  z.object({ kind: z.literal("distance"), value: z.number().positive(), unit: z.enum(["m", "km", "mi"]) }).strict(),
]);

const PRESCRIPTION = z.object({
  exercise: z.string().trim().min(1).max(200),
  target: TARGET.optional(),
  sets: z.number().int().min(1).max(20).optional(),
  rep_low: z.number().int().min(1).optional(),
  rep_high: z.number().int().max(100).optional(),
  rir_target_low: z.number().int().min(0).max(10).optional(),
  rir_target_high: z.number().int().min(0).max(10).optional(),
  rest_s: z.number().int().min(0).max(3600).optional(),
  load: z.object({
    ...PROGRAMME_LOAD,
    basis: BASIS,
    plates: z.array(PLATE).min(1).max(30).optional(),
    implement: z.union([z.number().int().positive(), z.string().trim().min(1).max(200)]).optional(),
  }).strict().optional(),
  progression_rule: PROGRAMME_RULE.optional(),
  cue: z.string().max(1_000).optional(),
  fallback_note: z.string().max(1_000).optional(),
  fallbacks: z.array(z.object({
    exercise: z.string().trim().min(1).max(200),
    note: z.string().trim().min(1).max(1_000).optional(),
  }).strict()).max(MAX_FALLBACKS_PER_PRESCRIPTION).optional(),
}).strict();

export const PROGRAMME_INPUT = {
  member: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  schedule_kind: z.enum(["weekday", "rotation"]),
  started_on: date,
  active: z.boolean().optional(),
  templates: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    session_type: z.enum(["strength", "cardio", "class"]),
    prescriptions: z.array(PRESCRIPTION).max(60),
  }).strict()).min(1).max(30),
  slots: z.array(z.object({
    weekday: z.number().int().min(1).max(7).optional(),
    rotation_position: z.number().int().min(1).optional(),
    template: z.string().trim().min(1).max(200),
  }).strict()).max(30),
};

export type ProgrammeInput = z.infer<z.ZodObject<typeof PROGRAMME_INPUT>>;

export interface ProgrammeRevisionOptions {
  predecessor: Row & { id: number; member_id: number; name: string; schedule_kind: string; active: number; started_on: string; ended_on: string | null };
  effectiveOn: string;
  changeReason: string;
  futureSwaps?: readonly { on_date: string; template: string | null; reason: string }[];
  /** False when an already-archived predecessor is being restored as a new successor. */
  retirePredecessor?: boolean;
}

function prescriptionImplement(atGym: readonly ImplementRow[], kind: string, ref: number | string | undefined, path: (string | number)[]): number | null {
  if (ref !== undefined) {
    const found = atGym.find((item) => (typeof ref === "number" ? item.id === ref : item.name.toLowerCase() === ref.trim().toLowerCase()));
    if (!found) throw new Clarify("unknown_implement", `Which implement is ${ref}?`, atGym.map((item) => item.name), path);
    return found.id;
  }
  const candidates = atGym.filter((item) => item.kind === kind);
  return candidates.length === 1 ? candidates[0]!.id : null;
}

function validateGraph(input: ProgrammeInput): void {
  if (input.slots.length === 0) throw new Clarify("slots_needed", "Add at least one schedule slot.", [], ["slots"]);
  const prescriptionCount = input.templates.reduce((count, template) => count + template.prescriptions.length, 0);
  if (prescriptionCount > MAX_PROGRAMME_PRESCRIPTIONS) {
    throw new Clarify(
      "programme_too_large",
      `A programme can contain at most ${MAX_PROGRAMME_PRESCRIPTIONS} prescriptions; split this into a smaller active plan.`,
      [],
      ["templates"],
    );
  }
  const templates = new Set<string>();
  for (const [index, template] of input.templates.entries()) {
    const key = template.name.trim().toLowerCase();
    if (templates.has(key)) throw new Clarify("duplicate_template", `Two templates are called ${template.name}.`, [], ["templates", index, "name"]);
    templates.add(key);
  }
  const positions: number[] = [];
  for (const [index, slot] of input.slots.entries()) {
    if (!templates.has(slot.template.trim().toLowerCase())) throw new Clarify("unknown_template", `No template called ${slot.template}.`, [...templates], ["slots", index, "template"]);
    if ((slot.weekday === undefined) === (slot.rotation_position === undefined)) throw new Clarify("slot_kind", "A slot is either a weekday or a rotation position.", [], ["slots", index]);
    if ((input.schedule_kind === "weekday") !== (slot.weekday !== undefined)) {
      throw new Clarify("slot_kind", `A ${input.schedule_kind} programme's slots use ${input.schedule_kind === "weekday" ? "weekdays" : "rotation positions"}.`, [], ["slots", index]);
    }
    positions.push(input.schedule_kind === "weekday" ? slot.weekday! : slot.rotation_position!);
  }
  if (new Set(positions).size !== positions.length) throw new Clarify("duplicate_schedule_slot", "Each weekday or rotation position can appear only once.", [], ["slots"]);
  if (input.schedule_kind === "rotation") {
    const sorted = [...positions].sort((a, b) => a - b);
    if (sorted.some((position, index) => position !== index + 1)) throw new Clarify("rotation_positions", "Rotation positions must be contiguous, starting at 1.", [], ["slots"]);
  }
}

export async function createProgrammeGraph(ctx: Ctx, input: ProgrammeInput, revision?: ProgrammeRevisionOptions) {
  validateGraph(input);
  const member = await ctx.member(input.member);
  ctx.onBehalfOf(member.id);
  if (member.programming_mode === "record_only") {
    throw new Clarify("record_only_member", `${member.name} is record-only: a trainer owns the programme, so the tracker holds none.`, [], ["member"]);
  }
  const active = input.active ?? true;
  if (active && !revision && (await first(ctx.db, "SELECT id FROM programme WHERE member_id = ? AND active = 1", member.id))) {
    throw new Clarify("programme_exists", `${member.name} already has an active programme.`, [], ["member"]);
  }
  const exerciseIndex = await ExerciseIndex.load(ctx);
  const implementsAtGym = member.home_gym_id === null ? [] : await loadImplements(ctx, { gymId: member.home_gym_id });
  const plannedTemplates: Array<{
    name: string;
    session_type: "strength" | "cardio" | "class";
    prescriptions: Array<{ row: Row; canonical: Record<string, unknown>; fallbacks: { exercise_id: number; rank: number; note: string | null; name: string }[] }>;
  }> = [];
  for (const [templateIndex, template] of input.templates.entries()) {
    const plannedPrescriptions: Array<{ row: Row; canonical: Record<string, unknown>; fallbacks: { exercise_id: number; rank: number; note: string | null; name: string }[] }> = [];
    for (const [index, prescription] of template.prescriptions.entries()) {
      const path = ["templates", templateIndex, "prescriptions", index];
      const target = prescription.target ?? { kind: "reps" as const };
      const reps = prescription.rep_low !== undefined || prescription.rep_high !== undefined;
      if (target.kind !== "reps" && reps) throw new Clarify("target_conflict", `A ${target.kind} target has no rep range; which is it?`, ["reps", target.kind], [...path, "target"]);
      if (target.kind === "reps" && (prescription.rep_low === undefined || prescription.rep_high === undefined)) throw new Clarify("rep_range", "What rep range does it prescribe?", [], [...path, "rep_low"]);
      if (prescription.rep_low !== undefined && prescription.rep_high !== undefined && prescription.rep_low > prescription.rep_high) throw new Clarify("rep_range", "The rep range runs low to high; which numbers?", [], [...path, "rep_low"]);
      if ((prescription.rir_target_low === undefined) !== (prescription.rir_target_high === undefined)) throw new Clarify("rir_range", "Give both ends of the RIR target, or neither.", [], [...path, "rir_target_low"]);
      if (prescription.rir_target_low !== undefined && prescription.rir_target_high !== undefined && prescription.rir_target_low > prescription.rir_target_high) throw new Clarify("rir_range", "The RIR target runs low to high; which numbers?", [], [...path, "rir_target_low"]);
      const rule = prescription.progression_rule;
      if (rule?.kind === "rep_top" && target.kind !== "reps") throw new Clarify("rule_needs_reps", `A rep_top rule needs a rep target; this one is a ${target.kind}. Make the rule manual?`, ["manual"], [...path, "progression_rule"]);
      if (rule?.kind === "rep_top" && rule.rir_floor === "from_prescription" && prescription.rir_target_low === undefined) throw new Clarify("rir_floor_needs_target", "The rule reads its RIR floor from the prescription, which has no RIR target. What is the floor?", [], [...path, "progression_rule", "rir_floor"]);
      if (target.kind === "duration" && (target.low_s === undefined) !== (target.high_s === undefined)) throw new Clarify("duration_range", "Give both ends of the duration, or neither (as long as possible).", [], [...path, "target"]);
      const exercise = exerciseIndex.find(prescription.exercise, [...path, "exercise"]);
      const fallbackExercises = (prescription.fallbacks ?? []).map((fallback, fallbackIndex) => ({
        exercise: exerciseIndex.find(fallback.exercise, [...path, "fallbacks", fallbackIndex, "exercise"]),
        note: fallback.note ?? null,
      }));
      if (new Set(fallbackExercises.map((fallback) => fallback.exercise.id)).size !== fallbackExercises.length) {
        throw new Clarify("duplicate_fallback", "A prescription can list an exercise fallback only once.", [], [...path, "fallbacks"]);
      }
      const implementId = prescription.load ? prescriptionImplement(implementsAtGym, exercise.implement_kind, prescription.load.implement, [...path, "load", "implement"]) : null;
      const implement = implementId === null ? null : implementsAtGym.find((item) => item.id === implementId) ?? null;
      const load = prescription.load ? programmeLoad(prescription.load, implement ?? null, [...path, "load"]) : null;
      const row = {
        position: index + 1, exercise_id: exercise.id, target_kind: target.kind, sets: prescription.sets ?? null,
        rep_low: prescription.rep_low ?? null, rep_high: prescription.rep_high ?? null, rir_target_low: prescription.rir_target_low ?? null, rir_target_high: prescription.rir_target_high ?? null,
        duration_low_s: target.kind === "duration" ? (target.low_s ?? null) : null, duration_high_s: target.kind === "duration" ? (target.high_s ?? null) : null,
        distance_value: target.kind === "distance" ? target.value : null, distance_unit: target.kind === "distance" ? target.unit : null,
        rest_s: prescription.rest_s ?? null, ...programmeLoadColumns(load), load_implement_id: implementId,
        progression_rule: rule ? JSON.stringify(rule) : null, cue: prescription.cue ?? null, fallback_note: prescription.fallback_note ?? null,
      };
      const canonicalTarget = target.kind === "reps"
        ? { kind: "reps" as const, low: prescription.rep_low ?? null, high: prescription.rep_high ?? null }
        : target.kind === "duration"
          ? { kind: "duration" as const, low_s: target.low_s ?? null, high_s: target.high_s ?? null }
          : { kind: "distance" as const, value: target.value, unit: target.unit };
      plannedPrescriptions.push({
        row,
        fallbacks: fallbackExercises.map((fallback, fallbackIndex) => ({
          exercise_id: fallback.exercise.id,
          rank: fallbackIndex + 1,
          note: fallback.note,
          name: fallback.exercise.name,
        })),
        canonical: {
          position: index + 1,
          exercise: exercise.name,
          target: canonicalTarget,
          sets: prescription.sets ?? null,
          rir_target: prescription.rir_target_low === undefined ? null : { low: prescription.rir_target_low, high: prescription.rir_target_high },
          rest_s: prescription.rest_s ?? null,
          current_load: load === null ? null : { ...load, implement: implement === null ? null : { id: implement.id, name: implement.name } },
          progression_rule: rule ?? null,
          cue: prescription.cue ?? null,
          fallback_note: prescription.fallback_note ?? null,
        },
      });
    }
    plannedTemplates.push({ name: template.name.trim(), session_type: template.session_type, prescriptions: plannedPrescriptions });
  }

  const fallbackPayloadBytes = new TextEncoder().encode(JSON.stringify(
    plannedTemplates.flatMap((template) => template.prescriptions.flatMap((prescription) => prescription.fallbacks)),
  )).byteLength;
  if (fallbackPayloadBytes > MAX_PROGRAMME_FALLBACK_BYTES) {
    throw new Clarify(
      "programme_fallbacks_too_large",
      "The programme's fallback notes are too large to save safely in one revision; shorten or split them.",
      [],
      ["templates"],
    );
  }

  const tx = ctx.txOrThrow;
  await tx.reserve(["programme", "session_template", "prescription", "schedule_slot", "schedule_swap"]);
  if (revision && revision.retirePredecessor !== false) {
    const changes = {
      active: 0,
      ended_on: revision.effectiveOn,
      superseded_at: ctx.nowIso(),
      superseded_reason: revision.changeReason,
    };
    tx.update("programme", revision.predecessor.id, changes, { ...revision.predecessor, ...changes });
  }
  const [programmeId] = await tx.createMany("programme", [{
    member_id: member.id, name: input.name.trim(), schedule_kind: input.schedule_kind, active: active ? 1 : 0, started_on: input.started_on, ended_on: null,
    ...(revision ? { supersedes_programme_id: revision.predecessor.id } : {}),
  }]);
  const templateIds = await tx.createMany("session_template", plannedTemplates.map((template) => ({ programme_id: programmeId, name: template.name, session_type: template.session_type })));
  const templateIdByName = new Map(plannedTemplates.map((template, index) => [template.name.toLowerCase(), templateIds[index]!]));
  const flattened = plannedTemplates.flatMap((template, templateIndex) => template.prescriptions.map((prescription) => ({ templateIndex, prescription })));
  const prescriptionIds = await tx.createMany("prescription", flattened.map(({ templateIndex, prescription }) => ({ template_id: templateIds[templateIndex]!, ...prescription.row })));
  const slotIds = await tx.createMany("schedule_slot", input.slots.map((slot) => ({
    programme_id: programmeId,
    weekday: slot.weekday ?? null,
    rotation_position: slot.rotation_position ?? null,
    template_id: templateIdByName.get(slot.template.trim().toLowerCase())!,
  })));
  const fallbackRows = flattened.flatMap(({ prescription }, index) => prescription.fallbacks.map(({ name: _name, ...fallback }) => ({
    prescription_id: prescriptionIds[index]!, ...fallback,
  })));
  if (fallbackRows.length > 0) {
    tx.exec(
      "INSERT INTO prescription_fallback (prescription_id, exercise_id, rank, note) SELECT json_extract(value, '$.prescription_id'), json_extract(value, '$.exercise_id'), json_extract(value, '$.rank'), json_extract(value, '$.note') FROM json_each(?)",
      JSON.stringify(fallbackRows),
    );
  }
  const swapIds = revision?.futureSwaps === undefined ? [] : await tx.createMany("schedule_swap", revision.futureSwaps.map((swap) => ({
    programme_id: programmeId,
    on_date: swap.on_date,
    template_id: swap.template === null ? null : templateIdByName.get(swap.template.toLowerCase())!,
    reason: swap.reason,
  })));
  let prescriptionIndex = 0;
  const canonicalTemplates = plannedTemplates.map((template, templateIndex) => ({
    id: templateIds[templateIndex]!,
    name: template.name,
    session_type: template.session_type,
    slots: input.slots.flatMap((slot, slotIndex) => templateIdByName.get(slot.template.trim().toLowerCase()) === templateIds[templateIndex]
      ? [{ id: slotIds[slotIndex]!, ...(slot.weekday === undefined ? { rotation_position: slot.rotation_position } : { weekday: slot.weekday }) }]
      : []),
    prescriptions: template.prescriptions.map((prescription) => {
      return {
        id: prescriptionIds[prescriptionIndex++]!,
        ...prescription.canonical,
        fallbacks: prescription.fallbacks.map((fallback) => fallback.name),
      };
    }),
  }));
  return {
    id: programmeId,
    member: member.name,
    name: input.name.trim(),
    schedule_kind: input.schedule_kind,
    active,
    started_on: input.started_on,
    supersedes_programme_id: revision?.predecessor.id ?? null,
    templates: canonicalTemplates,
    swaps: (revision?.futureSwaps ?? []).map((swap, index) => ({ id: swapIds[index]!, date: swap.on_date, template: swap.template, reason: swap.reason })),
  };
}
