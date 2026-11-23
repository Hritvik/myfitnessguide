import { describe, expect, it } from "vitest";
import { NOW, TestDb } from "./db";
import { household } from "./fixtures";

const BEFORE = "0031";

describe("migration 0032 write channel", () => {
  it("backfills only importer and system channels and leaves member and service-agent history unknown", () => {
    const t = new TestDb({ through: BEFORE });
    const h = household(t);
    const insert = (resolver: string, origin: string, actor: number | null = null) =>
      t.insert("write_log", {
        at: NOW,
        resolver,
        actor_member_id: actor,
        origin,
        tool: "test",
        reason: "historical",
      });
    const member = insert("member", "app", h.hritvik);
    const local = insert("claude_code", "live");
    const hosted = insert("hosted_model", "inbox");
    const imported = insert("importer", "import");
    const unattended = insert("system", "auto_confirm");

    t.migrateAfter(BEFORE);

    expect(t.all("SELECT id, channel FROM write_log ORDER BY id")).toEqual([
      { id: member, channel: null },
      { id: local, channel: null },
      { id: hosted, channel: null },
      { id: imported, channel: "import" },
      { id: unattended, channel: "unattended" },
    ]);
    expect(t.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(t.get("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
  });

  it("has no misleading default and accepts only the five trusted channel values or legacy NULL", () => {
    const t = new TestDb();
    const channel = t.all("PRAGMA table_info(write_log)").find((column) => column.name === "channel");
    expect(channel).toMatchObject({ notnull: 0, dflt_value: null });
    const base = { at: NOW, resolver: "claude_code", origin: "live", tool: "test", reason: "test" };
    for (const value of ["web", "remote_mcp", "local_agent", "unattended", "import", null]) {
      expect(t.insert("write_log", { ...base, channel: value })).toBeGreaterThan(0);
    }
    expect(() => t.insert("write_log", { ...base, channel: "model_claimed" })).toThrow(/CHECK/);
  });
});
