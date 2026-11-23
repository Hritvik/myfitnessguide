import { expect, type Page } from "@playwright/test";
import { fromTheSeed, journey } from "../support/journey.ts";
import { probe, step } from "../support/probes.ts";
import { settle } from "../support/settle.ts";
import { catalogueRecord, dayLabel, openSheet, region, sheet } from "../support/ui.ts";

// The new workout comes from a session logged today, which other journeys on this worker would find (J9 trains today).
fromTheSeed();

const PUSH_UP = "Push-up on the handles, deficit, chest to the floor";

journey("J18", "workouts and exercises: a new workout is offered by the + Workout tab; an exercise is read-only", ["asha", "noor"], async (j) => {
  const name = `Probe hotel day ${j.me} ${j.width}`;
  // Saved workouts are the household's: the other member's Workout tab offers it too.
  const offered = (who: Page, whose: string) =>
    probe(who, "/", `${whose} + sheet's Workout tab`, (p) => sheet(p).getByRole("list").getByRole("button"), async (p) => {
      await openSheet(p, "Workout");
      await settle(p);
    });
  const mine = offered(await j.observer(j.me), "my");
  const theirs = offered(await j.observer(j.other), `${j.other}'s`);
  const catalogue = probe(await j.observer(j.me), "/catalogue/workouts", "the catalogue's workouts", (p) => region(p, "Workouts").getByRole("listitem"));
  // Each member's list says when they last used it: today for me (the session it was saved from), never for them.
  const isOffered = (detail: string) => (after: string) => expect(after.split(" | ")).toContain(`${name} ${detail}`);

  await step("log a push-up session from nothing, then save it as a workout", async () => {
    const d = await openSheet(j.page, "Workout");
    await d.getByRole("button", { name: "Start from nothing" }).click();
    await d.getByLabel("Add an exercise").fill(PUSH_UP);
    await d.getByRole("button", { name: "Add", exact: true }).click();
    await d.getByRole("group", { name: "Set 1's load" }).getByRole("button", { name: "Bodyweight", exact: true }).click();
    await d.getByLabel("Reps").fill("12");
    await d.getByLabel("RIR").fill("2");
    await d.getByRole("button", { name: "Save workout" }).click();
    // A member with no home gym is asked which gym first (ticket 63): the first one.
    const logged = d.getByRole("heading", { name: "Logged" });
    const which = d.getByRole("group", { name: "Which gym" });
    await expect(logged.or(which)).toBeVisible();
    if (await which.isVisible()) await which.getByRole("button").first().click();
    await expect(logged).toBeVisible();
    await d.getByLabel("Name", { exact: true }).fill(name);
    await d.getByRole("button", { name: "Save as a workout" }).click();
    await expect(d.getByRole("status").filter({ hasText: /\S/ })).toHaveText(/saved/i);
  }, {
    changes: [
      // Finding (ticket 79): the Workout tab writes the day it was last used as an ISO date ("last 2026-10-07"), where
      // the catalogue writes "last Wed 7 Oct". Pinned as the app does it now: flip to dayLabel(j.today) when fixed.
      [mine, isOffered(`last ${j.today}`)],
      [theirs, isOffered("saved workout")],
      // One line (the session's one exercise), last used today. (The Workout tab writes the day as an ISO date.)
      [catalogue, (after) => expect(after.split(" | ")).toContain(`${name} 1 line · last ${dayLabel(j.today)}`)],
    ],
  });

  // An exercise is read-only: its record has nothing to press, and says where a change comes from.
  await j.page.goto("/catalogue/exercises");
  await settle(j.page);
  await region(j.page, "Exercises").getByRole("link", { name: new RegExp(`^${PUSH_UP}`) }).click();
  const record = catalogueRecord(j.page);
  await expect(record.getByRole("heading", { name: PUSH_UP })).toBeVisible();
  await expect(record).toContainText("Exercises are read-only here. A new exercise comes from Claude, in chat.");
  await expect(record.getByRole("button")).toHaveCount(0);
  await expect(record.getByRole("form")).toHaveCount(0);
});
