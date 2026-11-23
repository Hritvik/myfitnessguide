import { expect, type Page } from "@playwright/test";
import { fromTheSeed, journey } from "../support/journey.ts";
import { ABSENT, fromAnswer, probe, step } from "../support/probes.ts";
import { settle } from "../support/settle.ts";
import { leftOf, leftToday, logAs, othersRow, region, tier, waitingRows } from "../support/ui.ts";

// It writes: each run leaves its slot fresh for the next (fromTheSeed).
fromTheSeed();

/**
 * Waiting on you is Household's (HouseholdScreen). Drafts count in the day's totals (Worker decision 23), so a
 * Confirm leaves my Left where it is and pins the row instead (its draft line goes); Not mine removes the draft,
 * so my Left (or, with no whole target, what I have eaten so far) moves.
 */
journey("J20", "Waiting on you: tick, Confirm N, Not mine with a reason; my Left and the logger's Waiting on others", ["asha", "kabir", "noor"], async (j) => {
  // Asha's drafts are the seed's, logged by Kabir, plus these; Kabir's and Noor's are logged by Asha here.
  const logger = j.me === "asha" ? "kabir" : "asha";
  // What the strip shows after Jowar (log_intake's own answer: left of a whole target, else eaten so far). Confirm
  // leaves the totals alone (drafts count, Worker 23) and Not mine takes Urad out, so it is the strip's value after both.
  const afterJowar = await logAs(j.api(logger), j.names[j.me], j.today, "Jowar", 27);
  await logAs(j.api(logger), j.names[j.me], j.today, "Urad", 19);
  const energyAfterJowar = fromAnswer(async () => afterJowar, (a) => (a.day.left ? a.day.left.kcal.left : a.day.so_far.kcal.value), "kcal");
  const mine = await j.observer(j.me);
  const theirs = await j.observer(logger);
  const left = probe(mine, "/", "my Left", leftToday);
  const byLogger = (p: Page, food: string) => waitingRows(p).filter({ hasText: food }).filter({ hasText: `Logged by ${j.names[logger]}` });
  const waitingOnOthers = (food: string) => probe(theirs, "/household", `the ${food} for me in ${j.names[logger]}'s Waiting on others`, (p) => othersRow(p, food, j.names[j.me]));
  const jowar = probe(mine, "/", "my Jowar in Snack", (p) => tier(p, "Snack").getByRole("listitem").filter({ hasText: /^Jowar 27 g/ }));

  await step("tick one and Confirm 1", async () => {
    await j.page.goto("/household");
    await settle(j.page);
    await byLogger(j.page, "Jowar").getByRole("checkbox").check();
    await region(j.page, "Waiting on you").getByRole("button", { name: /^Confirm 1$/ }).click();
    await expect(byLogger(j.page, "Jowar")).toHaveCount(0);
  }, { changes: [[jowar, (after) => expect(after).not.toContain("Draft")], [waitingOnOthers("Jowar"), (after) => expect(after).toBe(ABSENT)]], same: [left, waitingOnOthers("Urad")] });

  await step("Not mine, with a reason", async () => {
    await j.page.goto("/household");
    await settle(j.page);
    const row = byLogger(j.page, "Urad");
    await row.getByRole("button", { name: "Not mine…" }).click();
    await row.getByLabel("Why isn't it yours?").fill("Someone else had the urad.");
    await row.getByRole("button", { name: "Remove it" }).click();
    await expect(row).toHaveCount(0);
  }, {
    changes: [
      [probe(mine, "/household", "the Urad row in my Waiting on you", (p) => byLogger(p, "Urad")), (after) => expect(after).toBe(ABSENT)],
      [waitingOnOthers("Urad"), (after) => expect(after).toBe(ABSENT)],
      [probe(mine, "/", "my Energy column", (p) => leftOf(p, "Energy")), energyAfterJowar],
    ],
    same: [jowar],
  });
}, { fast: ["asha"] });
