// Every output holds household data: owner-only (0600), the database included.
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalDb } from "../src/sqlite";
import { writePrivate } from "../src/write-private";

const mode = (path: string) => statSync(path).mode & 0o777;

describe("outputs are owner-only", () => {
  it("the rehearsal database is created 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "rehearsal-"));
    const path = join(dir, "rehearsal.sqlite");
    const db = new LocalDb(path);
    db.raw.exec("CREATE TABLE probe (x INTEGER); INSERT INTO probe VALUES (1);");
    db.close();
    expect(mode(path)).toBe(0o600);
  });

  it("text outputs are written 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "rehearsal-"));
    const path = join(dir, "out", "parity.md");
    writePrivate(path, "x");
    expect(mode(path)).toBe(0o600);
  });
});
