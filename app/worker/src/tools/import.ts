/**
 * Import-only tools: writes the one-time Sheets import needs where the API
 * has no path yet. They are Tools (zod-validated, run in one transaction,
 * write-logged) but are not in TOOLS, so the Worker never routes them.
 * Gyms and equipment are now routed (tools/equipment.ts), so the importer
 * calls those through the API's own tools.
 * See src/importing.ts.
 */
import { z } from "zod";
import { assertNotAnAlias, taken as wordTaken } from "../aliases";
import type { Ctx } from "../context";
import { all, first } from "../db";
import { Clarify, ToolError } from "../errors";
import { goalPointRow } from "../goals";
import { gymByRef } from "../training";
import type { Row } from "../db";
import { writeTool, type Tool } from "../tool";
import { IMPLEMENT_KINDS } from "./equipment";
import { createProgrammeGraph, PROGRAMME_INPUT, PROGRAMME_RULE } from "./programme-builder";

const GROUP = "import";
const date = z.iso.date();
const KINDS = IMPLEMENT_KINDS;

const createHousehold = writeTool({
  name: "create_household",
  group: GROUP,
  description: "Import only. Create the deployment's one household.",
  input: { name: z.string().min(1) },
  async run(ctx, input) {
    if (await first(ctx.db, "SELECT id FROM household LIMIT 1")) throw new ToolError("household_exists", "the household already exists", 409);
    const id = await ctx.txOrThrow.create("household", { name: input.name, created_at: ctx.nowIso() });
    return { household: { id, name: input.name } };
  },
});

async function householdId(ctx: Ctx): Promise<number> {
  const h = await first<{ id: number }>(ctx.db, "SELECT id FROM household ORDER BY id LIMIT 1");
  if (!h) throw new ToolError("no_household", "create the household first", 409);
  return h.id;
}

const createMember = writeTool({
  name: "create_member",
  group: GROUP,
  description: "Import only. Create a member of the household with their Access email and programming mode.",
  input: {
    name: z.string().min(1),
    email: z.email(),
    programming_mode: z.enum(["prescribed", "record_only"]),
    sex: z.enum(["female", "male"]).optional(),
    birth_date: date.optional(),
    week_anchor_date: date.optional(),
  },
  async run(ctx, input) {
    const hid = await householdId(ctx);
    const clash = await first<{ name: string }>(
      ctx.db,
      "SELECT name FROM member WHERE household_id = ? AND (name = ? COLLATE NOCASE OR email = ? COLLATE NOCASE)",
      hid,
      input.name,
      input.email,
    );
    if (clash) throw new Clarify("duplicate_member", `${clash.name} is already a member.`, [clash.name], ["name"]);
    const row = {
      household_id: hid, name: input.name, email: input.email, active: 1, programming_mode: input.programming_mode, sex: input.sex ?? null,
      birth_date: input.birth_date ?? null, week_anchor_date: input.week_anchor_date ?? null, created_at: ctx.nowIso(),
    };
    const id = await ctx.txOrThrow.create("member", row);
    return { member: { id, ...row } };
  },
});

const createExercise = writeTool({
  name: "create_exercise",
  group: GROUP,
  description: "Import only. Create a canonical exercise on a kind of implement, with the names people actually say as aliases.",
  input: {
    name: z.string().min(1),
    implement_kind: z.enum(KINDS),
    aliases: z.array(z.string().min(1)).optional(),
    bodyweight_dominant: z.boolean().optional().describe("Bodyweight is most of what moves, so its sets get no e1RM."),
    note: z.string().optional(),
  },
  async run(ctx, input) {
    const names = [input.name, ...(input.aliases ?? [])];
    for (const [i, n] of names.entries()) {
      const taken = await first<{ name: string }>(
        ctx.db,
        `SELECT e.name FROM exercise e WHERE e.household_id = ? AND (e.name = ?2 COLLATE NOCASE
           OR e.id IN (SELECT target_id FROM alias WHERE household_id = e.household_id AND kind = 'exercise' AND alias = ?2 COLLATE NOCASE))`,
        ctx.householdId,
        n.trim(),
      );
      if (taken || names.slice(0, i).some((m) => m.trim().toLowerCase() === n.trim().toLowerCase())) {
        throw new Clarify("duplicate_exercise", `"${n}" already names ${taken?.name ?? "this exercise"}.`, [taken?.name ?? n], i === 0 ? ["name"] : ["aliases", i - 1]);
      }
    }
    await assertNotAnAlias(ctx, input.name, ["name"]);
    // One meaning per word (spec §6): an alias can't be another thing's name or word.
    for (const [i, alias] of (input.aliases ?? []).entries()) {
      const hit = (await wordTaken(ctx, alias.trim()))[0];
      if (hit?.source === "name") {
        throw new Clarify("alias_is_a_name", `"${alias.trim()}" is the name of ${hit.label}, so it can't also name this exercise.`, [], ["aliases", i], { taken_by: { kind: hit.kind, id: hit.id, label: hit.label } });
      }
      if (hit) {
        throw new Clarify("alias_taken", `"${alias.trim()}" already means ${hit.label}. Forget that word first, or leave it out.`, [], ["aliases", i], {
          existing: { id: hit.id, kind: hit.kind, target_id: hit.target_id, label: hit.label },
        });
      }
    }
    const tx = ctx.txOrThrow;
    const id = await tx.create("exercise", { household_id: ctx.householdId, name: input.name.trim(), implement_kind: input.implement_kind, bodyweight_dominant: input.bodyweight_dominant ? 1 : 0, note: input.note ?? null });
    for (const alias of input.aliases ?? []) {
      await tx.create("alias", { household_id: ctx.householdId, alias: alias.trim(), kind: "exercise", target_id: id, created_by: null, created_at: ctx.nowIso() });
    }
    return { exercise: { id, name: input.name.trim(), implement_kind: input.implement_kind, aliases: input.aliases ?? [] } };
  },
});

/** A progression rule as stored (StoredRule in src/training.ts). */
export const RULE = PROGRAMME_RULE;

const createProgramme = writeTool({
  name: "create_programme",
  group: GROUP,
  description: "Import only. Create a member's programme: session templates with ordered prescriptions, and its schedule slots.",
  input: PROGRAMME_INPUT,
  async run(ctx, input) {
    const programme = await createProgrammeGraph(ctx, input);
    return {
      programme: {
        id: programme.id,
        member: programme.member,
        name: programme.name,
        templates: programme.templates.length,
        prescriptions: programme.templates.reduce((count, template) => count + template.prescriptions.length, 0),
        slots: programme.templates.reduce((count, template) => count + template.slots.length, 0),
      },
    };
  },
});

const createGoalPoint = writeTool({
  name: "create_goal_point",
  group: GROUP,
  description: "Import only. A dated target value on a member's trajectory, for a body metric or an exercise's e1RM.",
  input: {
    member: z.string().min(1),
    metric: z.string().min(1).optional(),
    exercise: z.string().min(1).optional(),
    week_of: date,
    tier: z.enum(["planned", "stretch"]),
    basis: z.enum(["absolute", "bodyweight_multiple"]),
    value_low: z.number(),
    value_high: z.number(),
    unit: z.string().min(1).optional(),
    headline: z.boolean().optional(),
    note: z.string().optional(),
  },
  async run(ctx, input) {
    const member = await ctx.member(input.member);
    ctx.onBehalfOf(member.id);
    const row = await goalPointRow(ctx, member, {
      metric: input.metric, exercise: input.exercise, week_of: input.week_of, tier: input.tier, basis: input.basis,
      low: input.value_low, high: input.value_high, unit: input.unit, headline: input.headline, note: input.note,
    });
    const id = await ctx.txOrThrow.create("goal_point", { ...row });
    return { goal_point: { id, ...row } };
  },
});

const addLegacyAudit = writeTool({
  name: "add_legacy_audit_entry",
  group: GROUP,
  description: "Import only. Keep one old Agent Audit row as history. A blank time is not recorded.",
  input: {
    source_file: z.enum(["base", "hritvik", "asha", "kabir"]),
    member: z.string().min(1).optional(),
    logged_on: date,
    logged_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
    agent: z.string().optional(),
    action: z.string().min(1),
    target: z.string().optional(),
    reason: z.string().optional(),
    prior_value: z.string().optional(),
    result: z.string().optional(),
  },
  async run(ctx, input) {
    const member = input.member === undefined ? null : await ctx.member(input.member);
    ctx.onBehalfOf(member?.id ?? null);
    const time = input.logged_time === undefined ? null : input.logged_time.length === 5 ? `${input.logged_time}:00` : input.logged_time;
    const row = {
      source_file: input.source_file, member_id: member?.id ?? null, logged_on: input.logged_on, logged_time: time, agent: input.agent ?? null,
      action: input.action, target: input.target ?? null, reason: input.reason ?? null, prior_value: input.prior_value ?? null, result: input.result ?? null,
    };
    const id = await ctx.txOrThrow.create("legacy_audit_entry", row);
    return { legacy_audit_entry: { id, ...row } };
  },
});

const createPlateSet = writeTool({
  name: "create_plate_set",
  group: GROUP,
  description:
    "Import only. A gym's plates of one unit: each denomination confirmed (named in the notes), inferred (read from loads lifted) or absent, and whether that is every denomination.",
  input: {
    gym: z.union([z.number().int().positive(), z.string().min(1)]),
    unit: z.enum(["kg", "lb"]),
    complete: z.boolean(),
    plates: z.array(z.object({ value: z.number().gt(0).lt(100), status: z.enum(["confirmed", "inferred", "absent"]) }).strict()),
    note: z.string().optional(),
  },
  async run(ctx, input) {
    const gym = await gymByRef(ctx, input.gym, ["gym"]);
    if (await first(ctx.db, "SELECT id FROM plate_set WHERE gym_id = ? AND unit = ?", gym.id, input.unit)) {
      throw new Clarify("duplicate_plate_set", `${gym.name} already has ${input.unit} plates.`, [], ["unit"]);
    }
    const tx = ctx.txOrThrow;
    const id = await tx.create("plate_set", { gym_id: gym.id, unit: input.unit, complete: input.complete ? 1 : 0, note: input.note ?? null });
    const plates = [...new Map(input.plates.map((p) => [p.value, p])).values()].sort((a, b) => a.value - b.value);
    for (const p of plates) await tx.create("plate", { plate_set_id: id, value: p.value, status: p.status });
    return { plate_set: { id, gym: gym.name, unit: input.unit, complete: input.complete, plates } };
  },
});

export const IMPORT_TOOLS: Tool[] = [createHousehold, createMember, createExercise, createProgramme, createGoalPoint, addLegacyAudit, createPlateSet];

