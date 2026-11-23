// The fixed costs of a call, and many-row writes, in as few D1 statements
// as possible (decision 96): every later budget rests on these.
import { describe, expect, it } from "vitest";
import { Catalogue } from "../src/catalogue";
import { Ctx } from "../src/context";
import { WriteTx } from "../src/write";
import { CountingDb } from "./counting";
import { NOW } from "./db";
import { LOG_SET_BUDGET, READ_BUDGET, toolWithinBudget } from "./budget";
import { foodSource, household, writeLog } from "./fixtures";
import { setup } from "./harness";
import { seedCatalogue } from "./seed";
import { SqliteDb } from "./sqlite";

describe("the budget helpers (test/budget.ts)", () => {
  it("toolWithinBudget runs a tool through the counting adapter, asserts the budget and returns the run", async () => {
    const x = setup();
    const run = await toolWithinBudget(x, "whoami", {}, "hritvik");
    expect(run.body.members).toEqual(["Hritvik", "Asha", "Kabir"]);
    expect(run.statements).toBe(1);
    expect([LOG_SET_BUDGET, READ_BUDGET]).toEqual([25, 30]);
  });
});

describe("a call's fixed cost", () => {
  it("reads a member caller and the household's members in one statement", async () => {
    const x = setup();
    const run = await x.counted("whoami", {}, "hritvik");
    expect(run.body.members).toEqual(["Hritvik", "Asha", "Kabir"]);
    expect(run.statements).toBe(1);
  });

  it("reads the agent's household and its members in one statement", async () => {
    const x = setup();
    const run = await x.counted("whoami", {}, "agent");
    expect(run.body.member).toBeNull();
    expect(run.statements).toBe(1);
  });

  it("checks a write's key and takes its write id in one statement", async () => {
    const x = setup();
    // caller+members 1, key+write id 1, then the batch: write_log, day_status, idempotency_key.
    const run = await x.counted("set_day_status", { member: "Hritvik", date: "2026-10-05", status: "open" }, "hritvik");
    expect(run.statements).toBe(5);
  });

  it("still replays a retried write from its key", async () => {
    const x = setup();
    const input = { member: "Hritvik", date: "2026-10-05", status: "open", idempotency_key: "k-replay" };
    const first = await x.call("set_day_status", input, "hritvik");
    const again = await x.raw("/tools/set_day_status", { method: "POST", body: JSON.stringify(input), as: "hritvik" });
    expect(again.body).toEqual(first.body);
    const clash = await x.call("set_day_status", { ...input, status: "complete" }, "hritvik");
    expect(clash.http).toBe(409);
  });
});

describe("WriteTx.createMany and finish", () => {
  function tx() {
    const db = new SqliteDb();
    const h = household(db.test);
    const w = writeLog(db.test);
    const counter = new CountingDb(db);
    return { db, t: db.test, h, w, counter, tx: new WriteTx(counter, w, NOW) };
  }

  it("inserts many rows of a table in one statement and their first versions in one more", async () => {
    const { t, h, w, counter, tx: write } = tx();
    const ids = await write.createMany("gym", [{ household_id: h.id, name: "A" }, { household_id: h.id, name: "B" }, { household_id: h.id, name: "C" }]);
    expect(ids).toEqual([1, 2, 3]);
    const statements = write.finish();
    expect(statements).toHaveLength(2);
    counter.reset();
    await counter.batch(statements);
    expect(counter.count).toBe(2);
    expect(t.all("SELECT id, name FROM gym ORDER BY id")).toEqual([{ id: 1, name: "A" }, { id: 2, name: "B" }, { id: 3, name: "C" }]);
    expect(t.all("SELECT table_name, record_id, version, action, json_extract(data, '$.name') AS name FROM record_version WHERE write_id = ? ORDER BY record_id", w)).toEqual([
      { table_name: "gym", record_id: 1, version: 1, action: "create", name: "A" },
      { table_name: "gym", record_id: 2, version: 1, action: "create", name: "B" },
      { table_name: "gym", record_id: 3, version: 1, action: "create", name: "C" },
    ]);
  });

  it("puts every table's first versions in the one statement, and keeps given ids", async () => {
    const { t, h, w, tx: write } = tx();
    const [food] = await write.createMany("food_source", [{ household_id: h.id, ref: "FS901", name: "Curd", state: "as_sold", reference_amount: 100, reference_unit: "g", kcal: 60, protein_g: 3.5, carbs_g: 4.7, fat_g: 3.1 }]);
    await write.createMany("measure", [{ id: 40, food_source_id: food as number, name: "katori", amount: 150 }]);
    const statements = write.finish();
    expect(statements).toHaveLength(3);
    await (write.db as CountingDb).batch(statements);
    expect(t.get("SELECT id, typeof(amount) AS amount_type FROM measure")).toEqual({ id: 40, amount_type: "real" });
    expect(t.all("SELECT table_name, record_id FROM record_version WHERE write_id = ? ORDER BY table_name", w)).toEqual([
      { table_name: "food_source", record_id: food },
      { table_name: "measure", record_id: 40 },
    ]);
  });

  it("keeps text that looks like a number as text, and NULL as NULL", async () => {
    const { t, h, tx: write } = tx();
    const food = foodSource(t, h);
    await write.createMany("measure", [{ food_source_id: food, name: "12", amount: 2.5 }]);
    await (write.db as CountingDb).batch(write.finish());
    expect(t.get("SELECT typeof(name) AS name_type, name, amount FROM measure WHERE food_source_id = ?", food)).toEqual({ name_type: "text", name: "12", amount: 2.5 });
  });

  it("never reuses a removed record's id: the new record's first version is 1 (decision 131)", async () => {
    const { t, h, w, tx: write } = tx();
    const older = writeLog(t);
    t.insert("record_version", { write_id: older, table_name: "gym", record_id: 1, version: 1, action: "create", data: "{}", created_at: NOW });
    t.insert("record_version", { write_id: older, table_name: "gym", record_id: 1, version: 2, action: "reject", data: "{}", created_at: NOW });
    const [id] = await write.createMany("gym", [{ household_id: h.id, name: "Again" }]);
    expect(id).toBe(2);
    await (write.db as CountingDb).batch(write.finish());
    expect(t.all("SELECT record_id, version FROM record_version WHERE write_id = ? AND table_name = 'gym'", w)).toEqual([{ record_id: 2, version: 1 }]);
  });

  it("allocates and reserves past a removed top id, in the statement that reads max(id) (decision 131)", async () => {
    const { t, h, counter, tx: write } = tx();
    foodSource(t, h);
    const older = writeLog(t);
    // food_source 5 and gym 3 were removed: only their versions are left. Another table's versions don't count.
    t.insert("record_version", { write_id: older, table_name: "food_source", record_id: 5, version: 1, action: "create", data: "{}", created_at: NOW });
    t.insert("record_version", { write_id: older, table_name: "gym", record_id: 3, version: 1, action: "retract", data: "{}", created_at: NOW });
    t.insert("record_version", { write_id: older, table_name: "session", record_id: 9, version: 1, action: "create", data: "{}", created_at: NOW });
    counter.reset();
    await write.reserve(["food_source", "gym", "session_set"]);
    expect(counter.count).toBe(1);
    expect([await write.allocate("food_source"), await write.allocate("gym"), await write.allocate("session_set")]).toEqual([6, 4, 1]);
    // allocate() on its own (no reserve) reads the same way, in one statement.
    expect(await write.allocate("session")).toBe(10);
    expect(counter.count).toBe(2);
  });

  it("reserves the next id of several tables in one statement", async () => {
    const { t, h, counter, tx: write } = tx();
    foodSource(t, h);
    counter.reset();
    await write.reserve(["food_source", "gym", "session"]);
    expect(counter.count).toBe(1);
    expect(await write.allocate("food_source")).toBe(2);
    expect(await write.allocate("gym")).toBe(1);
    expect(counter.count).toBe(1);
  });

  it("lets a column's DEFAULT apply to a row that omits it: one statement per distinct key set", async () => {
    const { t, h, tx: write } = tx();
    const gym = t.insert("gym", { household_id: h.id, name: "Invented gym" });
    const base = { gym_id: gym, kind: "dumbbell", unit: "kg", loading: "total" };
    await write.createMany("implement", [
      { ...base, name: "A" },
      { ...base, name: "B", load_list_complete: 0 },
      { ...base, name: "C" },
    ]);
    const statements = write.finish();
    expect(statements).toHaveLength(3); // two key sets, then the versions
    await (write.db as CountingDb).batch(statements);
    expect(t.all("SELECT id, name, load_list_complete FROM implement ORDER BY id")).toEqual([
      { id: 1, name: "A", load_list_complete: 1 },
      { id: 2, name: "B", load_list_complete: 0 },
      { id: 3, name: "C", load_list_complete: 1 },
    ]);
  });

  it("keeps rows of one key set in one statement whatever their key order", async () => {
    const { h, tx: write } = tx();
    await write.createMany("gym", [{ household_id: h.id, name: "A" }, { name: "B", household_id: h.id }]);
    expect(write.finish()).toHaveLength(2);
  });

  it("allocates past an id a row kept, in the same call and in a later one", async () => {
    const { t, h, tx: write } = tx();
    const ids = await write.createMany("gym", [{ id: 7, household_id: h.id, name: "Kept" }, { household_id: h.id, name: "Next" }]);
    expect(ids).toEqual([7, 8]);
    expect(await write.allocate("gym")).toBe(9);
    await (write.db as CountingDb).batch(write.finish());
    expect(t.all("SELECT id FROM gym ORDER BY id")).toEqual([{ id: 7 }, { id: 8 }]);
  });

  it("refuses to version again a row createMany made in the same call", async () => {
    const { h, tx: write } = tx();
    const [id] = await write.createMany("gym", [{ household_id: h.id, name: "A" }]);
    expect(() => write.update("gym", id as number, { name: "B" }, { name: "B" })).toThrow(/createMany/);
    expect(() => write.remove("gym", id as number, {}, "reject")).toThrow(/createMany/);
  });

  it("finishes a call with no createMany as the statements it already had", () => {
    const { tx: write } = tx();
    write.exec("SELECT 1");
    expect(write.finish()).toEqual(write.statements);
  });
});

describe("Catalogue.load", () => {
  it("reads every food source with its measures and yields in one statement", async () => {
    const x = setup();
    await seedCatalogue(x);
    const ctx = new Ctx(x.counter, { kind: "agent", resolver: "claude_code", householdId: x.h.id, clientId: "test" }, () => new Date(NOW), "Asia/Kolkata");
    x.counter.reset();
    const cat = await Catalogue.load(ctx);
    expect(x.counter.count).toBe(1);
    expect(cat.rows.map((r) => r.ref)).toEqual(["FS001", "FS002", "FS003", "FS004", "FS005", "FS006"]);
    expect(cat.measures.map((m) => [m.name, m.amount])).toEqual(expect.arrayContaining([["egg", 50], ["tsp", 4.5]]));
    expect(cat.yields).toEqual([{ food: "rice", fromState: "dry", toState: "cooked", factor: 3, discardedFraction: 0 }]);
    expect(cat.resolve({ food: "rice", value: 100, unit: "g", state: "dry" }, ["x"]).stored).toEqual({ amount_value: 100, amount_unit: "g", measure_id: null });
    expect(cat.rows[0]).not.toHaveProperty("_measures");
  });
});
