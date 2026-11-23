/**
 * Feedback about the app itself (spec §9), for requirements review in
 * chat. Owner-only: its sender and the agent see it and triage it.
 */
import { z } from "zod";
import type { Ctx } from "../context";
import { all, first } from "../db";
import { ToolError } from "../errors";
import { readTool, writeTool, type Tool } from "../tool";

const GROUP = "feedback";
const STATUSES = ["new", "discussed", "ticketed", "done", "wont_do"] as const;
const CONTEXT = z
  .object({
    route: z.string().max(300),
    date: z.iso.date().nullable(),
    version: z.string().max(60),
    viewport: z.enum(["phone", "desktop"]),
    at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/),
  })
  .partial()
  .strict();

interface FeedbackRow {
  id: number;
  member_id: number;
  member: string;
  type: string;
  text: string;
  context: string;
  status: string;
  triage_note: string | null;
  created_at: string;
}

const SELECT = "SELECT f.*, m.name AS member FROM feedback f JOIN member m ON m.id = f.member_id";
const out = (r: FeedbackRow) => ({ id: r.id, member: r.member, type: r.type, text: r.text, context: JSON.parse(r.context) as Record<string, unknown>, status: r.status, note: r.triage_note, created_at: r.created_at });

const submitFeedback = writeTool({
  name: "submit_feedback",
  group: GROUP,
  description: "Send feedback about the app: a bug, an idea or something confusing, with the context the app attaches (route, date viewed, app version, phone or desktop, time). From chat, the member the agent is talking with sends it.",
  input: { type: z.enum(["bug", "idea", "confusing"]), text: z.string().min(1).max(2000), context: CONTEXT.optional() },
  async run(ctx, input) {
    const member = ctx.caller.kind === "member" ? await ctx.memberById(ctx.caller.memberId) : ctx.writeInfo.speaker;
    if (!member) throw new ToolError("speaker_needed", "say which member the feedback is from (speaker)", 400);
    ctx.onBehalfOf(member.id);
    const row = { member_id: member.id, type: input.type, text: input.text, context: JSON.stringify(input.context ?? {}), status: "new", triage_note: null, created_at: ctx.nowIso() };
    const id = await ctx.txOrThrow.create("feedback", row);
    return { feedback: out({ id, ...row, member: member.name }) };
  },
});

const feedbackList = readTool({
  name: "feedback_list",
  group: GROUP,
  description: "Feedback about the app, newest first, optionally by status. A member sees their own; the agent sees everyone's.",
  input: { status: z.enum(STATUSES).optional() },
  async run(ctx, input) {
    const own = ctx.caller.kind === "member" ? ctx.caller.memberId : null;
    const rows = await all<FeedbackRow>(
      ctx.db,
      `${SELECT} WHERE m.household_id = ?1 AND (?2 IS NULL OR f.member_id = ?2) AND (?3 IS NULL OR f.status = ?3) ORDER BY f.created_at DESC, f.id DESC`,
      ctx.householdId,
      own,
      input.status ?? null,
    );
    return { feedback: rows.map(out) };
  },
});

const triageFeedback = writeTool({
  name: "triage_feedback",
  group: GROUP,
  description: "Triage one piece of feedback with a note: discussed, ticketed (say which ticket), done, won't do, or back to new. Only the agent or the member who sent it.",
  input: { id: z.number().int().positive(), status: z.enum(STATUSES), note: z.string().min(1) },
  async run(ctx: Ctx, input) {
    const row = await first<FeedbackRow>(ctx.db, `${SELECT} WHERE f.id = ? AND m.household_id = ?`, input.id, ctx.householdId);
    if (!row) throw new ToolError("not_found", `no feedback ${input.id}`, 404);
    if (ctx.caller.kind === "member" && ctx.caller.memberId !== row.member_id) throw new ToolError("not_yours", "only the agent or the member who sent it can triage feedback", 403);
    ctx.onBehalfOf(row.member_id);
    const changes = { status: input.status, triage_note: input.note };
    const { member: _member, ...stored } = row;
    ctx.txOrThrow.update("feedback", row.id, changes, { ...stored, ...changes });
    return { feedback: out({ ...row, ...changes }) };
  },
});

export const FEEDBACK_TOOLS: Tool[] = [submitFeedback, feedbackList, triageFeedback];
