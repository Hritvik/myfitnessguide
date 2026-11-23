import { describe, expect, it } from "vitest";
import { TestDb } from "./db";

const PATTERN = /\b(?:GLOB|LIKE)\s+'([^']*)'/gi;

describe("migration SQL stays inside D1's pattern limit", () => {
  it("has no GLOB or LIKE pattern longer than 40 bytes in the final schema", () => {
    const t = new TestDb();
    const rows = t.all("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL");
    const long = rows.flatMap((row) =>
      [...String(row.sql).matchAll(PATTERN)]
        .filter((match) => (match[1] ?? "").length > 40)
        .map((match) => `${String(row.type)} ${String(row.name)}: ${String(match[1]).length} bytes`),
    );
    expect(long).toEqual([]);
  });

  it("the rebuilt prep_task checks the window format without GLOB or LIKE", () => {
    const t = new TestDb();
    const sql = String(t.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'prep_task'")?.sql);
    expect(sql).not.toMatch(/GLOB|LIKE/i);
    expect(sql).toContain("length(window_start) = 16");
    expect(sql).toContain("length(window_end) = 16");
  });
});
