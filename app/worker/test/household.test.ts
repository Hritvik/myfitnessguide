import { describe, expect, it } from "vitest";
import { migrationFiles, TestDb } from "./db";
import { household } from "./fixtures";

describe("migrations", () => {
  it("are named the way wrangler d1 migrations names them", () => {
    const files = migrationFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    const numbers = files.map((f) => Number(f.slice(0, 4)));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  it("make every table STRICT", () => {
    const t = new TestDb();
    const tables = t.all(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    );
    expect(tables.length).toBeGreaterThan(0);
    for (const { name, sql } of tables) expect(sql, String(name)).toMatch(/\)\s*STRICT\s*$/);
  });
});

describe("household and members", () => {
  it("accepts a household with prescribed and record-only members", () => {
    const t = new TestDb();
    const h = household(t);
    const modes = t.all("SELECT name, programming_mode FROM member ORDER BY id");
    expect(modes).toEqual([
      { name: "Hritvik", programming_mode: "prescribed" },
      { name: "Asha", programming_mode: "record_only" },
      { name: "Kabir", programming_mode: "prescribed" },
    ]);
    expect(h.hritvik).toBeGreaterThan(0);
  });

  it("rejects an unknown programming mode", () => {
    const t = new TestDb();
    const h = household(t);
    expect(() =>
      t.insert("member", {
        household_id: h.id, name: "Guest", email: "g@example.com", programming_mode: "freestyle",
      }),
    ).toThrow(/CHECK/);
  });

  it("rejects two members with the same email", () => {
    const t = new TestDb();
    const h = household(t);
    expect(() =>
      t.insert("member", {
        household_id: h.id, name: "Twin", email: "hritvik@example.com", programming_mode: "prescribed",
      }),
    ).toThrow(/UNIQUE/);
  });

  it("rejects a member of a household that does not exist", () => {
    const t = new TestDb();
    expect(() =>
      t.insert("member", {
        household_id: 99, name: "Ghost", email: "x@example.com", programming_mode: "prescribed",
      }),
    ).toThrow(/FOREIGN KEY/);
  });

  it("rejects a malformed birth date and week anchor", () => {
    const t = new TestDb();
    const h = household(t);
    const base = { household_id: h.id, name: "N", email: "n@example.com", programming_mode: "prescribed" };
    expect(() => t.insert("member", { ...base, birth_date: "1990-02-30" })).toThrow(/CHECK/);
    expect(() => t.insert("member", { ...base, week_anchor_date: "26/07/2026" })).toThrow(/CHECK/);
    expect(t.insert("member", { ...base, week_anchor_date: "2026-07-26", sex: "male" })).toBeGreaterThan(0);
  });

  it("stores a text number as a type error, not silently (STRICT)", () => {
    const t = new TestDb();
    const h = household(t);
    expect(() =>
      t.insert("member", {
        household_id: h.id, name: "N", email: "n@example.com", programming_mode: "prescribed", active: "yes",
      }),
    ).toThrow(/cannot store TEXT value in INTEGER column|CHECK/);
  });
});
