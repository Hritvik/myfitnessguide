import { expect, type Page } from "@playwright/test";
import { fromTheSeed, journey } from "../support/journey.ts";
import { ABSENT, probe, step, type Probe } from "../support/probes.ts";
import { settle } from "../support/settle.ts";
import { catalogueRecord, dayLabel, openSheet, region, sheet } from "../support/ui.ts";

// It writes: each run leaves its slot fresh for the next (fromTheSeed).
fromTheSeed();

// Words are the household's: one member teaches a word and every member's Food search finds the food by it.
// Each run teaches its own word, so a width or a member never finds another run's.
journey("J16", "words: teach one, find the food by it, forget it", ["asha", "kabir"], async (j) => {
  const word = `kolvy${j.me}${j.width}`;
  const ref = String((await j.api().tool("catalogue_search", { query: "Methi", kinds: ["food_source"] })).body.results[0].ref);
  // What the Food tab offers for the word once its search has answered: the foods it finds (a search's results
  // replace the Recent list, under "Search results"), or "Nothing matches".
  const nothingMatches = (p: Page) => sheet(p).getByText(/^Nothing matches/);
  const found = (p: Page) => sheet(p).getByRole("list").getByRole("button").or(nothingMatches(p));
  const search = (who: Page, whose: string): Probe =>
    probe(who, "/", `${whose} Food search for ${word}`, found, async (p) => {
      const d = await openSheet(p, "Food");
      await d.getByLabel("Find a food or dish").fill(word);
      await sheet(p).getByRole("heading", { name: "Search results", exact: true }).or(nothingMatches(p)).waitFor();
    });
  const searches = [search(await j.observer(j.me), "my"), search(await j.observer(j.other), `${j.other}'s`)];
  const row = (p: Page) => region(p, "Words I've learned").getByRole("row").filter({ has: p.getByRole("rowheader", { name: word, exact: true }) });
  const listed = probe(await j.observer(j.other), "/catalogue/words", `${j.other}'s Words I've learned`, row);
  const findsMethi = (after: string) => expect(after).toMatch(/^Methi \(as sold\)/);
  const nothing = (after: string) => expect(after).toMatch(new RegExp(`^Nothing matches "${word}"\\.`));

  await step(`teach "${word}" on Methi`, async () => {
    await j.page.goto(`/catalogue/food/${encodeURIComponent(ref)}`);
    await settle(j.page);
    await catalogueRecord(j.page).getByRole("button", { name: "Teach a word", exact: true }).click();
    const form = j.page.getByRole("form", { name: "Teach a word" });
    await form.getByLabel("Word", { exact: true }).fill(word);
    await form.getByLabel("Why?").fill("What the market calls it.");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(region(j.page, "Words").getByRole("listitem").filter({ hasText: word })).toHaveCount(1);
  }, {
    changes: [
      ...searches.map((s): [Probe, (a: string) => void] => [s, findsMethi]),
      // Who taught it and when, as the other member reads it.
      [listed, (after) => expect(after).toBe(`${word} Methi (as sold) (food) ${j.names[j.me]}, ${dayLabel(j.today)} Forget`)],
    ],
  });

  await step("forget it, with a reason", async () => {
    await j.page.goto("/catalogue/words");
    await settle(j.page);
    await row(j.page).getByRole("button", { name: "Forget", exact: true }).click();
    const form = row(j.page).getByRole("form", { name: "Forget" });
    await form.getByLabel("Why?").fill("Nobody calls it that.");
    await form.getByRole("button", { name: "Forget it", exact: true }).click();
    await expect(row(j.page)).toHaveCount(0);
  }, {
    changes: [...searches.map((s): [Probe, (a: string) => void] => [s, nothing]), [listed, (after) => expect(after).toBe(ABSENT)]],
  });
});
