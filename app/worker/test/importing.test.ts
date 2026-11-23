// The one-time importer drives the Worker in-process: the same tool
// handlers and validation the API uses, with resolver `importer` and origin
// `import`, plus import-only tools that are never HTTP routes.
import { describe, expect, it } from "vitest";
import { IMPORT_TOOLS, importWrite } from "../src/importing";
import { TOOLS } from "../src/tools";
import { setup } from "./harness";

const AT = "2026-10-05T19:07:21Z";
const origin = (row: number) => ({ file: "base", tab: "Food Sources", row });

describe("importWrite", () => {
  it("runs a write tool with resolver importer and origin import, keeping the row's origin in the write log", async () => {
    const x = setup();
    const result = await importWrite(x.db, "upsert_food_source", {
      ref: "FS001", name: "Rice", state: "dry", reference_amount: 100, reference_unit: "g", kcal: 360, protein_g: 7, carbs_g: 79, fat_g: 0.6,
    }, { at: AT, origin: origin(2), reason: "import Food Sources row 2" });
    expect(result.status).toBe("ok");
    const log = x.t.get("SELECT * FROM write_log WHERE id = ?", result.write_id as number);
    expect(log).toMatchObject({ resolver: "importer", origin: "import", tool: "upsert_food_source", at: AT, actor_member_id: null });
    expect(JSON.parse(String(log?.resolver_detail))).toEqual({ origin: origin(2) });
    expect(x.t.get("SELECT count(*) AS n FROM idempotency_key")).toEqual({ n: 0 });
  });

  it("confirms member records whoever they are about, at the import time", async () => {
    const x = setup();
    const result = await importWrite(x.db, "log_intake", {
      member: "Asha", date: "2026-08-01", meal_slot: "lunch",
      items: [{ source: "manual", kcal: 300, protein_g: 10, carbs_g: 40, fat_g: 10, reason: "typed macros", provenance: "estimated", confidence: "low" }],
    }, { at: AT, origin: { file: "asha", tab: "Nutrition", row: 5 } });
    expect(result.status).toBe("ok");
    expect(x.t.get("SELECT state, confirmed_at FROM intake_item")).toEqual({ state: "confirmed", confirmed_at: AT });
    expect(x.t.get("SELECT on_behalf_of_member_id FROM write_log")).toEqual({ on_behalf_of_member_id: x.h.asha });
  });

  it("validates input exactly like the API and writes nothing on a refusal", async () => {
    const x = setup();
    const invalid = await importWrite(x.db, "upsert_food_source", { ref: "FS001", name: "Rice" }, { at: AT, origin: origin(2) });
    expect(invalid.status).toBe("invalid");
    const clarify = await importWrite(x.db, "log_intake", {
      member: "Nobody", date: "2026-08-01", meal_slot: "lunch",
      items: [{ source: "manual", kcal: 1, protein_g: 0, carbs_g: 0, fat_g: 0, reason: "r", provenance: "estimated", confidence: "low" }],
    }, { at: AT, origin: origin(3) });
    expect(clarify).toMatchObject({ status: "needs_clarification", reason: "unknown_member" });
    expect(x.t.get("SELECT count(*) AS n FROM write_log")).toEqual({ n: 0 });
  });

  it("lets an imported set of a prescribed member be confirmed as RIR not recorded", async () => {
    const x = setup();
    const gym = x.t.insert("gym", { household_id: x.h.id, name: "Home gym" });
    x.t.insert("exercise", { household_id: x.h.id, name: "Bench press", implement_kind: "barbell" });
    const session = await importWrite(x.db, "start_session", { member: "Hritvik", date: "2026-08-01", session_type: "strength", gym }, { at: AT, origin: origin(1) });
    const set = await importWrite(x.db, "log_set", {
      session_id: (session.session as { id: number }).id, exercise: "Bench press", reps: 8, load: { value: 30, unit: "kg", basis: "total" }, rir: "not_recorded",
    }, { at: AT, origin: origin(2) });
    expect(set.status).toBe("ok");
    expect(x.t.get("SELECT state, rir_status FROM session_set")).toEqual({ state: "confirmed", rir_status: "not_recorded" });
  });

  it("refuses a tool that is not a write", async () => {
    const x = setup();
    await expect(importWrite(x.db, "day_totals", { member: "Hritvik", date: "2026-08-01" }, { at: AT, origin: origin(1) })).rejects.toThrow(/not a write tool/);
  });
});

describe("tools that remain import-only", () => {
  it("are not HTTP routes while promoted shared tools are listed", async () => {
    const x = setup();
    const publicNames = new Set(TOOLS.map((tool) => tool.name));
    const importOnly = IMPORT_TOOLS.filter((tool) => !publicNames.has(tool.name));
    for (const tool of importOnly) {
      const reply = await x.call(tool.name, {});
      expect(reply.http).toBe(404);
    }
    const listed = await x.raw("/tools", { method: "GET" });
    const names = listed.body.tools.map((t: { name: string }) => t.name);
    for (const tool of importOnly) expect(names).not.toContain(tool.name);
    expect(names).toContain("create_programme");
  });
});
