import { expect, type Page } from "@playwright/test";
import { fromTheSeed, journey } from "../support/journey.ts";
import { probe, step } from "../support/probes.ts";
import { settle } from "../support/settle.ts";
import { catalogueRecord, dayLabel, openSheet, pick, region, sheet, tierMeta, writeAs } from "../support/ui.ts";

// Each run starts from the seed (Besan as sold: 385 kcal, 22 g protein, 58 g carbs, 6.5 g fat per 100 g; 65 g of it
// in today's dinner) and leaves the seed behind: Besan's values reach Asha's logged day, which other
// journeys on this worker read.
fromTheSeed();

journey("J15", "a catalogue food: edit it, add a measure, add a yield; the Food tab's measure chips, Used by and the logged day follow", ["asha"], async (j) => {
  // A yield comes from another state of the same food: a cooked Besan, as the agent would add it.
  const cooked = String((await writeAs(j.api(), "upsert_food_source", { name: "Besan", state: "cooked", reference_amount: 100, reference_unit: "g", kcal: 150, protein_g: 9, carbs_g: 23, fat_g: 2.5, reason: "Besan batter, for the yield." })).food_source.ref);
  const sold = String((await j.api().tool("catalogue_search", { query: "Besan", kinds: ["food_source"] })).body.results.find((r: { state: string }) => r.state === "as_sold").ref);
  const path = `/catalogue/food/${encodeURIComponent(sold)}`;
  const cookedPath = `/catalogue/food/${encodeURIComponent(cooked)}`;
  const mine = await j.observer("asha");
  const record = probe(mine, path, "Besan's record", catalogueRecord);
  const cookedRecord = probe(mine, cookedPath, "cooked Besan's record", catalogueRecord);
  // "Measure" exactly: "How it was measured" is a group too.
  const measures = (p: Page) => sheet(p).getByRole("group", { name: "Measure", exact: true });
  const chips = probe(mine, "/", "the Food tab's measure chips for Besan", measures, async (p) => {
    const d = await openSheet(p, "Food");
    await d.getByLabel("Find a food or dish").fill("Besan");
    await pick(d, /^Besan \(as sold\)/).click();
    // The chips come with the food's record (catalogue_lookup).
    await measures(p).waitFor();
  });
  const usedBy = probe(mine, path, "Besan's Used by", (p) => region(p, "Used by"));
  // Today's dinner holds 65 g of Besan (P 87.2 g in all; an item's own macros show only on a wide screen),
  // and one item nobody can value, so the subtotal reads as partial (web decision 118).
  const logged = probe(mine, "/", "today's dinner subtotal", (p) => tierMeta(p, "Dinner"));

  await j.page.goto(path);
  await settle(j.page);
  await expect(catalogueRecord(j.page).getByRole("row", { name: "385 kcal 22 g 58 g 6.5 g", exact: true })).toBeVisible();
  await expect(region(j.page, "Used by")).toContainText(`1 logged item, on ${dayLabel(j.today)}`);
  expect(await logged.read(), "the seed's dinner").toMatch(/, P 87\+ g · 1 item unknown$/);

  await step("edit its protein to 25 g, with a reason", async () => {
    await catalogueRecord(j.page).getByRole("button", { name: "Edit", exact: true }).click();
    const form = j.page.getByRole("form", { name: "Edit Besan (as sold)" });
    await form.getByLabel("Protein (g)", { exact: true }).fill("25");
    await form.getByLabel("Why the change?").fill("Rechecked the pack.");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(form).toHaveCount(0);
  }, {
    // The logged 65 g is worked out from the catalogue, not frozen: 3 g more per 100 g is 1.95 g more, 89.15 g in all.
    changes: [
      [record, (after) => expect(after).toContain("385 kcal 25 g 58 g 6.5 g")],
      [logged, (after) => expect(after).toMatch(/, P 89\+ g · 1 item unknown$/)],
    ],
    same: [chips, usedBy],
  });

  await step("add a measure: 1 ladle is 30 g", async () => {
    await catalogueRecord(j.page).getByRole("button", { name: "Add a measure", exact: true }).click();
    const form = j.page.getByRole("form", { name: "Add a measure" });
    await form.getByLabel("Measure, like katori").fill("ladle");
    await form.getByLabel("Amount (g)").fill("30");
    await form.getByLabel("Why?").fill("The batter ladle.");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(form).toHaveCount(0);
  }, {
    changes: [
      [record, (after) => expect(after).toContain("Measures: 1 ladle = 30 g")],
      [chips, (after) => expect(after).toContain("ladle (30 g)")],
    ],
    same: [usedBy, logged],
  });

  await step("add a yield to the cooked Besan: 1 g as sold becomes 2.5 g", async () => {
    await j.page.goto(cookedPath);
    await settle(j.page);
    await catalogueRecord(j.page).getByRole("button", { name: "Add a yield", exact: true }).click();
    const form = j.page.getByRole("form", { name: "Add a yield" });
    await expect(form.getByLabel("From")).toHaveValue(sold);
    await form.getByLabel("1 g becomes (g)").fill("2.5");
    await form.getByLabel("Why?").fill("Weighed the batter.");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(form).toHaveCount(0);
  }, {
    changes: [
      [cookedRecord, (after) => expect(after).toContain("Yields: From as sold: × 2.5")],
      // The as-sold record's Used by now names what it yields.
      [usedBy, (after) => expect(after).toContain("Yields cooked")],
    ],
    same: [chips, logged],
  });
});
