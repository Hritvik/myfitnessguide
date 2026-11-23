// Migration 0031 (redesign-a spec §5): Claude's questions and the drafts each one holds. Additive: two
// tables, three indexes and a trigger, onto a database holding data; the Worker before it never reads them.
import { describe, expect, it } from "vitest";
import { NOW, TestDb } from "./db";
import { day, invented, seedFoods, WED } from "./invented";

const BEFORE = "0030";

function populated() {
  const t = new TestDb({ through: BEFORE });
  const hh = t.insert("household", { name: "Sample household", created_at: NOW });
  const asha = t.insert("member", { household_id: hh, name: "Asha", email: "asha@example.com", programming_mode: "prescribed", created_at: NOW });
  return { t, asha };
}

const question = (member: number, over: Record<string, unknown> = {}) => ({
  member_id: member, text: "Which dal was it?", choices: JSON.stringify(["Toor dal", "Dal makhani"]), asked_at: NOW, ...over,
});

describe("migration 0031 on a database holding data", () => {
  it("adds question and question_block, with the join index, and keeps every row", () => {
    const { t, asha } = populated();
    const members = t.all("SELECT * FROM member ORDER BY id");
    t.migrateAfter(BEFORE);
    expect(t.all("SELECT * FROM member ORDER BY id")).toEqual(members);
    const id = t.insert("question", question(asha));
    t.insert("question_block", { question_id: id, table_name: "intake_item", record_id: 7 });
    expect(t.get("SELECT status, answer, blocks FROM question WHERE id = ?", id)).toEqual({ status: "open", answer: null, blocks: "[]" });
    expect(t.all("PRAGMA index_list(question_block)").map((r) => r.name)).toContain("question_block_by_record");
    expect(t.all("EXPLAIN QUERY PLAN SELECT question_id FROM question_block WHERE table_name = 'intake_item' AND record_id = 7").map((r) => r.detail).join(" ")).toMatch(/USING (COVERING )?INDEX question_block_by_record/);
    expect(t.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(t.get("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
  });

  it("refuses no choices, five choices, a blank text, an answer on an open question and an answered one with no answer", () => {
    const { t, asha } = populated();
    t.migrateAfter(BEFORE);
    expect(() => t.insert("question", question(asha, { choices: "[]" }))).toThrow(/CHECK/);
    expect(() => t.insert("question", question(asha, { choices: JSON.stringify(["a", "b", "c", "d", "e"]) }))).toThrow(/CHECK/);
    expect(() => t.insert("question", question(asha, { text: "  " }))).toThrow(/CHECK/);
    expect(() => t.insert("question", question(asha, { answer: "Toor dal", answered_at: NOW }))).toThrow(/CHECK/);
    expect(() => t.insert("question", question(asha, { status: "answered" }))).toThrow(/CHECK/);
    expect(() => t.insert("question", question(asha, { blocks: "{}" }))).toThrow(/CHECK/);
    expect(() => t.insert("question_block", { question_id: t.insert("question", question(asha)), table_name: "flag", record_id: 1 })).toThrow(/CHECK/);
  });

  it("answers a question once: a second answer aborts", () => {
    const { t, asha } = populated();
    t.migrateAfter(BEFORE);
    const entry = t.insert("inbox_entry", { member_id: asha, entry_on: "2026-10-07", text: "Toor dal", spans: JSON.stringify([{ text: "Toor dal", start: 0, end: 8 }]), created_by: asha, created_at: NOW });
    const id = t.insert("question", question(asha));
    t.db.prepare("UPDATE question SET status = 'answered', answer = 'Toor dal', answer_inbox_entry_id = ?, answered_at = ? WHERE id = ?").run(entry, NOW, id);
    expect(() => t.db.prepare("UPDATE question SET answer = 'Dal makhani' WHERE id = ?").run(id)).toThrow(/question_not_open/);
    // Closing and dropping change the status, not the answer, so they pass.
    t.db.prepare("UPDATE question SET status = 'closed', closed_at = ? WHERE id = ?").run(NOW, id);
    expect(t.get("SELECT status, answer FROM question WHERE id = ?", id)).toEqual({ status: "closed", answer: "Toor dal" });
  });
});

describe("the invented household (test/invented.ts)", () => {
  it("signs in Asha, Kabir and Noor, starts at Wed 7 Oct 10:00 IST, and Kabir's log about Asha is her draft", async () => {
    const x = invented();
    await seedFoods(x);
    expect((await x.ok("whoami", {}, "asha")).members).toEqual(["Asha", "Kabir", "Noor"]);
    expect((await x.ok("whoami", {}, "asha")).today).toBe(WED);
    const out = await x.ok("log_intake", { member: "Asha", date: day(0), meal_slot: "lunch", items: [{ source: "food", food: "Curd", value: 150, unit: "g", provenance: "estimated", confidence: "medium" }] }, "kabir");
    expect(out.items[0]).toMatchObject({ state: "draft", member: "Asha" });
  });
});
