/**
 * An assistant's questions to a member (redesign-a spec §5): the agent asks, in the app's Waiting on you; the member
 * answers with a choice or their own words; the answer reaches the agent as an Inbox entry from the member.
 */
import { z } from "zod";
import type { Row } from "../db";
import { all, first } from "../db";
import { Clarify, ToolError } from "../errors";
import { liveSql, questionOut, type QuestionRow } from "../questions";
import { ownersOf } from "../records";
import { writeTool, type Tool } from "../tool";

const GROUP = "questions";
const BLOCKABLE = ["session", "session_set", "portion", "leftover_serving", "intake_item", "reading", "blood_draw"] as const;
const RECORD = z.object({ table: z.enum(BLOCKABLE), id: z.number().int().positive() }).strict();

const askMember = writeTool({
  name: "ask_member",
  group: GROUP,
  description:
    "Agent only. Ask a member a question in the app's Waiting on you, with 1 to 4 answer choices (they may also answer in their own words). Ask instead of guessing a choice that changes a value. With inbox_entry_id the question is about that Inbox text and goes to its sender: `member` must be the sender, and an entry with no sender can't be asked about. `blocks` names drafts about that member that the answer decides: while the question is open or answered they don't confirm by themselves. The answer arrives as a pending Inbox entry from the member; resolving that entry closes the question. A question none of whose drafts is still a draft is dropped.",
  input: {
    member: z.string().min(1),
    text: z.string().min(1).max(500),
    choices: z.array(z.string().min(1).max(80)).min(1).max(4),
    blocks: z.array(RECORD).max(100).optional(),
    inbox_entry_id: z.number().int().positive().optional(),
  },
  async run(ctx, input) {
    if (ctx.caller.kind !== "agent") throw new ToolError("agent_only", "only the agent asks a member a question", 403);
    const member = await ctx.member(input.member);
    if (input.text.trim() === "") throw new ToolError("text_blank", "the question is blank", 400);
    const choices = input.choices.map((c) => c.trim());
    if (choices.some((c) => c === "") || new Set(choices.map((c) => c.toLowerCase())).size !== choices.length) throw new ToolError("bad_choices", "choices are distinct and not blank", 400);
    if (input.inbox_entry_id !== undefined) {
      const entry = await first<{ created_by: number | null }>(ctx.db, "SELECT e.created_by FROM inbox_entry e JOIN member m ON m.id = e.member_id WHERE e.id = ? AND m.household_id = ?", input.inbox_entry_id, ctx.householdId);
      if (!entry) throw new ToolError("not_found", `no inbox entry ${input.inbox_entry_id}`, 404);
      if (entry.created_by === null) throw new ToolError("no_sender", "that Inbox entry has no sender to ask", 400);
      if (entry.created_by !== member.id) throw new ToolError("not_the_sender", `ask the member who sent that text, ${(await ctx.memberById(entry.created_by)).name}`, 400);
    }
    const blocks = input.blocks ?? [];
    if (new Set(blocks.map((b) => `${b.table}:${b.id}`)).size !== blocks.length) {
      throw new ToolError("duplicate_block", "name each blocked record once", 400);
    }
    for (const table of [...new Set(blocks.map((b) => b.table))]) {
      const ids = blocks.filter((b) => b.table === table).map((b) => b.id);
      const rows = await all<Row & { id: number; state: string }>(ctx.db, `SELECT * FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids));
      const owners = await ownersOf(ctx.db, table, rows);
      for (const id of ids) {
        const i = rows.findIndex((r) => r.id === id);
        if (i < 0) throw new ToolError("not_found", `no ${table} ${id}`, 404);
        if (owners[i] !== member.id) throw new ToolError("block_not_theirs", `${table} ${id} is not about ${member.name}`, 400);
        if (rows[i]?.state !== "draft") throw new ToolError("block_not_draft", `${table} ${id} is not a draft`, 400);
      }
    }
    ctx.onBehalfOf(member.id);
    const tx = ctx.txOrThrow;
    // The blocks go on the row too (R3): written once, so every version of the question, and its history, shows them.
    const row = {
      member_id: member.id, inbox_entry_id: input.inbox_entry_id ?? null, text: input.text.trim(), choices: JSON.stringify(choices), blocks: JSON.stringify(blocks),
      status: "open" as const, answer: null, answer_inbox_entry_id: null, asked_at: ctx.nowIso(), answered_at: null, closed_at: null,
    };
    const id = await tx.create("question", row);
    if (blocks.length > 0) {
      tx.exec("INSERT INTO question_block (question_id, table_name, record_id) SELECT ?, json_extract(value, '$.table'), json_extract(value, '$.id') FROM json_each(?)", id, JSON.stringify(blocks));
    }
    return { question: questionOut({ id, ...row }, member.name) };
  },
});

const answerQuestion = writeTool({
  name: "answer_question",
  group: GROUP,
  description:
    "Answer the assistant's question: the member was asked in the app or through an agent while talking with them. Give `choice` (one of its choices) or `text` (their own words), not both. The answer is stored and sent as a pending Inbox entry from the member about them; a question answered, closed or dropped, or none of whose drafts is still a draft, is not_open (409).",
  input: { id: z.number().int().positive(), choice: z.string().min(1).optional(), text: z.string().min(1).max(500).optional() },
  async run(ctx, input) {
    const q = await first<QuestionRow & { member: string; live: number }>(ctx.db, `SELECT q.*, m.name AS member, ${liveSql("q")} AS live FROM question q JOIN member m ON m.id = q.member_id WHERE q.id = ? AND m.household_id = ?`, input.id, ctx.householdId);
    if (!q) throw new ToolError("not_found", `no question ${input.id}`, 404);
    const answering = ctx.caller.kind === "member" ? ctx.caller.memberId : (ctx.writeInfo.speaker?.id ?? null);
    if (answering !== q.member_id) throw new ToolError("not_yours", "only the member asked can answer", 403);
    if (q.status !== "open") throw new ToolError("not_open", `question ${q.id} is ${q.status}`, 409);
    // Settled by any path (R1): none of its drafts is a draft any more, so there is nothing left to decide.
    if (q.live !== 1) throw new ToolError("not_open", `question ${q.id} was settled: none of its drafts is a draft any more`, 409);
    if ((input.choice === undefined) === (input.text === undefined)) throw new ToolError("choice_or_text", "give a choice or your own words, not both", 400);
    const choices = JSON.parse(q.choices) as string[];
    if (input.choice !== undefined && !choices.includes(input.choice)) throw new Clarify("not_a_choice", "Which of these?", choices, ["choice"]);
    const answer = (input.choice ?? input.text ?? "").trim();
    if (answer === "") throw new ToolError("text_blank", "the answer is blank", 400);
    ctx.onBehalfOf(q.member_id);
    const tx = ctx.txOrThrow;
    const now = ctx.nowIso();
    // An answer is an Inbox entry from the member about them (ruling 7): it never copies the question's text.
    const lead = `Answer to assistant question ${q.id}: `;
    const text = `${lead}${answer}`;
    const entryId = await tx.create("inbox_entry", {
      member_id: q.member_id, entry_on: ctx.today(), meal_slot: null, text, spans: JSON.stringify([{ text: answer, start: lead.length, end: text.length }]),
      status: "pending", resolution_note: null, records: null, created_by: q.member_id, created_at: now, resolved_at: null,
    });
    const { member: name, live: _live, ...stored } = q;
    const changes = { status: "answered" as const, answer, answer_inbox_entry_id: entryId, answered_at: now };
    tx.update("question", q.id, changes, { ...stored, ...changes });
    return { question: questionOut({ ...stored, ...changes }, name), entry_id: entryId };
  },
});

export const QUESTION_TOOLS: Tool[] = [askMember, answerQuestion];
