import { expect } from "@playwright/test";
import { fromTheSeed, journey } from "../support/journey.ts";
import { ABSENT, nameProbe, probe, step } from "../support/probes.ts";
import { settle } from "../support/settle.ts";
import { potCard, region, tier, waitingRows, writeAs } from "../support/ui.ts";

// It writes: each run leaves its slot fresh for the next (fromTheSeed).
fromTheSeed();

// Yesterday's Dinner pot, cooked by Asha with shares for all three (estimated, so each eater is asked).
// Kabir confirms on the pot card; Noor says it isn't hers in Waiting on you (Household); Asha marks the rest
// leftover; Kabir eats the leftover today, from Household's Leftovers (a leftover action writes today's date).
journey("J5", "a pot downstream: confirm, Not mine, the rest marked leftover, the leftover eaten the next day", ["asha"], async (j) => {
  const pot = `Probe sambar ${j.width}`;
  await writeAs(j.api("asha"), "household_meal", {
    date: j.yesterday, meal_slot: "dinner",
    cooks: [{ name: pot, lines: [{ food: "Toor", value: 180, unit: "g", provenance: "weighed" }], portions: [
      { member: j.names.asha, fraction: 0.3, provenance: "estimated" }, { member: j.names.kabir, fraction: 0.25, provenance: "estimated" }, { member: j.names.noor, fraction: 0.2, provenance: "estimated" },
    ] }],
  });
  const [asha, kabir, noor] = [await j.observer("asha"), await j.observer("kabir"), await j.observer("noor")];
  const yesterday = `/?date=${j.yesterday}`;
  const card = (o: typeof asha, who: string) => probe(o, yesterday, `the pot's card on ${who}'s day`, (p) => potCard(p, pot));
  // The bar's accessible name carries every share and the remainder (today.ts potCard: "…, 25% not yet accounted for").
  // The setup fixes the remainder: 1 − 0.30 − 0.25 − 0.20 = 25% unaccounted; 45% once Noor's 20% goes.
  const bar = (o: typeof asha, who: string) => nameProbe(o, yesterday, `the pot's bar on ${who}'s card`, (p) => potCard(p, pot).getByRole("img"));
  const barOf = (p: typeof asha) => potCard(p, pot).getByRole("img");
  const dinnerRow = (o: typeof asha, who: string) => probe(o, yesterday, `${who}'s share in yesterday's Dinner`, (p) => tier(p, "Dinner").getByRole("listitem").filter({ hasText: pot }));
  const leftover = (p: typeof asha) => region(p, "Leftovers").getByRole("group", { name: pot, exact: true });

  await asha.goto(yesterday);
  await settle(asha);
  await expect(barOf(asha)).toHaveAccessibleName(/(^|, )25% not yet accounted for(,|$)/);

  await step("Kabir confirms his share", async () => {
    const k = await j.as("kabir");
    await k.goto(yesterday);
    await settle(k);
    await potCard(k, pot).getByRole("button", { name: "Yes, confirm" }).click();
    await expect(potCard(k, pot).getByRole("button", { name: "Yes, confirm" })).toHaveCount(0);
  }, {
    // His card's ask goes; the shares and the remainder stay as they were.
    changes: [[dinnerRow(kabir, "Kabir"), (after) => expect(after).not.toContain("Draft")], [card(kabir, "Kabir"), (after) => expect(after).not.toContain("Yes, confirm")]],
    same: [dinnerRow(noor, "Noor"), bar(asha, "Asha")],
  });

  await step("Noor says it isn't hers, with a reason", async () => {
    const n = await j.as("noor");
    await n.goto("/household");
    await settle(n);
    const row = waitingRows(n).filter({ hasText: pot }).first();
    await row.getByRole("button", { name: "Not mine…" }).click();
    await row.getByLabel("Why isn't it yours?").fill("I was out for dinner.");
    await row.getByRole("button", { name: "Remove it" }).click();
    await expect(waitingRows(n).filter({ hasText: pot })).toHaveCount(0);
  }, {
    // Her share goes, so more of the pot is unaccounted on the cook's card: 45%, from 25%.
    changes: [
      [bar(asha, "Asha"), (after) => {
        expect(after).toMatch(/(^|, )45% not yet accounted for(,|$)/);
        // Her share reads as absence now, not as a share (today.ts: "<member> not present").
        expect(after).toContain(`${j.names.noor} not present`);
        expect(after).not.toContain(`${j.names.noor} 20%`);
      }],
      [dinnerRow(noor, "Noor"), (after) => expect(after).toBe(ABSENT)],
    ],
    same: [dinnerRow(kabir, "Kabir")],
  });

  await step("Asha marks the rest leftover", async () => {
    await j.page.goto(yesterday);
    await settle(j.page);
    await potCard(j.page, pot).getByRole("button", { name: /^Mark the rest leftover/ }).click();
    await expect(potCard(j.page, pot).getByRole("button", { name: /^Mark the rest leftover/ })).toHaveCount(0);
  }, {
    // The unaccounted 45% becomes the leftover, on Household and on every card.
    changes: [
      [probe(asha, "/household", "the pot on Household's Leftovers", leftover), (after) => expect(after).toContain("45% of the pot")],
      [bar(kabir, "Kabir"), (after) => expect(after).toMatch(/(^|, )45% leftover(,|$)/)],
    ],
    same: [dinnerRow(kabir, "Kabir")],
  });

  await step("Kabir eats the leftover at Lunch today", async () => {
    const k = await j.as("kabir");
    await k.goto("/household");
    await settle(k);
    await leftover(k).getByRole("button", { name: `Eaten by ${j.names.kabir}`, exact: true }).click();
    await leftover(k).getByRole("group", { name: `Which meal did ${j.names.kabir} eat it at?` }).getByRole("button", { name: "Lunch", exact: true }).click();
    await expect(leftover(k)).toHaveCount(0);
  }, {
    changes: [
      [probe(asha, "/household", "the pot on Household's Leftovers", leftover), (after) => expect(after).toBe(ABSENT)],
      [probe(kabir, "/", "Kabir's Lunch today", (p) => tier(p, "Lunch")), (after) => expect(after).toContain(pot)],
    ],
    same: [probe(asha, "/", "Asha's Lunch today", (p) => tier(p, "Lunch"))],
  });
});
