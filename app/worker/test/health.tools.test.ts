import { describe, expect, it } from "vitest";
import { setup, type Harness } from "./harness";

const weight = (x: Harness, date: string, value: number, more: Record<string, unknown> = {}, as: Parameters<Harness["ok"]>[2] = "agent") =>
  x.ok("log_reading", { member: "Hritvik", date, metric: "weight", value, unit: "kg", body_state: "fasted", resolution: 0.05, ...more }, as);

describe("log_reading", () => {
  it("logs a reading and returns the 7-day fasted average and whether it is a real change", async () => {
    const x = setup();
    await weight(x, "2026-09-29", 78.6);
    await weight(x, "2026-10-01", 78.2);
    const body = await weight(x, "2026-10-05", 78.25);
    expect(body.reading).toMatchObject({ metric: "weight", value: 78.25, unit: "kg", value_canonical: 78.25, canonical_unit: "kg", state: "confirmed" });
    // 2026-09-29..2026-10-05: all three are in the window.
    expect(body.computed.seven_day_average_kg).toBeCloseTo((78.6 + 78.2 + 78.25) / 3, 9);
    // 0.05 kg from the previous reading is within one resolution step: not a change.
    expect(body.computed.change).toMatchObject({ previous: 78.2, real_change: false });
  });

  it("converts pounds and inches to the canonical unit", async () => {
    const x = setup();
    const body = await x.ok("log_reading", { member: "Hritvik", date: "2026-10-05", metric: "weight", value: 172.5, unit: "lb", body_state: "fasted" });
    expect(body.reading.value_canonical).toBeCloseTo(78.2447, 4);
  });

  it("computes waist to height from the stored height", async () => {
    const x = setup();
    await x.ok("log_reading", { member: "Hritvik", date: "2026-01-01", metric: "height", value: 175, unit: "cm", body_state: "not_recorded" });
    const body = await x.ok("log_reading", { member: "Hritvik", date: "2026-10-05", metric: "waist_navel", value: 87.5, unit: "cm", body_state: "fasted" });
    expect(body.computed.waist_to_height).toBeCloseTo(0.5, 9);
  });

  it("asks when the unit doesn't fit the metric, or the metric is unknown", async () => {
    const x = setup();
    const unit = await x.call("log_reading", { member: "Hritvik", date: "2026-10-05", metric: "weight", value: 78, unit: "cm", body_state: "fasted" });
    expect(unit.body).toMatchObject({ status: "needs_clarification", reason: "unit_mismatch", options: ["kg", "lb"] });
    const metric = await x.call("log_reading", { member: "Hritvik", date: "2026-10-05", metric: "waist", value: 87, unit: "cm", body_state: "fasted" });
    expect(metric.body).toMatchObject({ status: "needs_clarification", reason: "unknown_metric" });
    expect(metric.body.options).toContain("waist_navel");
  });

  it("starts a new method segment, and the average does not reach across it", async () => {
    const x = setup();
    await weight(x, "2026-10-01", 80);
    const body = await weight(x, "2026-10-03", 78, { method: "new scale", method_change: "switched to the Tanita" });
    expect(body.computed.seven_day_average_kg).toBe(78);
    expect(body.computed.change).toBeNull();
  });
});

describe("body_trends", () => {
  it("returns readings split at method changes, 7-day averages and the goal verdict", async () => {
    const x = setup();
    await weight(x, "2026-09-20", 80);
    await weight(x, "2026-09-27", 79.4);
    await weight(x, "2026-10-04", 78.1, { method_change: "new scale" });
    x.t.insert("goal_point", { member_id: x.h.hritvik, metric: "weight", week_of: "2026-10-04", tier: "planned", basis: "absolute", value_low: 78.5, value_high: 78.5, unit: "kg" });
    const body = await x.ok("body_trends", { member: "Hritvik", metric: "weight", direction: "decrease" });
    expect(body.segments.map((s: { readings: unknown[] }) => s.readings.length)).toEqual([2, 1]);
    expect(body.method_changes).toEqual([{ date: "2026-10-04", note: "new scale" }]);
    expect(body.seven_day_averages.at(-1)).toMatchObject({ date: "2026-10-04", average_kg: 78.1 });
    expect(body.goal).toMatchObject({ verdict: "on_track", goal: 78.5, reading: 78.1 });
  });
});

describe("blood draws", () => {
  it("logs a draw with its results and computes each status against that lab's range, and the change", async () => {
    const x = setup();
    await x.ok("log_blood_draw", { member: "Hritvik", date: "2026-04-01", lab: "Thyrocare", results: [{ marker: "Vitamin D", value: 18, unit: "ng/mL", ref_low: 30, ref_high: 100 }] });
    const body = await x.ok("log_blood_draw", {
      member: "Hritvik", date: "2026-10-01", lab: "Thyrocare", fasting: true,
      results: [
        { marker: "Vitamin D", value: 34, unit: "ng/mL", ref_low: 30, ref_high: 100 },
        { marker: "CRP", value: 0.5, comparator: "<", unit: "mg/L", ref_high: 5 },
        { marker: "Urine ketones", value_text: "negative" },
      ],
    });
    expect(body.draw).toMatchObject({ lab: "Thyrocare", state: "confirmed" });
    expect(body.results.map((r: { marker: string; status: string | null }) => [r.marker, r.status])).toEqual([
      ["Vitamin D", "within"], ["CRP", null], ["Urine ketones", null],
    ]);
    expect(body.results[0].change).toEqual({ previous: 18, previous_on: "2026-04-01", delta: 16 });
  });
});

describe("flags", () => {
  it("raises, lists and resolves a flag", async () => {
    const x = setup();
    const raised = await x.ok("raise_flag", { member: "Hritvik", subtype: "data", subject: "Lipid report never received", raised_on: "2026-10-01", due_on: "2026-10-12" });
    expect(raised.flag).toMatchObject({ status: "open", subtype: "data" });
    const open = await x.ok("flags", { member: "Hritvik" });
    expect(open.flags.map((f: { subject: string }) => f.subject)).toEqual(["Lipid report never received"]);
    const resolved = await x.ok("resolve_flag", { flag_id: raised.flag.id, resolution: "received on 4 Oct", resolved_on: "2026-10-04" });
    expect(resolved.flag).toMatchObject({ status: "resolved", resolved_on: "2026-10-04" });
    expect((await x.ok("flags", { member: "Hritvik" })).flags).toEqual([]);
    expect((await x.ok("flags", { member: "Hritvik", status: "resolved" })).flags).toHaveLength(1);
  });
});

describe("owner-only visibility: readings, blood draws, flags", () => {
  it("a member sees their own readings; another member is refused; the agent sees everything", async () => {
    const x = setup();
    await weight(x, "2026-10-05", 78.2, {}, "hritvik");
    expect((await x.call("body_trends", { member: "Hritvik", metric: "weight" }, "hritvik")).http).toBe(200);
    const refused = await x.call("body_trends", { member: "Hritvik", metric: "weight" }, "asha");
    expect(refused.http).toBe(403);
    expect(refused.body.error.code).toBe("not_visible");
    expect((await x.call("body_trends", { member: "Hritvik", metric: "weight" }, "agent")).http).toBe(200);
  });

  it("a member cannot write another member's health data", async () => {
    const x = setup();
    const reply = await x.call("log_reading", { member: "Hritvik", date: "2026-10-05", metric: "weight", value: 78, unit: "kg", body_state: "fasted" }, "asha");
    expect(reply.http).toBe(403);
  });

  it("flags list only the caller's own for a member, and everyone's for the agent", async () => {
    const x = setup();
    await x.ok("raise_flag", { member: "Hritvik", subtype: "health_watch", subject: "BP trending up" });
    await x.ok("raise_flag", { member: "Asha", subtype: "restriction", subject: "Back pain: no deadlifts" });
    const asha = await x.ok("flags", {}, "asha");
    expect(asha.flags.map((f: { subject: string }) => f.subject)).toEqual(["Back pain: no deadlifts"]);
    const agent = await x.ok("flags", {});
    expect(agent.flags).toHaveLength(2);
    expect((await x.call("flags", { member: "Hritvik" }, "asha")).http).toBe(403);
  });

  it("history of an owner-only record is refused to other members", async () => {
    const x = setup();
    const r = await weight(x, "2026-10-05", 78.2);
    expect((await x.call("history", { table: "reading", id: r.reading.id }, "asha")).http).toBe(403);
    expect((await x.call("history", { table: "reading", id: r.reading.id }, "hritvik")).http).toBe(200);
  });

  it("blood draws are refused to other members", async () => {
    const x = setup();
    await x.ok("log_blood_draw", { member: "Asha", date: "2026-10-01", lab: "Lal", results: [{ marker: "Hb", value: 11.2, unit: "g/dL", ref_low: 12, ref_high: 15 }] }, "asha");
    expect((await x.call("blood_draws", { member: "Asha" }, "hritvik")).http).toBe(403);
    const own = await x.ok("blood_draws", { member: "Asha" }, "asha");
    expect(own.draws[0].results[0]).toMatchObject({ marker: "Hb", status: "below" });
  });
});
