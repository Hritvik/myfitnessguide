import { describe, expect, it } from "vitest";
import { setup } from "./harness";
import { seedCatalogue } from "./seed";

describe("history names who made each version", () => {
  it("gives the actor, the member the agent was talking with, and whose record it is", async () => {
    const x = setup();
    await seedCatalogue(x);
    const logged = await x.ok("log_intake", { member: "Hritvik", date: "2026-10-05", meal_slot: "snack", items: [{ source: "food", food: "curd", value: 100, unit: "g", provenance: "weighed", confidence: "high" }] }, "asha");
    const id = logged.items[0].id;
    await x.ok("amend", { record: { table: "intake_item", id }, changes: { label: "1 katori" }, reason: "Asha says it was a katori", speaker: "Asha" });
    const body = await x.ok("history", { table: "intake_item", id }, "hritvik");
    expect(body.versions.map((v: { action: string; actor: string | null; speaker: string | null; on_behalf_of: string | null }) => [v.action, v.actor, v.speaker, v.on_behalf_of])).toEqual([
      ["create", "Asha", null, "Hritvik"],
      ["amend", null, "Asha", "Hritvik"],
    ]);
  });

  it("on an owner-only reading: the owner and the agent see the names, another member sees nothing", async () => {
    const x = setup();
    const r = await x.ok("log_reading", { member: "Hritvik", date: "2026-10-05", metric: "weight", value: 78.2, unit: "kg", body_state: "fasted", resolution: 0.05 }, "hritvik");
    const id = r.reading.id;
    const names = (b: { versions: { actor: string | null; speaker: string | null; on_behalf_of: string | null }[] }) => b.versions.map((v) => [v.actor, v.speaker, v.on_behalf_of]);
    expect(names(await x.ok("history", { table: "reading", id }, "hritvik"))).toEqual([["Hritvik", null, "Hritvik"]]);
    const agent = await x.call("history", { table: "reading", id }, "agent");
    expect(agent.http).toBe(200);
    expect(names(agent.body)).toEqual([["Hritvik", null, "Hritvik"]]);
    const refused = await x.call("history", { table: "reading", id }, "asha");
    expect(refused.http).toBe(403);
    const text = JSON.stringify(refused.body);
    expect(text).not.toMatch(/Hritvik|78\.2|versions|actor/);
  });
});
