import { expect, type Locator, type Page } from "@playwright/test";
import { fromTheSeed, journey } from "../support/journey.ts";
import { probe, step } from "../support/probes.ts";
import { settle } from "../support/settle.ts";
import { catalogueRecord, openSheet, pick, region, sheet } from "../support/ui.ts";

// Each run starts from the seed (Asha's home gym: the bar 20 kg; the row stack 30, 35, 40 kg; plates 20, 10, 5 kg and
// 5 lb) and leaves the seed behind: the gym is every journey's on this worker (J9 trains on it).
fromTheSeed();

/** The Set tab on an exercise found by `search`, with 10 reps at RIR 2 so the preview answers. */
async function setFor(p: Page, search: string, exercise: RegExp, load: "Weight" | "Plates"): Promise<Locator> {
  const d = await openSheet(p, "Set", "/train");
  await d.getByLabel("Find an exercise").fill(search);
  await pick(d, exercise).click();
  await d.getByRole("group", { name: "Load as" }).getByRole("button", { name: load, exact: true }).click();
  await d.getByLabel("Reps").fill("10");
  await d.getByPlaceholder("2 or 1-2").fill("2");
  return d;
}
/** The seed's two exercises, by the start of their (long) names. */
const BENCH = /^Barbell bench press,/;
const ROW = /^Seated cable row with/;
const inAll = (p: Page) => sheet(p).getByText(/ in all\.$/);
const kgOf = (text: string): number => Number(/([\d.]+) kg in all\./.exec(text)?.[1] ?? Number.NaN);

journey("J17", "gyms: the bar, the rack's loads and the plates; the Set tab's plate builder and snapping follow", ["asha"], async (j) => {
  const mine = await j.observer("asha");
  // The bench's plates on "the gym's own" bar: its total counts the bar the gym records.
  const benchTotal = probe(mine, "/train", "the bench's total on the gym's own bar", inAll, async (p) => {
    const d = await setFor(p, "bench", BENCH, "Plates");
    await d.getByRole("group", { name: "Bar" }).getByRole("button", { name: "The gym's own", exact: true }).click();
    // preview_set is debounced and can queue behind the four parallel E2E
    // workers; this is an API-backed result, not an immediate DOM toggle.
    await inAll(p).waitFor({ timeout: 20_000 });
  });
  const builder = probe(mine, "/train", "the Set tab's plate builder", (p) => sheet(p).getByRole("group", { name: "Add a plate" }), async (p) => {
    await setFor(p, "bench", BENCH, "Plates");
  });
  const snapping = probe(mine, "/train", "45 kg on the cable row (snapping)", (p) => sheet(p).getByRole("paragraph").filter({ hasText: /^45 kg / }), async (p) => {
    const d = await setFor(p, "row", ROW, "Weight");
    await d.getByLabel("Load", { exact: true }).fill("45");
    await inAll(p).filter({ hasText: /^45 kg/ }).waitFor({ timeout: 20_000 });
  });

  await j.page.goto("/catalogue/gyms");
  await settle(j.page);
  await region(j.page, "Gyms").getByRole("link", { name: /^Sample gym/ }).click();
  await expect(catalogueRecord(j.page)).toBeVisible();
  const gym = probe(mine, new URL(j.page.url()).pathname, "the gym's record", catalogueRecord);
  const equipment = (name: RegExp) => catalogueRecord(j.page).getByRole("row").filter({ has: j.page.getByRole("rowheader", { name }) });
  const before = kgOf(await benchTotal.read());
  expect(await snapping.read(), "the seed's row stack has no 45").toContain("45 kg isn't on the gym's list (nearest 40 kg)");

  await step("change the bar's weight to 15 kg", async () => {
    await equipment(/^Olympic bar/).getByRole("button", { name: "Change the bar's weight" }).click();
    const form = j.page.getByRole("form", { name: "Change the bar's weight" });
    await form.getByLabel("Weight", { exact: true }).fill("15");
    await form.getByLabel("Why?").fill("It's the women's bar.");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(form).toHaveCount(0);
  }, {
    changes: [
      // 5 kg lighter: the bench's plates are the same, on a bar the gym now says is 15 kg.
      [benchTotal, (after) => expect(kgOf(after)).toBeCloseTo(before - 5, 2)],
      [gym, (after) => expect(after).toContain("From the gym's plates · Bar 15 kg")],
    ],
    same: [builder, snapping],
  });

  await step("record a 1.25 kg plate seen on the rack", async () => {
    await region(j.page, "Plates").getByRole("button", { name: "Record plates", exact: true }).click();
    const form = j.page.getByRole("form", { name: "Record plates" });
    await form.getByLabel("Seen on the rack").fill("1.25");
    await form.getByLabel("Why?").fill("Found a pair by the mirror.");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(form).toHaveCount(0);
  }, {
    changes: [
      [builder, (after) => expect(after).toContain("+ 1.25 kg")],
      [gym, (after) => expect(after).toMatch(/kg: [\d., ]*\b1\.25\b/)],
    ],
    same: [snapping],
  });

  await step("add 45 kg to the row stack's loads", async () => {
    await equipment(/^Row stack/).getByRole("button", { name: "Add a load", exact: true }).click();
    const form = j.page.getByRole("form", { name: "Add a load" });
    await form.getByLabel("Loads it has").fill("45");
    await form.getByLabel("Why?").fill("The 45 pin works now.");
    await form.getByRole("button", { name: "Add", exact: true }).click();
    await expect(form).toHaveCount(0);
  }, {
    changes: [
      // On the list now: the set no longer waits as a draft.
      [snapping, (after) => expect(after).toBe("45 kg in all.")],
      [gym, (after) => expect(after).toContain("30, 35, 40, 45 kg")],
    ],
    same: [builder],
  });
});
