import { describe, expect, it } from "vitest";
import { setup, type Harness } from "./harness";
import { seedTraining } from "./seed";

const TODAY = "2026-10-05";

/** Invented cadences in the shape of the old gap registry. */
async function cadences(x: Harness) {
  await x.ok("set_measurement_cadence", { member: "Hritvik", name: "waist", every_days: 7, source: { kind: "reading", metric: "waist_navel" }, message: "Waist is overdue." });
  await x.ok("set_measurement_cadence", { member: "Hritvik", name: "fasted_weight", every_days: 2, source: { kind: "reading", metric: "weight", body_state: "fasted" }, message: "No recent fasted weight." });
  await x.ok("set_measurement_cadence", { member: "Hritvik", name: "hr_data", every_days: 7, source: { kind: "cardio_hr" }, message: "No HR data - wear the watch." });
  await x.ok("set_measurement_cadence", { member: "Hritvik", name: "progress_photos", every_days: 28, source: { kind: "manual" }, message: "No progress photos yet." });
  await x.ok("set_measurement_cadence", { member: "Hritvik", name: "push_up", every_days: 7, source: { kind: "exercise", exercise: "pushups" }, message: "Push-ups are overdue." });
}

const reading = (x: Harness, date: string, metric: string, value: number, unit: string, body_state = "fasted") =>
  x.ok("log_reading", { member: "Hritvik", date, metric, value, unit, body_state });

describe("set_measurement_cadence", () => {
  it("stores a cadence as data, and setting it again by name updates it", async () => {
    const x = setup();
    seedTraining(x);
    const created = await x.ok("set_measurement_cadence", { member: "Hritvik", name: "waist", every_days: 7, source: { kind: "reading", metric: "waist_navel" }, message: "Waist is overdue." });
    expect(created).toMatchObject({ action: "created", cadence: { name: "waist", every_days: 7, source: { kind: "reading", metric: "waist_navel" } } });
    const updated = await x.ok("set_measurement_cadence", { member: "Hritvik", name: "waist", every_days: 14, source: { kind: "reading", metric: "waist_navel" }, message: "Waist is overdue." });
    expect(updated).toMatchObject({ action: "updated", cadence: { id: created.cadence.id, every_days: 14 } });
  });

  it("asks when the metric or the exercise is unknown", async () => {
    const x = setup();
    seedTraining(x);
    const metric = await x.call("set_measurement_cadence", { member: "Hritvik", name: "waist", every_days: 7, source: { kind: "reading", metric: "waist" }, message: "m" });
    expect(metric.body).toMatchObject({ status: "needs_clarification", reason: "unknown_metric" });
    const exercise = await x.call("set_measurement_cadence", { member: "Hritvik", name: "x", every_days: 7, source: { kind: "exercise", exercise: "levitation" }, message: "m" });
    expect(exercise.body).toMatchObject({ status: "needs_clarification", reason: "unknown_exercise" });
  });
});

describe("staleness", () => {
  it("raises at most two overdue measurements, never-done first, from the member's own records", async () => {
    const x = setup();
    seedTraining(x);
    await cadences(x);
    await reading(x, "2026-09-20", "waist_navel", 88, "cm"); // 15 days ago: 8 days overdue
    await reading(x, "2026-10-04", "weight", 78, "kg"); // 1 day ago: on time
    const body = await x.ok("staleness", { member: "Hritvik", date: TODAY });
    // Never done: HR data, photos and push-ups. Two at most, in cadence order.
    expect(body.raise).toEqual(["No HR data - wear the watch.", "No progress photos yet."]);
    const waist = body.cadences.find((c: { name: string }) => c.name === "waist");
    expect(waist).toMatchObject({ last: "2026-09-20", days_since: 15, overdue_days: 8 });
    expect(body.cadences.find((c: { name: string }) => c.name === "fasted_weight")).toMatchObject({ last: "2026-10-04", overdue_days: null });
  });

  it("a draft reading (logged for the member by the agent) does not reset staleness", async () => {
    const x = setup();
    seedTraining(x);
    await cadences(x);
    await reading(x, "2026-09-20", "waist_navel", 88, "cm");
    x.t.insert("reading", { member_id: x.h.hritvik, metric: "waist_navel", measured_on: "2026-10-04", value: 70, unit: "cm", body_state: "not_recorded", measurer: "self", suspect: 0, state: "draft" });
    const body = await x.ok("staleness", { member: "Hritvik", date: TODAY });
    expect(body.cadences.find((c: { name: string }) => c.name === "waist")).toMatchObject({ last: "2026-09-20", overdue_days: 8 });
  });

  it("counts a fed weight as no fasted weight, and HR on a cardio block as HR data", async () => {
    const x = setup();
    seedTraining(x);
    await cadences(x);
    await reading(x, "2026-10-04", "weight", 78, "kg", "fed");
    await x.ok("log_cardio", { member: "Hritvik", date: "2026-10-03", session_type: "cardio", blocks: [{ kind: "steady", duration_s: 1200, avg_hr: 120 }] });
    await x.ok("set_measurement_cadence", { member: "Hritvik", name: "progress_photos", every_days: 28, source: { kind: "manual", last_done_on: "2026-10-01" }, message: "No progress photos yet." });
    const body = await x.ok("staleness", { member: "Hritvik", date: TODAY, limit: 5 });
    const by = (name: string) => body.cadences.find((c: { name: string }) => c.name === name);
    expect(by("fasted_weight").last).toBeNull();
    expect(by("hr_data").last).toBe("2026-10-03");
    expect(by("progress_photos").last).toBe("2026-10-01");
    expect(body.raise).toEqual(["Waist is overdue.", "No recent fasted weight.", "Push-ups are overdue."]);
  });

  it("an exercise cadence is met by a set of that exercise", async () => {
    const x = setup();
    seedTraining(x);
    await cadences(x);
    const session = (await x.ok("start_session", { member: "Hritvik", date: "2026-10-02", session_type: "strength" })).session.id;
    await x.ok("log_set", { session_id: session, exercise: "Push-up", reps: 15, load: "none", rir: 2 });
    const body = await x.ok("staleness", { member: "Hritvik", date: TODAY });
    expect(body.cadences.find((c: { name: string }) => c.name === "push_up")).toMatchObject({ last: "2026-10-02", overdue_days: null });
  });

  it("a member with no cadences has nothing to raise", async () => {
    const x = setup();
    const body = await x.ok("staleness", { member: "Kabir", date: TODAY });
    expect(body).toMatchObject({ raise: [], cadences: [] });
  });

  it("is owner-only: another member can't read it", async () => {
    const x = setup();
    seedTraining(x);
    await cadences(x);
    const reply = await x.call("staleness", { member: "Hritvik", date: TODAY }, "asha");
    expect(reply.body).toMatchObject({ status: "error", error: { code: "not_visible" } });
  });
});
