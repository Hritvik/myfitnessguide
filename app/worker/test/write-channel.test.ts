import { describe, expect, it } from "vitest";
import { autoConfirm } from "../src/autoconfirm";
import { importWrite } from "../src/importing";
import { setup } from "./harness";
import { foodSource, reading, writeLog } from "./fixtures";

describe("server-owned write channel attribution", () => {
  it("stamps member /tools writes as web and ignores model origin and headers", async () => {
    const x = setup();
    const food = foodSource(x.t, x.h, { name: "Rice" });
    const reply = await x.raw("/tools/log_intake", {
      method: "POST",
      as: "hritvik",
      headers: { "content-type": "application/json", "x-write-channel": "unattended" },
      body: JSON.stringify({
        idempotency_key: "member-channel",
        origin: "inbox",
        member: "Hritvik",
        date: "2026-10-05",
        meal_slot: "lunch",
        items: [{ source: "food", food: "Rice", value: 100, unit: "g", provenance: "weighed", confidence: "high" }],
      }),
    });
    expect(reply.http).toBe(200);
    expect(x.t.get("SELECT channel, origin FROM write_log ORDER BY id DESC LIMIT 1")).toEqual({ channel: "web", origin: "app" });

    const injected = await x.raw("/tools/log_intake", {
      method: "POST",
      as: "hritvik",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotency_key: "member-channel-injected",
        channel: "remote_mcp",
        member: "Hritvik",
        date: "2026-10-05",
        meal_slot: "dinner",
        items: [{ source: "food", food: "Rice", value: 100, unit: "g", provenance: "weighed", confidence: "high" }],
      }),
    });
    expect(injected.http).toBe(400);
    expect(x.t.get("SELECT count(*) AS n FROM write_log")).toEqual({ n: 1 });
    void food;
  });

  it("derives local_agent or unattended only from the authenticated service principal config", async () => {
    const x = setup();
    await x.ok("write_member_note", { member: "Hritvik", topic: "channel", body: "interactive", origin: "inbox" }, "agent");
    await x.ok("write_member_note", { member: "Hritvik", topic: "channel", body: "background", origin: "live" }, "harness");
    expect(x.t.all("SELECT channel, origin, resolver FROM write_log ORDER BY id")).toEqual([
      { channel: "local_agent", origin: "inbox", resolver: "claude_code" },
      { channel: "unattended", origin: "live", resolver: "hosted_model" },
    ]);
  });

  it("stamps imports and cron auto-confirm without an extra attribution query", async () => {
    const x = setup();
    await importWrite(x.db, "upsert_food_source", {
      name: "Imported food", state: "as_sold", reference_amount: 100, reference_unit: "g", kcal: 100, protein_g: 10, carbs_g: 10, fat_g: 2,
    }, { at: "2026-10-05T07:30:00Z", origin: { file: "foods", tab: "Food", row: 2 } });
    expect(x.t.get("SELECT channel FROM write_log ORDER BY id DESC LIMIT 1")).toEqual({ channel: "import" });

    const draft = reading(x.t, x.h.asha, { measured_on: "2026-10-01", state: "draft" });
    const write = writeLog(x.t, { channel: "local_agent", on_behalf_of_member_id: x.h.asha, at: "2026-10-01T00:00:00Z" });
    x.t.insert("record_version", { table_name: "reading", record_id: draft, version: 1, action: "create", data: JSON.stringify(x.t.get("SELECT * FROM reading WHERE id = ?", draft)), write_id: write, created_at: "2026-10-01T00:00:00Z" });
    await autoConfirm(x.db, new Date("2026-10-05T08:00:00Z"));
    expect(x.t.get("SELECT channel, resolver FROM write_log ORDER BY id DESC LIMIT 1")).toEqual({ channel: "unattended", resolver: "system" });
  });

  it("returns channel in record history", async () => {
    const x = setup();
    const result = await x.ok("log_reading", { member: "Hritvik", date: "2026-10-05", metric: "weight", value: 78, unit: "kg", body_state: "fasted", measurer: "self" }, "hritvik");
    const history = await x.ok("history", { table: "reading", id: result.reading.id }, "hritvik");
    expect(history.versions[0]).toMatchObject({ channel: "web", origin: "app" });
  });
});
