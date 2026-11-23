import { fromTheSeed, journey } from "../support/journey.ts";
import { fromAnswer, probe, step, type Check, type Probe } from "../support/probes.ts";
import { householdRow, leftOf, leftToday, logFood, tierMeta, weekView } from "../support/ui.ts";

// It writes: each run leaves its slot fresh for the next (fromTheSeed).
fromTheSeed();

/**
 * Only Asha has a whole target in the seed. Noor's is kcal only, and a target without protein, fat and carbs
 * is none (worker nutrition.ts domainTarget): her day's `left` is null, as Kabir's is, so the strip shows what
 * each has eaten "so far" and Household says "No target set" whatever they log (household.ts). The Energy
 * column is checked against the field of log_intake's answer the screen shows; the Household row is watched
 * only where it carries a number (F18).
 */
journey("J1", "log an item: Today, Progress's week and Household follow; nobody else's Left moves", [["asha", "noor"], "kabir", "noor"], async (j) => {
  const mine = await j.observer(j.me);
  const theirs = await j.observer(j.other);
  const answer = () => j.tools.lastBody("log_intake");
  const changes: (Probe | [Probe, Check])[] = [
    probe(mine, "/", "my Snack subtotal", (p) => tierMeta(p, "Snack")),
    probe(mine, `/progress/body?week=${j.today}`, "my Progress week", weekView),
    // What is left of the target (day.left.kcal.left), or with no target what is eaten so far (day.so_far.kcal.value).
    [probe(mine, "/", "my Energy column", (p) => leftOf(p, "Energy")), fromAnswer(answer, (a) => (a.day.left ? a.day.left.kcal.left : a.day.so_far.kcal.value), "kcal")],
  ];
  if (j.me === "asha") changes.push(probe(mine, "/household", "my Household row", (p) => householdRow(p, j.names[j.me])));
  await step("log 41 g of Ragi at Snack", () => logFood(j.page, { food: "Ragi", amount: "41", meal: "Snack" }), {
    changes,
    same: [probe(theirs, "/", `${j.other}'s Left today`, leftToday), probe(mine, `/?date=${j.yesterday}`, "my yesterday's Snack", (p) => tierMeta(p, "Snack"))],
  });
}, { fast: ["asha"] });
