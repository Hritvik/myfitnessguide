import { snapToImplement, WEEKDAYS } from "@myfitnessguide/domain";
import { z } from "zod";
import type { Ctx } from "../context";
import { all, first, type Row } from "../db";
import { Clarify, ToolError } from "../errors";
import { readTool, writeTool, type Tool } from "../tool";
import { activeProgramme, domainImplement, loadImplements, parseRule, prescribedLoad, prescriptionById, rirTargetOf, ruleShown, targetOf, type PrescriptionView } from "../training";
import { PROGRAMME_LOAD, programmeLoad, programmeLoadColumns } from "../sets";
import { createProgrammeGraph, PROGRAMME_INPUT, PROGRAMME_RULE } from "./programme-builder";
import type { ProgrammeInput } from "./programme-builder";

const GROUP = "everywhere";
const date = z.iso.date();
const MAX_FUTURE_SWAPS_TO_CLONE = 60;

async function phases(ctx: Ctx, memberId: number) {
  return all<Row & { id: number; name: string; starts_on: string; ends_on: string | null }>(ctx.db, "SELECT * FROM phase WHERE member_id = ? AND archived_at IS NULL ORDER BY starts_on", memberId);
}

const programme = readTool({
  name: "programme",
  group: GROUP,
  description:
    "A member's active programme: its schedule (weekday plan or rotation, with upcoming swaps), each session template's ordered prescriptions with current load, progression rule, cue and fallbacks, and the member's phases with the one in force. Cues, fallback notes and swaps' reasons are owner-only (null for another member), and so are phases (none for another member).",
  input: { member: z.string().min(1), date: date.optional() },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    const on = input.date ?? ctx.today();
    // Phases and a prescription's coach notes are owner-only (decisions 135 and 137): they cite readings, BIA and goals.
    const own = ctx.canSee(member.id);
    const allPhases = own ? await phases(ctx, member.id) : [];
    const current = allPhases.filter((p) => p.starts_on <= on && (p.ends_on === null || p.ends_on >= on)).at(-1) ?? null;
    const p = await activeProgramme(ctx, member.id);
    if (!p) return { member: member.name, programming_mode: member.programming_mode, programme: null, templates: [], swaps: [], phases: allPhases, current_phase: current };
    const templates = await all<{ id: number; name: string; session_type: string }>(ctx.db, "SELECT id, name, session_type FROM session_template WHERE programme_id = ? ORDER BY id", p.id);
    const slots = await all<{ template_id: number; weekday: number | null; rotation_position: number | null }>(ctx.db, "SELECT * FROM schedule_slot WHERE programme_id = ?", p.id);
    const prescriptions = await all<PrescriptionView>(
      ctx.db,
      "SELECT v.* FROM v_prescription v JOIN session_template t ON t.id = v.template_id WHERE t.programme_id = ? ORDER BY v.template_id, v.position",
      p.id,
    );
    const impls = await loadImplements(ctx, { ids: [...new Set(prescriptions.map((x) => x.current_load_implement_id).filter((x): x is number => x !== null))] });
    // Each prescription's load changes, newest first, with the reason the change was made (ticket 76): one read
    // for the whole programme, looked up in memory (decision 96).
    const loadChanges = await all<{ prescription_id: number; changed_on: string; load_value: number; load_unit: string; load_basis: string; load_implement_id: number | null; reason: string }>(
      ctx.db,
      `SELECT lc.prescription_id, lc.changed_on, lc.load_value, lc.load_unit, lc.load_basis, lc.load_implement_id, lc.reason
       FROM load_change lc JOIN prescription pr ON pr.id = lc.prescription_id
       JOIN session_template t ON t.id = pr.template_id WHERE t.programme_id = ? ORDER BY lc.changed_on DESC, lc.id DESC`,
      p.id,
    );
    const out = [];
    for (const t of templates) {
      const mine = [];
      for (const x of prescriptions.filter((y) => y.template_id === t.id)) {
        const fallbacks = await all<{ name: string; rank: number }>(
          ctx.db,
          "SELECT e.name, f.rank FROM prescription_fallback f JOIN exercise e ON e.id = f.exercise_id WHERE f.prescription_id = ? ORDER BY f.rank",
          x.id,
        );
        mine.push({
          id: x.id, position: x.position, exercise: x.exercise_name, sets: x.sets, target: targetOf(x), rep_low: x.rep_low, rep_high: x.rep_high,
          rir_target: rirTargetOf(x), rest_s: x.rest_s,
          current_load: x.current_load_value === null ? null : {
            ...prescribedLoad(x),
            implement: impls.find((i) => i.id === x.current_load_implement_id)?.name ?? null, since: x.load_changed_on,
          },
          load_history: loadChanges.filter((lc) => lc.prescription_id === x.id).map((lc) => ({
            date: lc.changed_on,
            load: { value: lc.load_value, unit: lc.load_unit, basis: lc.load_basis, implement: impls.find((i) => i.id === lc.load_implement_id)?.name ?? null },
            reason: lc.reason,
          })),
          progression_rule: ruleShown(parseRule(x.progression_rule), own), cue: own ? x.cue : null, fallback_note: own ? x.fallback_note : null,
          fallbacks: fallbacks.map((f) => f.name),
        });
      }
      const s = slots.filter((y) => y.template_id === t.id);
      out.push({
        id: t.id, name: t.name, session_type: t.session_type,
        weekdays: s.filter((y) => y.weekday !== null).map((y) => WEEKDAYS[(y.weekday as number) % 7]),
        rotation_positions: s.filter((y) => y.rotation_position !== null).map((y) => y.rotation_position),
        prescriptions: mine,
      });
    }
    const swaps = await all<Row & { reason: string | null }>(
      ctx.db,
      "SELECT w.on_date AS date, t.name AS template, w.reason FROM schedule_swap w LEFT JOIN session_template t ON t.id = w.template_id WHERE w.programme_id = ? AND w.on_date >= ? ORDER BY w.on_date",
      p.id,
      on,
    );
    return {
      member: member.name, programming_mode: member.programming_mode, programme: p, templates: out,
      // A swap's reason is still its member's alone (decision 167); the training notes are household data now.
      swaps: own ? swaps : swaps.map((w) => ({ ...w, reason: null })), phases: allPhases, current_phase: current,
    };
  },
});

const CHANGE = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("load_change"),
      prescription_id: z.number().int().positive(),
      date,
      load: z
        .object({
          ...PROGRAMME_LOAD,
          implement: z.number().int().positive().optional().describe("Default: the prescription's current implement."),
        })
        .strict(),
      reason: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("swap"), date, template: z.string().nullable().describe("null = no session that day."), reason: z.string().min(1) }).strict(),
]);

const programmeChange = writeTool({
  name: "programme_change",
  group: GROUP,
  description:
    "Change a member's active programme with a load change on a prescription (with its reason; the load must be producible on the implement), or a one-off swap on a weekday plan. Use upsert_phase for cross-domain strategy phases. Confirmed on write. Only the member or the agent changes it.",
  input: { member: z.string().min(1), change: CHANGE },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    // A programme is its member's to change, as amend decides (decision 138): another member is refused.
    ctx.assertCanSee("prescription", member.id);
    ctx.onBehalfOf(member.id);
    const tx = ctx.txOrThrow;
    const change = input.change;
    if (change.kind === "load_change") {
      const p = await prescriptionById(ctx, change.prescription_id);
      if (p.member_id !== member.id) throw new ToolError("not_members", `prescription ${p.id} is not ${member.name}'s`, 400);
      const implementId = change.load.implement ?? p.current_load_implement_id;
      const [impl] = implementId ? await loadImplements(ctx, { ids: [implementId] }) : [];
      // A value as given, or a composition (a bar and plates per side, units mixed) as log_set takes.
      const load = programmeLoad(change.load, impl ?? null, ["change", "load"]);
      let unverified = false;
      if (impl) {
        const snap = snapToImplement(load.value, load.unit, domainImplement(impl, { unit: impl.unit }), load.plates ?? undefined);
        // Above what the gym is known to have, the load may exist: it moves, marked unverified (check it exists).
        if (snap.status === "off_list" && snap.mayExist) unverified = true;
        else if (snap.status === "off_list") {
          const options = [snap.below, snap.above].filter((x) => x !== null).map((x) => `${x.value} ${x.unit}`);
          const said = load.plates ? load.plates.map((x) => `${x.count > 1 ? `${x.count} × ` : ""}${x.value} ${x.unit}`).join(" + ") + " a side" : `${load.value} ${load.unit}`;
          throw new Clarify("load_not_producible", `${impl.name} can't produce ${said}. Which load?`, options, ["change", "load", load.plates ? "plates" : "value"], {
            offer: impl.plates
              ? { tool: "record_plates", gym_id: impl.gym_id }
              : { tool: "add_implement_load", implement_id: impl.id, loads: [{ value: snap.value, unit: snap.unit }] },
          });
        }
      }
      const row = { prescription_id: p.id, changed_on: change.date, ...programmeLoadColumns(load), load_implement_id: impl?.id ?? null, reason: change.reason };
      const id = await tx.create("load_change", row);
      return {
        load_change: {
          id, prescription_id: p.id, exercise: p.exercise_name, date: change.date, reason: change.reason,
          previous: prescribedLoad(p),
          current: { value: load.value, unit: load.unit, basis: load.basis, bar: load.bar, plates: load.plates },
          unverified,
        },
      };
    }
    const p = await activeProgramme(ctx, member.id);
    if (!p) throw new ToolError("no_programme", `${member.name} has no active programme`, 400);
    if (p.schedule_kind !== "weekday") throw new Clarify("rotation_has_no_days", "A rotation has no calendar days to swap; what should change?", [], ["change"]);
    let templateId: number | null = null;
    if (change.template !== null) {
      const t = await first<{ id: number }>(ctx.db, "SELECT id FROM session_template WHERE programme_id = ? AND name = ? COLLATE NOCASE", p.id, change.template);
      if (!t) {
        const names = await all<{ name: string }>(ctx.db, "SELECT name FROM session_template WHERE programme_id = ?", p.id);
        throw new Clarify("unknown_template", `There is no session ${change.template}.`, names.map((n) => n.name), ["change", "template"]);
      }
      templateId = t.id;
    }
    const existing = await first<Row & { id: number }>(ctx.db, "SELECT * FROM schedule_swap WHERE programme_id = ? AND on_date = ?", p.id, change.date);
    const data = { programme_id: p.id, on_date: change.date, template_id: templateId, reason: change.reason };
    const id = existing ? existing.id : await tx.create("schedule_swap", data);
    if (existing) tx.update("schedule_swap", existing.id, data, { ...existing, ...data });
    return { swap: { id, date: change.date, template: change.template, reason: change.reason } };
  },
});

const createProgramme = writeTool({
  name: "create_programme",
  group: GROUP,
  description:
    "Create a member's first active programme from a conversation: named session templates, ordered prescriptions, and either unique weekday slots or contiguous rotation positions. The complete graph is validated and written atomically. Only the member or their agent can create it; record-only members do not store programmes. Needs a change reason and returns the canonical created graph.",
  input: {
    ...PROGRAMME_INPUT,
    active: z.literal(true).optional().describe("Public programmes are active; omit this or pass true."),
    change_reason: z.string().trim().min(1).max(1_000).describe("Why this programme is being created; preserved in audit history."),
  },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    ctx.assertCanSee("prescription", member.id);
    const programme = await createProgrammeGraph(ctx, input);
    return { programme };
  },
});

interface ProgrammeRecord extends Row {
  id: number;
  member_id: number;
  name: string;
  schedule_kind: "weekday" | "rotation";
  active: number;
  started_on: string;
  ended_on: string | null;
  archived_at: string | null;
  archived_reason: string | null;
}

async function cloneProgrammeInput(ctx: Ctx, memberName: string, predecessor: ProgrammeRecord, effectiveOn: string): Promise<{
  input: ProgrammeInput;
}> {
  const templates = await all<{ id: number; name: string; session_type: "strength" | "cardio" | "class" }>(
    ctx.db,
    "SELECT id, name, session_type FROM session_template WHERE programme_id = ? ORDER BY id",
    predecessor.id,
  );
  const slots = await all<{ template_id: number; weekday: number | null; rotation_position: number | null }>(
    ctx.db,
    "SELECT template_id, weekday, rotation_position FROM schedule_slot WHERE programme_id = ? ORDER BY coalesce(weekday, rotation_position)",
    predecessor.id,
  );
  const prescriptions = await all<PrescriptionView>(
    ctx.db,
    "SELECT v.* FROM v_prescription v JOIN session_template t ON t.id = v.template_id WHERE t.programme_id = ? ORDER BY v.template_id, v.position",
    predecessor.id,
  );
  const fallbackRows = await all<{ template_name: string; position: number; exercise_id: number; rank: number; note: string | null; name: string }>(
    ctx.db,
    `SELECT t.name AS template_name, p.position, f.exercise_id, f.rank, f.note, e.name
       FROM prescription_fallback f
       JOIN prescription p ON p.id = f.prescription_id
       JOIN session_template t ON t.id = p.template_id
       JOIN exercise e ON e.id = f.exercise_id
      WHERE t.programme_id = ?
      ORDER BY t.id, p.position, f.rank`,
    predecessor.id,
  );
  const fallbacks = new Map<string, { exercise_id: number; rank: number; note: string | null; name: string }[]>();
  for (const fallback of fallbackRows) {
    const key = `${fallback.template_name.toLowerCase()}:${fallback.position}`;
    fallbacks.set(key, [...(fallbacks.get(key) ?? []), {
      exercise_id: fallback.exercise_id, rank: fallback.rank, note: fallback.note, name: fallback.name,
    }]);
  }
  return {
    input: {
      member: memberName,
      name: predecessor.name,
      schedule_kind: predecessor.schedule_kind,
      started_on: effectiveOn,
      active: true,
      templates: templates.map((template) => ({
        name: template.name,
        session_type: template.session_type,
        prescriptions: prescriptions.filter((p) => p.template_id === template.id).map((p) => {
          const load = prescribedLoad(p);
          return {
            exercise: p.exercise_name,
            target: p.target_kind === "duration"
              ? { kind: "duration" as const, ...(p.duration_low_s === null ? {} : { low_s: p.duration_low_s }), ...(p.duration_high_s === null ? {} : { high_s: p.duration_high_s }) }
              : p.target_kind === "distance"
                ? { kind: "distance" as const, value: p.distance_value!, unit: p.distance_unit! }
                : { kind: "reps" as const },
            sets: p.sets ?? undefined,
            rep_low: p.rep_low ?? undefined,
            rep_high: p.rep_high ?? undefined,
            rir_target_low: p.rir_target_low ?? undefined,
            rir_target_high: p.rir_target_high ?? undefined,
            rest_s: p.rest_s ?? undefined,
            load: load === null ? undefined : {
              value: load.value,
              unit: load.unit,
              basis: load.basis as "total" | "per_side" | "per_hand" | "per_leg",
              bar: load.bar ?? undefined,
              plates: load.plates ?? undefined,
              implement: p.current_load_implement_id ?? undefined,
            },
            progression_rule: p.progression_rule === null ? undefined : PROGRAMME_RULE.parse(parseRule(p.progression_rule)),
            cue: p.cue ?? undefined,
            fallback_note: p.fallback_note ?? undefined,
            fallbacks: (fallbacks.get(`${template.name.toLowerCase()}:${p.position}`) ?? []).map((fallback) => ({
              exercise: fallback.name,
              ...(fallback.note === null ? {} : { note: fallback.note }),
            })),
          };
        }),
      })),
      slots: slots.map((slot) => ({
        ...(slot.weekday === null ? { rotation_position: slot.rotation_position! } : { weekday: slot.weekday }),
        template: templates.find((template) => template.id === slot.template_id)!.name,
      })),
    },
  };
}

async function futureSwapsForClone(ctx: Ctx, programmeId: number, effectiveOn: string) {
  const swaps = await all<{ on_date: string; template: string | null; reason: string }>(
    ctx.db,
    `SELECT w.on_date, t.name AS template, w.reason
       FROM schedule_swap w
       LEFT JOIN session_template t ON t.id = w.template_id
      WHERE w.programme_id = ? AND w.on_date >= ?
      ORDER BY w.on_date
      LIMIT ?`,
    programmeId,
    effectiveOn,
    MAX_FUTURE_SWAPS_TO_CLONE + 1,
  );
  if (swaps.length > MAX_FUTURE_SWAPS_TO_CLONE) {
    throw new Clarify(
      "programme_future_swaps_too_many",
      `This programme has more than ${MAX_FUTURE_SWAPS_TO_CLONE} future one-off swaps. Settle or remove older plans before cloning it.`,
      [`Keep at most ${MAX_FUTURE_SWAPS_TO_CLONE} future swaps`],
      ["programme_id"],
    );
  }
  return swaps;
}

const updateProgramme = writeTool({
  name: "update_programme",
  group: GROUP,
  description:
    "Revise an active programme immediately without rewriting history. A rename-only revision clones the current templates, current loads, progression rules, cues, fallbacks and future swaps. A structural revision supplies the complete replacement templates and schedule, and must retain templates referenced by future swaps. The predecessor is ended and the successor becomes active. Refused for draft or future-dated predecessor sessions. Only the member or their agent can revise it; record-only members are refused.",
  input: {
    member: PROGRAMME_INPUT.member,
    programme_id: z.number().int().positive().optional().describe("Optional guard: must be the member's active programme."),
    effective_on: date,
    change_reason: z.string().trim().min(1).max(1_000),
    name: PROGRAMME_INPUT.name.optional(),
    schedule_kind: PROGRAMME_INPUT.schedule_kind.optional(),
    templates: PROGRAMME_INPUT.templates.optional(),
    slots: PROGRAMME_INPUT.slots.optional(),
  },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    ctx.assertCanSee("prescription", member.id);
    ctx.onBehalfOf(member.id);
    if (member.programming_mode === "record_only") {
      throw new Clarify("record_only_member", `${member.name} is record-only: a trainer owns the programme, so the tracker holds none.`, [], ["member"]);
    }
    const predecessor = await first<ProgrammeRecord>(ctx.db, "SELECT * FROM programme WHERE member_id = ? AND active = 1", member.id);
    if (!predecessor) throw new Clarify("no_programme", `${member.name} has no active programme to revise.`, [], ["member"]);
    if (input.programme_id !== undefined && input.programme_id !== predecessor.id) {
      throw new Clarify("programme_selector", `Programme ${input.programme_id} is not ${member.name}'s active programme.`, [String(predecessor.id)], ["programme_id"]);
    }
    if (input.effective_on !== ctx.today()) {
      throw new Clarify("programme_revision_is_immediate", `A programme revision takes effect today (${ctx.today()}); future scheduling is not supported yet.`, [ctx.today()], ["effective_on"]);
    }
    const structuralParts = [input.schedule_kind, input.templates, input.slots].filter((value) => value !== undefined).length;
    if (structuralParts !== 0 && structuralParts !== 3) {
      throw new Clarify("complete_programme_structure", "A structural revision needs schedule_kind, templates and slots together.", [], ["templates"]);
    }
    if (structuralParts === 0 && input.name === undefined) {
      throw new Clarify("programme_change_needed", "What should change in this programme?", ["name", "complete structure"], ["name"]);
    }
    const open = await first<{ id: number }>(
      ctx.db,
      `SELECT s.id FROM session s
        JOIN session_template t ON t.id = s.template_id
       WHERE t.programme_id = ? AND s.state = 'draft'
       LIMIT 1`,
      predecessor.id,
    );
    if (open) {
      throw new Clarify("open_programme_session", `Finish or reject session ${open.id} before revising this programme.`, [String(open.id)], ["programme_id"]);
    }
    const futureSession = await first<{ id: number; performed_on: string }>(
      ctx.db,
      `SELECT s.id, s.performed_on FROM session s
        JOIN session_template t ON t.id = s.template_id
       WHERE t.programme_id = ? AND s.performed_on > ?
       ORDER BY s.performed_on, s.id
       LIMIT 1`,
      predecessor.id,
      input.effective_on,
    );
    if (futureSession) {
      throw new Clarify(
        "future_programme_session",
        `Session ${futureSession.id} is already recorded for ${futureSession.performed_on}; move or remove it before revising the programme.`,
        [futureSession.performed_on],
        ["effective_on"],
      );
    }
    const futureSwaps = await futureSwapsForClone(ctx, predecessor.id, input.effective_on);
    if (structuralParts === 3) {
      if (input.schedule_kind === "rotation" && futureSwaps.length > 0) {
        throw new Clarify(
          "programme_swaps_need_mapping",
          "A rotation programme cannot use dated swaps. Remove or settle the future swaps before changing this programme to a rotation.",
          futureSwaps.map((swap) => `${swap.on_date}: ${swap.template ?? "rest"}`),
          ["schedule_kind"],
        );
      }
      const replacementNames = new Set(input.templates!.map((template) => template.name.trim().toLowerCase()));
      const removed = futureSwaps.filter((swap) => swap.template !== null && !replacementNames.has(swap.template.toLowerCase()));
      if (removed.length > 0) {
        throw new Clarify(
          "programme_swaps_need_mapping",
          `Future swaps refer to removed templates: ${removed.map((swap) => `${swap.on_date} — ${swap.template}`).join(", ")}. Keep or rename those templates, or remove the swaps first.`,
          removed.map((swap) => `${swap.on_date}: ${swap.template}`),
          ["templates"],
        );
      }
    }
    const cloned = await cloneProgrammeInput(ctx, member.name, predecessor, input.effective_on);
    const replacement: ProgrammeInput = structuralParts === 3
      ? {
        member: member.name,
        name: input.name ?? predecessor.name,
        schedule_kind: input.schedule_kind!,
        started_on: input.effective_on,
        active: true,
        templates: input.templates!,
        slots: input.slots!,
      }
      : { ...cloned.input, name: input.name ?? predecessor.name };
    const programme = await createProgrammeGraph(ctx, replacement, {
      predecessor,
      effectiveOn: input.effective_on,
      changeReason: input.change_reason,
      futureSwaps,
    });
    return {
      programme,
      revision: {
        predecessor_id: predecessor.id,
        effective_on: input.effective_on,
        change_reason: input.change_reason,
        historical_sessions_changed: 0,
      },
    };
  },
});

async function assertProgrammeHasNoBlockingSessions(ctx: Ctx, programmeId: number, effectiveOn: string): Promise<void> {
  const draft = await first<{ id: number }>(
    ctx.db,
    `SELECT s.id FROM session s
      JOIN session_template t ON t.id = s.template_id
     WHERE t.programme_id = ? AND s.state = 'draft'
     LIMIT 1`,
    programmeId,
  );
  if (draft) throw new Clarify("open_programme_session", `Finish or reject session ${draft.id} before changing this programme.`, [String(draft.id)], ["programme_id"]);
  const future = await first<{ id: number; performed_on: string }>(
    ctx.db,
    `SELECT s.id, s.performed_on FROM session s
      JOIN session_template t ON t.id = s.template_id
     WHERE t.programme_id = ? AND s.performed_on > ?
     ORDER BY s.performed_on, s.id
     LIMIT 1`,
    programmeId,
    effectiveOn,
  );
  if (future) {
    throw new Clarify(
      "future_programme_session",
      `Session ${future.id} is already recorded for ${future.performed_on}; move or remove it before changing the programme.`,
      [future.performed_on],
      ["effective_on"],
    );
  }
}

const setProgrammeArchived = writeTool({
  name: "set_programme_archived",
  group: GROUP,
  description:
    "Archive an active programme today without deleting its templates, prescriptions or historical sessions. Restoring an archived programme creates a new active successor with new IDs, cloning its rules, loads, cues, fallbacks and applicable future swaps; it never reactivates the old graph. Only the member or their agent can do this, and record-only members are refused.",
  input: {
    member: z.string().trim().min(1).max(200),
    programme_id: z.number().int().positive().optional(),
    archived: z.boolean(),
    effective_on: date,
    change_reason: z.string().trim().min(1).max(1_000),
  },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    ctx.assertCanSee("prescription", member.id);
    ctx.onBehalfOf(member.id);
    if (member.programming_mode === "record_only") {
      throw new Clarify("record_only_member", `${member.name} is record-only: a trainer owns the programme, so the tracker holds none.`, [], ["member"]);
    }
    if (input.effective_on !== ctx.today()) {
      throw new Clarify("programme_archive_is_immediate", `This change takes effect today (${ctx.today()}); future scheduling is not supported yet.`, [ctx.today()], ["effective_on"]);
    }

    if (input.archived) {
      if (input.programme_id !== undefined) {
        const selected = await first<ProgrammeRecord>(ctx.db, "SELECT * FROM programme WHERE id = ? AND member_id = ?", input.programme_id, member.id);
        if (selected?.archived_at !== null && selected?.archived_at !== undefined) {
          return { action: "unchanged", programme: { ...selected, active: false } };
        }
      }
      const active = await first<ProgrammeRecord>(ctx.db, "SELECT * FROM programme WHERE member_id = ? AND active = 1", member.id);
      if (!active) throw new Clarify("no_programme", `${member.name} has no active programme to archive.`, [], ["member"]);
      if (input.programme_id !== undefined && input.programme_id !== active.id) {
        throw new Clarify("programme_selector", `Programme ${input.programme_id} is not ${member.name}'s active programme.`, [String(active.id)], ["programme_id"]);
      }
      if (active.started_on > input.effective_on) {
        throw new Clarify("future_programme", `Programme ${active.id} starts on ${active.started_on}; it cannot be retired before it starts.`, [active.started_on], ["effective_on"]);
      }
      await assertProgrammeHasNoBlockingSessions(ctx, active.id, input.effective_on);
      const changes = {
        active: 0,
        ended_on: input.effective_on,
        archived_at: ctx.nowIso(),
        archived_reason: input.change_reason,
      };
      ctx.txOrThrow.update("programme", active.id, changes, { ...active, ...changes });
      return { action: "archived", programme: { id: active.id, name: active.name, active: false, ended_on: input.effective_on, archived_at: changes.archived_at, archived_reason: changes.archived_reason } };
    }

    if (await first(ctx.db, "SELECT id FROM programme WHERE member_id = ? AND active = 1", member.id)) {
      throw new Clarify("programme_exists", `${member.name} already has an active programme. Archive it before restoring another.`, [], ["member"]);
    }
    const archived = input.programme_id === undefined
      ? await first<ProgrammeRecord>(ctx.db, "SELECT * FROM programme WHERE member_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC, id DESC LIMIT 1", member.id)
      : await first<ProgrammeRecord>(ctx.db, "SELECT * FROM programme WHERE id = ? AND member_id = ? AND archived_at IS NOT NULL", input.programme_id, member.id);
    if (!archived) throw new Clarify("archived_programme_not_found", `Which archived programme should be restored?`, [], ["programme_id"]);
    if (await first(ctx.db, "SELECT id FROM programme WHERE supersedes_programme_id = ?", archived.id)) {
      throw new Clarify("programme_already_restored", `Programme ${archived.id} already has a successor. Restore or revise that newer programme instead.`, [], ["programme_id"]);
    }
    await assertProgrammeHasNoBlockingSessions(ctx, archived.id, input.effective_on);
    const futureSwaps = await futureSwapsForClone(ctx, archived.id, input.effective_on);
    const cloned = await cloneProgrammeInput(ctx, member.name, archived, input.effective_on);
    const successor = await createProgrammeGraph(ctx, cloned.input, {
      predecessor: archived,
      effectiveOn: input.effective_on,
      changeReason: input.change_reason,
      futureSwaps,
      retirePredecessor: false,
    });
    return { action: "restored_as_successor", programme: successor, restored_from: archived.id, change_reason: input.change_reason };
  },
});

const PHASE_FIELDS = {
  name: z.string().trim().min(1).max(200),
  starts_on: date,
  ends_on: date.nullable(),
  energy_stance: z.enum(["deficit", "maintenance", "surplus"]),
  intent: z.string().trim().min(1).max(2_000),
};

interface PhaseRecord extends Row {
  id: number;
  member_id: number;
  name: string;
  starts_on: string;
  ends_on: string | null;
  energy_stance: "deficit" | "maintenance" | "surplus";
  intent: string;
  archived_at: string | null;
  archived_reason: string | null;
}

const PHASE_SELECTOR = z.union([
  z.number().int().positive(),
  z.string().trim().min(1).max(200),
]);

async function selectedPhase(ctx: Ctx, memberId: number, selector: number | string): Promise<PhaseRecord | null> {
  if (typeof selector === "number") return first<PhaseRecord>(ctx.db, "SELECT * FROM phase WHERE id = ? AND member_id = ?", selector, memberId);
  const matches = await all<PhaseRecord>(ctx.db, "SELECT * FROM phase WHERE member_id = ? AND name = ? COLLATE NOCASE ORDER BY starts_on DESC, id DESC LIMIT 2", memberId, selector);
  if (matches.length > 1) throw new Clarify("phase_selector", `More than one phase is called ${selector}; use its ID.`, matches.map((phase) => String(phase.id)), ["phase"]);
  return matches[0] ?? null;
}

async function overlappingPhase(ctx: Ctx, memberId: number, startsOn: string, endsOn: string | null, exceptId?: number) {
  return first<{ id: number; name: string }>(
    ctx.db,
    `SELECT id, name FROM phase
      WHERE member_id = ? AND archived_at IS NULL
        AND starts_on <= coalesce(?, '9999-12-31')
        AND coalesce(ends_on, '9999-12-31') >= ?
        AND (? IS NULL OR id <> ?)
      ORDER BY starts_on LIMIT 1`,
    memberId,
    endsOn,
    startsOn,
    exceptId ?? null,
    exceptId ?? null,
  );
}

const upsertPhase = writeTool({
  name: "upsert_phase",
  group: GROUP,
  description:
    "Create or fully update one live strategy phase spanning nutrition and training. Supply all semantic fields and a reason. Live phase date ranges may touch only on adjacent dates and never overlap. Updating preserves the phase ID and is written atomically. Only the member or their agent can do this; record-only programming does not restrict phases.",
  input: {
    member: z.string().trim().min(1).max(200),
    phase: PHASE_SELECTOR.optional().describe("Existing phase ID or unambiguous name. Omit to create."),
    ...PHASE_FIELDS,
    change_reason: z.string().trim().min(1).max(1_000),
  },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    ctx.assertCanSee("phase", member.id);
    ctx.onBehalfOf(member.id);
    if (input.ends_on !== null && input.ends_on < input.starts_on) {
      throw new Clarify("phase_dates", "The phase ends before it starts.", [], ["ends_on"]);
    }
    let previous: PhaseRecord | null = null;
    if (input.phase !== undefined) {
      previous = await selectedPhase(ctx, member.id, input.phase);
      if (!previous) throw new Clarify("phase_not_found", `That is not one of ${member.name}'s phases.`, [], ["phase"]);
      if (previous.archived_at !== null) throw new Clarify("phase_archived", `Phase ${previous.name} is archived; restore it before updating it.`, [previous.name], ["phase"]);
    }
    const overlap = await overlappingPhase(ctx, member.id, input.starts_on, input.ends_on, previous?.id);
    if (overlap) {
      throw new Clarify("phase_overlap", `That overlaps ${overlap.name}; adjust one of the date ranges first.`, [overlap.name], ["starts_on"]);
    }
    const row = {
      member_id: member.id,
      name: input.name,
      starts_on: input.starts_on,
      ends_on: input.ends_on,
      energy_stance: input.energy_stance,
      intent: input.intent,
    };
    if (previous) {
      ctx.txOrThrow.update("phase", previous.id, row, { ...previous, ...row });
      return { action: "updated", phase: { id: previous.id, ...row }, change_reason: input.change_reason };
    }
    const id = await ctx.txOrThrow.create("phase", row);
    return { action: "created", phase: { id, ...row }, change_reason: input.change_reason };
  },
});

const setPhaseArchived = writeTool({
  name: "set_phase_archived",
  group: GROUP,
  description:
    "Archive a strategy phase without deleting it, or restore that same phase when its dates do not overlap another live phase. Normal programme reads exclude archived phases. Only the member or their agent can do this; record-only programming does not restrict phases. Requires a reason.",
  input: {
    member: z.string().trim().min(1).max(200),
    phase: PHASE_SELECTOR.describe("Phase ID or unambiguous name."),
    archived: z.boolean(),
    change_reason: z.string().trim().min(1).max(1_000),
  },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    ctx.assertCanSee("phase", member.id);
    ctx.onBehalfOf(member.id);
    const phase = await selectedPhase(ctx, member.id, input.phase);
    if (!phase) throw new Clarify("phase_not_found", `That is not one of ${member.name}'s phases.`, [], ["phase"]);
    const isArchived = phase.archived_at !== null;
    if (isArchived === input.archived) return { action: "unchanged", phase };
    if (!input.archived) {
      const overlap = await overlappingPhase(ctx, member.id, phase.starts_on, phase.ends_on, phase.id);
      if (overlap) throw new Clarify("phase_overlap", `Restoring ${phase.name} would overlap ${overlap.name}.`, [overlap.name], ["phase"]);
    }
    const changes = input.archived
      ? { archived_at: ctx.nowIso(), archived_reason: input.change_reason }
      : { archived_at: null, archived_reason: null };
    ctx.txOrThrow.update("phase", phase.id, changes, { ...phase, ...changes });
    return { action: input.archived ? "archived" : "restored", phase: { ...phase, ...changes }, change_reason: input.change_reason };
  },
});

export const PROGRAMME_TOOLS: Tool[] = [
  programme,
  createProgramme,
  updateProgramme,
  setProgrammeArchived,
  upsertPhase,
  setPhaseArchived,
  programmeChange,
];
