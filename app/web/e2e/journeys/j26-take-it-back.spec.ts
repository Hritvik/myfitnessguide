import { expect, type Page } from "@playwright/test";
import { fromTheSeed, journey } from "../support/journey.ts";
import { ABSENT, probe, step } from "../support/probes.ts";
import { settle } from "../support/settle.ts";
import { logAs, region, tier, waitingRows } from "../support/ui.ts";

// It writes: each run leaves its slot fresh for the next (fromTheSeed).
fromTheSeed();

// Asha's draft about Kabir, 17 g of Makhana at Snack (Kabir's Waiting on you is Household's).
journey("J26", "take it back: the author withdraws an unconfirmed draft about another member; a third member can't", [["asha", "kabir"]], async (j) => {
  await logAs(j.api("asha"), j.names.kabir, j.today, "Makhana", 17);
  const kabirsDay = `/?member=${encodeURIComponent(j.names.kabir)}`;
  const makhana = (p: Page) => tier(p, "Snack").getByRole("listitem").filter({ hasText: /^Makhana 17 g/ });
  // Noor, a third member, sees the draft but no "Take it back" on it (web decision 107).
  const noor = await j.as("noor");
  await noor.goto(kabirsDay);
  await settle(noor);
  await expect(makhana(noor)).toBeVisible();
  await expect(makhana(noor).getByRole("button", { name: "Take it back" })).toHaveCount(0);
  const kabir = await j.observer("kabir");
  await step("Asha takes it back", async () => {
    await j.page.goto(kabirsDay);
    await settle(j.page);
    await makhana(j.page).getByRole("button", { name: "Take it back" }).click();
    await makhana(j.page).getByRole("group", { name: "Take this draft back?" }).getByRole("button", { name: "Take it back", exact: true }).click();
    await expect(makhana(j.page)).toHaveCount(0);
  }, {
    changes: [
      [probe(kabir, "/", "Kabir's Makhana in Snack", makhana), (after) => expect(after).toBe(ABSENT)],
      [probe(kabir, "/household", "Kabir's Makhana in Waiting on you", (p) => waitingRows(p).filter({ hasText: "Makhana" }).filter({ hasText: `Logged by ${j.names.asha}` })), (after) => expect(after).toBe(ABSENT)],
    ],
    same: [probe(kabir, "/household", "Kabir's Waiting on others", (p) => region(p, "Waiting on others"))],
  });
});
