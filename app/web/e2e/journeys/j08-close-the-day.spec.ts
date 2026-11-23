import { expect, type Page } from "@playwright/test";
import { fromTheSeed, journey } from "../support/journey.ts";
import { ABSENT, probe, step } from "../support/probes.ts";
import { settle } from "../support/settle.ts";
import { dayLabel, escapeRe, region, weekView } from "../support/ui.ts";

// It writes: each run leaves its slot fresh for the next (fromTheSeed).
fromTheSeed();

// Yesterday is the day closed: the seed leaves it open with items logged, so the strip asks to close it
// ("Yesterday is still open", strip.ts), and closing it is the strip's own errand. The day's section on Today is
// labelled by its heading: "Close the day" while open, "Day closed" after (dayClose.ts).
journey("J8", "close the day, then reopen it: the day's status, Progress's week and the strip follow", ["asha", "kabir"], async (j) => {
  const mine = await j.observer(j.me);
  const theirs = await j.observer(j.other);
  const yesterday = `/?date=${j.yesterday}`;
  const dayClose = (p: Page) => p.getByRole("region", { name: /^(Close the day|Day closed)$/ });
  const status = probe(mine, yesterday, "yesterday's status on Today", dayClose);
  const weekRow = (p: Page) => weekView(p).getByRole("listitem").filter({ hasText: new RegExp(`^${escapeRe(dayLabel(j.yesterday))}`) });
  const week = probe(mine, `/progress/body?week=${j.yesterday}`, "yesterday in Progress's week", weekRow);
  // The strip shows three cards and "+N more" (strip.ts): other journeys' drafts and pots in this slot can push
  // yesterday's card past the three, so it is read with the strip opened out.
  // The strip and its "+N more" come with the page's first read (settle waits for it); once pressed, the button
  // must go (web-first), so a read never sees only the first three.
  const showAll = async (p: Page) => {
    const more = region(p, "Needs you").getByRole("button", { name: /^\+\d+ more$/ });
    if ((await more.count()) > 0) await more.click();
    await expect(more).toHaveCount(0);
  };
  const cards = (p: Page) => region(p, "Needs you").getByRole("listitem");
  const yesterdayCard = (p: Page) => cards(p).filter({ hasText: "Yesterday is still open" });
  const strip = probe(mine, "/", "the strip's yesterday card", yesterdayCard, showAll);
  // Every card, opened out: closing yesterday takes exactly its card away, and reopening brings exactly it back.
  const allCards = probe(mine, "/", "the strip's cards", cards, showAll);
  const count = (read: string) => (read === ABSENT ? 0 : read.split(" | ").length);
  // The other member's own yesterday is theirs alone.
  const theirWeek = probe(theirs, `/progress/body?week=${j.yesterday}`, `${j.other}'s yesterday in the week`, weekRow);

  await j.page.goto("/");
  await settle(j.page);
  await showAll(j.page);
  await expect(yesterdayCard(j.page)).toHaveCount(1);
  const open = count(await allCards.read());

  await step("close yesterday: some of it isn't logged", async () => {
    await yesterdayCard(j.page).getByRole("link", { name: "Open yesterday" }).click();
    await settle(j.page);
    await dayClose(j.page).getByRole("button", { name: "Some of it isn't logged" }).click();
    // Meals with nothing logged are asked about first (click test P2-11); close anyway.
    const anyway = j.page.getByRole("group", { name: "Close the day anyway?" });
    const closed = j.page.getByRole("region", { name: "Day closed" });
    await expect(closed.or(anyway)).toBeVisible();
    if (await anyway.isVisible()) await anyway.getByRole("button", { name: "Close anyway" }).click();
    await expect(closed).toBeVisible();
  }, {
    changes: [
      [status, (after) => expect(after).toContain("Closed: some of what was eaten isn't logged.")],
      [week, (after) => expect(after).toMatch(/· partial$/)],
      [strip, (after) => expect(after).toBe(ABSENT)],
      [allCards, (after) => expect(count(after), "one card fewer: yesterday's").toBe(open - 1)],
    ],
    same: [theirWeek],
  });

  await step("reopen it", async () => {
    await j.page.getByRole("region", { name: "Day closed" }).getByRole("button", { name: "Reopen the day" }).click();
    await expect(j.page.getByRole("region", { name: "Close the day" })).toBeVisible();
  }, {
    changes: [
      [status, (after) => expect(after).toContain("When this day's logging is done, close it")],
      [week, (after) => expect(after).toMatch(/· open$/)],
      [strip, (after) => expect(after).toMatch(/^Yesterday is still open \(\d+ items?\)\. Close it, and mark any meal you skipped\. Open yesterday$/)],
      [allCards, (after) => expect(count(after), "yesterday's card back").toBe(open)],
    ],
    same: [theirWeek],
  });
});
