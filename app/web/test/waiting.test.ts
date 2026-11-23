import { describe, expect, it } from "vitest";
import type { HistoryVersion, HouseholdOverview, InboxEntry } from "../src/types";
import { afterRefusal, confirmTickedPlan, goneNote, rejectDraftPlan, settledText, settleRefusal, waitingRows, type WaitingRow } from "../src/waiting";

const TZ = "Asia/Kolkata";
const draft = (over: Partial<NonNullable<HouseholdOverview["waiting_on_you"]>["drafts"][number]> = {}) => ({
  table: "portion", id: 7, summary: "Masoor dal", logged_by: "Kabir", logged_at: "2026-10-06T07:35:00Z", deadline: "2026-10-08T07:35:00Z", waits: null, ...over,
});

function overview(drafts = [draft()], truncated = false): HouseholdOverview {
  return { date: "2026-10-06", members: [], meals: [], leftovers: [], waiting: [], waiting_on_you: { drafts, truncated } };
}

const inbox: InboxEntry[] = [{ id: 3, member: "Asha", date: "2026-10-06", meal_slot: "snack", text: "2 idli and the green chutney", spans: [], status: "pending", note: null, created_at: "2026-10-06T08:00:00Z" }];

describe("Waiting on you: the rows", () => {
  it("words each draft with who logged it, when, and when it confirms by itself, then the Inbox, read-only", () => {
    const { rows, more } = waitingRows(overview([
      draft(),
      draft({ table: "intake_item", id: 9, summary: "Greek yogurt", logged_at: "2026-10-06T08:05:00Z", deadline: "2026-10-08T08:05:00Z" }),
      draft({ table: "reading", id: 4, summary: "waist_navel", logged_by: null }),
    ]), inbox, TZ);
    expect(rows).toEqual([
      { key: "portion:7", ref: { table: "portion", id: 7 }, text: "Your share: Masoor dal", note: "Logged by Kabir Tue 13:05; confirms by itself Thu 13:05.", tickable: true },
      { key: "intake_item:9", ref: { table: "intake_item", id: 9 }, text: "Food: Greek yogurt", note: "Logged by Kabir Tue 13:35; confirms by itself Thu 13:35.", tickable: true },
      { key: "reading:4", ref: { table: "reading", id: 4 }, text: "Reading: waist navel", note: "Logged by someone Tue 13:05; confirms by itself Thu 13:05.", tickable: true },
      { key: "inbox:3", ref: null, text: "Inbox: \"2 idli and the green chutney\"", note: "Waiting for Claude; sent Tue 13:30.", tickable: false },
    ]);
    expect(more).toBeNull();
  });

  it("says why a row waits, and won't let it be ticked", () => {
    const { rows } = waitingRows(overview([draft({ table: "session_set", id: 5, summary: "Cable row", deadline: null, waits: "rir_needed" }), draft({ table: "session", id: 6, summary: "Upper A on 2026-10-05", deadline: null, waits: "end_of_session" })]), [], TZ);
    expect(rows.map((r) => [r.text, r.note, r.tickable])).toEqual([
      ["Set: Cable row", "Logged by Kabir Tue 13:05; needs RIR.", false],
      ["Session: Upper A on 2026-10-05", "Logged by Kabir Tue 13:05; waits for the end of the session.", false],
    ]);
  });

  // Review Focus 5: more than 100 drafts.
  it("says when more wait than are shown, and that they confirm by themselves", () => {
    expect(waitingRows(overview([draft()], true), [], TZ).more).toBe("More drafts are waiting than shown here. They confirm by themselves at their times; confirm or remove these to see the rest.");
  });

  it("leaves out \"Logged by\" when the draft has no logged_at (no version row), instead of failing", () => {
    const { rows } = waitingRows(overview([draft({ logged_at: "" }), draft({ table: "session_set", id: 5, logged_at: "", deadline: null, waits: "rir_needed" })]), [], TZ);
    expect(rows.map((r) => r.note)).toEqual(["Confirms by itself Thu 13:05.", "Needs RIR."]);
  });

  it("is empty when the API sends no list (an older Worker)", () => {
    const o = overview();
    delete o.waiting_on_you;
    expect(waitingRows(o, [], TZ).rows).toEqual([]);
  });
});

describe("Confirm N", () => {
  const rows: WaitingRow[] = waitingRows(overview([draft(), draft({ table: "intake_item", id: 9 }), draft({ table: "session_set", id: 5, waits: "rir_needed", deadline: null })]), inbox, TZ).rows;

  it("sends one confirm with every ticked draft, in the list's order", () => {
    const plan = confirmTickedPlan(rows, new Set(["intake_item:9", "portion:7"]));
    expect(plan?.steps).toHaveLength(1);
    expect(plan?.steps[0]).toMatchObject({ tool: "confirm", input: { records: [{ table: "portion", id: 7 }, { table: "intake_item", id: 9 }] } });
    expect(plan?.done).toBe("Confirmed 2 drafts.");
  });

  it("leaves out what can't be confirmed here: a waiting row, an Inbox entry, a tick for a row no longer listed", () => {
    expect(confirmTickedPlan(rows, new Set(["session_set:5", "inbox:3", "portion:99"]))).toBeNull();
    expect(confirmTickedPlan(rows, new Set(["portion:7", "portion:99"]))?.steps[0]?.input.records).toEqual([{ table: "portion", id: 7 }]);
  });
});

describe("the settled-row rule", () => {
  it("drops the ticked rows that left the list, and keeps the other ticks", () => {
    const now = waitingRows(overview([draft({ table: "intake_item", id: 9 })]), [], TZ).rows;
    expect(afterRefusal(new Set(["portion:7", "intake_item:9"]), now)).toEqual({ ticked: new Set(["intake_item:9"]), gone: ["portion:7"] });
  });

  it("finds nothing gone when every ticked row is still listed (a real refusal keeps its message)", () => {
    const now = waitingRows(overview([draft()]), [], TZ).rows;
    expect(afterRefusal(new Set(["portion:7"]), now)).toEqual({ ticked: new Set(["portion:7"]), gone: [] });
  });

  it("works out what left from the refused plan's records, not the ticks on screen, in the words of the rows the plan was made from", () => {
    const before = waitingRows(overview([draft(), draft({ table: "intake_item", id: 9, summary: "Greek yogurt" })]), [], TZ).rows;
    // A quiet re-read already dropped portion 7 from the screen; the re-read after the refusal lists only intake_item 9.
    const now = waitingRows(overview([draft({ table: "intake_item", id: 9, summary: "Greek yogurt" })]), [], TZ).rows;
    const out = settleRefusal([{ table: "portion", id: 7 }, { table: "intake_item", id: 9 }], now, before);
    expect(out.gone.map((r) => [r.key, r.text])).toEqual([["portion:7", "Your share: Masoor dal"]]);
    expect(out.ticked).toEqual(new Set(["intake_item:9"]));
  });

  it("finds nothing gone when every record of the plan is still listed, and keeps only the plan's tickable rows ticked", () => {
    const rows = waitingRows(overview([draft(), draft({ table: "session_set", id: 5, deadline: null, waits: "rir_needed" })]), [], TZ).rows;
    expect(settleRefusal([{ table: "portion", id: 7 }, { table: "session_set", id: 5 }], rows, rows)).toEqual({ gone: [], ticked: new Set(["portion:7"]) });
  });

  it("names a gone record missing from the rows it was made from by its table and id, so it still gets a note", () => {
    const out = settleRefusal([{ table: "leftover_serving", id: 12 }], [], []);
    expect(out.gone).toEqual([{ key: "leftover_serving:12", ref: { table: "leftover_serving", id: 12 }, text: "leftover serving 12", note: "", tickable: false }]);
  });

  const version = (over: Partial<HistoryVersion>): HistoryVersion => ({
    version: 2, action: "confirm", data: { state: "confirmed" }, created_at: "2026-10-08T07:35:00Z", resolver: "system", origin: "auto_confirm", tool: "auto_confirm", reason: null, actor: null, speaker: null, on_behalf_of: null, ...over,
  });

  it("says how a settled row settled, from its history", () => {
    expect(settledText([version({})], TZ)).toBe("Confirmed by itself on Thu 8 Oct 13:05.");
    expect(settledText([version({ resolver: "member", origin: "app" })], TZ)).toBe("Confirmed on Thu 8 Oct 13:05.");
    expect(settledText([version({ action: "reject", data: { state: "draft" } })], TZ)).toBe("Removed on Thu 8 Oct 13:05.");
    expect(settledText([version({ action: "create", data: { state: "draft" } })], TZ)).toBeNull();
    expect(settledText([], TZ)).toBeNull();
  });

  it("gives each gone row its note, or a plain one when its history couldn't be read or says it is still a draft", () => {
    const row = waitingRows(overview(), [], TZ).rows[0] as WaitingRow;
    expect(goneNote(row, [version({})], TZ)).toEqual({ key: "portion:7", text: "Your share: Masoor dal", said: "Confirmed by itself on Thu 8 Oct 13:05." });
    expect(goneNote(row, null, TZ).said).toBe("No longer waiting on you.");
    expect(goneNote(row, [version({ action: "create", data: { state: "draft" } })], TZ).said).toBe("No longer waiting on you.");
  });
});

describe("Not mine…", () => {
  it("needs a reason, never filled in, and rejects one record", () => {
    expect(rejectDraftPlan({ table: "portion", id: 7 }, "  ")).toEqual({ error: "Say why it isn't yours; the reason goes in its history." });
    expect(rejectDraftPlan({ table: "portion", id: 7 }, " I wasn't home ")).toMatchObject({ steps: [{ tool: "reject", input: { records: [{ table: "portion", id: 7 }], reason: "I wasn't home" } }], done: "Removed." });
  });
});
