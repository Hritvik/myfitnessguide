// body_trends' goal series, current-week verdict (whatever the range),
// phase, headline (resolved in the same call), and the waist:height block.
// Today is Mon 5 Oct 2026, so this week starts Sun 4 Oct.
import { describe, expect, it } from "vitest";
import { setup, type Harness } from "./harness";

const read = (x: Harness, date: string, metric: string, value: number, unit: string) =>
  x.ok("log_reading", { member: "Hritvik", date, metric, value, unit, body_state: metric === "height" ? "not_recorded" : "fasted" });

const goal = (x: Harness, metric: string, week_of: string, value: number, unit: string | null, tier = "planned") =>
  x.t.insert("goal_point", { member_id: x.h.hritvik, metric, week_of, tier, basis: "absolute", value_low: value, value_high: value, unit });

describe("body_trends current-week verdict", () => {
  it("says no reading this week when the latest reading is old, while the old verdict stays as it was", async () => {
    const x = setup();
    await read(x, "2026-09-13", "weight", 80, "kg");
    goal(x, "weight", "2026-09-13", 80, "kg");
    goal(x, "weight", "2026-10-04", 78.5, "kg");
    const body = await x.ok("body_trends", { member: "Hritvik", metric: "weight", direction: "decrease" });
    expect(body.current_week).toMatchObject({ verdict: "no_reading", week: "2026-10-04", goal: 78.5, reading: null });
    expect(body.goal).toMatchObject({ verdict: "on_track", week: "2026-09-13" });
  });

  it("is the same whatever range the chart asks for", async () => {
    const x = setup();
    await read(x, "2026-10-05", "weight", 78.4, "kg");
    goal(x, "weight", "2026-10-04", 78.5, "kg");
    const ranged = await x.ok("body_trends", { member: "Hritvik", metric: "weight", direction: "decrease", from: "2026-08-01", to: "2026-08-31" });
    expect(ranged.segments).toEqual([]);
    expect(ranged.current_week).toMatchObject({ verdict: "on_track", reading: 78.4, goal: 78.5 });
  });

  it("says no goal point this week when there is none, and behind only from three weeks running", async () => {
    const x = setup();
    await read(x, "2026-10-05", "weight", 78.4, "kg");
    goal(x, "weight", "2026-09-27", 79, "kg");
    expect((await x.ok("body_trends", { member: "Hritvik", metric: "weight", direction: "decrease" })).current_week).toMatchObject({ verdict: "no_goal_point", week: "2026-10-04" });

    const y = setup();
    for (const [date, week] of [["2026-09-21", "2026-09-20"], ["2026-09-28", "2026-09-27"], ["2026-10-05", "2026-10-04"]] as const) {
      await y.ok("log_reading", { member: "Hritvik", date, metric: "weight", value: 81.5, unit: "kg", body_state: "fasted" });
      goal(y, "weight", week, 80, "kg");
    }
    expect((await y.ok("body_trends", { member: "Hritvik", metric: "weight", direction: "decrease" })).current_week).toMatchObject({ verdict: "behind", weeksBehind: 3 });
  });
});

describe("body_trends goal series, phase and headline", () => {
  it("returns planned and stretch goal points in canonical units, the phase holding today, and the unit", async () => {
    const x = setup();
    goal(x, "weight", "2026-10-04", 172, "lb");
    goal(x, "weight", "2026-10-04", 76, "kg", "stretch");
    x.t.insert("phase", { member_id: x.h.hritvik, name: "Cut 1", starts_on: "2026-09-01", ends_on: null, energy_stance: "deficit", intent: "Lose waist" });
    const body = await x.ok("body_trends", { member: "Hritvik", metric: "weight" });
    expect(body.goal_points).toHaveLength(2);
    expect(body.goal_points[0]).toMatchObject({ week_of: "2026-10-04", tier: "planned" });
    expect(body.goal_points[0].low).toBeCloseTo(78.018, 3);
    expect(body.goal_points[1]).toMatchObject({ tier: "stretch", low: 76, high: 76 });
    expect(body.current_phase).toEqual({ name: "Cut 1", starts_on: "2026-09-01", ends_on: null, energy_stance: "deficit" });
    expect(body.canonical_unit).toBe("kg");
  });

  it("resolves the headline in the same call: waist:height reads the waist, with its ratio block and direction", async () => {
    const x = setup();
    await read(x, "2026-01-01", "height", 175, "cm");
    await read(x, "2026-10-05", "waist_navel", 88, "cm");
    goal(x, "waist_navel", "2026-10-04", 90, "cm");
    await x.ok("set_goal_point", { member: "Hritvik", metric: "waist_to_height", week_of: "2027-03-28", value: 0.5, tier: "planned", reason: "Guide end target" });
    for (const input of [{ member: "Hritvik", metric: "headline" }, { member: "Hritvik" }]) {
      const body = await x.ok("body_trends", input);
      expect(body).toMatchObject({ metric: "waist_navel", headline: { metric: "waist_to_height", direction: "decrease", reason: null } });
      expect(body.waist_to_height.current_week).toMatchObject({ verdict: "ahead" });
      expect(body.current_week).toMatchObject({ verdict: "ahead", goal: 90 });
    }
  });

  it("falls back to the first planned goal metric, with its direction, answering for it in the same call", async () => {
    const x = setup();
    goal(x, "weight", "2026-09-27", 80, "kg");
    goal(x, "weight", "2026-10-04", 79.5, "kg");
    await read(x, "2026-10-05", "weight", 79.4, "kg");
    const body = await x.ok("body_trends", { member: "Hritvik", metric: "headline" });
    expect(body).toMatchObject({ metric: "weight", headline: { metric: "weight", direction: "decrease", reason: "No height is stored." }, current_week: { verdict: "on_track" } });
    expect(body.segments[0].readings).toHaveLength(1);
    expect((await x.ok("body_trends", { member: "Hritvik", metric: "waist_navel" })).waist_to_height).toBeNull();
  });

  it("has no headline, and empty series, for a member with no goal points", async () => {
    const x = setup();
    const body = await x.ok("body_trends", { member: "Hritvik", metric: "headline" });
    expect(body).toMatchObject({ metric: null, headline: { metric: null, direction: null, reason: "No planned goal points yet." }, segments: [], goal_points: [], current_phase: null });
  });
});

describe("body_trends waist:height", () => {
  it("gives each waist reading's ratio from the stored height, the goal path from the cm goals, the stored ratio goals, and its own verdict", async () => {
    const x = setup();
    await read(x, "2026-01-01", "height", 175, "cm");
    await read(x, "2026-09-28", "waist_navel", 92, "cm");
    await read(x, "2026-10-05", "waist_navel", 88, "cm");
    goal(x, "waist_navel", "2026-09-27", 90, "cm");
    goal(x, "waist_navel", "2026-10-04", 90, "cm");
    await x.ok("set_goal_point", { member: "Hritvik", metric: "waist_to_height", week_of: "2027-03-28", value: 0.5, tier: "planned", reason: "Guide end target" });

    const body = await x.ok("body_trends", { member: "Hritvik", metric: "waist_navel", direction: "decrease" });
    const w = body.waist_to_height;
    expect(w.height_cm).toBe(175);
    expect(w.segments[0].readings.map((r: { value: number }) => r.value)).toEqual([92 / 175, 88 / 175]);
    expect(w.goal_path).toEqual([
      { week_of: "2026-09-27", value: 90 / 175 },
      { week_of: "2026-10-04", value: 90 / 175 },
      { week_of: "2027-03-28", value: 0.5 },
    ]);
    expect(w.goal_points).toEqual([{ week_of: "2027-03-28", tier: "planned", low: 0.5, high: 0.5 }]);
    expect(w.band).toBeCloseTo(1 / 175, 12);
    // 2 cm under this week's 90 cm goal is beyond the ±1 cm band on the good side.
    expect(w.current_week).toMatchObject({ verdict: "ahead", week: "2026-10-04" });
    expect(w.current_week.reading).toBeCloseTo(88 / 175, 12);
  });

  it("returns the end target even when the range ends before its week", async () => {
    const x = setup();
    await read(x, "2026-01-01", "height", 175, "cm");
    await read(x, "2026-10-05", "waist_navel", 88, "cm");
    goal(x, "waist_navel", "2026-10-04", 90, "cm");
    goal(x, "waist_navel", "2027-03-28", 87.5, "cm");
    await x.ok("set_goal_point", { member: "Hritvik", metric: "waist_to_height", week_of: "2027-03-28", value: 0.5, tier: "planned", reason: "Guide end target" });
    const body = await x.ok("body_trends", { member: "Hritvik", metric: "headline", from: "2026-07-15", to: "2026-12-31" });
    expect(body.waist_to_height.goal_points).toEqual([]);
    expect(body.waist_to_height.end_target).toEqual({ week_of: "2027-03-28", low: 0.5, high: 0.5 });
    expect(body.end_target).toEqual({ week_of: "2027-03-28", low: 87.5, high: 87.5 });
  });

  it("is owner-only like the rest of body_trends: another member is refused, the agent and the owner read", async () => {
    const x = setup();
    expect((await x.call("body_trends", { member: "Hritvik", metric: "headline" }, "asha")).http).toBe(403);
    expect((await x.call("body_trends", { member: "Hritvik", metric: "headline" }, "agent")).http).toBe(200);
    expect((await x.call("body_trends", { member: "Hritvik", metric: "headline" }, "hritvik")).http).toBe(200);
  });
});

describe("drafts stay out of trends (final-wave ruling)", () => {
  it("a same-day draft waist beside a confirmed one moves no trend, headline, verdict or last reading; it waits in Drafts to check", async () => {
    const x = setup();
    const own = (date: string, metric: string, value: number, unit: string) =>
      x.ok("log_reading", { member: "Asha", date, metric, value, unit, body_state: metric === "height" ? "not_recorded" : "fasted" }, "asha");
    await own("2026-09-01", "height", 160, "cm");
    await own("2026-10-05", "waist_navel", 80, "cm");
    // The agent, talking with Hritvik, logs Asha's waist the same day: her draft.
    const draft = (await x.ok("log_reading", { member: "Asha", date: "2026-10-05", metric: "waist_navel", value: 90, unit: "cm", body_state: "fasted" })).reading;
    expect(draft.state).toBe("draft");
    // And a draft height, which must not rescale her ratio.
    await x.ok("log_reading", { member: "Asha", date: "2026-10-04", metric: "height", value: 170, unit: "cm", body_state: "not_recorded" });
    x.t.insert("goal_point", { member_id: x.h.asha, metric: "waist_to_height", week_of: "2026-10-04", tier: "planned", basis: "absolute", value_low: 0.5, value_high: 0.5, unit: "ratio" });

    const body = await x.ok("body_trends", { member: "Asha" }, "asha");
    expect(body.metric).toBe("waist_navel");
    expect(body.segments.flatMap((s: { readings: { value: number }[] }) => s.readings.map((r) => r.value))).toEqual([80]);
    expect(body.waist_to_height.height_cm).toBe(160);
    expect(body.waist_to_height.segments.flatMap((s: { readings: { value: number }[] }) => s.readings.map((r) => r.value))).toEqual([0.5]);
    expect(body.waist_to_height.current_week).toMatchObject({ reading: 0.5 });

    const metrics = await x.ok("reading_metrics", { member: "Asha" }, "asha");
    expect(metrics.metrics.find((m: { code: string }) => m.code === "waist_navel").last).toMatchObject({ date: "2026-10-05", value: 80 });
    expect(metrics.metrics.find((m: { code: string }) => m.code === "height").last).toMatchObject({ value: 160 });
    expect((await x.ok("health_drafts", { member: "Asha" }, "asha")).readings.map((r: { id: number }) => r.id)).toContain(draft.id);
  });
});
