// Sheets-era honesty is computed from the records: who wrote them, and how
// much of the day's energy was typed in as macros.
import { describe, expect, it } from "vitest";
import { importWrite } from "../src/importing";
import { setup } from "./harness";
import { seedCatalogue, seedTraining } from "./seed";

const AT = "2026-10-05T19:07:21Z";
// Macros that agree with the kcal (4/4/9), so no energy check objects.
const typed = (kcal: number) => ({ source: "manual", kcal, protein_g: kcal * 0.05, carbs_g: kcal * 0.1, fat_g: Math.round(kcal * 0.0444 * 10) / 10, reason: "Typed macros in Sheets (no catalogue ref).", provenance: "reconstructed", confidence: "medium" });
const curd = (value: number) => ({ source: "food", food: "curd", value, unit: "g", provenance: "weighed", confidence: "high" });

describe("day_meals honesty", () => {
  it("marks an imported day, and a high share of typed macros with the share", async () => {
    const x = setup();
    await seedCatalogue(x);
    await importWrite(x.db, "log_intake", { member: "Hritvik", date: "2026-09-10", meal_slot: "lunch", items: [typed(600)] }, { at: AT, origin: { file: "hritvik", tab: "Nutrition", row: 12 } });
    await importWrite(x.db, "log_intake", { member: "Hritvik", date: "2026-09-10", meal_slot: "dinner", items: [curd(500)] }, { at: AT, origin: { file: "hritvik", tab: "Nutrition", row: 13 } });
    const body = await x.ok("day_meals", { member: "Hritvik", date: "2026-09-10" }, "hritvik");
    expect(body.honesty.imported).toBe(true);
    expect(body.honesty.typed_macros).toMatchObject({ items: 1, kcal: 600, high: true });
    expect(body.honesty.typed_macros.share).toBeCloseTo(600 / 900, 9);
  });

  it("a day logged in the app is not imported, and a low typed share is not high", async () => {
    const x = setup();
    await seedCatalogue(x);
    await x.ok("log_intake", { member: "Hritvik", date: "2026-10-05", meal_slot: "lunch", items: [curd(500), typed(100)] });
    const body = await x.ok("day_meals", { member: "Hritvik", date: "2026-10-05" }, "hritvik");
    expect(body.honesty).toMatchObject({ imported: false, typed_macros: { items: 1, kcal: 100, high: false } });
  });

  it("an empty day has no typed share", async () => {
    const x = setup();
    const body = await x.ok("day_meals", { member: "Hritvik", date: "2026-10-05" }, "hritvik");
    expect(body.honesty).toEqual({ imported: false, typed_macros: { items: 0, kcal: 0, share: null, high: false } });
  });
});

describe("sessions imported", () => {
  it("marks a session the import wrote", async () => {
    const x = setup();
    seedTraining(x);
    await importWrite(x.db, "log_cardio", { member: "Hritvik", date: "2026-09-12", session_type: "class", energy_kcal: 250, blocks: [{ kind: "steady", duration_s: 2700 }] }, { at: AT, origin: { file: "hritvik", tab: "Cardio", row: 4 } });
    await x.ok("log_cardio", { member: "Hritvik", date: "2026-10-04", session_type: "class", energy_kcal: 250, blocks: [{ kind: "steady", duration_s: 2700 }] });
    const body = await x.ok("sessions", { member: "Hritvik" }, "hritvik");
    expect(body.sessions.map((s: { date: string; imported: boolean }) => [s.date, s.imported])).toEqual([["2026-10-04", false], ["2026-09-12", true]]);
  });
});
