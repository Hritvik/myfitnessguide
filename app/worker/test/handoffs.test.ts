// Hand-offs (redesign-a spec §2, §5): grouping, batches, the cap and the badge's count, pure. Invented data.
import { describe, expect, it } from "vitest";
import type { DraftInfo } from "../src/drafts";
import { capHandoffs, groupHandoffs, unitDrafts, unitsCount, waitingCount, type Batch, type Handoff } from "../src/handoffs";

const ASHA = 1;
const KABIR = 2;
const NOOR = 3;
let seq = 0;
const at = (iso: string) => ({ createdAt: iso, latestAt: iso });
const draft = (over: Partial<DraftInfo> = {}): DraftInfo => ({
  table: "intake_item", id: ++seq, owner: ASHA, loggedBy: KABIR, origin: "app", summary: "Curd", ...at("2026-10-07T07:50:00Z"),
  on: "2026-10-07", slot: "lunch", parent: null, everConfirmed: false, editedBy: null, questionIds: [], deadline: "2026-10-09T07:50:00Z", waits: null, ...over,
});

describe("groupHandoffs: one logger's food for one date and slot", () => {
  it("puts one logger's lunch for one date in one hand-off, however many sittings wrote it", () => {
    const units = groupHandoffs([draft(), draft({ summary: "Rice", ...at("2026-10-07T10:50:00Z"), deadline: "2026-10-09T10:50:00Z" })]);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ kind: "handoff", type: "food", logger: { member: KABIR, origin: "app" }, loggedAt: "2026-10-07T07:50:00Z", deadline: "2026-10-09T07:50:00Z", on: "2026-10-07", slot: "lunch" });
    expect((units[0] as Handoff).drafts.map((d) => d.summary)).toEqual(["Curd", "Rice"]);
  });

  it("splits by slot, by date, by logger, and names an Inbox draft's logger as the Inbox", () => {
    const units = groupHandoffs([
      draft(), draft({ slot: "dinner" }), draft({ loggedBy: NOOR }),
      draft({ loggedBy: null, origin: "inbox", ...at("2026-10-07T07:51:00Z") }),
    ]);
    expect(units.map((u) => (u as Handoff).logger)).toEqual([
      { member: KABIR, origin: "app" }, { member: KABIR, origin: "app" }, { member: NOOR, origin: "app" }, { member: null, origin: "inbox" },
    ]);
  });

  it("keeps a session with its sets, and a reading or a blood draw on its own", () => {
    const units = groupHandoffs([
      draft({ table: "session", id: 40, parent: 40, slot: null, summary: "Upper A on 2026-10-06" }),
      draft({ table: "session_set", id: 41, parent: 40, slot: null, summary: "Cable row", waits: "rir_needed", deadline: null }),
      draft({ table: "reading", id: 9, slot: null, summary: "weight", ...at("2026-10-07T07:51:00Z") }),
      draft({ table: "blood_draw", id: 3, slot: null, summary: "Sample Labs", ...at("2026-10-07T07:52:00Z") }),
    ]);
    expect(units.map((u) => [(u as Handoff).type, unitDrafts(u).length, (u as Handoff).waits, u.deadline])).toEqual([
      ["session", 2, "rir_needed", null], ["reading", 1, null, "2026-10-09T07:50:00Z"], ["blood_draw", 1, null, "2026-10-09T07:50:00Z"],
    ]);
  });

  it("holds a hand-off with a question: it waits, with no deadline, whatever its other drafts say", () => {
    const [h] = groupHandoffs([draft(), draft({ waits: "question", deadline: null, questionIds: [12] })]);
    expect(h).toMatchObject({ waits: "question", deadline: null });
  });
});

describe("groupHandoffs: batches (ruling 2)", () => {
  const backfill = (date: string, iso: string) => draft({ loggedBy: ASHA, owner: NOOR, on: date, slot: "lunch", ...at(iso), deadline: null });

  it("folds one logger's food over several dates, first writes within 2 hours of each other, into one batch with a row per day", () => {
    const units = groupHandoffs([
      backfill("2026-10-05", "2026-10-07T04:00:00Z"), draft({ loggedBy: ASHA, owner: NOOR, on: "2026-10-05", slot: "dinner", ...at("2026-10-07T04:10:00Z") }),
      backfill("2026-10-06", "2026-10-07T05:00:00Z"), backfill("2026-10-07", "2026-10-07T06:00:00Z"),
    ]);
    expect(units).toHaveLength(1);
    const b = units[0] as Batch;
    expect(b.kind).toBe("batch");
    expect(b.days.map((d) => [d.on, d.handoffs.length])).toEqual([["2026-10-05", 2], ["2026-10-06", 1], ["2026-10-07", 1]]);
    expect(unitsCount(units)).toBe(3);
  });

  it("chains at exactly 2 hours and breaks at 2 hours and a second", () => {
    expect(groupHandoffs([backfill("2026-10-05", "2026-10-07T04:00:00Z"), backfill("2026-10-06", "2026-10-07T06:00:00Z")]).map((u) => u.kind)).toEqual(["batch"]);
    expect(groupHandoffs([backfill("2026-10-05", "2026-10-07T04:00:00Z"), backfill("2026-10-06", "2026-10-07T06:00:01Z")]).map((u) => u.kind)).toEqual(["handoff", "handoff"]);
  });

  it("compares each first write with the one before it, so a chain may run longer than 2 hours in all", () => {
    const units = groupHandoffs([backfill("2026-10-05", "2026-10-07T04:00:00Z"), backfill("2026-10-06", "2026-10-07T05:30:00Z"), backfill("2026-10-07", "2026-10-07T07:00:00Z")]);
    expect(units.map((u) => u.kind)).toEqual(["batch"]);
  });

  it("never batches one date's meals, nor two loggers' food", () => {
    expect(groupHandoffs([draft(), draft({ slot: "dinner" })]).map((u) => u.kind)).toEqual(["handoff", "handoff"]);
    expect(groupHandoffs([draft({ on: "2026-10-06" }), draft({ loggedBy: NOOR })]).map((u) => u.kind)).toEqual(["handoff", "handoff"]);
  });

  it("keeps a re-draft inside its batch day with its own facts", () => {
    const units = groupHandoffs([backfill("2026-10-05", "2026-10-07T04:00:00Z"), draft({ loggedBy: ASHA, owner: NOOR, on: "2026-10-06", ...at("2026-10-07T04:30:00Z"), everConfirmed: true, editedBy: ASHA })]);
    expect((units[0] as Batch).days[1]?.handoffs[0]?.drafts[0]).toMatchObject({ everConfirmed: true, editedBy: ASHA });
  });
});

describe("groupHandoffs: oldest first, whatever order the drafts arrive in", () => {
  it("orders hand-offs, batches and a batch's days by their first write", () => {
    const food = (loggedBy: number, on: string, iso: string) => draft({ loggedBy, owner: NOOR, on, slot: "lunch", ...at(iso), deadline: null });
    const units = groupHandoffs([
      food(KABIR, "2026-10-07", "2026-10-07T04:30:00Z"),
      food(ASHA, "2026-10-07", "2026-10-07T05:00:00Z"),
      food(ASHA, "2026-10-06", "2026-10-07T06:00:00Z"),
      food(ASHA, "2026-10-05", "2026-10-07T04:00:00Z"),
      draft({ table: "reading", id: 90, slot: null, summary: "weight", ...at("2026-10-07T03:00:00Z") }),
      draft({ table: "blood_draw", id: 91, slot: null, summary: "Sample Labs", ...at("2026-10-07T07:30:00Z") }),
    ]);
    expect(units.map((u) => [u.kind, u.loggedAt])).toEqual([
      ["handoff", "2026-10-07T03:00:00Z"], ["batch", "2026-10-07T04:00:00Z"], ["handoff", "2026-10-07T04:30:00Z"],
      ["handoff", "2026-10-07T07:30:00Z"],
    ]);
    expect((units[1] as Batch).days.map((d) => d.on)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
  });
});

describe("the cap and the count (ruling 3 and 4)", () => {
  const day = (n: number, items: number): DraftInfo[] =>
    Array.from({ length: items }, () => draft({ on: `2026-09-${String(n).padStart(2, "0")}`, ...at(`2026-09-${String(n).padStart(2, "0")}T07:00:00Z`) }));

  it("cuts only between hand-offs, and counts everything", () => {
    const units = groupHandoffs([...day(1, 60), ...day(2, 30), ...day(3, 20)]);
    const { kept, truncated } = capHandoffs(units);
    expect(kept.map((u) => unitDrafts(u).length)).toEqual([60, 30]);
    expect(truncated).toBe(true);
    expect(waitingCount({ asks: 2, units, settle: 1 })).toBe(6);
  });

  it("counts a batch by its days in the badge", () => {
    const units = groupHandoffs([
      draft({ on: "2026-10-05", ...at("2026-10-07T04:00:00Z") }), draft({ on: "2026-10-06", ...at("2026-10-07T04:10:00Z") }), draft({ on: "2026-10-07", ...at("2026-10-07T04:20:00Z") }),
    ]);
    expect(units.map((u) => u.kind)).toEqual(["batch"]);
    expect(waitingCount({ asks: 1, units, settle: 1 })).toBe(5);
  });

  it("always keeps the first hand-off, even one of more than 100 drafts", () => {
    const units = groupHandoffs([...day(1, 120), ...day(2, 1)]);
    const { kept, truncated } = capHandoffs(units);
    expect(kept.map((u) => unitDrafts(u).length)).toEqual([120]);
    expect(truncated).toBe(true);
  });

  it("is not truncated at exactly 100", () => {
    expect(capHandoffs(groupHandoffs([...day(1, 50), ...day(2, 50)])).truncated).toBe(false);
  });
});
