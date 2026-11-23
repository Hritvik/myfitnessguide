import { expect } from "@playwright/test";
import { fromTheSeed, journey } from "../support/journey.ts";
import { apiProbe, fromAnswer, probe, step } from "../support/probes.ts";
import { settle } from "../support/settle.ts";
import { catalogueRecord, measureChip, openSheet, pick } from "../support/ui.ts";

// It writes: each run leaves its slot fresh for the next (fromTheSeed).
fromTheSeed();

journey("J3", "a search that misses, New food, log it, then edit it in the catalogue with a reason", ["asha", "noor"], async (j) => {
  const name = `Zorbled oats ${j.me} ${j.width}`;
  const mine = await j.observer(j.me);
  let ref = "";
  const kcalOfItem = apiProbe("the logged item's kcal", async () => {
    const meals = (await j.api().tool("day_meals", { member: j.names[j.me], date: j.today })).body as { slots: { items: { name: string | null; kcal: number | null }[] }[] };
    return meals.slots.flatMap((s) => s.items).filter((i) => i.name === name).map((i) => i.kcal);
  });

  await step("search misses, New food, log 50 g of it", async () => {
    const d = await openSheet(j.page, "Food");
    await d.getByLabel("Find a food or dish").fill(name);
    await d.getByRole("button", { name: "+ New food" }).click();
    await expect(d.getByRole("heading", { name: "New food" })).toBeVisible();
    await d.getByLabel("Name").fill(name);
    // The values are per 100 g, the "Per 100" chips' default; the four fields sit beside that group, not in it.
    await expect(d.getByRole("group", { name: "Per 100" }).getByRole("button", { name: "per 100 g" })).toHaveAttribute("aria-pressed", "true");
    await d.getByLabel("kcal", { exact: true }).fill("380");
    await d.getByLabel("protein", { exact: true }).fill("13");
    await d.getByLabel("carbs", { exact: true }).fill("67");
    await d.getByLabel("fat", { exact: true }).fill("7");
    // The new food's ref, from upsert_food_source's own answer (read off the response: the tool log keeps a call only once it finishes).
    const added = j.page.waitForResponse((r) => r.url().endsWith("/tools/upsert_food_source") && r.status() === 200);
    await d.getByRole("button", { name: "Add food" }).click();
    ref = String(((await (await added).json()) as { food_source: { ref: string } }).food_source.ref);
    await pick(d, name).click();
    await measureChip(d, "g").click();
    await d.getByLabel("How much").fill("50");
    await d.getByRole("button", { name: "Save", exact: true }).click();
    await expect(d.getByLabel("How much")).toHaveCount(0);
  }, {
    changes: [
      [probe(mine, "/catalogue", "the catalogue list", (p) => p.getByLabel("Foods and recipes"), async (p) => {
        await p.getByLabel("Search foods and recipes").fill(name);
        // "Searching…" shows from the keystroke until the debounced search answers (FoodsList): read the answer, not the wait.
        await p.getByLabel("Foods and recipes").getByText("Searching…").waitFor({ state: "hidden" });
      }), (after) => expect(after).toContain(name)],
      kcalOfItem,
    ],
  });

  await step("edit its kcal in the catalogue, with a reason", async () => {
    await j.page.goto(`/catalogue/food/${encodeURIComponent(ref)}`);
    await settle(j.page);
    await catalogueRecord(j.page).getByRole("button", { name: "Edit", exact: true }).click();
    // The record's Edit form, labelled "Edit <title>" (FoodRecord); kcal is the Macros group's "Energy (kcal)" (catalogue.ts FOOD_FIELDS).
    const form = j.page.getByRole("form", { name: /^Edit / });
    await form.getByLabel("Energy (kcal)", { exact: true }).fill("360");
    await form.getByLabel("Why the change?").fill("The second pack's label is lower.");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(form).toHaveCount(0);
  }, {
    // The record shows the kcal the amend's answer stored (after.kcal), not merely something new.
    changes: [[probe(mine, `/catalogue/food/${encodeURIComponent(ref)}`, "the catalogue record", catalogueRecord), fromAnswer(() => j.tools.lastBody("amend"), (a) => a.after.kcal, "kcal")], kcalOfItem],
  });
});
