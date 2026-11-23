import { expect, type Page } from "@playwright/test";
import { fromTheSeed, journey } from "../support/journey.ts";
import { ABSENT, apiProbe, probe, step } from "../support/probes.ts";
import { settle } from "../support/settle.ts";
import { dayLabel, escapeRe, openSheet, region } from "../support/ui.ts";

// Each run starts from the seed (a fresh copy and Worker): Asha's answer changes her gym's inventory for good, and
// Noor's first set of the day is the one that asks which gym, so a second width must not find either already done.
fromTheSeed();

journey("J10", "the gym question; a member with no home gym is asked which gym", ["asha", "noor"], async (j) => {
  const mine = await j.observer(j.me);
  const todayLabel = dayLabel(j.today);
  if (j.me === "asha") {
    const question = (p: Page) => region(p, "A question about your gym");
    const plates = probe(mine, "/train", "the plate builder's plates", (p) => p.getByRole("dialog", { name: "Add" }).getByRole("group", { name: "Add a plate" }), async (p) => {
      const d = await openSheet(p, "Set", null);
      await d.getByLabel("Find an exercise").fill("bench");
      await d.getByRole("list").getByRole("button", { name: /bench press/i }).first().click();
      await d.getByRole("group", { name: "Load as" }).getByRole("button", { name: "Plates", exact: true }).click();
    });
    await j.page.goto("/train");
    await settle(j.page);
    const first = question(j.page).getByRole("button", { pressed: false }).first();
    const seen = (await first.innerText()).trim();
    // The builder doesn't offer it yet: only her answer can add it.
    expect(await plates.read(), `the builder already offers ${seen}`).not.toContain(`+ ${seen}`);
    await step(`answer the gym question on Train: ${seen} is there`, async () => {
      await first.click();
      await question(j.page).getByRole("button", { name: "Save the plates" }).click();
    }, {
      changes: [
        [plates, (after) => expect(after).toContain(`+ ${seen}`)],
        // The plate she saw is no longer asked about (the rest are saved as not there, so the question may go).
        [probe(mine, "/train", "the check-at-gym question", question), (after) => expect(after === ABSENT || !after.includes(seen), `${seen} is still asked: ${after}`).toBe(true)],
      ],
    });
    return;
  }
  // Noor has no home gym: a strength set asks which gym, and the session takes the answer. Train's session cards
  // don't name a gym, so the session's gym is read as Noor over the API (the sessions tool's `gym`).
  let gym = "";
  const todays = apiProbe("Noor's sessions today, with their gym", async () =>
    ((await j.api("noor").tool("sessions", { member: j.names.noor, from: j.today, to: j.today })).body.sessions as { gym: string | null }[]).map((s) => s.gym));
  await step("log a set with no home gym", async () => {
    const d = await openSheet(j.page, "Set");
    await d.getByLabel("Find an exercise").fill("row");
    await d.getByRole("list").getByRole("button", { name: /cable row/i }).first().click();
    await d.getByRole("group", { name: "Load as" }).getByRole("button", { name: "Weight", exact: true }).click();
    await d.getByLabel("Load", { exact: true }).fill("30");
    await d.getByLabel("Reps").fill("12");
    await d.getByPlaceholder("2 or 1-2").fill("2");
    await d.getByRole("button", { name: "Save set" }).click();
    const which = d.getByRole("group", { name: "Which gym" });
    await expect(which).toBeVisible();
    gym = (await which.getByRole("button").first().innerText()).trim();
    await which.getByRole("button").first().click();
    await expect(d.getByLabel("Reps")).toHaveValue("");
  }, {
    changes: [
      [todays, (after) => expect(JSON.parse(after)).toEqual([gym])],
      // Today's session leads the list now: one working set of 12 × 30 kg.
      [probe(mine, "/train", "Noor's Sessions", (p) => region(p, "Sessions")), (after) => expect(after).toMatch(new RegExp(`^Sessions ${escapeRe(todayLabel)}: Gym session 1 working set, 360 kg volume `))],
    ],
  });
});
