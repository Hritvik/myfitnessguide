// The app's reading entry (spec addendum 7 Oct 2026, A): what can be
// logged, the owner-only rule the sheet relies on, and the strip's cadence
// card naming its metric. Invented readings only.
import { describe, expect, it } from "vitest";
import { seedGym, toolWithinBudget } from "./budget";
import { setup } from "./harness";

const reading = (more: Record<string, unknown>) => ({ member: "Hritvik", date: "2026-10-04", body_state: "not_recorded", ...more });

describe("reading_metrics", () => {
  it("lists every loggable metric with the units the metric table allows, the sides used and the last reading", async () => {
    const x = setup();
    await x.ok("log_reading", reading({ date: "2026-10-01", metric: "arm", value: 35.5, unit: "cm", side: "left" }), "hritvik");
    await x.ok("log_reading", reading({ metric: "weight", value: 172.4, unit: "lb", body_state: "fasted" }), "hritvik");
    const body = await x.ok("reading_metrics", { member: "Hritvik" }, "hritvik");
    const by = (code: string) => body.metrics.find((m: { code: string }) => m.code === code);
    expect(body.member).toBe("Hritvik");
    expect(by("weight")).toEqual({
      code: "weight", label: "Body weight", dimension: "mass", units: ["kg", "lb"], sides: [], usual_unit: "lb",
      last: { date: "2026-10-04", value: 172.4, unit: "lb", body_state: "fasted", side: null },
    });
    expect(by("arm")).toEqual({
      code: "arm", label: "Arm", dimension: "length", units: ["cm", "in", "mm"], sides: ["left"], usual_unit: "cm",
      last: { date: "2026-10-01", value: 35.5, unit: "cm", body_state: "not_recorded", side: "left" },
    });
    expect(by("bp_systolic")).toMatchObject({ units: ["mmHg"], sides: [], last: null });
    // Computed from the waist and the stored height: log_reading refuses it, so it isn't offered.
    expect(by("waist_to_height")).toBeUndefined();
    // 0028's ratio unit shares the score dimension but is waist to height's alone: never offered for a score.
    expect(by("bia_visceral_fat")).toMatchObject({ dimension: "score", units: ["score"] });
    expect(body.metrics.filter((m: { units: string[] }) => m.units.includes("ratio"))).toEqual([]);
  });

  it("is owner-only, as log_reading is: a member can't read or log another's; the agent's reading about someone else is their draft", async () => {
    const x = setup();
    expect((await x.call("reading_metrics", { member: "Asha" }, "hritvik")).body.error.code).toBe("not_visible");
    const ashas = reading({ member: "Asha", metric: "weight", value: 61, unit: "kg", body_state: "fasted" });
    expect((await x.call("log_reading", ashas, "hritvik")).body.error.code).toBe("not_visible");
    expect((await x.ok("log_reading", ashas)).reading.state).toBe("draft");
  });

  it("stays within the budget, with a long history", async () => {
    const x = setup();
    seedGym(x, 40);
    for (let d = 1; d <= 28; d++) {
      const on = `2026-09-${String(d).padStart(2, "0")}`;
      const base = { member_id: x.h.hritvik, measured_on: on, measurer: "self", suspect: 0, state: "confirmed", confirmed_at: "2026-10-01T00:00:00Z" };
      x.t.insert("reading", { ...base, metric: "weight", value: 80 - d * 0.1, unit: "kg", body_state: "fasted" });
      x.t.insert("reading", { ...base, metric: "arm", value: 35, unit: "cm", side: d % 2 ? "left" : "right", body_state: "not_recorded" });
    }
    await toolWithinBudget(x, "reading_metrics", { member: "Hritvik" }, "hritvik");
    await toolWithinBudget(x, "log_reading", reading({ date: "2026-10-05", metric: "weight", value: 77.1, unit: "kg", body_state: "fasted" }), "hritvik");
  });
});

describe("needs_you: a reading cadence's card", () => {
  it("names the metric and body state the cadence counts, so the app can open the Reading tab on them", async () => {
    const x = setup();
    await x.ok("set_measurement_cadence", { member: "Hritvik", name: "fasted_weight", every_days: 7, source: { kind: "reading", metric: "weight", body_state: "fasted" }, message: "Log a fasted weight." });
    const body = await x.ok("needs_you", { member: "Hritvik" }, "hritvik");
    expect(body.cards).toEqual([{ rule: "measurement", cadence: "fasted_weight", metric: "weight", body_state: "fasted", last: null, message: "Log a fasted weight." }]);
  });

  it("names no metric for a cadence that isn't a reading", async () => {
    const x = setup();
    await x.ok("set_measurement_cadence", { member: "Hritvik", name: "bp_cuff", every_days: 30, source: { kind: "manual" }, message: "Check the BP cuff's battery." });
    const body = await x.ok("needs_you", { member: "Hritvik" }, "hritvik");
    expect(body.cards[0]).toMatchObject({ rule: "measurement", cadence: "bp_cuff", metric: null, body_state: null });
  });

  it("names no metric for a cadence on a computed metric, which the Reading tab can't log", async () => {
    const x = setup();
    await x.ok("set_measurement_cadence", { member: "Hritvik", name: "waist_ratio", every_days: 14, source: { kind: "reading", metric: "waist_to_height" }, message: "Check your waist to height." });
    const body = await x.ok("needs_you", { member: "Hritvik" }, "hritvik");
    expect(body.cards[0]).toMatchObject({ rule: "measurement", cadence: "waist_ratio", metric: null, body_state: null });
  });
});

describe("reading_metrics: the usual unit per metric (click test P1-2)", () => {
  it("is the unit the member uses most for that metric, not the last one: one waist in inches among several in cm stays cm", async () => {
    const x = setup();
    for (const [date, value] of [["2026-09-20", 97], ["2026-09-27", 96.5], ["2026-10-01", 96]] as const) {
      await x.ok("log_reading", reading({ date, metric: "waist_navel", value, unit: "cm" }), "hritvik");
    }
    await x.ok("log_reading", reading({ date: "2026-10-03", metric: "waist_navel", value: 37.8, unit: "in" }), "hritvik");
    await x.ok("log_reading", reading({ date: "2026-10-03", metric: "arm", value: 14, unit: "in", side: "left" }), "hritvik");
    const body = await x.ok("reading_metrics", { member: "Hritvik" }, "hritvik");
    const by = (code: string) => body.metrics.find((m: { code: string }) => m.code === code);
    expect(by("waist_navel")).toMatchObject({ usual_unit: "cm", last: { unit: "in" } });
    // Each metric its own: the arm's one reading in inches makes inches its usual unit.
    expect(by("arm").usual_unit).toBe("in");
  });

  it("with no readings of a metric, its canonical unit (kg, cm, mmHg); a tie goes to the more recent", async () => {
    const x = setup();
    await x.ok("log_reading", reading({ date: "2026-10-01", metric: "weight", value: 170, unit: "lb", body_state: "fasted" }), "hritvik");
    await x.ok("log_reading", reading({ date: "2026-10-02", metric: "weight", value: 77, unit: "kg", body_state: "fasted" }), "hritvik");
    const body = await x.ok("reading_metrics", { member: "Hritvik" }, "hritvik");
    const by = (code: string) => body.metrics.find((m: { code: string }) => m.code === code);
    expect(by("weight").usual_unit).toBe("kg");
    expect(by("height").usual_unit).toBe("cm");
    expect(by("bp_systolic").usual_unit).toBe("mmHg");
    expect(by("sleep").usual_unit).toBe("h");
  });
});

describe("log_reading: an implausible value is asked about, never refused (click test P1-2)", () => {
  it("700 kg asks, writes nothing, and goes in as typed once the member says it is right", async () => {
    const x = setup();
    await x.ok("log_reading", reading({ date: "2026-10-01", metric: "weight", value: 70, unit: "kg", body_state: "fasted" }), "hritvik");
    const asked = await x.call("log_reading", reading({ metric: "weight", value: 700, unit: "kg", body_state: "fasted" }), "hritvik");
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "implausible_reading", path: ["implausible_ok"] });
    expect(asked.body.question).toBe("700 kg is outside the range a body weight can be (20 to 300 kg). Is it right?");
    expect(x.t.get("SELECT count(*) AS n FROM reading WHERE metric = 'weight'")).toEqual({ n: 1 });
    const body = await x.ok("log_reading", reading({ metric: "weight", value: 700, unit: "kg", body_state: "fasted", implausible_ok: true }), "hritvik");
    expect(body.reading).toMatchObject({ value: 700, unit: "kg", suspect: 0 });
  });

  it("94 in for a waist last measured 96 cm asks, and names the unit that would fit", async () => {
    const x = setup();
    await x.ok("log_reading", reading({ date: "2026-10-01", metric: "waist_navel", value: 96, unit: "cm" }), "hritvik");
    const asked = await x.call("log_reading", reading({ metric: "waist_navel", value: 94, unit: "in" }), "hritvik");
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "implausible_reading" });
    expect(asked.body.question).toBe("94 in (238.8 cm) is outside the range a waist at navel can be (40 to 200 cm). Did you mean 94 cm? If 94 in is right, say so.");
  });

  it("an in-range value far from the last (lb typed as kg) asks, naming the last reading", async () => {
    const x = setup();
    await x.ok("log_reading", reading({ date: "2026-10-01", metric: "weight", value: 77.5, unit: "kg", body_state: "fasted" }), "hritvik");
    const asked = await x.call("log_reading", reading({ metric: "weight", value: 171, unit: "kg", body_state: "fasted" }), "hritvik");
    expect(asked.body.question).toBe("171 kg is far from the last body weight, 77.5 kg on 2026-10-01. Did you mean 171 lb? If 171 kg is right, say so.");
  });

  it("a method change starts a new segment, so the last reading before it isn't compared", async () => {
    const x = setup();
    await x.ok("log_reading", reading({ date: "2026-10-01", metric: "waist_navel", value: 96, unit: "cm" }), "hritvik");
    await x.ok("log_reading", reading({ metric: "waist_navel", value: 70, unit: "cm", method_change: "Measured at the narrowest point now" }), "hritvik");
  });

  it("an ordinary reading doesn't ask", async () => {
    const x = setup();
    await x.ok("log_reading", reading({ date: "2026-10-01", metric: "weight", value: 77.5, unit: "kg", body_state: "fasted" }), "hritvik");
    await x.ok("log_reading", reading({ metric: "weight", value: 77.1, unit: "kg", body_state: "fasted" }), "hritvik");
    await x.ok("log_reading", reading({ metric: "weight", value: 170, unit: "lb", body_state: "fasted" }), "hritvik");
  });
});

describe("amend of a reading's value or unit asks as log_reading does (click test P1-2, P1-3)", () => {
  it("70 kg corrected to 700 asks; with implausible_ok it is amended; a plausible correction just goes in", async () => {
    const x = setup();
    await x.ok("log_reading", reading({ date: "2026-10-01", metric: "weight", value: 70.2, unit: "kg", body_state: "fasted" }), "hritvik");
    const r = await x.ok("log_reading", reading({ metric: "weight", value: 70, unit: "kg", body_state: "fasted" }), "hritvik");
    const record = { table: "reading", id: r.reading.id };
    const asked = await x.call("amend", { record, changes: { value: 700 }, reason: "Corrected in the app" }, "hritvik");
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "implausible_reading", path: ["implausible_ok"] });
    // Compared with the reading before it, never with itself.
    expect((await x.ok("amend", { record, changes: { value: 70.4 }, reason: "Corrected in the app" }, "hritvik")).after.value).toBe(70.4);
    expect((await x.ok("amend", { record, changes: { value: 700 }, reason: "Corrected in the app", implausible_ok: true }, "hritvik")).after.value).toBe(700);
    // Fixing a wrong unit back is plausible.
    expect((await x.ok("amend", { record, changes: { value: 70, unit: "kg" }, reason: "Corrected in the app" }, "hritvik")).after.value).toBe(70);
  });

  it("another member can't edit or remove a reading, and an implausible edit is refused before it is asked about", async () => {
    const x = setup();
    await x.ok("log_reading", reading({ date: "2026-10-01", metric: "weight", value: 70.2, unit: "kg", body_state: "fasted" }), "hritvik");
    const r = await x.ok("log_reading", reading({ metric: "weight", value: 70, unit: "kg", body_state: "fasted" }), "hritvik");
    const record = { table: "reading", id: r.reading.id };
    for (const changes of [{ value: 70.4 }, { value: 700 }]) {
      const edit = await x.call("amend", { record, changes, reason: "Corrected in the app" }, "asha");
      expect([edit.http, edit.body.error?.code]).toEqual([403, "not_visible"]);
      expect(JSON.stringify(edit.body)).not.toMatch(/70\.2|2026-10-01/);
    }
    const forced = await x.call("amend", { record, changes: { value: 700 }, reason: "Corrected in the app", implausible_ok: true }, "asha");
    expect([forced.http, forced.body.error?.code]).toEqual([403, "not_visible"]);
    const remove = await x.call("retract", { records: [record], reason: "Removed in the app" }, "asha");
    expect([remove.http, remove.body.error?.code]).toEqual([403, "not_visible"]);
    // Untouched, and still his.
    const mine = await x.ok("reading_metrics", { member: "Hritvik" }, "hritvik");
    expect(mine.recent[0]).toMatchObject({ id: r.reading.id, value: 70, unit: "kg" });
    expect((await x.call("reading_metrics", { member: "Hritvik" }, "asha")).body.error.code).toBe("not_visible");
  });
});

describe("reading_metrics: your recent readings, to fix (click test P1-3)", () => {
  it("lists the member's confirmed readings newest first with their ids, never a draft, at most 30", async () => {
    const x = setup();
    await x.ok("log_reading", reading({ date: "2026-10-01", metric: "weight", value: 70, unit: "kg", body_state: "fasted" }), "hritvik");
    const arm = await x.ok("log_reading", reading({ date: "2026-10-03", metric: "arm", value: 35.5, unit: "cm", side: "left" }), "hritvik");
    // The agent's reading about Asha is her draft, and Hritvik's list is his own.
    await x.ok("log_reading", reading({ member: "Asha", metric: "weight", value: 61, unit: "kg", body_state: "fasted" }));
    x.t.insert("reading", { member_id: x.h.hritvik, metric: "weight", measured_on: "2026-10-04", value: 71, unit: "kg", body_state: "fasted", measurer: "self", suspect: 0, state: "draft" });
    const body = await x.ok("reading_metrics", { member: "Hritvik" }, "hritvik");
    expect(body.recent).toEqual([
      { id: arm.reading.id, metric: "arm", date: "2026-10-03", value: 35.5, unit: "cm", side: "left", body_state: "not_recorded", note: null },
      { id: expect.any(Number), metric: "weight", date: "2026-10-01", value: 70, unit: "kg", side: null, body_state: "fasted", note: null },
    ]);
    for (let d = 1; d <= 35; d++) x.t.insert("reading", { member_id: x.h.hritvik, metric: "neck", measured_on: "2026-08-01", value: 38, unit: "cm", body_state: "not_recorded", measurer: "self", suspect: 0, state: "confirmed", confirmed_at: "2026-08-01T00:00:00Z" });
    expect((await x.ok("reading_metrics", { member: "Hritvik" }, "hritvik")).recent).toHaveLength(30);
  });
});

describe("an implausible reading about someone else names no earlier value (review round)", () => {
  it("the agent logging Asha's weight with Hritvik as speaker is told only that it is far from the last reading", async () => {
    const x = setup();
    await x.ok("log_reading", reading({ member: "Asha", date: "2026-10-01", metric: "weight", value: 61.3, unit: "kg", body_state: "fasted" }), "asha");
    const asked = await x.call("log_reading", reading({ member: "Asha", metric: "weight", value: 135, unit: "kg", body_state: "fasted", speaker: "Hritvik" }));
    expect(asked.body).toMatchObject({ status: "needs_clarification", reason: "implausible_reading" });
    expect(asked.body.question).toBe("135 kg is far from the last body weight reading. Did you mean 135 lb? If 135 kg is right, say so.");
    expect(asked.body.question).not.toMatch(/61|2026-10-01/);
    expect(JSON.stringify(asked.body)).not.toMatch(/61\.3/);
    // Asha herself is told the earlier value.
    expect((await x.call("log_reading", reading({ member: "Asha", metric: "weight", value: 135, unit: "kg", body_state: "fasted" }), "asha")).body.question).toMatch(/61\.3 kg on 2026-10-01/);
  });
});
