import { describe, expect, it } from "vitest";
import { importWrite } from "../src/importing";
import { setup } from "./harness";

const target = (more: Record<string, unknown> = {}) => ({
  member: "Hritvik", metric: "waist_to_height", week_of: "2027-03-31", value: 0.5, tier: "planned", reason: "End target from the Guide", ...more,
});

describe("set_goal_point", () => {
  it("stores a waist:height goal point as a unitless ratio on the week's Sunday, with the reason in the write log", async () => {
    const x = setup();
    const body = await x.ok("set_goal_point", target());
    expect(body).toMatchObject({
      action: "created", state: "confirmed",
      goal_point: { member: "Hritvik", metric: "waist_to_height", week_of: "2027-03-28", tier: "planned", basis: "absolute", value_low: 0.5, value_high: 0.5, unit: "ratio", headline: false },
    });
    expect(x.t.get("SELECT tool, reason FROM write_log ORDER BY id DESC LIMIT 1")).toEqual({ tool: "set_goal_point", reason: "End target from the Guide" });
  });

  it("changes the goal point when the same metric, week and tier is set again; a range is stored low to high", async () => {
    const x = setup();
    const first = await x.ok("set_goal_point", target());
    const again = await x.ok("set_goal_point", target({ week_of: "2027-03-29", value: undefined, range: { low: 0.49, high: 0.51 }, reason: "Guide revised" }));
    expect(again).toMatchObject({ action: "updated", goal_point: { id: first.goal_point.id, value_low: 0.49, value_high: 0.51 } });
    expect(x.t.get("SELECT count(*) AS n FROM goal_point")).toEqual({ n: 1 });
  });

  it("keeps the headline and the note when a revision omits them; an explicit headline:false clears the headline", async () => {
    const x = setup();
    await x.ok("set_goal_point", target({ headline: true, note: "Guide end target" }));
    const revised = await x.ok("set_goal_point", target({ value: 0.49, reason: "Guide revised" }));
    expect(revised).toMatchObject({ action: "updated", goal_point: { value_low: 0.49, headline: true, note: "Guide end target" } });
    expect(x.t.get("SELECT headline, note FROM goal_point")).toEqual({ headline: 1, note: "Guide end target" });
    const cleared = await x.ok("set_goal_point", target({ headline: false, reason: "No longer the headline" }));
    expect(cleared).toMatchObject({ goal_point: { headline: false, note: "Guide end target" } });
    expect(x.t.get("SELECT headline, note FROM goal_point")).toEqual({ headline: 0, note: "Guide end target" });
    await x.ok("set_goal_point", target({ note: "New note", reason: "Reworded" }));
    expect(x.t.get("SELECT headline, note FROM goal_point")).toEqual({ headline: 0, note: "New note" });
  });

  it("takes a unit for a measured metric and asks when it is missing or doesn't fit", async () => {
    const x = setup();
    expect(await x.ok("set_goal_point", target({ metric: "waist_navel", value: 88, unit: "cm" }))).toMatchObject({ goal_point: { unit: "cm", value_low: 88 } });
    expect((await x.call("set_goal_point", target({ metric: "waist_navel", value: 88 }))).body).toMatchObject({ status: "needs_clarification", reason: "unit_needed" });
    expect((await x.call("set_goal_point", target({ metric: "waist_navel", value: 88, unit: "kg" }))).body).toMatchObject({ status: "needs_clarification", reason: "unit_mismatch" });
  });

  it("asks for a reason, for exactly one of value or range, for a range that runs low to high, and for a known metric", async () => {
    const x = setup();
    expect((await x.call("set_goal_point", target({ reason: undefined }))).body).toMatchObject({ reason: "reason_needed" });
    expect((await x.call("set_goal_point", target({ range: { low: 0.49, high: 0.51 } }))).body).toMatchObject({ reason: "value_or_range" });
    const neither = (await x.call("set_goal_point", target({ value: undefined }))).body;
    expect(neither).toMatchObject({ reason: "value_or_range" });
    expect(neither.question).toMatch(/either one value or a range/);
    expect((await x.call("set_goal_point", target({ value: undefined, range: { low: 0.52, high: 0.5 } }))).body).toMatchObject({ reason: "goal_range" });
    expect((await x.call("set_goal_point", target({ metric: "waistline" }))).body).toMatchObject({ reason: "unknown_metric" });
  });

  it("is owner-only: the member and the agent may set it, another member may not", async () => {
    const x = setup();
    expect((await x.call("set_goal_point", target(), "hritvik")).http).toBe(200);
    expect((await x.call("set_goal_point", target({ reason: "Agent sets it" }), "agent")).http).toBe(200);
    const refused = await x.call("set_goal_point", target(), "asha");
    expect(refused.http).toBe(403);
    expect(refused.body.error.code).toBe("not_visible");
  });
});

describe("one goal-point builder for the import and the app", () => {
  it("revises a goal the import stored on the sheet's Monday: found in its week, updated, not duplicated", async () => {
    const x = setup();
    // As the importer wrote goal points before 0028 normalised them: on the sheet's Monday.
    const imported = x.t.insert("goal_point", { member_id: x.h.hritvik, metric: "waist_navel", week_of: "2026-08-03", tier: "planned", basis: "absolute", value_low: 90, value_high: 90, unit: "cm" });
    const body = await x.ok("set_goal_point", { member: "Hritvik", metric: "waist_navel", week_of: "2026-08-05", value: 89.5, unit: "cm", tier: "planned", reason: "Guide revised" });
    expect(body).toMatchObject({ action: "updated", goal_point: { id: imported, week_of: "2026-08-02", value_low: 89.5 } });
    expect(x.t.all("SELECT week_of, value_low FROM goal_point")).toEqual([{ week_of: "2026-08-02", value_low: 89.5 }]);
  });

  it("create_goal_point (import only) builds through the same helper: Sunday weeks, the same questions", async () => {
    const x = setup();
    const at = { at: "2026-10-05T19:07:21Z", origin: { file: "hritvik", tab: "Trajectory", row: 2 } };
    const made = await importWrite(x.db, "create_goal_point", { member: "Hritvik", metric: "waist_navel", week_of: "2026-08-03", tier: "planned", basis: "absolute", value_low: 90, value_high: 90, unit: "cm" }, at);
    expect(made).toMatchObject({ status: "ok", goal_point: { week_of: "2026-08-02", unit: "cm" } });
    const mismatch = await importWrite(x.db, "create_goal_point", { member: "Hritvik", metric: "waist_navel", week_of: "2026-08-10", tier: "planned", basis: "absolute", value_low: 90, value_high: 90, unit: "kg" }, at);
    expect(mismatch).toMatchObject({ status: "needs_clarification", reason: "unit_mismatch" });
  });
});

describe("log_reading and waist_to_height", () => {
  it("refuses a reading of waist_to_height, which is computed from waist and height", async () => {
    const x = setup();
    const reply = await x.call("log_reading", { member: "Hritvik", date: "2026-10-05", metric: "waist_to_height", value: 0.52, unit: "ratio", body_state: "fasted" });
    expect(reply.body).toMatchObject({ status: "needs_clarification", reason: "computed_metric", options: ["waist_navel", "height"] });
  });
});
