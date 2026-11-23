import { expect } from "@playwright/test";
import { fromTheSeed, journey } from "../support/journey.ts";
import { fromAnswer, probe, step } from "../support/probes.ts";
import { settle } from "../support/settle.ts";
import { itemRow, leftToday, tierMeta, weekView, writeAs } from "../support/ui.ts";

// It writes: each run leaves its slot fresh for the next (fromTheSeed).
fromTheSeed();

// Asha's other is Noor (as in J1). Every member's strip moves with their own log: what is left of Asha's
// target, what Kabir and Noor have eaten so far (neither has a whole target; J1's note).
// Bajra goes where no member has anything (today's Post-workout, then yesterday's Breakfast, in the seed),
// so the meal's subtotal is Bajra's alone and is checked against the amend's own answer (computed.nutrients).
journey("J2", "edit, move to another meal and day, remove: both days, Left, the week and History follow", [["asha", "noor"], "kabir", "noor"], async (j) => {
  await writeAs(j.api(), "log_intake", { member: j.names[j.me], date: j.today, meal_slot: "post_workout", items: [{ source: "food", food: "Bajra", value: 33, unit: "g", provenance: "weighed", confidence: "high" }] });
  const mine = await j.observer(j.me);
  const theirs = await j.observer(j.other);
  const left = [probe(mine, "/", "my Left today", leftToday)];
  const amended = fromAnswer(() => j.tools.lastBody("amend"), (a) => a.computed.nutrients.kcal.value, "kcal");
  const openEdit = async (path: string) => {
    await j.page.goto(path);
    await settle(j.page);
    await itemRow(j.page, "Bajra").getByRole("button", { name: "Edit Bajra" }).click();
    return j.page.getByRole("form", { name: "Edit this item" });
  };

  await step("edit the amount to 44 g", async () => {
    const form = await openEdit("/");
    await form.getByLabel(/^How much/).fill("44");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(form).toHaveCount(0);
  }, {
    changes: [
      [probe(mine, "/", "my Post-workout subtotal", (p) => tierMeta(p, "Post-workout")), amended],
      ...left,
      probe(mine, `/progress/body?week=${j.today}`, "my week", weekView),
      probe(mine, "/", "Bajra's History", (p) => itemRow(p, "Bajra").getByRole("list"), async (p) => {
        await itemRow(p, "Bajra").getByRole("button", { name: "history", exact: true }).click();
        // The trail loads after the click ("Loading…" first): read it once it is there.
        await itemRow(p, "Bajra").getByRole("list").waitFor();
      }),
    ],
    same: [probe(theirs, "/", `${j.other}'s Left`, leftToday)],
  });

  await step("move it to Breakfast, yesterday", async () => {
    const form = await openEdit("/");
    await form.getByLabel("Meal").selectOption({ label: "Breakfast" });
    await form.getByLabel("Day").fill(j.yesterday);
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(form).toHaveCount(0);
  }, {
    changes: [
      probe(mine, "/", "today's Post-workout", (p) => tierMeta(p, "Post-workout")),
      [probe(mine, `/?date=${j.yesterday}`, "yesterday's Breakfast", (p) => tierMeta(p, "Breakfast")), amended],
      ...left,
    ],
    same: [probe(mine, "/", "today's Dinner", (p) => tierMeta(p, "Dinner")), probe(theirs, "/", `${j.other}'s Left`, leftToday)],
  });

  await step("remove it", async () => {
    await j.page.goto(`/?date=${j.yesterday}`);
    await settle(j.page);
    await itemRow(j.page, "Bajra").getByRole("button", { name: "Remove Bajra" }).click();
    await itemRow(j.page, "Bajra").getByRole("button", { name: "Remove", exact: true }).click();
    await expect(itemRow(j.page, "Bajra")).toHaveCount(0);
  }, {
    changes: [
      [probe(mine, `/?date=${j.yesterday}`, "yesterday's Breakfast", (p) => tierMeta(p, "Breakfast")), (after) => expect(after).toBe("nothing yet")],
      probe(mine, `/progress/body?week=${j.yesterday}`, "the week", weekView),
    ],
    same: [probe(mine, "/", "today's Lunch", (p) => tierMeta(p, "Lunch"))],
  });
});
