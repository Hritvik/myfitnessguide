// planSet is log_set's logic with no writing and no per-set query, so a
// call can plan many sets against one load of everything they need.
import { describe, expect, it } from "vitest";
import { Ctx } from "../src/context";
import { loadSetScope, planSet, runningOrder, stageSets, type SetInput } from "../src/sets";
import { ExerciseIndex, sessionById } from "../src/training";
import { WriteTx } from "../src/write";
import { LOG_SET_BUDGET, toolWithinBudget } from "./budget";
import { bar20, busyInput, MONDAY } from "./input-seed";
import { writeLog } from "./fixtures";
import { setup, type Harness } from "./harness";
import { seedTraining } from "./seed";

async function speakerCtx(x: Harness): Promise<Ctx> {
  const ctx = new Ctx(x.counter, { kind: "agent", resolver: "claude_code", householdId: x.h.id, clientId: "test" }, () => x.clock.now, "Asia/Kolkata");
  ctx.write = { origin: "live", speaker: await ctx.memberById(x.h.hritvik), onBehalfOf: null };
  return ctx;
}

describe("ExerciseIndex", () => {
  it("finds an exercise by name or alias in one statement, and asks with the closest names", async () => {
    const { x } = await busyInput(23);
    const ctx = await speakerCtx(x);
    x.counter.reset();
    const index = await ExerciseIndex.load(ctx);
    expect(x.counter.count).toBe(1);
    expect(index.find("pulldown", []).name).toBe("Cable lat pulldown");
    expect(index.find("LAT PULLDOWN", []).name).toBe("Cable lat pulldown");
    expect(index.lookup("no such lift")).toBeNull();
    expect(() => index.find("bench pres", ["exercise"])).toThrow(/Which exercise/);
  });
});

describe("planSet", () => {
  it("plans several sets of one session in memory: set numbers per exercise, positions in order, links, no query per set", async () => {
    const { x, p } = await busyInput(40);
    const ctx = await speakerCtx(x);
    const session = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper A" })).session.id;
    const row = await sessionById(ctx, session);
    const scope = await loadSetScope(ctx, row, { fresh: false, names: ["bench", "lat pulldown"] });
    const running = runningOrder(scope.existing);
    x.counter.reset();
    const a = await planSet(ctx, scope, { exercise: "bench", reps: 10, rir: 2, load: { value: 12.5, unit: "lb", basis: "per_side", bar: bar20 } }, running);
    const b = await planSet(ctx, scope, { exercise: "lat pulldown", reps: 12, rir: 2, load: { value: 40, unit: "kg", basis: "total" } }, running);
    const c = await planSet(ctx, scope, { exercise: "bench", reps: 9, rir: 1, load: { value: 12.5, unit: "lb", basis: "per_side", bar: bar20 } }, running);
    expect(x.counter.count).toBe(0);
    expect([a, b, c].map((s) => [s.row.set_number, s.row.position, s.row.prescription_id])).toEqual([[1, 1, p.bench], [1, 2, p.pulldown], [2, 3, p.bench]]);
    expect(a.row.state).toBe("confirmed");
  });

  it("asks at the set's own path", async () => {
    const { x } = await busyInput(23);
    const ctx = await speakerCtx(x);
    const session = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength" })).session.id;
    const scope = await loadSetScope(ctx, await sessionById(ctx, session), { fresh: false, names: ["bench"] });
    await expect(planSet(ctx, scope, { exercise: "bench", reps: 10, load: { value: 12.5, unit: "lb", basis: "per_side", bar: bar20 } }, runningOrder([]), ["sets", 4])).rejects.toMatchObject({
      reason: "rir_needed",
      path: ["sets", 4, "rir"],
    });
  });
});

describe("log_set through planSet", () => {
  it(`by session_id: at most ${LOG_SET_BUDGET} at 40 implements`, async () => {
    const { x } = await busyInput(40);
    const session = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength", template: "Upper A" })).session.id;
    const run = await toolWithinBudget(x, "log_set", { session_id: session, exercise: "lat pulldown", reps: 10, rir: { low: 2, high: 2 }, load: { value: 40, unit: "kg", basis: "total" } }, "agent", LOG_SET_BUDGET);
    expect(run.body.set).toMatchObject({ exercise: "Cable lat pulldown", set_number: 1, position: 1, total_kg: 40, state: "confirmed" });
  });
});

describe("stageSets with several sets in one call", () => {
  // Three stored sets, then four planned in one call: A appended, B at 1, C appended, D at 3.
  const stored = ["S1", "S2", "S3"];
  const planned: [string, number | undefined][] = [["A", undefined], ["B", 1], ["C", undefined], ["D", 3]];
  const set = (note: string, position?: number): SetInput => ({ exercise: "Push-up", reps: 10, rir: 2, load: "none", note, ...(position === undefined ? {} : { position }) });

  async function session() {
    const x = setup();
    seedTraining(x);
    const id = (await x.ok("start_session", { member: "Hritvik", date: MONDAY, session_type: "strength" })).session.id;
    for (const note of stored) await x.ok("log_set", { session_id: id, ...set(note) });
    const order = () => x.t.all("SELECT note, set_number, position FROM session_set WHERE session_id = ? ORDER BY position", id);
    return { x, id, order };
  }

  it("places every set as the same log_set calls one by one would, with unique positions", async () => {
    const one = await session();
    for (const [note, position] of planned) await one.x.ok("log_set", { session_id: one.id, ...set(note, position) });

    const { x, id, order } = await session();
    const ctx = await speakerCtx(x);
    const w = writeLog(x.t);
    ctx.tx = new WriteTx(x.counter, w, "2026-10-05T07:30:00Z");
    const scope = await loadSetScope(ctx, await sessionById(ctx, id), { fresh: false, names: ["Push-up"] });
    const running = runningOrder(scope.existing);
    const plans = [];
    for (const [note, position] of planned) plans.push(await planSet(ctx, scope, set(note, position), running));
    const staged = await stageSets(ctx, scope, plans);
    await x.counter.batch(ctx.tx.finish());

    const expected = [
      { note: "B", position: 1 }, { note: "S1", position: 2 }, { note: "D", position: 3 }, { note: "S2", position: 4 },
      { note: "S3", position: 5 }, { note: "A", position: 6 }, { note: "C", position: 7 },
    ];
    expect((await order()).map((r: any) => ({ note: r.note, position: r.position }))).toEqual(expected);
    expect(await order()).toEqual(await one.order());
    expect(staged.sets.map((s) => s.set.position)).toEqual([6, 1, 7, 3]);
    // Each moved stored set is versioned once, at its final position.
    expect(x.t.all("SELECT json_extract(data, '$.note') AS note, json_extract(data, '$.position') AS position FROM record_version WHERE write_id = ? AND action = 'amend' ORDER BY record_id", w)).toEqual([
      { note: "S1", position: 2 },
      { note: "S2", position: 4 },
      { note: "S3", position: 5 },
    ]);
  });
});
