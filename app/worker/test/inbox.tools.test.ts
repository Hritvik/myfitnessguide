// The Inbox: what the router couldn't resolve, waiting for the gym-inbox
// skill, and counted in the router's measure when the app sends it.
import { describe, expect, it } from "vitest";
import { toolWithinBudget } from "./budget";
import { setup } from "./harness";
import { busyInput, MONDAY } from "./input-seed";

const text = "2 eggs and the green chutney from the dhaba";
const spans = [{ text: "the green chutney from the dhaba", start: 11, end: text.length }];

describe("submit_to_inbox", () => {
  it("stores the unresolved spans as a pending entry and counts them for the member's app call", async () => {
    const x = setup();
    const body = await x.ok("submit_to_inbox", { member: "Hritvik", date: MONDAY, text, spans, meal_slot: "dinner" }, "hritvik");
    expect(body.entry).toMatchObject({ member: "Hritvik", date: MONDAY, meal_slot: "dinner", status: "pending", spans, created_by: "Hritvik" });
    expect(body.stats).toEqual({ inbox: 1 });
    expect(x.t.all("SELECT unedited, edited, inbox FROM route_stat")).toEqual([{ unedited: 0, edited: 0, inbox: 1 }]);
  });

  it("refuses a span that isn't the text at its offsets", async () => {
    const x = setup();
    const reply = await x.call("submit_to_inbox", { member: "Hritvik", date: MONDAY, text, spans: [{ text: "chutney", start: 0, end: 7 }] }, "hritvik");
    expect(reply.body.error.code).toBe("span_mismatch");
    expect((await x.call("submit_to_inbox", { member: "Hritvik", date: MONDAY, text, spans: [] }, "hritvik")).http).toBe(400);
  });

  it("holds each span to its offsets in Devanagari text, at both ends of the text", async () => {
    const x = setup();
    const deva = "दो अंडे और हरी चटनी";
    const at = (w: string) => ({ text: w, start: deva.indexOf(w), end: deva.indexOf(w) + w.length });
    const ends = [at("दो"), at("चटनी")];
    expect(ends[0]?.start).toBe(0);
    expect(ends[1]?.end).toBe(deva.length);
    const body = await x.ok("submit_to_inbox", { member: "Hritvik", date: MONDAY, text: deva, spans: [...ends, at("हरी")] }, "hritvik");
    for (const s of body.entry.spans) expect(deva.slice(s.start, s.end)).toBe(s.text);
    expect(body.stats).toEqual({ inbox: 3 });
    const off = await x.call("submit_to_inbox", { member: "Hritvik", date: MONDAY, text: deva, spans: [{ ...at("चटनी"), start: at("चटनी").start + 1 }] }, "hritvik");
    expect(off.body.error.code).toBe("span_mismatch");
    // Past the end of the text, even when the span's text is the tail.
    const past = await x.call("submit_to_inbox", { member: "Hritvik", date: MONDAY, text: deva, spans: [{ ...at("चटनी"), end: deva.length + 3 }] }, "hritvik");
    expect(past.body.error.code).toBe("span_mismatch");
  });

  it("refuses a span that splits a surrogate pair, and overlapping spans", async () => {
    const x = setup();
    const t = "a😀b c";
    const bad = (spans: unknown[]) => x.call("submit_to_inbox", { member: "Hritvik", date: MONDAY, text: t, spans }, "hritvik");
    expect((await bad([{ text: "\ude00b", start: 2, end: 4 }])).body.error.code).toBe("span_mismatch");
    expect((await bad([{ text: "a\ud83d", start: 0, end: 2 }])).body.error.code).toBe("span_mismatch");
    expect((await bad([{ text: "a😀", start: 0, end: 3 }, { text: "😀b", start: 1, end: 4 }])).body.error.code).toBe("span_overlap");
    expect((await bad([{ text: "😀b", start: 1, end: 4 }, { text: "a😀", start: 0, end: 3 }])).body.error.code).toBe("span_overlap");
    const fine = await x.ok("submit_to_inbox", { member: "Hritvik", date: MONDAY, text: t, spans: [{ text: "😀", start: 1, end: 3 }, { text: "b", start: 3, end: 4 }] }, "hritvik");
    expect(fine.entry.spans).toHaveLength(2);
  });

  it("refuses blank text", async () => {
    const x = setup();
    expect((await x.call("submit_to_inbox", { member: "Hritvik", date: MONDAY, text: "   ", spans: [{ text: " ", start: 0, end: 1 }] }, "hritvik")).http).toBe(400);
  });

  it("records no stats for an agent's call", async () => {
    const x = setup();
    expect((await x.ok("submit_to_inbox", { member: "Hritvik", date: MONDAY, text, spans })).stats).toBeNull();
  });
});

describe("inbox_entries and resolve_inbox_entry", () => {
  it("lists pending entries, then resolves one with a note and the records it wrote, once", async () => {
    const x = setup();
    const a = (await x.ok("submit_to_inbox", { member: "Hritvik", date: MONDAY, text, spans }, "hritvik")).entry;
    await x.ok("submit_to_inbox", { member: "Asha", date: MONDAY, text: "bhel", spans: [{ text: "bhel", start: 0, end: 4 }] }, "asha");
    expect((await x.ok("inbox_entries", {}, "hritvik")).entries.map((e: { member: string }) => e.member)).toEqual(["Hritvik"]);
    expect((await x.ok("inbox_entries", {})).entries.map((e: { member: string }) => e.member).sort()).toEqual(["Asha", "Hritvik"]);
    const body = await x.ok("resolve_inbox_entry", { id: a.id, status: "resolved", note: "logged as manual macros", records: [{ table: "intake_item", id: 7 }], reason: "resolved in the inbox skill" });
    expect(body.entry).toMatchObject({ status: "resolved", note: "logged as manual macros", records: [{ table: "intake_item", id: 7 }], resolved_at: "2026-10-05T07:30:00Z" });
    expect((await x.ok("inbox_entries", { status: "pending" })).entries).toHaveLength(1);
    expect((await x.call("resolve_inbox_entry", { id: a.id, status: "rejected", note: "again", reason: "r" })).body.error.code).toBe("not_pending");
  });

  it("lets only the agent or the entry's member resolve it, and needs a reason", async () => {
    const x = setup();
    const a = (await x.ok("submit_to_inbox", { member: "Hritvik", date: MONDAY, text, spans }, "hritvik")).entry;
    expect((await x.call("resolve_inbox_entry", { id: a.id, status: "rejected", note: "not mine" }, "asha")).body.error.code).toBe("not_yours");
    expect((await x.call("resolve_inbox_entry", { id: a.id, status: "rejected", note: "duplicate" }, "hritvik")).body).toMatchObject({ reason: "reason_needed" });
    expect((await x.ok("resolve_inbox_entry", { id: a.id, status: "rejected", note: "a duplicate of lunch", reason: "duplicate" }, "hritvik")).entry.status).toBe("rejected");
  });

  it("closes an entry once even when another close lands between the read and the write", async () => {
    const x = setup();
    const a = (await x.ok("submit_to_inbox", { member: "Hritvik", date: MONDAY, text, spans }, "hritvik")).entry;
    const real = x.db.batch.bind(x.db);
    x.db.batch = async (statements: Parameters<typeof real>[0]) => {
      x.t.run("UPDATE inbox_entry SET status = 'rejected', resolution_note = 'first', resolved_at = '2026-10-05T07:29:00Z' WHERE id = ?", a.id);
      return real(statements);
    };
    const reply = await x.call("resolve_inbox_entry", { id: a.id, status: "resolved", note: "second", reason: "r" });
    x.db.batch = real;
    expect(reply.http).toBe(409);
    expect(reply.body.error.code).toBe("not_pending");
    expect(x.t.get("SELECT status, resolution_note FROM inbox_entry WHERE id = ?", a.id)).toEqual({ status: "rejected", resolution_note: "first" });
    expect(x.t.all("SELECT version FROM record_version WHERE table_name = 'inbox_entry' AND record_id = ?", a.id)).toEqual([{ version: 1 }]);
  });

  it("keeps created_by in the stored version", async () => {
    const x = setup();
    const a = (await x.ok("submit_to_inbox", { member: "Asha", date: MONDAY, text, spans }, "hritvik")).entry;
    await x.ok("resolve_inbox_entry", { id: a.id, status: "rejected", note: "dup", reason: "r" });
    const v = x.t.get("SELECT data FROM record_version WHERE table_name = 'inbox_entry' AND record_id = ? AND version = 2", a.id);
    const hritvik = x.t.get("SELECT id FROM member WHERE name = 'Hritvik'");
    expect(JSON.parse((v as { data: string }).data)).toMatchObject({ created_by: (hritvik as { id: number }).id, status: "rejected" });
  });

  it("allows only resolution tables in records, and none on a rejection", async () => {
    const x = setup();
    const a = (await x.ok("submit_to_inbox", { member: "Hritvik", date: MONDAY, text, spans }, "hritvik")).entry;
    expect((await x.call("resolve_inbox_entry", { id: a.id, status: "resolved", note: "n", records: [{ table: "member", id: 1 }], reason: "r" })).http).toBe(400);
    expect((await x.call("resolve_inbox_entry", { id: a.id, status: "rejected", note: "n", records: [{ table: "intake_item", id: 1 }], reason: "r" })).body.error.code).toBe("records_on_rejection");
  });

  it("takes a cook's line and a saved workout's line as resolution records", async () => {
    const x = setup();
    const a = (await x.ok("submit_to_inbox", { member: "Hritvik", date: MONDAY, text, spans }, "hritvik")).entry;
    const records = [{ table: "cook_line", id: 3 }, { table: "workout_line", id: 4 }];
    const body = await x.ok("resolve_inbox_entry", { id: a.id, status: "resolved", note: "added the oil to the pot and the row to the workout", records, reason: "resolved in the inbox skill" });
    expect(body.entry.records).toEqual(records);
  });

  it("tells a foreign member not_yours even on a settled entry", async () => {
    const x = setup();
    const a = (await x.ok("submit_to_inbox", { member: "Hritvik", date: MONDAY, text, spans }, "hritvik")).entry;
    await x.ok("resolve_inbox_entry", { id: a.id, status: "rejected", note: "dup", reason: "r" });
    expect((await x.call("resolve_inbox_entry", { id: a.id, status: "rejected", note: "x", reason: "r" }, "asha")).body.error.code).toBe("not_yours");
  });

  it("caps the list at 100: the oldest pending, the most recent otherwise", async () => {
    const x = setup();
    const hritvik = (x.t.get("SELECT id FROM member WHERE name = 'Hritvik'") as { id: number }).id;
    for (let i = 1; i <= 105; i++) {
      x.t.insert("inbox_entry", {
        id: i, member_id: hritvik, entry_on: MONDAY, text: `t${i}`, spans: JSON.stringify([{ text: `t${i}`, start: 0, end: 2 }]), status: i > 102 ? "pending" : i % 2 ? "resolved" : "rejected",
        resolution_note: i > 102 ? null : "n", created_at: `2026-10-04T07:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
        resolved_at: i > 102 ? null : "2026-10-05T07:00:00Z",
      });
    }
    const all = await x.ok("inbox_entries", { status: "all" });
    expect(all.truncated).toBe(true);
    expect(all.entries).toHaveLength(100);
    expect(all.entries[0].id).toBe(6);
    expect(all.entries[99].id).toBe(105);
    const small = await x.ok("inbox_entries", { status: "pending" });
    expect(small).toMatchObject({ truncated: false });
    expect(small.entries.map((e: { id: number }) => e.id)).toEqual([103, 104, 105]);
    for (let i = 106; i <= 210; i++) x.t.insert("inbox_entry", { id: i, member_id: hritvik, entry_on: MONDAY, text: "p", spans: JSON.stringify([{ text: "p", start: 0, end: 1 }]), status: "pending", created_at: "2026-10-04T08:00:00Z" });
    const pending = await x.ok("inbox_entries", {});
    expect(pending.truncated).toBe(true);
    expect(pending.entries[0].id).toBe(103);
    expect(pending.entries).toHaveLength(100);
  });

  it("stays within the budget", async () => {
    const { x } = await busyInput(40);
    await toolWithinBudget(x, "submit_to_inbox", { member: "Hritvik", date: MONDAY, text, spans }, "hritvik");
    await toolWithinBudget(x, "inbox_entries", {});
  });

  it("lists many entries and resolves one within the budget", async () => {
    const { x } = await busyInput(40);
    for (let i = 0; i < 60; i++) await x.ok("submit_to_inbox", { member: i % 2 ? "Asha" : "Hritvik", date: MONDAY, text, spans }, i % 2 ? "asha" : "hritvik");
    const run = await toolWithinBudget(x, "inbox_entries", { status: "all" });
    expect(run.statements).toBeLessThanOrEqual(3);
    const id = (await x.ok("inbox_entries", {})).entries[0].id;
    await toolWithinBudget(x, "resolve_inbox_entry", { id, status: "resolved", note: "done", records: [{ table: "intake_item", id: 1 }], reason: "r" }, "agent", 8);
  });
});
