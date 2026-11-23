import { expect, type Page } from "@playwright/test";
import { writeCount } from "../support/d1.ts";
import { journey } from "../support/journey.ts";
import { settle } from "../support/settle.ts";
import { addDays, dayLabel, region } from "../support/ui.ts";

/** The Sunday a week starts on (every member's week does, in the seed). */
const sunday = (iso: string): string => addDays(iso, -new Date(`${iso}T00:00:00Z`).getUTCDay());
/** The week's section: "This week", or "Week of …" for another (ProgressScreen WeekSection). */
const week = (p: Page) => p.getByRole("region", { name: /week/i });
const readingsShown = (label: string | null): number => Number(/(\d+) readings? shown\.$/.exec(label ?? "")?.[1] ?? Number.NaN);

// Read-only, on the seed (every journey that writes leaves its slot fresh: fromTheSeed): Asha has 12 waist readings
// in the 12-week chart; Noor one waist reading, on 28 Aug (outside the last 4 weeks); Kabir none, so no chart at all.

journey("J19", "Progress and the week view: ranges, week back and forward (read-only)", ["asha", "kabir", "noor"], async (j) => {
  const writes = writeCount(j.slot.persist);
  const page = j.page;
  await page.goto("/progress/body");
  await settle(page);
  const range = page.getByRole("navigation", { name: "Range" });
  const chart = page.getByRole("main").getByRole("figure").first().getByRole("img");

  // The default is 12 weeks; 4 weeks narrows the chart, and the URL keeps the range.
  await expect(range.getByRole("link", { name: "12 weeks" })).toHaveAttribute("aria-current", "page");
  const twelve = j.me === "kabir" ? null : await chart.getAttribute("aria-label");
  await range.getByRole("link", { name: "4 weeks" }).click();
  await expect(page).toHaveURL(/[?&]range=4w\b/);
  await expect(range.getByRole("link", { name: "4 weeks" })).toHaveAttribute("aria-current", "page");
  await settle(page);
  if (j.me === "asha") {
    expect(readingsShown(twelve), "the seed's 12-week chart").toBe(12);
    const four = readingsShown(await chart.getAttribute("aria-label"));
    expect(four, "4 weeks shows fewer readings than 12").toBeGreaterThan(0);
    expect(four).toBeLessThan(12);
  } else if (j.me === "noor") {
    expect(twelve).toMatch(/^Waist at navel: 77\.7 cm on Fri 28 Aug\. 1 reading shown\.$/);
    // 4 weeks holds none of her readings: no chart, and the headline says so.
    await expect(page.getByRole("main").getByRole("figure")).toHaveCount(0);
    await expect(region(page, "Headline goal")).toContainText("No reading yet Target 75.0 cm by 13 Dec 2026");
  } else {
    await expect(page.getByRole("main").getByRole("figure")).toHaveCount(0);
    await expect(page.getByRole("main")).toContainText("No goal set yet.");
  }

  // The week: back a week and forward again, by the week view's own arrows.
  await page.goto(`/progress/body?week=${j.today}`);
  await settle(page);
  await expect(week(page)).toHaveAccessibleName("This week");
  await expect(week(page).getByRole("listitem").first()).toBeVisible();
  const rows = await week(page).getByRole("list").innerText();
  expect(rows).toContain(dayLabel(j.today));
  await week(page).getByRole("navigation", { name: "Week" }).getByRole("link", { name: "‹", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]week=${sunday(addDays(j.today, -7))}\\b`));
  await expect(week(page).getByRole("list")).toContainText(dayLabel(addDays(j.today, -7)));
  await expect(week(page).getByRole("list")).not.toContainText(dayLabel(j.today));
  await week(page).getByRole("navigation", { name: "Week" }).getByRole("link", { name: "›", exact: true }).click();
  await expect(week(page)).toHaveAccessibleName("This week");
  await expect(week(page).getByRole("list")).toHaveText(rows.replace(/\s+/g, " ").trim(), { useInnerText: true });

  expect(writeCount(j.slot.persist), "Progress wrote nothing").toBe(writes);
});
