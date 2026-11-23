// Two gaps found while logging on 7-8 Oct 2026.
//
// 1. A reading's MEASURER could not be amended. Who held the tape decides whether two
//    readings are comparable, and it is routinely learned after the fact - a whole
//    household tape set was written before anyone said who took it, and the answer
//    changed how the key reading was read. It had nowhere to go.
//
// 2. Free text with items run together and no separator came back "No amount the app
//    can read. Change the words" - which does not say WHAT to change. The splitter uses
//    [,;\n+&], so a space-separated list is one piece, and the second number in it bails.
import { describe, expect, it } from "vitest";
import { parsePiece, splitText } from "../src/router";
import { setup } from "./harness";
import { seedCatalogue } from "./seed";

const DAY = "2026-10-08";

async function reading(x: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) {
  const body = await x.ok(
    "log_reading",
    { member: "Hritvik", date: DAY, metric: "waist_navel", value: 38, unit: "in", body_state: "fasted", ...extra },
    "hritvik",
  );
  return body.reading.id as number;
}

describe("amending a reading's measurer", () => {
  it("records who took it after the fact, with the member", async () => {
    const x = setup();
    const id = await reading(x);
    expect(x.t.get("SELECT measurer, measurer_member_id FROM reading WHERE id = ?", id)).toEqual({ measurer: "self", measurer_member_id: null });
    const body = await x.ok(
      "amend",
      { record: { table: "reading", id }, changes: { measurer: "member", measurer_member_id: x.h.asha }, reason: "Asha took the whole set." },
      "hritvik",
    );
    expect(body.after).toMatchObject({ measurer: "member", measurer_member_id: x.h.asha });
  });

  it("'member' without a member asks who, rather than storing a measurer nobody can name", async () => {
    const x = setup();
    const id = await reading(x);
    const asked = await x.call("amend", { record: { table: "reading", id }, changes: { measurer: "member" }, reason: "x" }, "hritvik");
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "measurer_needed" });
  });

  it("a member from outside the household is refused", async () => {
    const x = setup();
    const id = await reading(x);
    const refused = await x.call(
      "amend",
      { record: { table: "reading", id }, changes: { measurer: "member", measurer_member_id: 9999 }, reason: "x" },
      "hritvik",
    );
    expect(refused.body).toMatchObject({ status: "needs_clarification", reason: "measurer_needed" });
  });

  it("a member credited to a non-member measurer is refused, so the pair cannot drift apart", async () => {
    const x = setup();
    const id = await reading(x, { measurer: "member", measurer_member: "Asha" });
    const refused = await x.call("amend", { record: { table: "reading", id }, changes: { measurer: "self" }, reason: "x" }, "hritvik");
    expect(refused.body).toMatchObject({ status: "needs_clarification", reason: "measurer_member_unused" });
    // Clearing both together is the way through.
    const ok = await x.ok(
      "amend",
      { record: { table: "reading", id }, changes: { measurer: "self", measurer_member_id: null }, reason: "He took it himself." },
      "hritvik",
    );
    expect(ok.after).toMatchObject({ measurer: "self", measurer_member_id: null });
  });
});

describe("amending a reading's measurer on main (ported from 97d97c4)", () => {
  it("takes the measurer by name, as log_reading does, and the question points at that name", async () => {
    const x = setup();
    const id = await reading(x);
    const asked = await x.call("amend", { record: { table: "reading", id }, changes: { measurer: "member" }, reason: "x" }, "hritvik");
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "measurer_needed", path: ["changes", "measurer_member"] });
    const body = await x.ok("amend", { record: { table: "reading", id }, changes: { measurer: "member", measurer_member: "Asha" }, reason: "Asha took it." }, "hritvik");
    expect(body.after).toMatchObject({ measurer: "member", measurer_member_id: x.h.asha, state: "confirmed" });
    const cleared = await x.ok("amend", { record: { table: "reading", id }, changes: { measurer: "not_recorded", measurer_member: null }, reason: "Not sure after all." }, "hritvik");
    expect(cleared.after).toMatchObject({ measurer: "not_recorded", measurer_member_id: null });
  });

  it("an unknown name is asked about, both forms at once are refused, and a measurer outside the enum is asked about", async () => {
    const x = setup();
    const id = await reading(x);
    const unknown = await x.call("amend", { record: { table: "reading", id }, changes: { measurer: "member", measurer_member: "Nobody" }, reason: "x" }, "hritvik");
    expect(unknown.body).toMatchObject({ status: "needs_clarification", reason: "unknown_member" });
    const both = await x.call("amend", { record: { table: "reading", id }, changes: { measurer: "member", measurer_member: "Asha", measurer_member_id: x.h.asha }, reason: "x" }, "hritvik");
    expect([both.http, both.body.error?.code]).toEqual([400, "measurer_member_or_id"]);
    const bad = await x.call("amend", { record: { table: "reading", id }, changes: { measurer: "partner" }, reason: "x" }, "hritvik");
    expect(bad.body).toMatchObject({ status: "needs_clarification", reason: "invalid_measurer", path: ["changes", "measurer"] });
    // null too: the column is NOT NULL, so it is a question, not a raw constraint error.
    const none = await x.call("amend", { record: { table: "reading", id }, changes: { measurer: null }, reason: "x" }, "hritvik");
    expect([none.http, none.body]).toMatchObject([200, { status: "needs_clarification", reason: "invalid_measurer", path: ["changes", "measurer"] }]);
    expect(x.t.get("SELECT measurer, measurer_member_id FROM reading WHERE id = ?", id)).toEqual({ measurer: "self", measurer_member_id: null });
  });

  it("the question points at the field the caller used: measurer_member_id gets measurer_member_id", async () => {
    const x = setup();
    const id = await reading(x);
    const unused = await x.call("amend", { record: { table: "reading", id }, changes: { measurer: "self", measurer_member_id: x.h.asha }, reason: "x" }, "hritvik");
    expect(unused.body).toMatchObject({ status: "needs_clarification", reason: "measurer_member_unused", path: ["changes", "measurer_member_id"] });
    const outside = await x.call("amend", { record: { table: "reading", id }, changes: { measurer: "member", measurer_member_id: 9999 }, reason: "x" }, "hritvik");
    expect(outside.body).toMatchObject({ reason: "measurer_needed", path: ["changes", "measurer_member_id"] });
    const byName = await x.call("amend", { record: { table: "reading", id }, changes: { measurer: "self", measurer_member: "Asha" }, reason: "x" }, "hritvik");
    expect(byName.body).toMatchObject({ reason: "measurer_member_unused", path: ["changes", "measurer_member"] });
  });

  it("an id given as text is that id; other text is asked about, naming the field", async () => {
    const x = setup();
    const id = await reading(x);
    const text = await x.ok("amend", { record: { table: "reading", id }, changes: { measurer: "member", measurer_member_id: String(x.h.asha) }, reason: "Asha took it." }, "hritvik");
    expect(text.after).toMatchObject({ measurer: "member", measurer_member_id: x.h.asha });
    const word = await x.call("amend", { record: { table: "reading", id }, changes: { measurer: "member", measurer_member_id: "Asha" }, reason: "x" }, "hritvik");
    expect(word.body).toMatchObject({ status: "needs_clarification", reason: "measurer_needed", path: ["changes", "measurer_member_id"] });
    expect(x.t.get("SELECT measurer_member_id FROM reading WHERE id = ?", id)).toEqual({ measurer_member_id: x.h.asha });
  });

  it("the owner's reject of a re-drafted reading restores both measurer fields", async () => {
    const x = setup();
    const id = await reading(x, { measurer: "member", measurer_member: "Asha" });
    const record = { table: "reading", id };
    const redrafted = await x.ok("amend", { record, changes: { measurer: "self", measurer_member: null }, reason: "Thought he took it.", speaker: "Asha" });
    expect(redrafted.after).toMatchObject({ measurer: "self", measurer_member_id: null, state: "draft" });
    const rejected = await x.ok("reject", { records: [record], reason: "Asha did take it." }, "hritvik");
    expect(rejected.restored).toMatchObject([record]);
    expect(x.t.get("SELECT measurer, measurer_member_id, state FROM reading WHERE id = ?", id)).toEqual({ measurer: "member", measurer_member_id: x.h.asha, state: "confirmed" });
  });

  it("a reading is owner-only: another member cannot amend its measurer, even to name themselves", async () => {
    const x = setup();
    const id = await reading(x);
    const refused = await x.call("amend", { record: { table: "reading", id }, changes: { measurer: "member", measurer_member: "Asha" }, reason: "I took it." }, "asha");
    expect([refused.http, refused.body.error?.code]).toEqual([403, "not_visible"]);
    expect(x.t.get("SELECT measurer FROM reading WHERE id = ?", id)).toEqual({ measurer: "self" });
  });

  it("follows ticket 69: the agent talking with another member re-drafts the owner's confirmed reading; talking with the owner it stays confirmed", async () => {
    const x = setup();
    const id = await reading(x);
    const own = await x.ok("amend", { record: { table: "reading", id }, changes: { measurer: "member", measurer_member: "Asha" }, reason: "Asha took it." });
    expect(own.after.state).toBe("confirmed");
    const other = await x.ok("amend", { record: { table: "reading", id }, changes: { measurer: "self", measurer_member: null }, reason: "He took it himself.", speaker: "Asha" });
    expect(other.after).toMatchObject({ measurer: "self", measurer_member_id: null, state: "draft", confirmed_at: null });
    expect(other.draft_for).toBe("Hritvik");
  });
});

describe("items run together in free text", () => {
  it("route_text says run_together for the verbatim text", async () => {
    const x = setup();
    const body = await x.ok("route_text", { member: "Hritvik", date: DAY, text: "2 eggs 1 medium tomato 10gm peas provilac milk 280ml dry instant oats 47gm ghee 1tsp" }, "hritvik");
    expect(body.pieces).toHaveLength(1);
    expect(body.pieces[0]).toMatchObject({ status: "unresolved", reason: "run_together" });
  });

  it("a run-together piece with 'and' is still tried as its parts", async () => {
    const x = setup();
    await seedCatalogue(x);
    const body = await x.ok("route_text", { member: "Hritvik", date: DAY, text: "2 eggs 1 tomato and 100 g curd" }, "hritvik");
    expect(body.pieces).toHaveLength(2);
    expect(body.pieces.map((p: { span: { text: string } }) => p.span.text)).toEqual(["2 eggs 1 tomato", "100 g curd"]);
    expect(body.pieces[0]).toMatchObject({ status: "unresolved", reason: "run_together" });
    expect(body.pieces[1].status).toBe("resolved");
  });

  // Verbatim, from the app on 7 Oct 2026.
  const TEXT = "2 eggs 1 medium tomato 10gm peas provilac milk 280ml dry instant oats 47gm ghee 1tsp";

  it("is one piece, because a space is not a separator", () => {
    expect(splitText(TEXT).spans).toHaveLength(1);
  });

  it("comes back as run-together, not as an unreadable amount", () => {
    const parsed = parsePiece(splitText(TEXT).spans[0]!);
    expect(parsed).toMatchObject({ kind: "unreadable", why: "several" });
  });

  it("the same items with commas read fine, which is what the message now tells them to do", () => {
    const spans = splitText("2 eggs, 1 medium tomato, 10gm peas, provilac milk 280ml, dry instant oats 47gm, ghee 1tsp").spans;
    expect(spans).toHaveLength(6);
    for (const span of spans) expect(parsePiece(span).kind).not.toBe("unreadable");
  });

  it("gm was never the problem - it is a known unit", () => {
    const parsed = parsePiece(splitText("peas 10gm").spans[0]!);
    expect(parsed).toMatchObject({ kind: "food", amount: { value: 10 }, unit: "g" });
  });

  it("a genuinely unreadable amount still says so", () => {
    expect(parsePiece(splitText("curd 10 % protein").spans[0]!)).toMatchObject({ kind: "unreadable", why: "amount" });
  });
});
