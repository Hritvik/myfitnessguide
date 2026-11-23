import { expect, type Page } from "@playwright/test";
import { fromTheSeed, journey } from "../support/journey.ts";
import { probe, step } from "../support/probes.ts";
import { settle } from "../support/settle.ts";
import { escapeRe, openSheet, region, sheet, tellText, tier, tierMeta } from "../support/ui.ts";

// It writes: each run leaves its slot fresh for the next (fromTheSeed).
fromTheSeed();

/** Another member's Today as the viewer sees it (?member=), whole: a sent text must not reach it (web 110, Worker 157; F6). */
const todayOf = (name: string) => `/?member=${encodeURIComponent(name)}`;
/** The Tell Claude tab, once its list of my waiting texts has loaded (it loads quietly, with no "Loading…"). */
async function openTellClaude(p: Page): Promise<void> {
  const loaded = p.waitForResponse((r) => r.url().endsWith("/tools/inbox_entries"));
  await openSheet(p, "Tell Claude", null);
  await loaded;
  await settle(p);
}
/** The meals Close the day offers as skipped (DayClose.tsx), on my own day. */
const skippable = (p: Page) => region(p, "Close the day").getByRole("group", { name: "Meals you skipped" });

journey("J7", "Tell Claude: the meal's waiting line; Close the day doesn't offer that meal as skipped; nobody else sees the text", ["asha", "kabir", "noor"], async (j) => {
  const text = "two idli and a coffee";
  const mine = await j.observer(j.me);
  const theirs = await j.observer(j.other);
  // A day long past, that no other journey writes (seeded days and today's meals already hold items, and other
  // journeys log into today's empty ones): the meal is the first one Close the day still offers as skipped there
  // (nothing logged, nothing waiting), so the run at 1,440 px takes the next one after the run at 390.
  const day = new Date(Date.parse(`${j.today}T00:00:00Z`) - 50 * 86_400_000).toISOString().slice(0, 10);
  const myDay = `/?date=${day}`;
  await j.page.goto(myDay);
  await settle(j.page);
  const offered = (await skippable(j.page).getByRole("button").allInnerTexts()).map((t) => t.replace(/ skipped$/, ""));
  expect(offered.length, "Close the day offers some meal as skipped before the text").toBeGreaterThan(0);
  const meal = offered[0] as string;
  // A positive control: their view of my day that long ago renders it, the meal's tier and all, so the privacy
  // probes below read a real day, not an error or an empty shell.
  const myDayAsTheySee = `${todayOf(j.names[j.me])}&date=${day}`;
  await theirs.goto(myDayAsTheySee);
  await settle(theirs);
  await expect(tier(theirs, meal)).toBeVisible();
  await expect(tierMeta(theirs, meal)).toHaveText("nothing yet");

  await step(`tell Claude what was eaten at ${meal}`, async () => {
    const d = await openSheet(j.page, "Tell Claude", myDay);
    await d.getByLabel("Day").fill(day);
    await d.getByLabel("Meal").selectOption({ label: meal });
    await tellText(d).fill(text);
    await d.getByRole("button", { name: "Send to Claude" }).click();
    await expect(d.getByRole("heading", { name: "Waiting for Claude" })).toBeVisible();
  }, {
    changes: [
      [probe(mine, myDay, `${meal}'s waiting line`, (p) => tier(p, meal)), (after) => expect(after).toContain(`Waiting for Claude: "${text}"`)],
      // Web decision 75: a meal waiting on Claude is not offered as skipped.
      [probe(mine, myDay, "Close the day's skipped meals", skippable), (after) => expect(after).not.toMatch(new RegExp(`(^|\\s)${escapeRe(meal)} skipped`))],
    ],
    same: [
      // The text is mine alone (F6): my Today, as another member sees it, doesn't change.
      probe(theirs, myDayAsTheySee, `my day as ${j.names[j.other]} sees it`, (p) => p.getByRole("main")),
      probe(theirs, `/?date=${day}`, `${j.names[j.other]}'s own day`, (p) => p.getByRole("main")),
    ],
  });
  // Nowhere on their screen of my day, shown or hidden.
  await theirs.goto(myDayAsTheySee);
  await settle(theirs);
  await expect(theirs.getByText(text)).toHaveCount(0);
});

// A text about another member stays its sender's (web 110, Worker 157; F6): Asha sees it on Kabir's Today;
// Kabir's own Today, his Tell Claude tab and his Waiting on you (Household) show none of it.
journey("J7", "Tell Claude about another member: the sender sees it on their day; the member it is about doesn't", [["asha", "kabir"]], async (j) => {
  const text = "a plate of qorvel";
  const asha = await j.observer(j.me);
  const kabir = await j.observer(j.other);
  const kabirsName = j.names[j.other];
  // The run at 390 sent the same words: the line Asha sees is counted, one more than before.
  const line = `Waiting for Claude: "${text}"`;
  const linesOf = (read: string) => read.split(line).length - 1;
  await asha.goto(todayOf(kabirsName));
  await settle(asha);
  const before = await tier(asha, "Breakfast").getByText(line, { exact: true }).count();
  await step(`tell Claude what ${kabirsName} had at Breakfast`, async () => {
    const d = await openSheet(j.page, "Tell Claude");
    await d.getByRole("group", { name: "For" }).getByRole("button", { name: new RegExp(`^${escapeRe(kabirsName)}`) }).click();
    await d.getByLabel("Meal").selectOption({ label: "Breakfast" });
    await tellText(d).fill(text);
    await d.getByRole("button", { name: "Send to Claude" }).click();
    await expect(d.getByRole("heading", { name: "Waiting for Claude" })).toBeVisible();
  }, {
    changes: [[probe(asha, todayOf(kabirsName), `${kabirsName}'s Breakfast as Asha sees it`, (p) => tier(p, "Breakfast")), (after) => expect(linesOf(after)).toBe(before + 1)]],
    same: [
      probe(kabir, "/", `${kabirsName}'s own Today`, (p) => p.getByRole("main")),
      probe(kabir, "/", `${kabirsName}'s Tell Claude tab`, sheet, openTellClaude),
      probe(kabir, "/household", `${kabirsName}'s Waiting on you`, (p) => region(p, "Waiting on you")),
    ],
  });
  for (const [path, open] of [["/", false], ["/", true], ["/household", false]] as const) {
    await kabir.goto(path);
    await settle(kabir);
    if (open) await openTellClaude(kabir);
    await expect(kabir.getByRole("main")).toBeVisible();
    // Nowhere on Kabir's screens, shown or hidden.
    await expect(kabir.getByText("qorvel")).toHaveCount(0);
  }
});
