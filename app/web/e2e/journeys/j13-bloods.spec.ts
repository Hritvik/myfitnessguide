import { expect, type Page } from "@playwright/test";
import { journey } from "../support/journey.ts";
import { settle } from "../support/settle.ts";
import { region } from "../support/ui.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2 Oct 2026" (format.ts longDay) as 2026-10-02. */
const iso = (d: string): string => {
  const [day, mon, year] = d.split(" ") as [string, string, string];
  return `${year}-${String(MONTHS.indexOf(mon) + 1).padStart(2, "0")}-${day.padStart(2, "0")}`;
};
/** A marker's row on Health (ProgressScreen MarkerItem), by its name. */
const marker = (p: Page, name: string) => p.getByRole("main").getByRole("listitem").filter({ has: p.getByText(name, { exact: true }) }).first();

// Read-only: Asha's seeded draws (2026-04-01: TSH 3.1, Ferritin 40; 2026-10-02: TSH 5.6, ALT 52, Vitamin D 34,
// CRP <0.5; 2026-08-08: the B12 draw) and, if J12 hasn't removed it in this slot, the agent's draft draw of today.
// Kabir has no draws.
journey("J13", "bloods: statuses, latest first, with deltas; and the empty state", ["asha", "kabir"], async (j) => {
  await j.page.goto("/progress/health");
  await settle(j.page);
  const draws = region(j.page, "Blood draws");
  if (j.me === "kabir") {
    // The empty state: Health has loaded (its heading and Kabir's own flag are there) and holds no draw and no marker.
    // Health has no "no blood draws yet" line: the section is left out (DrawsList renders nothing for no rows).
    await expect(j.page.getByRole("main").getByRole("heading", { name: "Data to check" })).toBeVisible();
    await expect(draws).toHaveCount(0);
    for (const name of ["TSH", "ALT", "Vitamin D", "Vitamin B12", "Ferritin"]) await expect(marker(j.page, name)).toHaveCount(0);
    return;
  }

  // Latest first: each draw's row closes over its results, so the region's text is the rows' summaries.
  await expect(draws).toBeVisible();
  const dates = [...(await draws.innerText()).matchAll(/\b(\d{1,2} [A-Z][a-z]{2} \d{4})\b/g)].map((m) => iso(m[1]!));
  expect(dates, "latest first").toEqual([...dates].sort().reverse());
  expect(dates.filter((d) => ["2026-10-02", "2026-08-08", "2026-04-01"].includes(d)), "the seeded draws, latest first").toEqual(["2026-10-02", "2026-08-08", "2026-04-01"]);
  await expect(draws).toContainText("2 Oct 2026 4 results · 2 out of range, 1 not checked");

  // Statuses, and the change since the earlier draw of the same marker: TSH 5.6 − 3.1 = +2.5 since 1 Apr.
  await expect(marker(j.page, "TSH")).toContainText("5.6 mIU/L (0.4–4.2 mIU/L)");
  await expect(marker(j.page, "TSH")).toContainText(/2 Oct 2026, above range, \+2\.5 since Wed 1 Apr$/);
  await expect(marker(j.page, "ALT")).toContainText(/52 U\/L \(≤ 45 U\/L\)\s*.*2 Oct 2026, above range$/);
  await expect(marker(j.page, "Vitamin D")).toContainText(/34 ng\/mL \(30–100 ng\/mL\)\s*in range$/);
  await expect(marker(j.page, "CRP")).toContainText(/<0\.5 mg\/L \(≤ 5 mg\/L\)\s*not checked against the range$/);

  // Bloods are owner-only (Worker decision 40): Kabir's view of Asha's Health holds none of them. The same
  // locators found them above on Asha's own Health (the positive control).
  const kabir = await j.observer("kabir");
  await kabir.goto(`/progress/health?member=${encodeURIComponent(j.names.asha)}`);
  await settle(kabir);
  await expect(kabir.getByRole("main")).toBeVisible();
  await expect(region(kabir, "Blood draws")).toHaveCount(0);
  for (const name of ["TSH", "ALT", "Vitamin D", "CRP", "Vitamin B12"]) await expect(marker(kabir, name), `Kabir sees Asha's ${name}`).toHaveCount(0);
  const shown = await kabir.getByRole("main").innerText();
  for (const value of [/(?<![\d.])5\.6(?![\d]|\.\d)/, /(?<![\d.])52(?![\d]|\.\d)/, /2 Oct 2026/, /Sample Labs/]) expect(shown, `Kabir's view of Asha's Health shows ${value}`).not.toMatch(value);
});
