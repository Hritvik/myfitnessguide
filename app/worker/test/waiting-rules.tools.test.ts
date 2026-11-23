// One set of rules (redesign-a spec §5): needs_you is a projection of the shared rules in src/waiting.ts.
// Its remainder rule now covers the date and the two days before, in pots the member cooked or ate from.
import { describe, expect, it } from "vitest";
import { READ_BUDGET } from "./budget";
import { day, invented, seedFoods, WED } from "./invented";

const pot = (date: string, name: string, portions: { member: string; fraction: number }[]) => ({
  date, meal_slot: "dinner",
  cooks: [{ name, lines: [{ food: "Toor dal", value: 600, unit: "g", provenance: "weighed" }], portions: portions.map((p) => ({ ...p, provenance: "estimated" })) }],
});

describe("needs_you's remainder rule, shared with waiting", () => {
  it("lists an unaccounted rest in pots eaten from on the date and the two days before, not three days back", async () => {
    const x = invented();
    await seedFoods(x);
    await x.ok("household_meal", pot(day(-2), "Toor dal, Monday", [{ member: "Asha", fraction: 0.4 }]), "asha");
    await x.ok("household_meal", pot(day(-3), "Toor dal, Sunday", [{ member: "Asha", fraction: 0.4 }]), "asha");
    const cards = (await x.ok("needs_you", { member: "Asha" }, "asha")).cards.concat((await x.ok("needs_you", { member: "Asha" }, "asha")).more);
    expect(cards.filter((c: { rule: string }) => c.rule === "remainder").map((c: { cook: string; fraction: number; cooked_on: string }) => [c.cook, c.fraction, c.cooked_on])).toEqual([["Toor dal, Monday", 0.6, day(-2)]]);
  });

  it("lists a pot the member cooked though they took no share, and not one cooked by another they didn't eat from", async () => {
    const x = invented();
    await seedFoods(x);
    await x.ok("household_meal", pot(WED, "Rajma for the others", [{ member: "Kabir", fraction: 0.5 }]), "asha");
    await x.ok("household_meal", pot(WED, "Kabir's khichdi", [{ member: "Noor", fraction: 0.5 }]), "kabir");
    const out = await x.ok("needs_you", { member: "Asha" }, "asha");
    const cooks = [...out.cards, ...out.more].filter((c: { rule: string }) => c.rule === "remainder").map((c: { cook: string }) => c.cook);
    expect(cooks).toEqual(["Rajma for the others"]);
  });

  it(`reads three days' pots in the same statements as one day's, at most ${READ_BUDGET} (decision 96)`, async () => {
    const run = async (days: number) => {
      const x = invented();
      await seedFoods(x);
      for (let n = 0; n < days; n++) await x.ok("household_meal", pot(day(-n), `Toor dal ${n}`, [{ member: "Asha", fraction: 0.4 }]), "asha");
      const out = await x.counted("needs_you", { member: "Asha" }, "asha");
      expect([...out.body.cards, ...out.body.more].filter((c: { rule: string }) => c.rule === "remainder")).toHaveLength(days);
      return out.statements;
    };
    const one = await run(1);
    expect(await run(3)).toBe(one);
    expect(one).toBeLessThanOrEqual(READ_BUDGET);
  });

  it("keeps yesterday's rule and the load rule as they were", async () => {
    const x = invented();
    await seedFoods(x);
    await x.ok("log_intake", { member: "Asha", date: day(-1), meal_slot: "lunch", items: [{ source: "food", food: "Curd", value: 150, unit: "g", provenance: "weighed", confidence: "high" }] }, "asha");
    const out = await x.ok("needs_you", { member: "Asha" }, "asha");
    expect([...out.cards, ...out.more].find((c: { rule: string }) => c.rule === "yesterday_open")).toMatchObject({ date: day(-1), items: 1 });
  });
});

describe("the drafts snapshot carries what grouping needs", () => {
  it("gives each draft its date, slot, origin and logger; a re-draft its latest writer", async () => {
    const x = invented();
    await seedFoods(x);
    const out = await x.ok("log_intake", { member: "Asha", date: day(-1), meal_slot: "lunch", items: [{ source: "food", food: "Curd", value: 150, unit: "g", provenance: "estimated", confidence: "medium" }] }, "kabir");
    const id = out.items[0].id as number;
    const { householdDrafts } = await import("../src/drafts");
    const { Ctx } = await import("../src/context");
    const ctx = new Ctx(x.db, { kind: "agent", resolver: "claude_code", householdId: x.h.id, clientId: "test" }, () => x.clock.now, "Asia/Kolkata");
    const [d] = await householdDrafts(ctx);
    expect(d).toMatchObject({ table: "intake_item", id, owner: x.h.asha, loggedBy: x.h.kabir, origin: "app", on: day(-1), slot: "lunch", parent: null, everConfirmed: false, editedBy: null });
    // Asha confirms; Kabir edits: a re-draft whose latest writer is Kabir.
    await x.ok("confirm", { records: [{ table: "intake_item", id }] }, "asha");
    await x.ok("amend", { record: { table: "intake_item", id }, changes: { amount_value: 200 }, reason: "It was a bigger bowl" }, "kabir");
    const [again] = await householdDrafts(ctx);
    expect(again).toMatchObject({ everConfirmed: true, editedBy: x.h.kabir });
  });
});
