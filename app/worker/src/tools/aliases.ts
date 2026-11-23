/**
 * Learning the household's words (spec §6): one meaning per word, never
 * taken silently, every change versioned with its reason.
 */
import { addDays, weekStart } from "@myfitnessguide/domain";
import { z } from "zod";
import { ALIAS_KINDS, TARGET_LABEL, taken, type AliasKind } from "../aliases";
import type { Ctx } from "../context";
import { all, first, type Row } from "../db";
import { Clarify, ToolError } from "../errors";
import { readTool, writeTool, type Tool } from "../tool";
import { ExerciseIndex } from "../training";
import { workoutByRef } from "../workouts";

const GROUP = "aliases";

function reasonNeeded(reason: string | undefined, question: string): void {
  if (!reason) throw new Clarify("reason_needed", question, [], ["reason"]);
}

interface Target {
  id: number;
  label: string;
}

/** The record a word will name: by id, ref, name (asking between a food's states) or, for exercises and workouts, an existing name or alias. */
async function resolveTarget(ctx: Ctx, kind: AliasKind, ref: number | string, path: (string | number)[]): Promise<Target> {
  const unknown = () => new Clarify("unknown_target", `There is no ${kind.replace("_", " ")} ${ref}.`, [], path);
  if (kind === "food_source") {
    const rows = await all<{ id: number; name: string; state: string; ref: string }>(
      ctx.db,
      "SELECT id, name, state, ref FROM food_source WHERE household_id = ?1 AND (id = ?2 OR ref = ?2 COLLATE NOCASE OR name = ?2 COLLATE NOCASE) ORDER BY id",
      ctx.householdId,
      typeof ref === "number" ? ref : ref.trim(),
    );
    if (rows.length > 1) throw new Clarify("target_ambiguous", `Which ${rows[0]?.name}?`, rows.map((r) => `${r.ref} (${r.state})`), path);
    const r = rows[0];
    if (!r) throw unknown();
    return { id: r.id, label: `${r.name} (${r.state}, ${r.ref})` };
  }
  if (kind === "recipe") {
    const r = await first<{ id: number; name: string; ref: string }>(
      ctx.db,
      "SELECT id, name, ref FROM recipe WHERE household_id = ?1 AND (id = ?2 OR ref = ?2 COLLATE NOCASE OR name = ?2 COLLATE NOCASE)",
      ctx.householdId,
      typeof ref === "number" ? ref : ref.trim(),
    );
    if (!r) throw unknown();
    return { id: r.id, label: `${r.name} (${r.ref})` };
  }
  if (kind === "exercise") {
    const index = await ExerciseIndex.load(ctx);
    const e = typeof ref === "number" ? (index.entries.find((x) => x.id === ref) ?? null) : index.lookup(ref);
    if (!e) throw unknown();
    return { id: e.id, label: e.name };
  }
  if (kind === "implement") {
    const rows = await all<{ id: number; name: string; gym: string }>(
      ctx.db,
      `SELECT i.id, i.name, g.name AS gym FROM implement i JOIN gym g ON g.id = i.gym_id
       WHERE g.household_id = ?1 AND (i.id = ?2 OR i.name = ?2 COLLATE NOCASE) ORDER BY i.id`,
      ctx.householdId,
      typeof ref === "number" ? ref : ref.trim(),
    );
    if (rows.length > 1) throw new Clarify("target_ambiguous", `Which ${rows[0]?.name}?`, rows.map((r) => `${r.name} (${r.gym})`), path);
    const r = rows[0];
    if (!r) throw unknown();
    return { id: r.id, label: `${r.name} (${r.gym})` };
  }
  const w = await workoutByRef(ctx, ref, path);
  return { id: w.id, label: w.name };
}

/** The router's measure covers the last 26 weeks: from the Sunday 25 weeks before this week's (the domain's weekStart). */
export function routerSince(today: string): string {
  return addDays(weekStart(today), -25 * 7);
}

const learnAlias = writeTool({
  name: "learn_alias",
  group: GROUP,
  description:
    "Teach the household a word for a food source, recipe, exercise or workout, with the reason. Every reader then knows it (catalogue_search, log_intake, household_meal, log_set, log_workout, route_text). A word means one thing: if it already means something else, this asks (replace, or keep the existing one) and only replace: true replaces it, as a versioned delete and insert. A word that is already a name is refused.",
  input: {
    alias: z.string().min(1).max(60),
    kind: z.enum(ALIAS_KINDS),
    target: z.union([z.number().int().positive(), z.string().min(1)]).describe("The food source's ref or name, the recipe's ref or name, the exercise's or workout's name, or the id."),
    replace: z.boolean().optional().describe("Answers alias_taken: replace the word's existing meaning."),
  },
  async run(ctx, input) {
    reasonNeeded(input.reason, "Why should this word mean that (for example, it's what the member calls it)?");
    // Internal whitespace collapses to one space, as the router reads words ("paneer  bhurji" is "paneer bhurji").
    const word = input.alias.trim().replace(/\s+/g, " ");
    const target = await resolveTarget(ctx, input.kind, input.target, ["target"]);
    const hits = await taken(ctx, word);
    const name = hits.find((h) => h.source === "name");
    if (name) {
      if (name.kind === input.kind && name.id === target.id) throw new Clarify("alias_is_the_name", `"${word}" is already ${target.label}'s name.`, [], ["alias"]);
      throw new Clarify("alias_is_a_name", `"${word}" is the name of ${name.label}, so it can't also mean ${target.label}.`, [], ["alias"], { taken_by: { kind: name.kind, id: name.id, label: name.label } });
    }
    const existing = hits.find((h) => h.source === "alias");
    // Implement names are not in `taken` (they have no alias kind of their own), so check them here.
    const implName = await first<{ id: number; name: string; gym: string }>(
      ctx.db,
      `SELECT i.id, i.name, g.name AS gym FROM implement i JOIN gym g ON g.id = i.gym_id
       WHERE g.household_id = ? AND i.name = ? COLLATE NOCASE`,
      ctx.householdId,
      word,
    );
    if (implName && !(input.kind === "implement" && implName.id === target.id)) {
      throw new Clarify(
        "alias_is_a_name",
        `"${word}" is the name of the implement ${implName.name} (${implName.gym}), so it can't also mean ${target.label}.`,
        [],
        ["alias"],
        { taken_by: { kind: "implement", id: implName.id, label: `${implName.name} (${implName.gym})` } },
      );
    }
    if (existing && existing.kind === input.kind && existing.target_id === target.id) {
      return { alias: { id: existing.id, alias: existing.word, kind: input.kind, target }, replaced: null, unchanged: true };
    }
    const tx = ctx.txOrThrow;
    let replaced: { id: number; kind: AliasKind; label: string } | null = null;
    if (existing) {
      if (!input.replace) {
        throw new Clarify("alias_taken", `"${word}" already means ${existing.label}. Replace it, or keep the existing one?`, ["replace", "keep"], ["replace"], {
          existing: { id: existing.id, kind: existing.kind, target_id: existing.target_id, label: existing.label },
        });
      }
      const row = (await first<Row & { id: number }>(ctx.db, "SELECT * FROM alias WHERE id = ?", existing.id)) as Row & { id: number };
      tx.remove("alias", existing.id, row, "delete");
      replaced = { id: existing.id, kind: existing.kind, label: existing.label };
    }
    const createdBy = ctx.caller.kind === "member" ? ctx.caller.memberId : (ctx.writeInfo.speaker?.id ?? null);
    const id = await tx.create("alias", { household_id: ctx.householdId, alias: word, kind: input.kind, target_id: target.id, created_by: createdBy, created_at: ctx.nowIso() });
    return { alias: { id, alias: word, kind: input.kind, target }, replaced, unchanged: false };
  },
});

const forgetAlias = writeTool({
  name: "forget_alias",
  group: GROUP,
  description: "Forget a learned word, with the reason: a versioned delete (its last content is kept in its history).",
  input: { id: z.number().int().positive() },
  async run(ctx, input) {
    reasonNeeded(input.reason, "Why forget this word?");
    const row = await first<Row & { id: number; alias: string; kind: string }>(ctx.db, "SELECT * FROM alias WHERE id = ? AND household_id = ?", input.id, ctx.householdId);
    if (!row) throw new ToolError("not_found", `no alias ${input.id}`, 404);
    ctx.txOrThrow.remove("alias", row.id, row, "delete");
    return { forgotten: { id: row.id, alias: row.alias, kind: row.kind } };
  },
});

const learned = readTool({
  name: "learned",
  group: GROUP,
  description:
    "Every word the household has taught (alias, kind, what it means, who taught it and when; member narrows to words that member taught), and the router's measure: per member per week, the pieces of free text saved unedited, edited, and sent to the Inbox, with the share saved unedited without Claude, for the last 26 weeks. Agent calls are not counted.",
  input: { member: z.string().min(1).optional() },
  async run(ctx, input) {
    const member = input.member !== undefined ? await ctx.member(input.member) : null;
    const memberId = member?.id ?? null;
    const aliases = await all<{ id: number; alias: string; kind: AliasKind; target_id: number; target: string; created_by: string | null; created_at: string }>(
      ctx.db,
      `SELECT a.id, a.alias, a.kind, a.target_id, ${TARGET_LABEL} AS target, m.name AS created_by, a.created_at
       FROM alias a LEFT JOIN member m ON m.id = a.created_by
       WHERE a.household_id = ?1 AND (?2 IS NULL OR a.created_by = ?2) ORDER BY a.created_at DESC, a.id DESC`,
      ctx.householdId,
      memberId,
    );
    const weeks = await all<{ member: string; week_of: string; unedited: number; edited: number; inbox: number }>(
      ctx.db,
      `SELECT m.name AS member, date(s.recorded_on, '-' || CAST(strftime('%w', s.recorded_on) AS INTEGER) || ' days') AS week_of,
              sum(s.unedited) AS unedited, sum(s.edited) AS edited, sum(s.inbox) AS inbox
       FROM route_stat s JOIN member m ON m.id = s.member_id
       WHERE m.household_id = ?1 AND (?2 IS NULL OR s.member_id = ?2) AND s.recorded_on >= ?3
       GROUP BY s.member_id, week_of ORDER BY week_of DESC, m.id`,
      ctx.householdId,
      memberId,
      routerSince(ctx.today()),
    );
    return {
      aliases,
      router: weeks.map((w) => {
        const pieces = w.unedited + w.edited + w.inbox;
        return { ...w, pieces, share_unedited: pieces > 0 ? w.unedited / pieces : null };
      }),
    };
  },
});

export const ALIAS_TOOLS: Tool[] = [learnAlias, forgetAlias, learned];
