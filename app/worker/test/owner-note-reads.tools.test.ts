// An owner-only read returns the note it selects, to its owner (Worker
// decision 168, ticket 76). reading.note, blood_draw.note, goal_point.note and
// hr_zone.basis were written but no read returned them, even to the member who
// wrote them; the privacy suite's positive control then could not tell
// "hidden from others" from "shown to nobody". Each read here is already
// owner-only, so returning the note to the caller returns it to its owner
// alone. Invented data only.
import { describe, expect, it } from "vitest";
import { setup } from "./harness";

const SECRET = "Recovered after the invented virus";

describe("an owner-only read returns its note to the owner (ticket 76)", () => {
  it("body_trends returns a reading's note and a goal point's note", async () => {
    const x = setup();
    await x.ok("log_reading", { member: "Hritvik", date: "2026-10-01", metric: "weight", value: 70, unit: "kg", body_state: "fasted", note: SECRET }, "hritvik");
    await x.ok("set_goal_point", { member: "Hritvik", metric: "waist_navel", week_of: "2026-11-02", value: 80, unit: "cm", tier: "planned", note: `Goal. ${SECRET}`, reason: "invented" }, "hritvik");
    const body = await x.ok("body_trends", { member: "Hritvik", metric: "weight", from: "2026-09-01", to: "2026-12-01" }, "hritvik");
    const reading = body.segments.flatMap((s: { readings: { note: string | null }[] }) => s.readings).find((r: { note: string | null }) => r.note);
    expect(reading?.note).toBe(SECRET);
    const waist = await x.ok("body_trends", { member: "Hritvik", metric: "waist_navel", from: "2026-09-01", to: "2026-12-01" }, "hritvik");
    expect(waist.goal_points[0].note).toContain(SECRET);
    // Another member cannot reach either read (owner-only).
    expect((await x.call("body_trends", { member: "Hritvik", metric: "weight" }, "asha")).body.error.code).toBe("not_visible");
  });

  it("reading_metrics returns each recent reading's note", async () => {
    const x = setup();
    await x.ok("log_reading", { member: "Hritvik", date: "2026-10-01", metric: "arm", value: 35.5, unit: "cm", side: "left", body_state: "not_recorded", note: SECRET }, "hritvik");
    const body = await x.ok("reading_metrics", { member: "Hritvik" }, "hritvik");
    expect(body.recent[0].note).toBe(SECRET);
  });

  it("blood_draws returns each draw's note", async () => {
    const x = setup();
    await x.ok("log_blood_draw", { member: "Hritvik", date: "2026-10-02", lab: "Invented Labs", note: SECRET, results: [{ marker: "Ferritin", value: 50, unit: "ng/mL" }] }, "hritvik");
    const body = await x.ok("blood_draws", { member: "Hritvik" }, "hritvik");
    expect(body.draws[0].note).toBe(SECRET);
    expect((await x.call("blood_draws", { member: "Hritvik" }, "asha")).body.error.code).toBe("not_visible");
  });

  it("heart_rate_zones returns each zone's basis, and refuses another member", async () => {
    const x = setup();
    x.t.insert("hr_zone", { member_id: x.h.hritvik, zone: 2, low_bpm: 110, high_bpm: 130, status: "tested", set_on: "2026-10-01", basis: SECRET });
    const body = await x.ok("heart_rate_zones", { member: "Hritvik" }, "hritvik");
    expect(body.zones).toEqual([
      { id: expect.any(Number), zone: 2, low_bpm: 110, high_bpm: 130, status: "tested", set_on: "2026-10-01", basis: SECRET },
    ]);
    expect((await x.call("heart_rate_zones", { member: "Hritvik" }, "asha")).body.error.code).toBe("not_visible");
    // The agent reads it too.
    expect((await x.ok("heart_rate_zones", { member: "Hritvik" })).zones[0].basis).toBe(SECRET);
  });
});
