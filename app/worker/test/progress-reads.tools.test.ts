import { describe, expect, it } from "vitest";
import { setup, type Harness } from "./harness";
import { seedCatalogue, seedTraining } from "./seed";

const curd = (value: number) => ({ source: "food", food: "curd", value, unit: "g", provenance: "weighed", confidence: "high" });
const biscuits = { source: "manual", kcal: 100, protein_g: 5, carbs_g: 10, fat_g: 4.4, reason: "No catalogue entry", label: "Biscuits", provenance: "estimated", confidence: "low" };

async function ready() {
  const x = setup();
  seedTraining(x);
  await seedCatalogue(x);
  await x.ok("set_target", {
    member: "Hritvik", effective_from: "2026-09-01", provenance: "member", reasoning: "Test target",
    values: [
      { nutrient: "kcal", kind: "target", value: 2000 },
      { nutrient: "protein_g", kind: "target", value: 150 },
      { nutrient: "fat_g", kind: "target", value: 60 },
      { nutrient: "fat_g", kind: "floor", value: 45 },
      { nutrient: "carbs_g", kind: "remainder" },
    ],
  });
  return x;
}

async function week(x: Harness) {
  // Sun 4 Oct: 300 kcal weighed + 100 kcal estimated, and a 300 kcal dance class.
  await x.ok("log_intake", { member: "Hritvik", date: "2026-10-04", meal_slot: "lunch", items: [curd(500), biscuits] });
  await x.ok("log_cardio", { member: "Hritvik", date: "2026-10-04", session_type: "class", energy_kcal: 300, blocks: [{ kind: "steady", duration_s: 3600 }] });
  // Mon 5 Oct: 150 kcal weighed, and a gym session with no energy recorded.
  await x.ok("log_intake", { member: "Hritvik", date: "2026-10-05", meal_slot: "lunch", items: [curd(250)] });
  await x.ok("start_session", { member: "Hritvik", date: "2026-10-05", session_type: "strength" });
}

describe("week_summary", () => {
  it("gives the week Sunday to Saturday: each day's kcal against target, protein, status and training", async () => {
    const x = await ready();
    await week(x);
    const body = await x.ok("week_summary", { member: "Hritvik" }, "hritvik");
    expect(body).toMatchObject({ week_start: "2026-10-04", week_end: "2026-10-10" });
    expect(body.days.map((d: { date: string; kind: string }) => [d.date, d.kind])).toEqual([
      ["2026-10-04", "dance"], ["2026-10-05", "gym"], ["2026-10-06", "rest"], ["2026-10-07", "rest"],
      ["2026-10-08", "rest"], ["2026-10-09", "rest"], ["2026-10-10", "rest"],
    ]);
    expect(body.days[0]).toMatchObject({ kcal_target: 2000, protein_target: 150, day_status: "open", item_count: 2, training: [{ kind: "dance", energy_kcal: 300 }] });
    expect(body.days[0].kcal).toBeCloseTo(400, 6);
    expect(body.days[1].kcal).toBeCloseTo(150, 6);
  });

  it("says how much of the week's energy was measured", async () => {
    const x = await ready();
    await week(x);
    const body = await x.ok("week_summary", { member: "Hritvik" }, "hritvik");
    expect(body.measured.kcal_known).toBeCloseTo(550, 6);
    expect(body.measured.kcal_measured).toBeCloseTo(450, 6);
    expect(body.measured.share).toBeCloseTo(450 / 550, 9);
  });

  it("computes energy availability from the latest fat-free mass, flagged below 25 kcal/kg", async () => {
    const x = await ready();
    await week(x);
    await x.ok("log_reading", { member: "Hritvik", date: "2026-10-01", metric: "bia_fat_free_mass", value: 60, unit: "kg", body_state: "fasted" });
    const body = await x.ok("week_summary", { member: "Hritvik" }, "hritvik");
    // (550 / 2 days) - (300 / 2 days) = 125 kcal a day over 60 kg.
    expect(body.energy_availability).toMatchObject({ low: true, threshold: 25, ffm_kg: 60, ffm_measured_on: "2026-10-01", days_counted: 2, sessions_without_energy: 0 });
    expect(body.energy_availability.value).toBeCloseTo(125 / 60, 9);
  });

  it("without fat-free mass, energy availability is not known, and says why", async () => {
    const x = await ready();
    await week(x);
    const body = await x.ok("week_summary", { member: "Hritvik" }, "hritvik");
    expect(body.energy_availability).toBeNull();
    expect(body.energy_availability_missing).toBe("no fat-free mass reading");
  });

  it("a week with nothing logged has no measured share and no energy availability, never zero", async () => {
    const x = await ready();
    await x.ok("log_reading", { member: "Hritvik", date: "2026-09-01", metric: "bia_fat_free_mass", value: 60, unit: "kg", body_state: "fasted" });
    const body = await x.ok("week_summary", { member: "Hritvik", week: "2026-09-23" }, "hritvik");
    expect(body).toMatchObject({ week_start: "2026-09-20", week_end: "2026-09-26", energy_availability: null, energy_availability_missing: "nothing logged this week" });
    expect(body.measured).toEqual({ kcal_measured: 0, kcal_known: 0, share: null });
    expect(body.days.every((d: { item_count: number }) => d.item_count === 0)).toBe(true);
  });

  it("each day reads the target in force that day, when it changes mid-week", async () => {
    const x = await ready();
    await x.ok("set_target", {
      member: "Hritvik", effective_from: "2026-10-07", provenance: "member", reasoning: "Test target change",
      values: [
        { nutrient: "kcal", kind: "target", value: 1800 },
        { nutrient: "protein_g", kind: "target", value: 160 },
        { nutrient: "fat_g", kind: "target", value: 55 },
        { nutrient: "carbs_g", kind: "remainder" },
      ],
    });
    const body = await x.ok("week_summary", { member: "Hritvik" }, "hritvik");
    expect(body.days.map((d: { kcal_target: number; protein_target: number }) => [d.kcal_target, d.protein_target])).toEqual([
      [2000, 150], [2000, 150], [2000, 150], [1800, 160], [1800, 160], [1800, 160], [1800, 160],
    ]);
  });

  it("is owner-only: another member is refused; the member and the agent read it", async () => {
    const x = await ready();
    const refused = await x.call("week_summary", { member: "Hritvik" }, "asha");
    expect(refused.http).toBe(403);
    expect(refused.body.error.code).toBe("not_visible");
    expect((await x.call("week_summary", { member: "Hritvik" }, "agent")).http).toBe(200);
  });
});

describe("blood_draws change", () => {
  it("gives each plain numeric result its change since the previous draw", async () => {
    const x = setup();
    await x.ok("log_blood_draw", { member: "Hritvik", date: "2026-04-01", lab: "Thyrocare", results: [{ marker: "TSH", value: 3.1, unit: "mIU/L", ref_low: 0.4, ref_high: 4.2 }] });
    await x.ok("log_blood_draw", { member: "Hritvik", date: "2026-10-01", lab: "Thyrocare", results: [{ marker: "TSH", value: 5.6, unit: "mIU/L", ref_low: 0.4, ref_high: 4.2 }, { marker: "CRP", value: 0.5, comparator: "<", unit: "mg/L", ref_high: 5 }] });
    const body = await x.ok("blood_draws", { member: "Hritvik" });
    const [latest, earlier] = body.draws;
    expect(latest.results.map((r: { marker: string; status: string | null }) => [r.marker, r.status])).toEqual([["TSH", "above"], ["CRP", null]]);
    expect(latest.results[0].change.previous).toBe(3.1);
    expect(latest.results[0].change.previous_on).toBe("2026-04-01");
    expect(latest.results[0].change.delta).toBeCloseTo(2.5, 9);
    expect(latest.results[1].change).toBeNull();
    expect(earlier.results[0].change).toBeNull();
  });
});
