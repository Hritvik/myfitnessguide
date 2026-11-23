import { describe, expect, it } from "vitest";
import { setup } from "./harness";
import { seedCatalogue } from "./seed";

async function ready() {
  const x = setup();
  await seedCatalogue(x);
  await x.ok("log_intake", {
    member: "Hritvik", date: "2026-10-05", meal_slot: "lunch",
    items: [{ source: "food", food: "FS001", value: 100, unit: "g", provenance: "weighed", confidence: "high" }],
  });
  await x.ok("log_reading", { member: "Hritvik", date: "2026-10-05", metric: "weight", value: 78.2, unit: "kg", body_state: "fasted" });
  return x;
}

const refused = async (x: Awaited<ReturnType<typeof ready>>, sql: string) => {
  const reply = await x.call("query", { sql });
  expect(reply.http, sql).toBe(400);
  expect(reply.body.error.code, sql).toBe("query_refused");
  return reply.body.error.message as string;
};

describe("query: read-only SQL over the curated views", () => {
  it("runs a single SELECT over a view, with bound parameters", async () => {
    const x = await ready();
    const body = await x.ok("query", { sql: "SELECT member_name, kcal FROM v_intake_item WHERE eaten_on = ?", params: ["2026-10-05"] });
    expect(body.rows).toEqual([{ member_name: "Hritvik", kcal: 360 }]);
    expect(body).toMatchObject({ columns: ["member_name", "kcal"], row_count: 1, truncated: false });
  });

  it("allows CTEs, joins between views, subqueries over views, and column names that match table names", async () => {
    const x = await ready();
    const body = await x.ok("query", {
      sql: `WITH d AS (SELECT member_id, day, kcal FROM v_day_intake)
            SELECT d.day, d.kcal, (SELECT count(*) FROM v_reading r WHERE r.member_id = d.member_id) AS readings,
                   (SELECT unit FROM v_reading LIMIT 1) AS unit, (SELECT metric FROM v_reading LIMIT 1) AS metric
            FROM d JOIN v_food_source f ON f.ref = 'FS001' -- a comment
            ORDER BY d.day;`,
    });
    expect(body.rows).toEqual([{ day: "2026-10-05", kcal: 360, readings: 1, unit: "kg", metric: "weight" }]);
  });

  it("enforces a row limit and says when it truncated", async () => {
    const x = await ready();
    const body = await x.ok("query", { sql: "SELECT * FROM v_measure, v_food_source", limit: 3 });
    expect(body.rows).toHaveLength(3);
    expect(body.truncated).toBe(true);
    const over = await x.call("query", { sql: "SELECT 1 FROM v_food_source", limit: 5000 });
    expect(over.http).toBe(400);
  });

  it("refuses anything that isn't a single SELECT", async () => {
    const x = await ready();
    await refused(x, "DELETE FROM intake_item");
    await refused(x, "UPDATE v_food_source SET kcal = 0");
    await refused(x, "SELECT 1; DROP TABLE member");
    await refused(x, "PRAGMA table_info(member)");
    await refused(x, "ATTACH DATABASE 'x' AS y");
    await refused(x, "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT i FROM n");
  });

  it("refuses any reference to a table, however it is hidden", async () => {
    const x = await ready();
    const message = await refused(x, "SELECT * FROM member");
    expect(message).toContain("member");
    await refused(x, "SELECT * FROM v_set JOIN session_set ON session_set.id = v_set.id");
    await refused(x, "SELECT * FROM v_set, write_log");
    await refused(x, "SELECT (SELECT email FROM member LIMIT 1) FROM v_food_source");
    await refused(x, 'SELECT * FROM "member"');
    await refused(x, "SELECT * FROM main.member");
    await refused(x, "SELECT * FROM sqlite_master");
    await refused(x, "SELECT * FROM pragma_table_info('member')");
    await refused(x, "SELECT * FROM v_set WHERE id IN (SELECT id FROM session_set)");
    await refused(x, "WITH member AS (SELECT * FROM v_set) SELECT * FROM member");
    await refused(x, "SELECT * FROM (SELECT * FROM idempotency_key)");
  });

  it("the views' macros agree with day_totals, the domain's single source for everything else", async () => {
    const x = await ready();
    await x.ok("household_meal", {
      date: "2026-10-05", meal_slot: "dinner",
      cooks: [{ name: "Rice", lines: [{ food: "FS001", value: 200, unit: "g", provenance: "weighed" }], portions: [{ member: "Hritvik", fraction: 0.4, provenance: "estimated" }] }],
    });
    const view = await x.ok("query", { sql: "SELECT kcal, protein_g FROM v_day_intake WHERE day = '2026-10-05'" });
    const day = await x.ok("day_totals", { member: "Hritvik", date: "2026-10-05" });
    expect(view.rows[0].kcal).toBeCloseTo(day.so_far.kcal.value, 9);
    expect(view.rows[0].protein_g).toBeCloseTo(day.so_far.protein.value, 9);
  });

  it("is the agent's tool only: a signed-in member is refused, however the SQL is written", async () => {
    const x = await ready();
    for (const sql of ["SELECT kcal FROM v_intake_item", "SELECT reasoning FROM (v_target)", "SELECT * FROM (target)", "SELECT * FROM ((reading))"]) {
      for (const who of ["hritvik", "asha"] as const) {
        const reply = await x.call("query", { sql }, who);
        expect(reply.http, `${who}: ${sql}`).toBe(403);
        expect(reply.body.error.code).toBe("not_visible");
        expect(JSON.stringify(reply.body)).not.toContain("rows");
      }
    }
    expect((await x.call("query", { sql: "SELECT kcal FROM v_intake_item" })).http).toBe(200);
  });

  it("reports a bad query as an error, not a crash", async () => {
    const x = await ready();
    const reply = await x.call("query", { sql: "SELECT no_such_column FROM v_food_source" });
    expect(reply.http).toBe(400);
    expect(reply.body.error.code).toBe("query_error");
  });

});
