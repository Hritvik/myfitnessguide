// The final-load SQL: the rehearsal database as INSERTs for
// `wrangler d1 execute gym-tracker --remote --file`, chunked to D1 limits.
import { describe, expect, it } from "vitest";
import { MAX_STATEMENT_BYTES, sqlDump } from "../src/dump";
import { rehearse } from "../src/rehearse";
import { LocalDb } from "../src/sqlite";
import { basePeople, f, food, FOOD_HEADER, intake, members, NUTRITION_HEADER, snapshot } from "./fixture";

const foods = Array.from({ length: 40 }, (_, i) =>
  food({ ref: `FS${String(i + 1).padStart(3, "0")}`, name: `Test food ${i + 1} with a long name that is O'Neil's`, serving: "100 g", kcal: 100 + i, protein: 10, carbs: 10, fat: 2 }),
);

async function loaded() {
  return rehearse({
    snapshot: snapshot({
      base: { People: basePeople(), "Food Sources": [FOOD_HEADER, ...foods] },
      hritvik: { Nutrition: [NUTRITION_HEADER, intake({ date: 46240, meal: "Lunch", item: "Food", person: "Hritvik", ref: "FS001", qty: 1.5, macros: [f("=..", 150), f("=..", 15), f("=..", 15), f("=..", 3)] })] },
    } as never),
    members: members(),
  });
}

const TABLES = ["household", "member", "gym", "food_source", "intake_item", "target", "target_value", "reading", "write_log", "record_version", "member_note_version"];

describe("sqlDump", () => {
  it("replays into a freshly migrated database to the same rows", async () => {
    const r = await loaded();
    const chunks = sqlDump(r.db, { maxStatementBytes: 4_000, maxFileBytes: 20_000 });
    expect(chunks.length).toBeGreaterThan(1);
    const fresh = new LocalDb();
    for (const chunk of chunks) fresh.raw.exec(chunk.sql);
    for (const t of TABLES) expect(fresh.all(`SELECT * FROM ${t} ORDER BY rowid`), t).toEqual(r.db.all(`SELECT * FROM ${t} ORDER BY rowid`));
    expect(fresh.all("SELECT count(*) AS n FROM unit")).toEqual(r.db.all("SELECT count(*) AS n FROM unit"));
  });

  it("keeps every statement under the limit and never opens a transaction", async () => {
    const r = await loaded();
    const chunks = sqlDump(r.db);
    for (const chunk of chunks) {
      expect(chunk.sql).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|PRAGMA)\b/);
      for (const statement of chunk.sql.split(";\n").filter((s) => s.trim() && !s.trim().startsWith("--"))) {
        expect(new TextEncoder().encode(statement).length).toBeLessThanOrEqual(MAX_STATEMENT_BYTES);
      }
    }
    expect(chunks.map((c) => c.name)[0]).toBe("final-load-001.sql");
  });

  it("is deterministic", async () => {
    const a = sqlDump((await loaded()).db);
    const b = sqlDump((await loaded()).db);
    expect(a).toEqual(b);
  });
});
