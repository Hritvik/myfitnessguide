import { expect, type Page } from "@playwright/test";
import { fromTheSeed, journey } from "../support/journey.ts";
import { probe, step } from "../support/probes.ts";
import { settle } from "../support/settle.ts";
import { logAs, tier, writeAs } from "../support/ui.ts";

// It writes: each run leaves its slot fresh for the next (fromTheSeed).
fromTheSeed();

/**
 * Kabir's own 30 g of Dates at Snack, confirmed (his own log). The app offers Edit only on your own day's confirmed
 * items (today.ts: ownDay), so another member's edit comes the way it can: an amend as Asha through the API (as
 * Claude's tools write it), and the browser shows what follows. Rows are found by their amount: the run at 390
 * leaves its row at 35 g, so at 1,440 px the 30 g and 45 g rows are this run's, and the 35 g probe reads every
 * 35 g row (one more after the edit, none a draft).
 */
journey("J27", "another member's edit re-drafts a confirmed record; the owner keeps or undoes it", [["asha", "kabir"]], async (j) => {
  const logged = await logAs(j.api("kabir"), j.names.kabir, j.today, "Dates", 30);
  const id = Number(logged.items[0].id);
  const kabirsDay = `/?member=${encodeURIComponent(j.names.kabir)}`;
  const kabir = await j.observer("kabir");
  const datesRows = (p: Page, grams: number) => tier(p, "Snack").getByRole("listitem").filter({ hasText: new RegExp(`^Dates ${grams} g`) });
  const dates = (p: Page, grams: number) => datesRows(p, grams).first();
  const editAmount = async (page: Page, path: string, from: number, grams: string) => {
    await page.goto(path);
    await settle(page);
    await dates(page, from).getByRole("button", { name: "Edit Dates" }).click();
    const form = page.getByRole("form", { name: "Edit this item" });
    await form.getByLabel(/^How much/).fill(grams);
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(form).toHaveCount(0);
  };
  // On Kabir's day, Asha has no Edit on his confirmed row.
  await j.page.goto(kabirsDay);
  await settle(j.page);
  await expect(dates(j.page, 30)).toBeVisible();
  await expect(dates(j.page, 30).getByRole("button", { name: "Edit Dates" })).toHaveCount(0);
  await step("Asha changes Kabir's confirmed Dates to 45 g", async () => {
    await writeAs(j.api("asha"), "amend", { record: { table: "intake_item", id }, changes: { amount_value: 45 }, reason: "Kabir had the bigger box." });
  }, {
    changes: [[probe(kabir, "/", "Kabir's Dates row (45 g)", (p) => dates(p, 45)), (after) => {
      expect(after).toContain(`Draft, edited by ${j.names.asha}`);
    }]],
  });
  // Web decision 108: a record that was ever confirmed is never Asha's to take back.
  await j.page.goto(kabirsDay);
  await settle(j.page);
  await expect(dates(j.page, 45)).toBeVisible();
  await expect(dates(j.page, 45).getByRole("button", { name: "Take it back" })).toHaveCount(0);
  const k = await j.as("kabir");
  await k.goto("/");
  await settle(k);
  await expect(dates(k, 45).getByRole("button", { name: "Keep their change" })).toBeVisible();
  await step("Kabir undoes it: the confirmed value is back", async () => {
    await dates(k, 45).getByRole("button", { name: "Undo their change" }).click();
    await expect(dates(k, 45)).toHaveCount(0);
  }, {
    changes: [[probe(kabir, "/", "Kabir's Dates row (30 g)", (p) => dates(p, 30)), (after) => {
      expect(after).not.toContain("Draft");
    }]],
  });
  await step("Kabir's own edit to 35 g stays confirmed", () => editAmount(k, "/", 30, "35"), {
    changes: [[probe(kabir, "/", "Kabir's Dates rows at 35 g", (p) => datesRows(p, 35)), (after) => {
      expect(after).not.toContain("Draft");
    }]],
  });
});
