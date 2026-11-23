// Ticket 54 (decision 131): a removed record's id is never handed out again,
// so a new record's history starts at its own create. Invented readings only.
import { describe, expect, it } from "vitest";
import { setup } from "./harness";

const weight = (member: string, value: number) => ({ member, date: "2026-10-04", metric: "weight", value, unit: "kg", body_state: "fasted" });

describe("record ids are never reused", () => {
  it("a reading logged after the top-id reading is rejected has one version", async () => {
    const x = setup();
    // The agent, talking with Hritvik, logs Asha's weight: a draft about her, which she rejects.
    const draft = (await x.ok("log_reading", weight("Asha", 61))).reading;
    expect(draft.state).toBe("draft");
    await x.ok("reject", { records: [{ table: "reading", id: draft.id }], reason: "not my weight" }, "asha");
    expect(x.t.get("SELECT count(*) AS n FROM reading")).toEqual({ n: 0 });

    const fresh = (await x.ok("log_reading", weight("Asha", 60.5), "asha")).reading;
    expect(fresh.id).toBe(draft.id + 1);
    const history = await x.ok("history", { table: "reading", id: fresh.id }, "asha");
    expect(history.versions.map((v: { version: number; action: string }) => [v.version, v.action])).toEqual([[1, "create"]]);
    // The rejected draft's history is still its own.
    const old = await x.ok("history", { table: "reading", id: draft.id }, "asha");
    expect(old.versions.map((v: { action: string }) => v.action)).toEqual(["create", "reject"]);
  });

  it("nor after the top-id reading is retracted", async () => {
    const x = setup();
    const first = (await x.ok("log_reading", weight("Hritvik", 80.2), "hritvik")).reading;
    await x.ok("retract", { records: [{ table: "reading", id: first.id }], reason: "logged twice" }, "hritvik");
    const next = (await x.ok("log_reading", weight("Hritvik", 80.1), "hritvik")).reading;
    expect(next.id).toBe(first.id + 1);
    expect((await x.ok("history", { table: "reading", id: next.id }, "hritvik")).versions).toHaveLength(1);
  });
});
