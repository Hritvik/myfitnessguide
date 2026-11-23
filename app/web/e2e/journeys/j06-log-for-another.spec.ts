import { expect, type Page } from "@playwright/test";
import { fromTheSeed, journey } from "../support/journey.ts";
import { ABSENT, fromAnswer, probe, step, type Check, type Probe } from "../support/probes.ts";
import { settle } from "../support/settle.ts";
import { escapeRe, leftOf, leftToday, logFood, othersRow, region, tier, waitingRows } from "../support/ui.ts";

// It writes: each run leaves its slot fresh for the next (fromTheSeed).
fromTheSeed();

/**
 * Waiting on you and Waiting on others are Household's (HouseholdScreen). The spec's row says "their Left only after
 * Confirm", but drafts count in the day's totals (Worker decision 23: day_totals "Drafts count"): the draft moves
 * their Left when it is logged, to the value of log_intake's own answer (its `day` is theirs), and Confirm leaves it
 * where it is. Kabir has no target (his strip is what he has eaten so far): for him Confirm is pinned on his Chana
 * row, which loses its draft line.
 */
journey("J6", "log for another member: their Waiting on you and Today draft, my Waiting on others; drafts count in their Left (Worker 23)", [["asha", "kabir"], ["noor", "asha"]], async (j) => {
  const mine = await j.observer(j.me);
  const theirs = await j.observer(j.other);
  const them = j.names[j.other];
  const chana = (p: Page) => tier(p, "Snack").getByRole("listitem").filter({ hasText: /^Chana 23 g/ });
  const theirLeft = probe(theirs, "/", `${them}'s Left`, leftToday);
  const theirChana = probe(theirs, "/", `${them}'s Chana in Snack`, chana);
  const waitingOnOthers = probe(mine, "/household", `the Chana for ${them} in my Waiting on others`, (p) => othersRow(p, "Chana", them));
  const draftLine = `Draft, logged by ${j.names[j.me]}`;
  // Their Energy left, from log_intake's own answer (its day is theirs); Kabir has no target to be left of.
  const energyLeft: [Probe, Check][] = j.other === "kabir"
    ? []
    : [[probe(theirs, "/", `${them}'s Energy left`, (p) => leftOf(p, "Energy")), fromAnswer(() => j.tools.lastBody("log_intake"), (a) => a.day.left.kcal.left, "kcal")]];
  await step(`log 23 g of Chana for ${them}`, () => logFood(j.page, { food: "Chana", amount: "23", meal: "Snack", forName: them }), {
    changes: [
      [probe(theirs, "/household", `${them}'s Waiting on you`, (p) => region(p, "Waiting on you")), (after) => expect(after).toContain("Chana")],
      [theirChana, (after) => expect(after).toContain(draftLine)],
      // The row names the food and the member, not the amount (household.ts: "<summary> for <member>: …").
      [waitingOnOthers, (after) => expect(after).toMatch(new RegExp(`^Chana for ${escapeRe(them)}: `))],
      ...energyLeft,
    ],
    same: [probe(mine, "/", "my Snack", (p) => tier(p, "Snack"))],
  });
  await step(`${them} confirms it`, async () => {
    const t = await j.as(j.other);
    await t.goto("/household");
    await settle(t);
    // The seed may hold another Chana draft for them: this one is the one I logged.
    const row = waitingRows(t).filter({ hasText: "Chana" }).filter({ hasText: `Logged by ${j.names[j.me]}` });
    await row.getByRole("checkbox").check();
    await region(t, "Waiting on you").getByRole("button", { name: /^Confirm 1$/ }).click();
    await expect(row).toHaveCount(0);
  }, {
    changes: [[theirChana, (after) => expect(after).not.toContain("Draft")], [waitingOnOthers, (after) => expect(after).toBe(ABSENT)]],
    same: [theirLeft],
  });
});
