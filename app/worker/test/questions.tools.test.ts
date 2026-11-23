// Assistant questions (redesign-a spec §5): routing and refusals, the lifecycle (open, answered, closed, dropped),
// and the hold on auto-confirm. Invented household and texts.
import { describe, expect, it } from "vitest";
import { day, invented, seedFoods, WED } from "./invented";
import { READ_BUDGET, withinBudget } from "./budget";
import { Ctx } from "../src/context";
import { householdDrafts } from "../src/drafts";
import { openQuestions } from "../src/questions";
import { QUESTION_TOOLS } from "../src/tools/questions";

const context = (x: ReturnType<typeof invented>) => new Ctx(x.db, { kind: "member", memberId: x.h.asha, householdId: x.h.id, name: "Asha" }, () => x.clock.now, "Asia/Kolkata");

const curd = { source: "food", food: "Curd", value: 150, unit: "g", provenance: "estimated", confidence: "medium" };
const TEXT = "two phulka with the leftover dal";
/** A span's offsets, found in the text rather than counted by hand (R14): "the leftover dal" is 16..32. */
const span = (text: string, part: string) => ({ text: part, start: text.indexOf(part), end: text.indexOf(part) + part.length });

/** Asha's Inbox text, and Kabir's draft about Asha's lunch. */
async function ready() {
  const x = invented();
  await seedFoods(x);
  const sent = await x.ok("submit_to_inbox", { member: "Asha", date: WED, meal_slot: "dinner", text: TEXT, spans: [span(TEXT, "the leftover dal")] }, "asha");
  const lunch = await x.ok("log_intake", { member: "Asha", date: WED, meal_slot: "lunch", items: [curd] }, "kabir");
  return { x, entry: sent.entry.id as number, item: lunch.items[0].id as number };
}

const ask = (over: Record<string, unknown> = {}) => ({ member: "Asha", text: "Which dal was it?", choices: ["Toor dal from Kabir's pot", "Dal makhani"], ...over });

describe("ask_member: routing and refusals", () => {
  it("describes the durable question flow without naming a provider", () => {
    const descriptions = QUESTION_TOOLS.map((tool) => tool.description);
    expect(descriptions.join(" ")).not.toMatch(/Claude/i);
    expect(descriptions.find((description) => description.startsWith("Answer"))).toContain("assistant's question");
  });

  it("asks the sender of an Inbox entry, holding a draft about them", async () => {
    const { x, entry, item } = await ready();
    const out = await x.ok("ask_member", ask({ inbox_entry_id: entry, blocks: [{ table: "intake_item", id: item }] }));
    expect(out.question).toMatchObject({ member: "Asha", status: "open", choices: ["Toor dal from Kabir's pot", "Dal makhani"], inbox_entry_id: entry, blocks: [{ table: "intake_item", id: item }] });
  });

  it("refuses a member, another member than the sender, an entry with no sender, and a block about someone else or not a draft", async () => {
    const { x, entry, item } = await ready();
    expect((await x.call("ask_member", ask(), "asha")).body.error.code).toBe("agent_only");
    expect((await x.call("ask_member", ask({ member: "Kabir", inbox_entry_id: entry }))).body.error.code).toBe("not_the_sender");
    x.t.db.prepare("UPDATE inbox_entry SET created_by = NULL WHERE id = ?").run(entry);
    expect((await x.call("ask_member", ask({ inbox_entry_id: entry }))).body.error.code).toBe("no_sender");
    expect((await x.call("ask_member", ask({ member: "Noor", blocks: [{ table: "intake_item", id: item }] }))).body.error.code).toBe("block_not_theirs");
    await x.ok("confirm", { records: [{ table: "intake_item", id: item }] }, "asha");
    expect((await x.call("ask_member", ask({ blocks: [{ table: "intake_item", id: item }] }))).body.error.code).toBe("block_not_draft");
  });
});

describe("the lifecycle", () => {
  it("refuses duplicate block references with a stable 400 error", async () => {
    const { x, item } = await ready();
    const block = { table: "intake_item", id: item };
    const reply = await x.call("ask_member", ask({ blocks: [block, block] }));
    expect([reply.http, reply.body.error.code]).toEqual([400, "duplicate_block"]);
    expect(x.t.get("SELECT count(*) AS n FROM question")).toEqual({ n: 0 });
  });

  it("drops a question blocked only on a set when reject removes its session", async () => {
    const { x } = await ready();
    const exercise = x.t.insert("exercise", { household_id: x.h.id, name: "Romanian deadlift", implement_kind: "barbell" });
    const gym = x.t.insert("gym", { household_id: x.h.id, name: "Sample gym" });
    const session = x.t.insert("session", { member_id: x.h.asha, gym_id: gym, performed_on: WED, session_type: "strength", state: "draft" });
    const set = x.t.insert("session_set", { session_id: session, exercise_id: exercise, set_number: 1, position: 1, set_type: "working", reps: 8, load_status: "none", rir_status: "recorded", rir_low: 2, rir_high: 2, state: "draft" });
    const q = (await x.ok("ask_member", ask({ blocks: [{ table: "session_set", id: set }] }))).question.id;
    const rejected = await x.counted("reject", { records: [{ table: "session", id: session }], reason: "Logged twice" }, "asha");
    withinBudget(rejected, READ_BUDGET);
    expect(x.t.get("SELECT status FROM question WHERE id = ?", q)).toEqual({ status: "dropped" });
  });

  it.each([false, true])("drops a question blocking only a portion's item when reject restores=%s", async (restore) => {
    const { x } = await ready();
    const meal = await x.ok("household_meal", { date: WED, meal_slot: "dinner", cooks: [{ name: "Curd bowl", lines: [{ food: "Curd", value: 600, unit: "g", provenance: "weighed" }], portions: [{ member: "Asha", fraction: 0.5, provenance: "estimated" }] }] }, "kabir");
    const portion = meal.cooks[0].portions[0].id as number;
    const item = x.t.get("SELECT id FROM intake_item WHERE portion_id = ?", portion)?.id as number;
    if (restore) {
      await x.ok("confirm", { records: [{ table: "portion", id: portion }] }, "asha");
      await x.ok("amend", { record: { table: "portion", id: portion }, changes: { fraction: 0.4 }, reason: "Smaller share" }, "kabir");
    }
    const q = (await x.ok("ask_member", ask({ blocks: [{ table: "intake_item", id: item }] }))).question.id;
    const rejected = await x.counted("reject", { records: [{ table: "portion", id: portion }], reason: "Wrong share" }, "asha");
    withinBudget(rejected, READ_BUDGET);
    expect(x.t.get("SELECT status FROM question WHERE id = ?", q)).toEqual({ status: "dropped" });
  });

  it("answers once as an Inbox entry from the member; resolving that entry closes it", async () => {
    const { x, item } = await ready();
    const q = (await x.ok("ask_member", ask({ blocks: [{ table: "intake_item", id: item }] }))).question.id;
    expect((await x.call("answer_question", { id: q, choice: "Dal makhani" }, "kabir")).body.error.code).toBe("not_yours");
    const answered = await x.ok("answer_question", { id: q, choice: "Toor dal from Kabir's pot" }, "asha");
    expect(answered.question).toMatchObject({ status: "answered", answer: "Toor dal from Kabir's pot" });
    const entry = (await x.ok("inbox_entries", {}, "asha")).entries.find((e: { id: number }) => e.id === answered.entry_id);
    expect(entry).toMatchObject({ member: "Asha", text: `Answer to assistant question ${q}: Toor dal from Kabir's pot`, status: "pending" });
    expect((await x.call("answer_question", { id: q, text: "Something else" }, "asha")).http).toBe(409);
    await x.ok("resolve_inbox_entry", { id: answered.entry_id, status: "resolved", note: "Logged the toor dal as her dinner share", reason: "her answer" });
    expect(x.t.get("SELECT status, closed_at IS NOT NULL AS closed FROM question WHERE id = ?", q)).toEqual({ status: "closed", closed: 1 });
  });

  it("accepts a choice or its own words, not both and not a word outside the choices", async () => {
    const { x } = await ready();
    const q = (await x.ok("ask_member", ask())).question.id;
    expect((await x.call("answer_question", { id: q, choice: "Moong", text: "x" }, "asha")).body.error.code).toBe("choice_or_text");
    expect((await x.call("answer_question", { id: q, choice: "Moong" }, "asha")).body).toMatchObject({ status: "needs_clarification", reason: "not_a_choice" });
    expect((await x.ok("answer_question", { id: q, text: "Moong dal, from the tiffin" }, "asha")).question.answer).toBe("Moong dal, from the tiffin");
  });

  // Review Focus 4: the question's drafts settle before it is answered.
  it("drops when a write leaves none of its drafts a draft, in that write; an answer afterwards is 409 not_open", async () => {
    const { x, item } = await ready();
    const q = (await x.ok("ask_member", ask({ blocks: [{ table: "intake_item", id: item }] }))).question.id;
    await x.ok("reject", { records: [{ table: "intake_item", id: item }], reason: "Taken back: logged on the wrong day" }, "kabir");
    expect(x.t.get("SELECT status FROM question WHERE id = ?", q)).toEqual({ status: "dropped" });
    const late = await x.call("answer_question", { id: q, choice: "Dal makhani" }, "asha");
    expect([late.http, late.body.error.code]).toEqual([409, "not_open"]);
  });

  it("stays while another of its drafts is still one; drops on the member's own confirm and on amend's confirm", async () => {
    const { x, item } = await ready();
    const other = (await x.ok("log_intake", { member: "Asha", date: WED, meal_slot: "lunch", items: [curd] }, "kabir")).items[0].id as number;
    const q = (await x.ok("ask_member", ask({ blocks: [{ table: "intake_item", id: item }, { table: "intake_item", id: other }] }))).question.id;
    await x.ok("confirm", { records: [{ table: "intake_item", id: item }] }, "asha");
    expect(x.t.get("SELECT status FROM question WHERE id = ?", q)).toEqual({ status: "open" });
    await x.ok("amend", { record: { table: "intake_item", id: other }, changes: { amount_value: 100 }, reason: "A smaller bowl" }, "asha");
    expect(x.t.get("SELECT status FROM question WHERE id = ?", q)).toEqual({ status: "dropped" });
  });
});

describe("the hold", () => {
  it.each([
    ["portion", "intake_item"], ["portion", "portion"],
    ["leftover_serving", "intake_item"], ["leftover_serving", "leftover_serving"],
  ] as const)("holds both sides of a %s pair when only %s is blocked", async (shareTable, blockedTable) => {
    const { x } = await ready();
    const meal = await x.ok("household_meal", { date: WED, meal_slot: "dinner", cooks: [{ name: "Curd bowl", lines: [{ food: "Curd", value: 600, unit: "g", provenance: "weighed" }], portions: [{ member: shareTable === "portion" ? "Asha" : "Kabir", fraction: 0.5, provenance: "estimated" }] }] }, "kabir");
    let share = meal.cooks[0].portions[0].id as number;
    if (shareTable === "leftover_serving") {
      const component = meal.cooks[0].components[0].id as number;
      await x.ok("mark_remainder", { component_id: component, disposition: "leftover", provenance: "estimated", date: WED }, "kabir");
      const eaten = await x.ok("mark_remainder", { component_id: component, disposition: "eaten", member: "Asha", fraction: 0.25, meal_slot: "snack", provenance: "estimated", date: WED }, "kabir");
      share = eaten.serving.id as number;
    }
    const item = x.t.get(`SELECT id FROM intake_item WHERE ${shareTable === "portion" ? "portion_id" : "leftover_serving_id"} = ?`, share)?.id as number;
    const q = (await x.ok("ask_member", ask({ blocks: [{ table: blockedTable, id: blockedTable === "intake_item" ? item : share }] }))).question.id as number;
    const { autoConfirm } = await import("../src/autoconfirm");
    x.advanceHours(49);
    for (const answered of [false, true]) {
      if (answered) await x.ok("answer_question", { id: q, choice: "Dal makhani" }, "asha");
      const result = await autoConfirm(x.db, x.clock.now);
      expect(result.confirmed).not.toContainEqual({ table: shareTable, id: share });
      expect(result.confirmed).not.toContainEqual({ table: "intake_item", id: item });
      expect(x.t.get(`SELECT state FROM ${shareTable} WHERE id = ?`, share)?.state).toBe("draft");
      expect(x.t.get("SELECT state FROM intake_item WHERE id = ?", item)?.state).toBe("draft");
      if (!answered) {
        const draft = (await householdDrafts(context(x))).find((d) => d.table === shareTable && d.id === share);
        expect(draft).toMatchObject({ waits: "question", deadline: null, questionIds: [q] });
      }
    }
    await x.ok("reject", { records: [{ table: shareTable, id: share }], reason: "Wrong share" }, "asha");
    expect(x.t.get("SELECT status FROM question WHERE id = ?", q)?.status).toBe("dropped");
  });

  it("auto-confirm leaves a held draft alone while the question is open or answered, then confirms it once closed", async () => {
    const { x, item } = await ready();
    const q = (await x.ok("ask_member", ask({ blocks: [{ table: "intake_item", id: item }] }))).question.id;
    const { autoConfirm } = await import("../src/autoconfirm");
    x.advanceHours(49);
    expect((await autoConfirm(x.db, x.clock.now)).skipped).toContainEqual({ table: "intake_item", id: item, reason: "question" });
    const answered = await x.ok("answer_question", { id: q, choice: "Dal makhani" }, "asha");
    expect((await autoConfirm(x.db, x.clock.now)).skipped).toContainEqual({ table: "intake_item", id: item, reason: "question" });
    await x.ok("resolve_inbox_entry", { id: answered.entry_id, status: "resolved", note: "Kept the curd as logged", reason: "her answer" });
    expect((await autoConfirm(x.db, x.clock.now)).confirmed).toContainEqual({ table: "intake_item", id: item });
  });

  it("household_overview says the draft waits for a question, with no deadline", async () => {
    const { x, item } = await ready();
    await x.ok("ask_member", ask({ blocks: [{ table: "intake_item", id: item }] }));
    const asha = (await x.ok("household_overview", {}, "asha")).members.find((m: { member: string }) => m.member === "Asha");
    expect(asha.drafts.oldest).toMatchObject({ table: "intake_item", id: item, deadline: null, waits: "question" });
  });

  it("history of a question is the recipient's and the agent's only", async () => {
    const { x } = await ready();
    const q = (await x.ok("ask_member", ask())).question.id;
    expect((await x.call("history", { table: "question", id: q }, "kabir")).http).toBe(403);
    expect((await x.call("history", { table: "question", id: q }, "asha")).http).toBe(200);
  });

  // R3: an answered question's drafts stay readable, through its history (the question row carries them).
  it("keeps an answered question's blocks in every version of its history", async () => {
    const { x, item } = await ready();
    const q = (await x.ok("ask_member", ask({ blocks: [{ table: "intake_item", id: item }] }))).question.id;
    await x.ok("answer_question", { id: q, choice: "Dal makhani" }, "asha");
    const versions = (await x.ok("history", { table: "question", id: q })).versions as { data: { blocks: string } }[];
    expect(versions.length).toBeGreaterThanOrEqual(2);
    for (const v of versions) expect(JSON.parse(v.data.blocks)).toEqual([{ table: "intake_item", id: item }]);
  });
});

// R1: a question is live only while one of its blocked records is still a draft, whatever settled it.
describe("settled by any path", () => {
  /** A draft session of Asha's with one draft set (RIR given), written as Kabir logged it in the app. */
  function draftSet(x: Awaited<ReturnType<typeof ready>>["x"]) {
    const exercise = x.t.insert("exercise", { household_id: x.h.id, name: "Romanian deadlift", implement_kind: "barbell" });
    const gym = x.t.insert("gym", { household_id: x.h.id, name: "Sample gym" });
    const session = x.t.insert("session", { member_id: x.h.asha, gym_id: gym, performed_on: WED, session_type: "strength", state: "draft" });
    const set = x.t.insert("session_set", { session_id: session, exercise_id: exercise, set_number: 3, position: 3, set_type: "working", reps: 18, load_status: "none", rir_status: "recorded", rir_low: 2, rir_high: 2, state: "draft" });
    return { session, set };
  }

  it.each([false, true])("a settled set's question block never revives on re-draft; another block remains=%s", async (another) => {
    const { x, item } = await ready();
    const { session, set } = draftSet(x);
    const q = (await x.ok("ask_member", ask({ blocks: [{ table: "session_set", id: set }, ...(another ? [{ table: "intake_item", id: item }] : [])] }))).question.id as number;
    await x.ok("end_session", { session_id: session }, "asha");
    await x.ok("amend", { record: { table: "session_set", id: set }, changes: { reps: 9 }, reason: "Corrected the count" }, "kabir");
    const ids = (await openQuestions(context(x), x.h.asha)).map((a) => a.id);
    expect(ids.includes(q)).toBe(another);
    const setDraft = (await householdDrafts(context(x))).find((d) => d.table === "session_set" && d.id === set);
    expect(setDraft).toMatchObject({ waits: null, questionIds: [] });
    if (!another) expect((await x.call("answer_question", { id: q, choice: "Dal makhani" }, "asha")).http).toBe(409);
    const { autoConfirm } = await import("../src/autoconfirm");
    x.advanceHours(49);
    expect((await autoConfirm(x.db, x.clock.now)).confirmed).toContainEqual({ table: "session_set", id: set });
    // A new question about the new draft still holds it; the earlier confirmed versions predate this ask.
    await x.ok("amend", { record: { table: "session_set", id: set }, changes: { reps: 10 }, reason: "Another correction" }, "kabir");
    const fresh = (await x.ok("ask_member", ask({ blocks: [{ table: "session_set", id: set }] }))).question.id as number;
    expect((await householdDrafts(context(x))).find((d) => d.table === "session_set" && d.id === set)).toMatchObject({ waits: "question", questionIds: [fresh] });
  });

  it("end_session confirming a held set takes its question out of asks and the count, and an answer is 409", async () => {
    const { x } = await ready();
    const { session, set } = draftSet(x);
    const q = (await x.ok("ask_member", ask({ text: "Romanian deadlift, set 3: 18 reps?", choices: ["It was 8", "18 is right"], blocks: [{ table: "session_set", id: set }] }))).question.id;
    const before = await x.ok("waiting", {}, "asha");
    expect(before.asks.map((a: { id?: number }) => a.id)).toContain(q);
    await x.ok("end_session", { session_id: session }, "asha");
    const w = await x.ok("waiting", {}, "asha");
    expect(w.asks.map((a: { id?: number }) => a.id)).not.toContain(q);
    // The question and the session's hand-off both leave the badge; Kabir's lunch stays.
    expect(w.count).toBe(before.count - 2);
    expect((await x.call("answer_question", { id: q, choice: "It was 8" }, "asha")).http).toBe(409);
  });

  it("retract of a held draft does the same, and retract runs no statement more", async () => {
    const { x, item } = await ready();
    const q = (await x.ok("ask_member", ask({ blocks: [{ table: "intake_item", id: item }] }))).question.id;
    await x.ok("retract", { records: [{ table: "intake_item", id: item }], reason: "Logged twice" }, "asha");
    expect((await x.ok("waiting", {}, "asha")).asks.map((a: { id?: number }) => a.id)).not.toContain(q);
    expect((await x.call("answer_question", { id: q, choice: "Dal makhani" }, "asha")).http).toBe(409);
  });

  it("a question with no blocks stays live until it is answered", async () => {
    const { x } = await ready();
    const q = (await x.ok("ask_member", ask())).question.id;
    expect((await x.ok("waiting", {}, "asha")).asks.map((a: { id?: number }) => a.id)).toContain(q);
    await x.ok("answer_question", { id: q, choice: "Dal makhani" }, "asha");
    expect((await x.ok("waiting", {}, "asha")).asks.map((a: { id?: number }) => a.id)).not.toContain(q);
  });
});
