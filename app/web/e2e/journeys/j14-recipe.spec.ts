import { expect, type Page } from "@playwright/test";
import { fromTheSeed, journey } from "../support/journey.ts";
import { fromAnswer, probe, step } from "../support/probes.ts";
import { settle } from "../support/settle.ts";
import { catalogueRecord, openSheet, pick, region, sheet } from "../support/ui.ts";

// Each run starts from the seed: the recipe's servings and lines are the seed's (Upma: 100 g Suji and 1 tsp Ghee, 2
// servings, 400 kcal in all), whatever an earlier width changed.
fromTheSeed();

journey("J14", "a catalogue recipe: add a line, remove it, edit its servings; per-serving totals, Used by and the pot preview follow", ["asha"], async (j) => {
  const ref = String((await j.api().tool("catalogue_search", { query: "Upma", kinds: ["recipe"] })).body.results[0].ref);
  const path = `/catalogue/recipe/${encodeURIComponent(ref)}`;
  const mine = await j.observer("asha");
  const totals = probe(mine, path, "the per-serving totals", (p) => catalogueRecord(p).getByText(/^Per serving/));
  const usedBy = probe(mine, path, "Used by", (p) => region(p, "Used by"));
  // The Food tab's pot: Upma cooked for the household, Asha eating half. Half of a 2-serving pot is one serving.
  const potLine = (p: Page) => sheet(p).getByText(new RegExp(`^${j.names.asha}: 50%,`));
  const preview = probe(mine, "/", "the pot preview (Asha's half)", potLine, async (p) => {
    const d = await openSheet(p, "Food");
    await d.getByLabel("Find a food or dish").fill("Upma");
    await pick(d, /^Upma/).click();
    await d.getByRole("button", { name: "Cooked it for the household" }).click();
    await d.getByRole("list", { name: "Who ate" }).getByRole("button", { name: j.names.asha, exact: true }).click();
    await d.getByLabel(`${j.names.asha}'s share`).fill("50");
    await potLine(p).waitFor();
  });
  const added = () => j.tools.lastBody("add_recipe_line");
  const removed = () => j.tools.lastBody("remove_recipe_line");
  const peanuts = (p: Page) => catalogueRecord(p).getByRole("row").filter({ has: p.getByRole("cell", { name: /^Peanuts/ }) });

  await j.page.goto(path);
  await settle(j.page);
  // The seed's recipe, before anything changes.
  await expect(catalogueRecord(j.page)).toContainText("2 servings");
  await expect(catalogueRecord(j.page).getByText(/^Per serving/)).toHaveText("Per serving: 200 kcal · 6 g protein · 37 g carbs · 3 g fat");

  await step("add a line of 20 g Peanuts", async () => {
    await catalogueRecord(j.page).getByRole("button", { name: "Add a line", exact: true }).click();
    const form = j.page.getByRole("form", { name: "Add a line" });
    await form.getByLabel("Food", { exact: true }).fill("Peanuts");
    await form.getByLabel("Amount", { exact: true }).fill("20");
    await form.getByLabel("Why?").fill("Kabir adds a handful.");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(peanuts(j.page)).toHaveCount(1);
  }, {
    // 20 g of Peanuts (609 kcal per 100 g) is 121.8 kcal more: 521.8 kcal, 260.9 a serving; the screen shows add_recipe_line's own answer.
    changes: [
      [totals, fromAnswer(added, (a) => a.recipe.per_serving.kcal.value, "kcal")],
      [preview, fromAnswer(added, (a) => a.recipe.per_serving.kcal.value * a.recipe.servings * 0.5, "kcal")],
    ],
    same: [usedBy],
  });
  expect((await added()).recipe.per_serving.kcal.value, "the answer counts the peanuts").toBeCloseTo(260.9, 1);

  await step("remove that line, with a reason", async () => {
    await peanuts(j.page).getByRole("button", { name: "Remove", exact: true }).click();
    const form = j.page.getByRole("form", { name: "Remove" });
    await form.getByLabel("Why?").fill("Not in the usual one.");
    await form.getByRole("button", { name: "Remove it", exact: true }).click();
    await expect(peanuts(j.page)).toHaveCount(0);
  }, {
    changes: [
      [totals, (after) => expect(after).toBe("Per serving: 200 kcal · 6 g protein · 37 g carbs · 3 g fat")],
      [preview, fromAnswer(removed, (a) => a.recipe.per_serving.kcal.value * a.recipe.servings * 0.5, "kcal")],
    ],
    same: [usedBy],
  });

  await step("edit the recipe's servings to 3", async () => {
    await catalogueRecord(j.page).getByRole("button", { name: "Edit", exact: true }).click();
    const form = j.page.getByRole("form", { name: "Edit Upma" });
    await form.getByLabel("Servings", { exact: true }).fill("3");
    await form.getByLabel("Why the change?").fill("It makes three bowls.");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(catalogueRecord(j.page)).toContainText("3 servings");
  }, {
    // The same 400 kcal over three servings; the pot's half is the same food, however many servings the recipe says.
    changes: [[totals, (after) => expect(after).toBe("Per serving: 133 kcal · 4 g protein · 24 g carbs · 2 g fat")]],
    same: [preview, usedBy],
  });
});
