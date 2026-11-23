import { describe, expect, it } from "vitest";
import { Catalogue } from "../src/catalogue";
import { Ctx } from "../src/context";
import { dayViews, NutritionReader } from "../src/nutrition";
import { CountingDb } from "./counting";
import { invented } from "./invented";
import { TimedDb } from "./timing";
import { seedYear } from "./year";

const FROM = "2026-09-10";
const TO = "2026-10-07";

async function measureFresh(cooksPerDay: 2 | 6) {
  const x = invented();
  seedYear(x.t, x.h, { cooksPerDay });
  const timed = new TimedDb(x.db);
  const counted = new CountingDb(timed);
  const ctx = new Ctx(
    counted,
    { kind: "member", memberId: x.h.asha, householdId: x.h.id, name: "Asha", channel: "web" },
    () => new Date("2026-10-07T04:30:00Z"),
    "Asia/Kolkata",
  );
  const members = (await ctx.members()).filter((member) => member.id === x.h.asha);

  async function run() {
    counted.reset();
    timed.reset();
    const started = performance.now();
    const reader = new NutritionReader(ctx, await Catalogue.load(ctx));
    const result = await dayViews(ctx, reader, members, FROM, TO);
    const wallMs = performance.now() - started;
    return { ...result, statements: counted.count, jsMs: Math.max(0, wallMs - timed.sqlMs) };
  }

  await run(); // warm caches/JIT; measurements are the next five runs
  const samples = [];
  for (let sample = 0; sample < 5; sample++) samples.push(await run());
  if (process.env.MEASURE_NUTRITION_PAGE) {
    const js = samples.map((sample) => sample.jsMs).sort((a, b) => a - b);
    const statements = samples.map((sample) => sample.statements);
    console.log(
      `nutrition-page cooks=${cooksPerDay}: JS median=${js[2]!.toFixed(2)}ms p95=${js[4]!.toFixed(2)}ms; statements=${statements.join(",")}`,
    );
  }
  return samples;
}

type Samples = Awaited<ReturnType<typeof measureFresh>>;
const measurementCache = new Map<2 | 6, Promise<Samples>>();
function measure(cooksPerDay: 2 | 6): Promise<Samples> {
  const cached = measurementCache.get(cooksPerDay);
  if (cached) return cached;
  const pending = measureFresh(cooksPerDay);
  measurementCache.set(cooksPerDay, pending);
  return pending;
}

describe("nutrition page measurement", () => {
  it("loads 28 stable day views within one statement per day", async () => {
    const samples = await measure(2);
    for (const sample of samples) {
      expect(sample.views.size).toBe(28);
      expect(sample.statements).toBeLessThanOrEqual(28);
      expect(sample.views.get("1|2026-10-07")).toMatchObject({
        date: "2026-10-07",
        day_status: "complete",
        item_count: 8,
        draft_items: 0,
        target_effective_from: "2026-09-24",
        unknown_items: { any: 0 },
      });
    }
  });

  it("six shared cooks cost no fewer statements than two", async () => {
    const two = await measure(2);
    const six = await measure(6);
    expect(six[0]!.views.get("1|2026-10-07")).toMatchObject({ item_count: 12 });
    expect(Math.min(...six.map((sample) => sample.statements))).toBeGreaterThanOrEqual(
      Math.max(...two.map((sample) => sample.statements)),
    );
  });
});
