/**
 * A gym's equipment: adding a gym, adding a piece of kit with its loads, and
 * the load ladders members report ("5 to 100 lb in 5s"). The inventory is
 * facts only: which loads exist, which are known not to, a bar's own weight,
 * and whether the list is complete. How far a lift should move is a
 * prescription's progression rule, never a property of the machine.
 */
import { producibleLoads, toKg } from "@myfitnessguide/domain";
import { z } from "zod";
import { assertNotAnAlias } from "../aliases";
import type { Ctx } from "../context";
import { first, type Row } from "../db";
import { Clarify, ToolError } from "../errors";
import { domainImplement, gymByRef, loadImplements, platesLoaded, type ImplementRow } from "../training";
import { writeTool, type Tool } from "../tool";

export const GROUP = "training";

export const IMPLEMENT_KINDS = [
  "barbell", "dumbbell", "kettlebell", "machine", "plate_loaded", "cable",
  "fixed_bar", "plates", "bodyweight", "band", "cardio_machine", "other",
] as const;

/** A load in its own unit; a bare number is in the implement's unit. */
export const LOAD_ENTRY = z.union([z.number().gt(-1000).lt(1000), z.object({ value: z.number().gt(-1000).lt(1000), unit: z.enum(["kg", "lb"]) }).strict()]);

/**
 * A stated ladder: every step from `from` to `to`, in one unit. A member who
 * says "the stack goes 20 to 200 in 10s" has confirmed those loads, so a
 * range is stored as available, not inferred.
 */
export const RANGE = z
  .object({
    from: z.number().gt(-1000).lt(1000),
    to: z.number().gt(-1000).lt(1000),
    step: z.number().gt(0).lt(1000),
    unit: z.enum(["kg", "lb"]),
  })
  .strict();

/** One call expands at most this many stated loads, so a typo can't write a thousand rows. */
export const MAX_RANGE_LOADS = 60;

/** An implement as the API describes it: its loads (or plates), and whether it is retired. */
export function describeImplement(i: ImplementRow) {
  return {
    id: i.id, name: i.name, kind: i.kind, unit: i.unit, loading: i.loading, load_list_complete: i.load_list_complete === 1,
    bar: i.bar_value === null ? null : { value: i.bar_value, unit: i.bar_unit },
    // Plate-loaded kit makes its loads from the gym's plates; everything else lists them.
    loads: i.plates ? null : producibleLoads(domainImplement(i, { unit: i.unit })).map(({ value, unit }) => ({ value, unit })),
    absent: i.absent,
    plates: i.plates,
    archived: i.archived_at !== null,
    archived_at: i.archived_at,
    archived_reason: i.archived_reason,
    note: i.note ?? null,
  };
}

const round9 = (x: number): number => Math.round(x * 1e9) / 1e9;

/**
 * Every load a stated ladder names, in the order given, in its own unit.
 * The unit is trusted as stated: the member said "5 lb", so each rung is
 * 5 lb even where the value is also a round number in kg.
 */
export function expandRanges(ranges: readonly z.infer<typeof RANGE>[] | undefined, path: (string | number)[] = ["ranges"]) {
  const out: { value: number; unit: "kg" | "lb" }[] = [];
  for (const [i, r] of (ranges ?? []).entries()) {
    if (r.to < r.from) {
      throw new Clarify(
        "range_backwards",
        `The range runs from ${r.from} to ${r.to} ${r.unit}: it ends below where it starts. Which way does it run?`,
        [],
        [...path, i, "to"],
      );
    }
    const steps = Math.floor((r.to - r.from) / r.step + 1e-9) + 1;
    if (out.length + steps > MAX_RANGE_LOADS) {
      throw new Clarify(
        "range_too_large",
        `That is ${out.length + steps} loads; give at most ${MAX_RANGE_LOADS} at a time, or split the ladder into more ranges.`,
        [],
        [...path, i, "step"],
      );
    }
    for (let k = 0; k < steps; k++) {
      const value = round9(r.from + k * r.step);
      if (value > r.to + 1e-9) break;
      out.push({ value, unit: r.unit });
    }
  }
  return out;
}

/** A load as stored: its own unit, and its weight for ordering. */
export function weighedLoads(entries: readonly z.infer<typeof LOAD_ENTRY>[], unit: "kg" | "lb") {
  const seen = new Map<string, { value: number; unit: "kg" | "lb" }>();
  for (const e of entries) {
    const a = typeof e === "number" ? { value: e, unit } : e;
    seen.set(`${a.value} ${a.unit}`, a);
  }
  return [...seen.values()].sort((x, y) => toKg(x.value, x.unit) - toKg(y.value, y.unit));
}

const createGym = writeTool({
  name: "create_gym",
  group: GROUP,
  description:
    "Add a gym to the household, optionally as the home gym of the members named. A new gym has no inventory until its plates and equipment are recorded.",
  input: { name: z.string().min(1), home_of: z.array(z.string().min(1)).optional() },
  async run(ctx, input) {
    if (await first(ctx.db, "SELECT id FROM gym WHERE household_id = ? AND name = ? COLLATE NOCASE", ctx.householdId, input.name)) {
      throw new Clarify("duplicate_gym", `There is already a gym called ${input.name}.`, [input.name], ["name"]);
    }
    const tx = ctx.txOrThrow;
    const id = await tx.create("gym", { household_id: ctx.householdId, name: input.name });
    for (const [i, name] of (input.home_of ?? []).entries()) {
      const member = await ctx.member(name, ["home_of", i]);
      tx.update("member", member.id, { home_gym_id: id }, { ...member, home_gym_id: id });
    }
    return { gym: { id, name: input.name, home_of: input.home_of ?? [] } };
  },
});

const createImplement = writeTool({
  name: "create_implement",
  group: GROUP,
  description:
    "Add a piece of equipment to a gym's inventory with its producible loads: explicit values in their own units (a number is in the implement's unit; assistance is negative), stated ladders (`ranges`: 5 to 100 lb in 5s), loads known not to exist, its bar or sled weight, whether the list is complete (false: heavier loads may exist), and the prescriptions whose current load is on it. Barbells and plate-loaded machines may list no loads: theirs are combinations of the gym's plates.",
  input: {
    gym: z.union([z.number().int().positive(), z.string().min(1)]),
    name: z.string().min(1),
    kind: z.enum(IMPLEMENT_KINDS),
    unit: z.enum(["kg", "lb"]),
    loading: z.enum(["total", "per_side", "plates_only"]),
    loads: z.array(LOAD_ENTRY).optional(),
    ranges: z.array(RANGE).optional().describe("Stated ladders, each every step from `from` to `to`, in its own unit."),
    absent: z.array(LOAD_ENTRY).optional(),
    bar: z.object({ value: z.number().min(0).lt(1000), unit: z.enum(["kg", "lb"]) }).strict().optional(),
    load_list_complete: z.boolean().optional().describe("Default true."),
    note: z.string().optional(),
    link_prescriptions: z.array(z.number().int().positive()).optional(),
  },
  async run(ctx, input) {
    const gym = await gymByRef(ctx, input.gym, ["gym"]);
    if (await first(ctx.db, "SELECT id FROM implement WHERE gym_id = ? AND name = ? COLLATE NOCASE", gym.id, input.name)) {
      throw new Clarify("duplicate_implement", `${gym.name} already has an implement called ${input.name}.`, [input.name], ["name"]);
    }
    const tx = ctx.txOrThrow;
    const complete = input.load_list_complete ?? true;
    const plateLoaded = (input.kind === "barbell" || input.kind === "plate_loaded") && input.loading !== "total";
    const loads = weighedLoads([...(input.loads ?? []), ...expandRanges(input.ranges, ["ranges"])], input.unit);
    if (!plateLoaded && loads.length === 0) throw new Clarify("loads_needed", `Which loads does ${input.name} produce?`, [], ["loads"]);
    const absent = weighedLoads(input.absent ?? [], input.unit);
    const id = await tx.create("implement", {
      gym_id: gym.id, name: input.name, kind: input.kind, unit: input.unit, loading: input.loading, load_list_complete: complete ? 1 : 0, note: input.note ?? null,
      bar_value: input.bar?.value ?? null, bar_unit: input.bar?.unit ?? null,
    });
    for (const load of loads) await tx.create("implement_load", { implement_id: id, load: load.value, unit: load.unit, status: "available" });
    for (const load of absent) await tx.create("implement_load", { implement_id: id, load: load.value, unit: load.unit, status: "absent" });
    const linked: number[] = [];
    for (const [i, pid] of (input.link_prescriptions ?? []).entries()) {
      const p = await first<Row & { id: number; kind: string; home_gym_id: number | null; load_value: number | null }>(
        ctx.db,
        `SELECT p.*, e.implement_kind AS kind, m.home_gym_id FROM prescription p JOIN exercise e ON e.id = p.exercise_id
           JOIN session_template t ON t.id = p.template_id JOIN programme pr ON pr.id = t.programme_id JOIN member m ON m.id = pr.member_id
          WHERE p.id = ?`,
        pid,
      );
      if (!p) throw new ToolError("not_found", `no prescription ${pid}`, 404);
      if (p.home_gym_id !== gym.id) throw new Clarify("link_other_gym", `Prescription ${pid} belongs to a member who trains at another gym.`, [], ["link_prescriptions", i]);
      if (p.kind !== input.kind) throw new Clarify("link_kind_mismatch", `Prescription ${pid} is a ${p.kind} exercise; this implement is a ${input.kind}.`, [], ["link_prescriptions", i]);
      if (p.load_value === null) throw new Clarify("link_without_load", `Prescription ${pid} has no load to put on this implement.`, [], ["link_prescriptions", i]);
      const { kind: _kind, home_gym_id: _gym, ...row } = p;
      tx.update("prescription", pid, { load_implement_id: id }, { ...row, load_implement_id: id });
      linked.push(pid);
    }
    return {
      implement: {
        id, gym: gym.name, name: input.name, kind: input.kind, unit: input.unit, loading: input.loading, loads, absent, bar: input.bar ?? null,
        load_list_complete: complete, linked_prescriptions: linked,
      },
    };
  },
});

/** A piece of kit, only when it belongs to the caller's household. */
async function implementInHousehold(ctx: Ctx, id: number): Promise<ImplementRow> {
  const [impl] = await loadImplements(ctx, { ids: [id] });
  const gym = impl ? await first<{ household_id: number }>(ctx.db, "SELECT household_id FROM gym WHERE id = ?", impl.gym_id) : null;
  if (!impl || gym?.household_id !== ctx.householdId) throw new ToolError("not_found", `no implement ${id}`, 404);
  return impl;
}

/**
 * What a change would alter about a load already logged on the kit: whether
 * its loads come from plates, how a per-side load splits, or whether a sled
 * has a known weight. Renaming and notes are never a meaning change.
 */
function meaningChange(before: ImplementRow, after: Pick<ImplementRow, "kind" | "loading">): string | null {
  const reasons: string[] = [];
  if (platesLoaded(before) !== platesLoaded(after)) reasons.push("whether its loads are combinations of the gym's plates");
  if ((before.kind === "cable") !== (after.kind === "cable")) reasons.push("how a per-side load is split");
  if ((before.loading === "plates_only") !== (after.loading === "plates_only")) reasons.push("whether the sled's own weight is known");
  return reasons.length > 0 ? reasons.join("; ") : null;
}

const updateImplement = writeTool({
  name: "update_implement",
  group: GROUP,
  description:
    "Rename a piece of equipment, correct what it is (kind, loading), or change its note. A change that would alter what already-logged sets mean is refused: retire the piece and add the corrected one instead. Loads are changed with add_implement_load / remove_implement_load, and plates with record_plates.",
  input: {
    implement_id: z.number().int().positive(),
    name: z.string().min(1).optional(),
    kind: z.enum(IMPLEMENT_KINDS).optional(),
    loading: z.enum(["total", "per_side", "plates_only"]).optional(),
    note: z.string().nullable().optional(),
  },
  async run(ctx, input) {
    const impl = await implementInHousehold(ctx, input.implement_id);
    const changes: Partial<ImplementRow> = {};
    const name = input.name?.trim();
    if (name !== undefined && name !== impl.name) {
      if (name.toLowerCase() !== impl.name.toLowerCase()) {
        const clash = await first<{ id: number }>(
          ctx.db,
          "SELECT id FROM implement WHERE gym_id = ? AND name = ? COLLATE NOCASE AND id <> ?",
          impl.gym_id,
          name,
          impl.id,
        );
        if (clash) throw new Clarify("duplicate_implement", `${impl.name} is already the name of another piece at this gym.`, [], ["name"]);
        await assertNotAnAlias(ctx, name, ["name"]);
      }
      changes.name = name;
    }
    if (input.kind !== undefined && input.kind !== impl.kind) changes.kind = input.kind;
    if (input.loading !== undefined && input.loading !== impl.loading) changes.loading = input.loading;
    if (changes.kind !== undefined || changes.loading !== undefined) {
      const why = meaningChange(impl, { kind: changes.kind ?? impl.kind, loading: changes.loading ?? impl.loading });
      if (why) {
        const sets = (await first<{ n: number }>(ctx.db, "SELECT count(*) AS n FROM session_set WHERE load_implement_id = ?", impl.id))?.n ?? 0;
        const prescriptions =
          (await first<{ n: number }>(ctx.db, "SELECT count(*) AS n FROM prescription WHERE load_implement_id = ?", impl.id))?.n ?? 0;
        if (sets + prescriptions > 0) {
          throw new Clarify(
            "reclassify_in_use",
            `${impl.name} has ${sets} logged set(s) and ${prescriptions} prescription(s) that read its loads; changing ${why} would change what they mean. Retire it with set_implement_archived and add the corrected piece, or move those loads first.`,
            [],
            [changes.kind !== undefined ? "kind" : "loading"],
          );
        }
      }
    }
    if (input.note !== undefined) changes.note = input.note;
    if (Object.keys(changes).length === 0) throw new ToolError("no_changes", "give at least one change", 400);
    ctx.txOrThrow.update("implement", impl.id, changes as Row, { ...impl, ...changes });
    return { implement: describeImplement({ ...impl, ...changes }) };
  },
});

const setImplementArchived = writeTool({
  name: "set_implement_archived",
  group: GROUP,
  description:
    "Reversibly retire a piece of equipment, or restore it. Retired kit keeps its loads, logged sets and prescriptions, and is left out of inventory and inventory_gaps. Use archived=true when the member says a machine was sold, moved or is out of service. Needs a change reason.",
  input: {
    implement_id: z.number().int().positive(),
    archived: z.boolean(),
    change_reason: z.string().trim().min(1).optional().describe("Why the member is retiring or restoring it."),
  },
  async run(ctx, input) {
    const impl = await implementInHousehold(ctx, input.implement_id);
    const current = impl.archived_at !== null;
    const changed = current !== input.archived;
    const why = (input.change_reason ?? input.reason)?.trim();
    if (changed && !why) throw new Clarify("reason_needed", "Why is this equipment being retired or restored?", [], ["change_reason"]);
    if (!changed) return { state: "confirmed", action: "unchanged", implement: describeImplement(impl) };
    const archived_at = input.archived ? ctx.nowIso() : null;
    const archived_reason = input.archived ? (why as string) : null;
    ctx.txOrThrow.update("implement", impl.id, { archived_at, archived_reason }, { ...impl, archived_at, archived_reason });
    return { state: "confirmed", action: input.archived ? "archived" : "restored", implement: describeImplement({ ...impl, archived_at, archived_reason }) };
  },
});

export const EQUIPMENT_TOOLS: Tool[] = [createGym, createImplement, updateImplement, setImplementArchived];
