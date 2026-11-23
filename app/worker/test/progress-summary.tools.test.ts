import { describe, expect, it } from "vitest";
import { setup } from "./harness";

/**
 * The unified Progress read model (spec §Unified Progress read model, 20 Oct 2026):
 * one owner-only `progress_summary` with {member, period, as_of?} that supplies
 * comparison metadata and no more than five signals, excluding an open current day.
 */
describe("progress_summary", () => {
  it("defaults to 12w and returns the five signals in a fixed order", async () => {
    const x = setup();
    const result = await x.ok("progress_summary", { member: "Hritvik" }, "hritvik");

    expect(result.member).toBe("Hritvik");
    expect(result.period).toBe("12w");
    expect(result.signals.map((s: { name: string }) => s.name)).toEqual([
      "body",
      "strength",
      "nutrition",
      "review",
      "next",
    ]);
    expect(result.signals).toHaveLength(5);
  });

  it("refuses another member's summary", async () => {
    const x = setup();
    const refused = await x.call("progress_summary", { member: "Hritvik" }, "asha");
    expect(refused.body.error.code).toBe("not_visible");
  });

  it("refuses an unknown period", async () => {
    const x = setup();
    const refused = await x.call("progress_summary", { member: "Hritvik", period: "2w" }, "hritvik");
    expect(refused.http).toBe(400);
    expect(refused.body.status).toBe("invalid");
  });

  it("excludes the open current day from nutrition coverage", async () => {
    const x = setup();
    const result = await x.ok("progress_summary", { member: "Hritvik", period: "4w" }, "hritvik");
    const nutrition = result.signals.find((s: { name: string }) => s.name === "nutrition");
    expect(nutrition.to < x.clock.now.toISOString().slice(0, 10)).toBe(true);
  });
});
