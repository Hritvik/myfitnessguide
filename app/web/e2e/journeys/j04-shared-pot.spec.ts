import { expect, type Page } from "@playwright/test";
import { fromTheSeed, journey } from "../support/journey.ts";
import { probe, step } from "../support/probes.ts";
import { escapeRe, openSheet, potCard, region, tier } from "../support/ui.ts";

// It writes: each run leaves its slot fresh for the next (fromTheSeed).
fromTheSeed();

journey("J4", "a shared pot with shares: the cook's share confirmed, each eater asked, Household's shared meals", ["asha"], async (j) => {
  const pot = `Probe khichdi ${j.width}`;
  const [asha, kabir, noor] = [await j.observer("asha"), await j.observer("kabir"), await j.observer("noor")];
  const lunchRow = (p: Page) => tier(p, "Lunch").getByRole("listitem").filter({ hasText: new RegExp(`^${escapeRe(pot)}`) });
  const asked = (share: string) => (after: string) => {
    expect(after).toContain(share);
    expect(after).toContain(`Draft, logged by ${j.names.asha}`);
  };
  await step("Asha cooks a pot at Lunch for herself, Kabir and Noor", async () => {
    const d = await openSheet(j.page, "Food");
    await d.getByLabel("Meal").selectOption({ label: "Lunch" });
    await d.getByRole("button", { name: "A dish cooked for the household" }).click();
    await d.getByLabel("Dish").fill(pot);
    await d.getByLabel("Add an ingredient").fill("Moong");
    await d.getByRole("button", { name: /^Moong/ }).first().click();
    await d.getByRole("group", { name: /^Add Moong/ }).getByRole("textbox").first().fill("200");
    await d.getByRole("button", { name: "Add ingredient" }).click();
    const eaters = d.getByRole("list", { name: "Who ate" });
    for (const [m, share] of [["asha", "40"], ["kabir", "30"], ["noor", "20"]] as const) {
      await eaters.getByRole("button", { name: j.names[m], exact: true }).click();
      await d.getByLabel(`${j.names[m]}'s share`).fill(share);
    }
    const saved = j.page.waitForResponse((r) => r.url().endsWith("/tools/household_meal") && r.status() === 200);
    await d.getByRole("button", { name: "Save", exact: true }).click();
    const keep = d.getByRole("group", { name: "Keep these changes for next time?" });
    await Promise.race([saved, keep.waitFor().catch(() => undefined)]);
    if (await keep.isVisible()) await keep.getByRole("button", { name: "Just this time" }).click();
    await saved;
  }, {
    changes: [
      // The cook's own share is hers, confirmed; each eater's is a draft logged by her, asked on the pot card.
      [probe(asha, "/", "Asha's share in her Lunch", lunchRow), (after) => {
        expect(after).toContain("40% of the pot");
        expect(after).not.toContain("Draft");
      }],
      [probe(kabir, "/", "Kabir's share in his Lunch", lunchRow), asked("30% of the pot")],
      [probe(noor, "/", "Noor's share in her Lunch", lunchRow), asked("20% of the pot")],
      [probe(kabir, "/", "the pot's card on Kabir's Today", (p) => potCard(p, pot)), (after) => expect(after).toContain("Yes, confirm")],
      [probe(asha, "/household", "Household's shared meals", (p) => region(p, "Shared meals")), (after) => expect(after).toContain(pot)],
    ],
    same: [probe(asha, `/?date=${j.yesterday}`, "Asha's yesterday's Lunch", (p) => tier(p, "Lunch"))],
  });
});
