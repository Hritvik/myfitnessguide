import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { Ctx } from "../src/context";
import { NUTRITION_MAX_PAGES, nutritionTrends } from "../src/tools/screens";
import { READ_BUDGET, withinBudget } from "./budget";
import { invented, type InventedHarness } from "./invented";
import { CountingDb } from "./counting";
import { TimedDb } from "./timing";
import { seedYear } from "./year";

const TODAY = "2026-10-07";
const NEWEST = { from: "2026-09-13", to: "2026-10-10" } as const;

function logDays(x: InventedHarness, dates: readonly string[]) {
  for (const date of dates) {
    x.t.insert("intake_item", {
      member_id: x.h.asha, eaten_on: date, meal_slot: "lunch", source_kind: "manual",
      manual_kcal: 500, manual_protein_g: 30, manual_carbs_g: 50, manual_fat_g: 15,
      manual_reason: "range fixture", provenance: "estimated", confidence: "medium",
      state: "confirmed", confirmed_at: `${date}T12:00:00Z`,
    });
  }
}

function sparse(first = "2025-11-05") {
  const x = invented();
  logDays(x, [first, "2026-08-19", "2026-09-30", TODAY]);
  return x;
}

const trends = (x: InventedHarness, input: Record<string, unknown> = {}) =>
  x.ok("nutrition_trends", { member: "Asha", ...input }, "kabir");

describe("nutrition_trends ranges", () => {
  it("snaps to Sunday weeks, answers the newest four, and returns replayable older pages", async () => {
    const x = sparse();
    const four = await trends(x, { from: "2026-09-16" });
    expect(four).toMatchObject({ from: NEWEST.from, to: NEWEST.to, today: TODAY, pages: [] });
    expect(four.days).toHaveLength(28);
    expect(four.weeks.map((week: { week_start: string }) => week.week_start)).toEqual(["2026-09-13", "2026-09-20", "2026-09-27", "2026-10-04"]);

    const all = await trends(x, { from: "2026-07-12" });
    expect(all.pages).toEqual([
      { from: "2026-08-16", to: "2026-09-12" },
      { from: "2026-07-19", to: "2026-08-15" },
      { from: "2026-07-12", to: "2026-07-18" },
    ]);
    const replay = await trends(x, all.pages[2]);
    expect(replay).toMatchObject({ from: "2026-07-12", to: "2026-07-18", pages: [] });
    expect(replay.days).toHaveLength(7);
  });

  it("clamps to the first item or manual total and returns empty success for no logs, pre-first, and from after to", async () => {
    const x = sparse("2026-08-19");
    x.t.insert("day_status", {
      member_id: x.h.asha, day: "2026-06-03", status: "complete",
      manual_total_kcal: 2000, manual_total_protein_g: 120, manual_total_carbs_g: 230,
      manual_total_fat_g: 65, manual_total_reason: "legacy total",
    });
    const all = await trends(x);
    expect(all.first_logged_on).toBe("2026-06-03");
    expect(all.pages.at(-1)?.from).toBe("2026-05-31");
    expect(await x.ok("nutrition_trends", { member: "Noor" }, "kabir")).toMatchObject({ first_logged_on: null, from: null, to: null, pages: [], days: [], weeks: [] });
    expect(await trends(x, { from: "2025-01-01", to: "2025-03-01" })).toMatchObject({ from: null, to: null, pages: [], days: [], weeks: [] });
    expect(await trends(x, { from: "2026-10-04", to: "2026-09-01" })).toMatchObject({ from: null, to: null, pages: [], days: [], weeks: [] });
  });

  it("caps all and explicit old ranges at 26 four-week pages", async () => {
    const x = sparse("2023-01-04");
    const all = await trends(x);
    expect(NUTRITION_MAX_PAGES).toBe(26);
    expect(all).toMatchObject({ first_logged_on: "2023-01-04", capped: true });
    expect(all.pages).toHaveLength(25);
    expect(all.pages.at(-1)).toEqual({ from: "2024-10-13", to: "2024-11-09" });
    expect((await trends(x, { from: "2023-06-01" })).pages.at(-1)?.from).toBe("2024-10-13");
  });

  it("clamps a far-future to date to this week's Saturday", async () => {
    const x = sparse("2023-01-04");
    const out = await trends(x, { from: "2023-01-01", to: "9999-12-31" });
    expect(out.to).toBe("2026-10-10");
    expect(out.days).toHaveLength(28);
    expect(out.pages).toHaveLength(25);
  });
});

describe("nutrition_trends truth and privacy", () => {
  it("marks future days, today's open log, unlogged days, and exposes only household nutrition", async () => {
    const x = sparse();
    const out = await trends(x, { from: "2026-09-27" });
    const on = (date: string) => out.days.find((day: { date: string }) => day.date === date);
    expect(on("2026-10-08")).toMatchObject({ status: "future", not_counted: "future", kcal: null, cost: null });
    expect(on(TODAY)).toMatchObject({ status: "open", not_counted: "today_open", counted: false });
    expect(on("2026-09-30")).toMatchObject({ counted: true, logged: true, kcal: { complete: true } });
    expect(on("2026-10-01")).toMatchObject({ counted: false, not_counted: "unlogged", kcal: null });
    expect(Object.keys(out).sort()).toEqual(["capped", "days", "first_logged_on", "from", "member", "pages", "status", "to", "today", "weeks"]);
    expect(JSON.stringify(out)).not.toMatch(/fat_free|ffm|energy_availability|reading|bodyweight/);
  });

  it("returns truthful day/week coverage, targets and cost fields from the pure folds", async () => {
    const x = invented();
    seedYear(x.t, x.h, { cooksPerDay: 2 });
    const out = await trends(x, NEWEST);
    expect(out.days).toHaveLength(28);
    expect(out.weeks).toHaveLength(4);
    for (const [index, week] of out.weeks.entries()) {
      const days = out.days.slice(index * 7, index * 7 + 7);
      expect(week.days.logged).toBe(days.filter((day: { logged: boolean }) => day.logged).length);
      expect(week.days.complete).toBe(days.filter((day: { status: string }) => day.status === "complete").length);
    }
    const counted = out.days.find((day: { counted: boolean }) => day.counted);
    expect(counted).toMatchObject({ kcal: { complete: true }, protein: { complete: true }, cost: { complete: false }, cost_missing: "nothing_priced" });
    expect(counted).toHaveProperty("target", null);
    expect(out.weeks[0]).toHaveProperty("target_average");
  }, 120_000);
});

describe("nutrition_trends statement and CPU scale", () => {
  for (const cooksPerDay of [2, 6] as const) {
    it(`has newest/oldest fixed-query parity with ${cooksPerDay} cooks per day`, async () => {
      const x = invented();
      seedYear(x.t, x.h, { cooksPerDay });
      const newest = await x.counted("nutrition_trends", { member: "Asha", ...NEWEST }, "kabir");
      const oldest = await x.counted("nutrition_trends", { member: "Asha", from: "2025-10-05", to: "2025-11-01" }, "kabir");
      withinBudget(newest, READ_BUDGET);
      withinBudget(oldest, READ_BUDGET);
      expect(newest.statements, oldest.log.join("\n")).toBe(oldest.statements);
    }, 120_000);
  }

  it.runIf(process.env.BUDGET_REPORT === "cpu")("reports six-cook JavaScript time without weakening page size", async () => {
    const x = invented();
    seedYear(x.t, x.h, { cooksPerDay: 6 });
    const timed = new TimedDb(x.db);
    const counted = new CountingDb(timed);
    const ctx = new Ctx(counted, { kind: "member", memberId: x.h.kabir, householdId: x.h.id, name: "Kabir", channel: "web" }, () => x.clock.now, "Asia/Kolkata");
    const samples: number[] = [];
    for (let run = 0; run < 6; run++) {
      timed.reset();
      const started = performance.now();
      const out = await nutritionTrends(ctx, { member: "Asha", ...NEWEST });
      expect(out.days).toHaveLength(28);
      if (run > 0) samples.push(performance.now() - started - timed.sqlMs);
    }
    samples.sort((a, b) => a - b);
    console.log(`CPU nutrition_trends newest page, 6 cooks/day: ${samples[2]!.toFixed(2)} ms JS (median of 5 warm runs)`);
  }, 120_000);
});
