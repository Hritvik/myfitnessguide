import { z } from "zod";
import type { Ctx, Member } from "../context";
import { all, first, type Row } from "../db";
import { ToolError } from "../errors";
import { ownerOf } from "../records";
import { readTool, writeTool, type Tool } from "../tool";

const GROUP = "everywhere";
const SUBJECT_TABLES = [
  "gym", "implement", "exercise", "programme", "session_template", "prescription", "phase", "session", "food_source", "recipe",
  "target", "goal_point", "flag", "reading", "blood_draw",
] as const;
const SUBJECT = z.object({ table: z.enum(SUBJECT_TABLES), id: z.number().int().positive() }).strict();

/** null = household documents; a name = that member's notes (owner-only). */
async function noteOwner(ctx: Ctx, ref: string | null): Promise<Member | null> {
  if (ref === null) return null;
  const member = await ctx.member(ref);
  ctx.assertCanSee("member_note", member.id);
  return member;
}

const memberNotes = readTool({
  name: "member_notes",
  group: GROUP,
  description:
    "Versioned prose about a member (protocols, constraints, the reasoning behind a target), optionally about one of their records; member null reads household documents such as Meal Prep. A member's notes are visible only to that member and the agent. Latest version by default.",
  input: {
    member: z.string().nullable().optional().describe("Omit for every note the caller may see; null for household documents."),
    topic: z.string().optional(),
    subject: SUBJECT.optional(),
    include_versions: z.boolean().optional(),
  },
  async run(ctx, input) {
    let rows = await all<Row & { id: number; member_id: number | null; topic: string; subject_table: string | null; subject_id: number | null }>(
      ctx.db,
      "SELECT * FROM v_member_note WHERE household_id = ? ORDER BY member_id IS NOT NULL, member_id, topic, id",
      ctx.householdId,
    );
    if (input.member !== undefined) {
      const owner = await noteOwner(ctx, input.member);
      rows = rows.filter((r) => r.member_id === (owner?.id ?? null));
    } else {
      rows = rows.filter((r) => ctx.canSee(r.member_id));
    }
    if (input.topic !== undefined) rows = rows.filter((r) => r.topic.toLowerCase() === input.topic?.toLowerCase());
    if (input.subject) rows = rows.filter((r) => r.subject_table === input.subject?.table && r.subject_id === input.subject?.id);
    const members = await ctx.members();
    const notes = [];
    for (const r of rows) {
      const note: Record<string, unknown> = {
        ...r,
        member: members.find((m) => m.id === r.member_id)?.name ?? null,
        subject: r.subject_table ? { table: r.subject_table, id: r.subject_id } : null,
      };
      if (input.include_versions) {
        note.versions = await all(ctx.db, "SELECT version, body, created_at, write_id FROM member_note_version WHERE note_id = ? ORDER BY version", r.id);
      }
      notes.push(note);
    }
    return { notes };
  },
});

const writeMemberNote = writeTool({
  name: "write_member_note",
  group: GROUP,
  description:
    "Write a member note (or a household document with member null). Writing the same member, topic and subject again, or giving note_id, adds a new version; every version is kept.",
  input: {
    member: z.string().nullable(),
    topic: z.string().min(1),
    body: z.string().min(1),
    subject: SUBJECT.optional().describe("The member's record the note is about (a target, a prescription, a gym)."),
    note_id: z.number().int().positive().optional(),
  },
  async run(ctx, input) {
    const owner = await noteOwner(ctx, input.member);
    ctx.onBehalfOf(owner?.id ?? null);
    const tx = ctx.txOrThrow;
    if (input.subject) {
      const record = await first<Row>(ctx.db, `SELECT * FROM ${input.subject.table} WHERE id = ?`, input.subject.id);
      if (!record) throw new ToolError("not_found", `no ${input.subject.table} ${input.subject.id}`, 404);
      const recordOwner = await ownerOf(ctx.db, input.subject.table, record);
      if (recordOwner !== null && recordOwner !== (owner?.id ?? null)) {
        throw new ToolError("subject_not_members", `that ${input.subject.table} belongs to another member`, 400);
      }
    }
    let note = input.note_id
      ? await first<Row & { id: number; member_id: number | null; topic: string }>(ctx.db, "SELECT * FROM member_note WHERE id = ? AND household_id = ?", input.note_id, ctx.householdId)
      : await first<Row & { id: number; member_id: number | null; topic: string }>(
          ctx.db,
          `SELECT * FROM member_note WHERE household_id = ? AND member_id IS ? AND topic = ? COLLATE NOCASE
           AND subject_table IS ? AND subject_id IS ? ORDER BY id LIMIT 1`,
          ctx.householdId,
          owner?.id ?? null,
          input.topic,
          input.subject?.table ?? null,
          input.subject?.id ?? null,
        );
    if (input.note_id && (!note || note.member_id !== (owner?.id ?? null))) throw new ToolError("not_found", `no note ${input.note_id} for that member`, 404);
    let version = 1;
    if (note) {
      version = ((await first<{ v: number }>(ctx.db, "SELECT max(version) + 1 AS v FROM member_note_version WHERE note_id = ?", note.id))?.v ?? 1);
    } else {
      const row = {
        household_id: ctx.householdId, member_id: owner?.id ?? null, topic: input.topic, subject_table: input.subject?.table ?? null,
        subject_id: input.subject?.id ?? null, created_at: ctx.nowIso(),
      };
      note = { id: await tx.create("member_note", row), ...row };
    }
    await tx.create("member_note_version", { note_id: note.id, version, body: input.body, write_id: tx.writeId, created_at: ctx.nowIso() });
    return {
      note: {
        id: note.id, member: owner?.name ?? null, topic: note.topic, version, body: input.body,
        subject: input.subject ?? (note.subject_table ? { table: note.subject_table, id: note.subject_id } : null),
      },
      state: "confirmed",
    };
  },
});

export const NOTE_TOOLS: Tool[] = [memberNotes, writeMemberNote];
