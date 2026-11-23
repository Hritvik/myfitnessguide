// Ticket 55 (decision 132): a draft is decided once. Decisions are serialized
// by the write-log id reservation: every write takes max(write_log.id) + 1
// before it reads, so a write that commits between another call's reads and
// its batch has taken that id, the later batch fails on write_log's primary
// key, and the call runs again on fresh reads. Each test lands a competing
// write in exactly that window. Invented readings only.
import { describe, expect, it } from "vitest";
import { autoConfirm } from "../src/autoconfirm";
import type { DbStatement } from "../src/db";
import { setup, type Harness } from "./harness";
import { seedTraining } from "./seed";

const weight = (value: number, member = "Asha") => ({ member, date: "2026-10-04", metric: "weight", value, unit: "kg", body_state: "fasted" });

/** The write id a call's batch carries: the id bound to its write_log INSERT. */
function batchWriteId(statements: DbStatement[]): number | null {
  for (const st of statements as unknown as { sql: string; inner: { params: unknown[] } }[]) {
    if (/^\s*INSERT INTO write_log\b/.test(st.sql)) return st.inner.params[0] as number;
  }
  return null;
}

const maxWriteId = (x: Harness) => (x.t.get("SELECT coalesce(max(id), 0) AS m FROM write_log") as { m: number }).m;

/**
 * Run `competitor` just before the next batch reaches the database (after the call's reads, before its
 * write), and record the batches the call itself sends afterwards: how many, the write id its first one
 * carried, and the write id the competitor committed.
 */
function landsFirst(x: Harness, competitor: () => Promise<unknown>): { loserBatches: number; loserFirstId: number | null; competitorId: number | null } {
  const batch = x.counter.batch.bind(x.counter);
  const seen = { loserBatches: 0, loserFirstId: null as number | null, competitorId: null as number | null };
  let phase: "before" | "competing" | "after" = "before";
  x.counter.batch = async (statements: DbStatement[]) => {
    if (phase === "before") {
      phase = "competing";
      seen.loserFirstId = batchWriteId(statements);
      await competitor();
      seen.competitorId = maxWriteId(x);
      phase = "after";
    }
    if (phase === "after") seen.loserBatches++;
    return batch(statements);
  };
  return seen;
}

/** A draft reading about Asha (the agent logs it talking with Hritvik). */
async function draftReading(x: Harness, value = 61): Promise<number> {
  const reading = (await x.ok("log_reading", weight(value))).reading;
  expect(reading.state).toBe("draft");
  return reading.id as number;
}

const actions = async (x: Harness, id: number) =>
  ((await x.ok("history", { table: "reading", id }, "asha")).versions as { action: string; tool: string | null }[]).map((v) => `${v.action}:${v.tool}`);

const state = (x: Harness, id: number) => x.t.get("SELECT state FROM reading WHERE id = ?", id);

describe("confirm against the hourly auto-confirm", () => {
  it("auto-confirm first: confirm runs again and answers 409 not_draft with the index, writing nothing", async () => {
    const x = setup();
    const id = await draftReading(x);
    x.advanceHours(49);
    landsFirst(x, () => autoConfirm(x.counter, x.clock.now));
    const reply = await x.call("confirm", { records: [{ table: "reading", id }] }, "asha");
    expect([reply.http, reply.body.error.code, reply.body.error.index]).toEqual([409, "not_draft", 0]);
    expect(state(x, id)).toEqual({ state: "confirmed" });
    expect(await actions(x, id)).toEqual(["create:log_reading", "confirm:auto_confirm"]);
  });

  it("the member's confirm first: the auto-confirm reads the drafts again and confirms nothing twice", async () => {
    const x = setup();
    const id = await draftReading(x);
    const other = await draftReading(x, 61.2);
    x.advanceHours(49);
    landsFirst(x, () => x.ok("confirm", { records: [{ table: "reading", id }] }, "asha"));
    const result = await autoConfirm(x.counter, x.clock.now);
    expect(result.confirmed).toEqual([{ table: "reading", id: other }]);
    expect(await actions(x, id)).toEqual(["create:log_reading", "confirm:confirm"]);
    expect(await actions(x, other)).toEqual(["create:log_reading", "confirm:auto_confirm"]);
  });
});

describe("reject against a confirm that lands first", () => {
  it("the record survives, confirmed, and reject answers 409 not_draft with the index", async () => {
    const x = setup();
    const id = await draftReading(x);
    landsFirst(x, () => x.ok("confirm", { records: [{ table: "reading", id }] }, "asha"));
    const reply = await x.call("reject", { records: [{ table: "reading", id }], reason: "not my weight" }, "asha");
    expect([reply.http, reply.body.error.code, reply.body.error.index]).toEqual([409, "not_draft", 0]);
    expect(state(x, id)).toEqual({ state: "confirmed" });
    expect(await actions(x, id)).toEqual(["create:log_reading", "confirm:confirm"]);
  });
});

describe("reject against the auto-confirm landing first", () => {
  it("the record survives, confirmed by the auto-confirm, and reject answers 409 not_draft with the index", async () => {
    const x = setup();
    const id = await draftReading(x);
    x.advanceHours(49);
    landsFirst(x, () => autoConfirm(x.counter, x.clock.now));
    const reply = await x.call("reject", { records: [{ table: "reading", id }], reason: "not my weight" }, "asha");
    expect([reply.http, reply.body.error.code, reply.body.error.index]).toEqual([409, "not_draft", 0]);
    expect(state(x, id)).toEqual({ state: "confirmed" });
    expect(await actions(x, id)).toEqual(["create:log_reading", "confirm:auto_confirm"]);
  });
});

describe("end_session against a confirm landing first", () => {
  it("runs again and confirms only what is still a draft: the member's confirmed set gets no second confirm", async () => {
    const x = setup();
    const s = seedTraining(x);
    const session = (await x.ok("start_session", { origin: "coach", member: "Hritvik", date: "2026-10-05", session_type: "strength" })).session.id;
    const logSet = async () =>
      (await x.ok("log_set", { origin: "coach", session_id: session, exercise: "lat pulldown", reps: 12, rir: { low: 1, high: 2 }, load: { value: 40, unit: "kg", basis: "total", implement: s.stack } })).set.id as number;
    const first = await logSet();
    const second = await logSet();
    landsFirst(x, () => x.ok("confirm", { records: [{ table: "session_set", id: first }] }, "hritvik"));
    const body = await x.ok("end_session", { origin: "coach", session_id: session });
    expect(body.session.state).toBe("confirmed");
    expect(body.confirmed_sets).toBe(1);
    const setActions = async (id: number) =>
      ((await x.ok("history", { table: "session_set", id }, "hritvik")).versions as { action: string; tool: string }[]).map((v) => `${v.action}:${v.tool}`);
    expect(await setActions(first)).toEqual(["create:log_set", "confirm:confirm"]);
    expect(await setActions(second)).toEqual(["create:log_set", "confirm:end_session"]);
  });
});

describe("two confirms", () => {
  it("the second answers 409 not_draft with the index, and its batch (the other record too) is not written", async () => {
    const x = setup();
    const a = await draftReading(x);
    const b = await draftReading(x, 61.3);
    landsFirst(x, () => x.ok("confirm", { records: [{ table: "reading", id: b }] }, "asha"));
    const reply = await x.call("confirm", { records: [{ table: "reading", id: a }, { table: "reading", id: b }] }, "asha");
    expect([reply.http, reply.body.error.code, reply.body.error.index]).toEqual([409, "not_draft", 1]);
    expect(state(x, a)).toEqual({ state: "draft" });
    expect(await actions(x, b)).toEqual(["create:log_reading", "confirm:confirm"]);
    expect(await actions(x, a)).toEqual(["create:log_reading"]);
  });
});

describe("an amend that would accept a draft another call confirmed", () => {
  it("runs again on the confirmed record: the edit lands as an amend, with no second confirm", async () => {
    const x = setup();
    const id = await draftReading(x);
    const confirmedAt = () => x.t.get("SELECT confirmed_at FROM reading WHERE id = ?", id);
    let first: unknown;
    landsFirst(x, async () => {
      await x.ok("confirm", { records: [{ table: "reading", id }] }, "asha");
      first = confirmedAt();
    });
    x.advanceHours(1);
    const body = await x.ok("amend", { record: { table: "reading", id }, changes: { value: 60.8 }, reason: "misread the scale" }, "asha");
    expect(body.after).toMatchObject({ value: 60.8, state: "confirmed" });
    // The confirm's time stands: the amend did not accept the record a second time.
    expect(confirmedAt()).toEqual(first);
    expect(await actions(x, id)).toEqual(["create:log_reading", "confirm:confirm", "amend:amend"]);
  });
});

describe("the invariant: a write's id is reserved, as max(write_log.id) + 1, before it reads", () => {
  it("any write committing between a call's reads and its batch makes the call run again: even one about another record", async () => {
    const x = setup();
    const id = await draftReading(x);
    // The competitor touches nothing the confirm reads: only the write id makes the confirm run again.
    const seen = landsFirst(x, () => x.ok("log_reading", weight(80.1, "Hritvik"), "hritvik"));
    const body = await x.ok("confirm", { records: [{ table: "reading", id }] }, "asha");
    expect(seen.loserBatches).toBe(2);
    expect(body.confirmed).toEqual([{ table: "reading", id }]);
    expect(body.write_id).toBe((x.t.get("SELECT max(id) AS m FROM write_log") as { m: number }).m);
  });

  it("the same for the auto-confirm", async () => {
    const x = setup();
    const id = await draftReading(x);
    x.advanceHours(49);
    let batches = 0;
    const batch = x.counter.batch.bind(x.counter);
    let competed = false;
    x.counter.batch = async (statements: DbStatement[]) => {
      if (!competed) {
        competed = true;
        await x.ok("log_reading", weight(80.1, "Hritvik"), "hritvik");
      }
      batches++;
      return batch(statements);
    };
    const result = await autoConfirm(x.counter, x.clock.now);
    // The competitor's own batch, the auto-confirm's failed one, and its re-run.
    expect(batches).toBe(3);
    expect(result.confirmed).toEqual([{ table: "reading", id }]);
  });

  it("the competitor commits the very write id the loser reserved before reading, so the loser's first batch can't land", async () => {
    const x = setup();
    const id = await draftReading(x);
    const reserved = maxWriteId(x) + 1;
    const seen = landsFirst(x, () => x.ok("confirm", { records: [{ table: "reading", id }] }, "asha"));
    const reply = await x.call("reject", { records: [{ table: "reading", id }], reason: "not my weight" }, "asha");
    expect(reply.http).toBe(409);
    // The loser's first batch carried an id it took before its reads (max + 1 at that moment), and the
    // competitor committed exactly that id. An id SQLite assigns, or one taken inside the batch (NULL, or a
    // max + 1 subquery), would differ, the loser's batch would land on its stale reads, and this fails.
    expect(seen.loserFirstId).toBe(reserved);
    expect(seen.competitorId).toBe(seen.loserFirstId);
  });
});

describe("when every attempt loses its write id", () => {
  /** Land a write about another record before each of the call's batches: every attempt collides. */
  function alwaysLoses(x: Harness): void {
    const batch = x.counter.batch.bind(x.counter);
    let competing = false;
    let value = 80;
    x.counter.batch = async (statements: DbStatement[]) => {
      if (!competing) {
        competing = true;
        await x.ok("log_reading", weight((value += 0.1), "Hritvik"), "hritvik");
        competing = false;
      }
      return batch(statements);
    };
  }

  it("answers a retryable 503 busy, writes nothing, and the same key then saves once", async () => {
    const x = setup();
    const id = await draftReading(x);
    const restore = x.counter.batch;
    alwaysLoses(x);
    const input = { records: [{ table: "reading", id }], idempotency_key: "k-busy-confirm" };
    const reply = await x.call("confirm", input, "asha");
    expect([reply.http, reply.body.error.code, reply.body.error.message]).toEqual([503, "busy", "The app is busy; try again."]);
    expect(state(x, id)).toEqual({ state: "draft" });
    expect(x.t.get("SELECT count(*) AS n FROM idempotency_key WHERE key = 'k-busy-confirm'")).toEqual({ n: 0 });
    x.counter.batch = restore;
    expect((await x.ok("confirm", input, "asha")).confirmed).toEqual([{ table: "reading", id }]);
    expect(await actions(x, id)).toEqual(["create:log_reading", "confirm:confirm"]);
  });

  it("another UNIQUE failure stays a 422 constraint", async () => {
    const x = setup();
    const t = seedTraining(x);
    const batch = x.counter.batch.bind(x.counter);
    let pending = true;
    x.counter.batch = async (statements: DbStatement[]) => {
      if (pending) {
        pending = false;
        // The same word, taught directly under a distant id (no write log, no id collision): the loser's
        // write id is free, but its alias meets UNIQUE (household_id, alias).
        x.t.insert("alias", { id: 900, household_id: x.h.id, alias: "invented word", kind: "exercise", target_id: t.pulldown, created_at: "2026-10-01T00:00:00Z" });
      }
      return batch(statements);
    };
    const reply = await x.call("learn_alias", { alias: "invented word", kind: "exercise", target: "Cable lat pulldown", reason: "what we call it" }, "asha");
    expect([reply.http, reply.body.error?.code], JSON.stringify(reply.body)).toEqual([422, "constraint"]);
  });
});

describe("decisions that stay legitimate", () => {
  it("amend of a confirmed record, retract of a confirmed reading, and the auto-confirm of a draft", async () => {
    const x = setup();
    const mine = (await x.ok("log_reading", weight(60.9), "asha")).reading;
    expect(mine.state).toBe("confirmed");
    const amended = await x.ok("amend", { record: { table: "reading", id: mine.id }, changes: { value: 60.7, note: "invented" }, reason: "typo" }, "asha");
    expect(amended.after).toMatchObject({ value: 60.7, state: "confirmed" });
    await x.ok("retract", { records: [{ table: "reading", id: mine.id }], reason: "logged twice" }, "asha");
    expect(x.t.get("SELECT count(*) AS n FROM reading WHERE id = ?", mine.id)).toEqual({ n: 0 });

    const draft = await draftReading(x);
    x.advanceHours(49);
    expect((await autoConfirm(x.counter, x.clock.now)).confirmed).toEqual([{ table: "reading", id: draft }]);
    expect(state(x, draft)).toEqual({ state: "confirmed" });
  });
});
