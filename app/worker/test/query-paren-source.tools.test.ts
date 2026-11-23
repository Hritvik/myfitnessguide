// A parenthesized source is still a source (Worker decision 138). SQLite
// reads `FROM (name)` as a table reference, not a subquery, so checkQuery
// keeps expecting a source inside a "(" that follows FROM, JOIN or a
// FROM-list comma unless it opens SELECT, WITH or VALUES. Members are
// refused `query` outright (decision 136); memberRefusal is the gate a
// member-facing query would pass. The agent goes through the same guard.
// Invented data only.
import { describe, expect, it } from "vitest";
import { checkQuery, QueryRefused } from "../src/query";
import { memberRefusal, OWNER_ONLY_VIEWS } from "../src/tools/query";
import { setup, type Harness } from "./harness";
import { TestDb } from "./db";

const SECRET = "BMR 1650 from the BIA scan";
const OWNER_ONLY = [...OWNER_ONLY_VIEWS];
const RAW = ["target", "reading", "lab_result", "flag", "member_note_version", "phase"];

/** The real schema's views and tables, as the tool reads them. */
function schema() {
  const t = new TestDb();
  const rows = t.all("SELECT type, lower(name) AS name FROM sqlite_master WHERE type IN ('table', 'view')") as { type: string; name: string }[];
  return { views: new Set(rows.filter((r) => r.type === "view").map((r) => r.name)), tables: new Set(rows.filter((r) => r.type === "table").map((r) => r.name)) };
}

async function secrets(x: Harness) {
  await x.ok("set_target", { member: "Hritvik", effective_from: "2026-10-01", provenance: "agent", reasoning: SECRET, values: [{ nutrient: "kcal", kind: "target", value: 2100 }] });
  await x.ok("write_member_note", { member: "Hritvik", topic: "bia", body: SECRET });
}

const shapes = (name: string) => [
  `SELECT * FROM (${name})`,
  `SELECT * FROM ((${name}))`,
  `SELECT * FROM v_food_source JOIN (${name}) ON 1 = 1`,
  `SELECT * FROM v_food_source AS a, (${name}) AS b`,
  `SELECT * FROM ("${name}")`,
  `SELECT * FROM ([${name}])`,
  `SELECT * FROM (\`${name}\`)`,
  `SELECT * FROM (${name.toUpperCase()})`,
  `SELECT * FROM (SELECT * FROM v_food_source) AS f JOIN (${name}) ON 1 = 1`,
];

describe("a parenthesized name is checked like any source", () => {
  it("checkQuery reports every parenthesized owner-only view as read, in every shape, so a member gate sees it", () => {
    const { views, tables } = schema();
    for (const name of OWNER_ONLY) {
      for (const sql of shapes(name)) {
        expect([sql, checkQuery(sql, views, tables).views]).toEqual([sql, expect.arrayContaining([name])]);
        expect([sql, memberRefusal(sql, checkQuery(sql, views, tables).views, tables)]).toEqual([sql, expect.arrayContaining([name])]);
      }
    }
  });

  it("checkQuery refuses a parenthesized raw table in every shape", () => {
    const { views, tables } = schema();
    for (const name of RAW) for (const sql of shapes(name)) expect(() => checkQuery(sql, views, tables), sql).toThrow(QueryRefused);
  });

  it("refuses a raw table in parentheses to the agent too, with nothing leaked", async () => {
    const x = setup();
    await secrets(x);
    for (const name of RAW) {
      for (const sql of shapes(name)) {
        const r = await x.call("query", { sql });
        expect([sql, r.http, JSON.stringify(r.body).includes(SECRET)]).toEqual([sql, 400, false]);
      }
    }
  });

  it("refuses a member every shape, before the guard (decision 136)", async () => {
    const x = setup();
    await secrets(x);
    for (const name of [...OWNER_ONLY, ...RAW]) {
      for (const sql of shapes(name)) {
        const r = await x.call("query", { sql }, "asha");
        expect([sql, r.http, JSON.stringify(r.body).includes(SECRET)]).toEqual([sql, 403, false]);
      }
    }
  });

  it("memberRefusal names any mention of an owner-only view or a raw table, even where it isn't a source; reference names that are columns pass", () => {
    const { tables } = schema();
    expect(memberRefusal("SELECT 'x' AS v_target FROM v_food_source", [], tables)).toEqual(["v_target"]);
    expect(memberRefusal("SELECT reading FROM v_food_source", [], tables)).toEqual(["reading"]);
    expect(memberRefusal('SELECT "Target" FROM v_food_source', [], tables)).toEqual(["target"]);
    expect(memberRefusal("SELECT unit, metric FROM v_plate", ["v_plate"], tables)).toEqual([]);
    expect(memberRefusal("SELECT ref FROM v_food_source", ["v_food_source"], tables)).toEqual([]);
  });

  it("leaves the agent's owner-only views readable in parentheses, and a subquery still a subquery", async () => {
    const x = setup();
    await secrets(x);
    expect((await x.ok("query", { sql: "SELECT reasoning FROM (v_target)" })).rows[0].reasoning).toBe(SECRET);
    expect((await x.ok("query", { sql: "SELECT body FROM ((v_member_note))" })).rows[0].body).toBe(SECRET);
    expect((await x.ok("query", { sql: "SELECT * FROM (SELECT ref FROM v_food_source) AS f" })).status).toBe("ok");
    expect((await x.ok("query", { sql: "SELECT * FROM (VALUES (1))" })).status).toBe("ok");
    expect((await x.ok("query", { sql: "SELECT * FROM (v_food_source AS a JOIN v_measure AS b ON a.id = b.food_source_id)" })).status).toBe("ok");
  });
});
