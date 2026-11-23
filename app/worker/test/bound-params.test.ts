// D1 binds at most 100 parameters to one statement. allIn splits an IN
// list into chunks under that limit (decision 96); the counting adapter
// refuses a statement over it, as D1 does, so every budget test checks it.
import { describe, expect, it } from "vitest";
import { all, allIn } from "../src/db";
import { CountingDb } from "./counting";
import { SqliteDb } from "./sqlite";

function db() {
  const sqlite = new SqliteDb();
  const household = sqlite.test.insert("household", { name: "Invented household", created_at: "2026-10-05T07:30:00Z" });
  const gyms = Array.from({ length: 250 }, (_, i) => sqlite.test.insert("gym", { household_id: household, name: `Invented gym ${i + 1}` }));
  return { counting: new CountingDb(sqlite), household, gyms };
}

describe("bound parameters", () => {
  it("the counting adapter refuses a statement binding more than 100 parameters, as D1 does", async () => {
    const { counting, gyms } = db();
    const ids = gyms.slice(0, 101);
    await expect(all(counting, `SELECT id FROM gym WHERE id IN (${ids.map(() => "?").join(", ")})`, ...ids)).rejects.toThrow(/100/);
  });

  it("allIn reads 250 keys in three statements, none over the limit", async () => {
    const { counting, gyms } = db();
    const rows = await allIn<{ id: number }>(counting, (ph) => `SELECT id FROM gym WHERE id IN (${ph})`, gyms);
    expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual(gyms);
    expect(counting.count).toBe(3);
  });

  it("allIn leaves room for the parameters bound before the list, and skips the query for no keys", async () => {
    const { counting, household, gyms } = db();
    const rows = await allIn<{ id: number }>(counting, (ph) => `SELECT id FROM gym WHERE household_id = ? AND id IN (${ph})`, gyms.slice(0, 100), household);
    expect(rows).toHaveLength(100);
    expect(counting.count).toBe(2);
    expect(await allIn(counting, (ph) => `SELECT id FROM gym WHERE id IN (${ph})`, [])).toEqual([]);
    expect(counting.count).toBe(2);
  });
});

describe("compound SELECT terms", () => {
  const terms = (n: number) => Array.from({ length: n }, (_, i) => `SELECT ${i}`).join(" UNION ALL ");

  it("the test database refuses a compound SELECT of more than 5 terms, as D1 does", () => {
    const sqlite = new SqliteDb();
    expect(sqlite.test.all(terms(5))).toHaveLength(5);
    expect(() => sqlite.test.all(terms(6))).toThrow(/too many terms in compound SELECT/);
  });
});
