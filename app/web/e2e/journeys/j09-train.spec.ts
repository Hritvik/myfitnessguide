import { expect, type Page } from "@playwright/test";
import { fromTheSeed, journey } from "../support/journey.ts";
import { probe, step, type Check, type Probe } from "../support/probes.ts";
import { settle } from "../support/settle.ts";
import { answerGymIfAsked, dayLabel, FAB, logSet, openSheet, region, sheet } from "../support/ui.ts";

// It writes: each run leaves its slot fresh for the next (fromTheSeed).
fromTheSeed();

// The seed's long names ("Seated cable row with…", "Barbell bench press, flat bench…"): matched by a part.
// Today's session is the newest card in Sessions (train.ts, newest first): every set below lands in it. It holds
// the earlier width's sets too (one slot, one day), so its tally is checked as a change from what it read before.
/** A session's "<n> working set(s), <kg> kg volume" (train.ts). */
const tally = (text: string): { sets: number; kg: number } => {
  const m = /(\d+) working sets?, ([\d,]+) kg volume/.exec(text);
  if (!m) throw new Error(`no tally in ${JSON.stringify(text)}`);
  return { sets: Number(m[1]), kg: Number(m[2]!.replace(/,/g, "")) };
};
journey("J9", "train: log sets (plates per side, a load, bodyweight; RIR), edit, remove, save as a workout", ["asha", "noor"], async (j) => {
  const mine = await j.observer(j.me);
  const theirs = await j.observer(j.other);
  const sessions = (p: Page) => region(p, "Sessions");
  /** Today's session: on the phone the first card's body opens in place; wide, the first row opens it beside the list. */
  const openToday = async (p: Page) => {
    if (j.wide) await sessions(p).locator("[data-row]").first().click();
    // <summary> has no ARIA role to find it by: the card's disclosure is its first child's summary.
    else await sessions(p).getByRole("listitem").first().locator("summary").click();
  };
  const todays = (p: Page) => (j.wide ? p.getByRole("article").filter({ has: p.getByRole("heading", { level: 3 }) }) : sessions(p).getByRole("listitem").first());
  const today = probe(mine, "/train", "today's session in Sessions", todays, openToday);
  // The row's prescription on Train (Asha's programme): its load and its progression chip.
  const rowRx = probe(mine, "/train", "the cable row's prescription and chip", (p) => p.getByRole("main").getByRole("listitem").filter({ has: p.getByRole("heading", { level: 2, name: /cable row/i }) }));
  /** Today's working cable rows in a session card's text ("<row>: 10 × 35 kg, …"). */
  const cableRows = (text: string): number => (text.match(/cable row[^:]*: \d+ ×/gi) ?? []).length;
  // Today's working cable rows hold the step back until the rule's three (train.ts chip "Holding (<reason>)"): the
  // ones already there before the step (the earlier width's, read below) and the one this step logs.
  let rowsBefore = 0;
  const rowChip: [Probe, Check] = [rowRx, (after) => expect(after).toContain(`Holding (${rowsBefore + 1} working sets; the rule needs 3)`)];
  const theirSessions = probe(theirs, "/train", `${j.other}'s Sessions`, sessions);
  const workoutName = `Probe circuit ${j.me} ${j.width}`;

  /** The tally after a step: `sets` more working sets and `kg` more volume than `from`. */
  const grew = (from: { sets: number; kg: number }, sets: number, kg: number) => (after: string) => expect(tally(after)).toEqual({ sets: from.sets + sets, kg: from.kg + kg });
  const todayLabel = dayLabel(j.today);
  const tallyNow = async () => {
    const t = await today.read();
    // No session today yet: the newest card is an earlier day's.
    const ours = t.startsWith(`${todayLabel}:`);
    rowsBefore = ours ? cableRows(t) : 0;
    return ours ? tally(t) : { sets: 0, kg: 0 };
  };

  let base = await tallyNow();
  await step("log a cable row at 35 kg, 10 reps, RIR 2", () => logSet(j.page, { search: "row", exercise: /cable row/i, load: "35", reps: "10", rir: "2" }), {
    changes: [[today, (after) => {
      expect(after).toMatch(/cable row[^:]*: 10 × 35 kg, RIR 2(?!\d)/i);
      expect(after.startsWith(`${todayLabel}:`), "the newest card is today's session").toBe(true);
      grew(base, 1, 350)(after);
    }], ...(j.me === "asha" ? [rowChip] : [])],
    same: [theirSessions],
  });

  // Asha's bench is plate-loaded at her home gym. Noor has no home gym, so no plate inventory: the builder offers
  // no plates and "Other plate…" is off (PlateBuilder: needs the inventory). Hers is the same load as a weight per side.
  const bench = j.me === "asha" ? /bench press[^:]*: 8 × 20 kg bar \+ 10 kg \+ 5 kg a side, RIR 1–2/i : /bench press[^:]*: 8 × 20 kg bar \+ 25 kg a side, RIR 1–2/i;
  base = await tallyNow();
  await step(j.me === "asha" ? "log a bench set as plates per side" : "log a bench set as a weight per side", async () => {
    const d = await openSheet(j.page, "Set");
    await d.getByLabel("Find an exercise").fill("bench");
    await d.getByRole("list").getByRole("button", { name: /bench press/i }).first().click();
    if (j.me === "asha") {
      await d.getByRole("group", { name: "Load as" }).getByRole("button", { name: "Plates", exact: true }).click();
      // The builder opens on the prescription's load (20 kg bar + 10 kg + 5 lb a side): swap the 5 lb for a 5 kg.
      await d.getByRole("group", { name: "Plates on one side" }).getByRole("button", { name: "Remove one 5 lb", exact: true }).click();
      await d.getByRole("group", { name: "Add a plate" }).getByRole("button", { name: "+ 5 kg", exact: true }).click();
      await expect(d.getByText("20 kg bar + 10 kg + 5 kg a side", { exact: true })).toBeVisible();
    } else {
      await d.getByRole("group", { name: "Load as" }).getByRole("button", { name: "Weight", exact: true }).click();
      await d.getByLabel("Load", { exact: true }).fill("25");
      await d.getByLabel("Basis").selectOption("per_side");
    }
    await d.getByLabel("Reps").fill("8");
    await d.getByPlaceholder("2 or 1-2").fill("1-2");
    await d.getByRole("button", { name: "Save set" }).click();
    await answerGymIfAsked(d);
    await expect(d.getByLabel("Reps")).toHaveValue("");
    await d.getByRole("button", { name: "Close" }).click();
  }, {
    changes: [[today, (after) => {
      expect(after).toMatch(bench);
      // 8 × (20 kg bar + 2 × 15 kg), or, a barbell's weight per side counting its bar, 8 × (20 + 2 × 25 kg).
      grew(base, 1, j.me === "asha" ? 400 : 560)(after);
    }]],
    same: [theirSessions],
  });

  await step("log a bodyweight push-up set", () => logSet(j.page, { search: "push", exercise: /^Push-up/, reps: "15", rir: "3" }), {
    changes: [[today, (after) => expect(after).toMatch(/Push-up[^:]*: 15 ×[^,]*, RIR 3/)]],
    same: [theirSessions],
  });

  const pushUp = (p: Page) => (j.wide ? p.getByRole("article") : sessions(p)).getByRole("button", { name: /^Edit Push-up/ }).filter({ visible: true }).first();
  await step("edit the push-ups' reps to 14", async () => {
    await j.page.goto("/train");
    await settle(j.page);
    await openToday(j.page);
    await pushUp(j.page).click();
    const form = j.page.getByRole("form", { name: "Edit this set" });
    await form.getByLabel("Reps").fill("14");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(form).toHaveCount(0);
  }, {
    changes: [[today, (after) => {
      expect(after).toMatch(/Push-up[^:]*: 14 ×[^,]*, RIR 3/);
      expect(after).not.toMatch(/Push-up[^:]*: 15 ×/);
    }]],
    same: [theirSessions],
  });

  await step("remove the push-ups", async () => {
    const remove = (j.wide ? j.page.getByRole("article") : sessions(j.page)).getByRole("button", { name: /^Remove Push-up/ }).filter({ visible: true }).first();
    await remove.click();
    await j.page.getByRole("button", { name: "Remove", exact: true }).filter({ visible: true }).first().click();
    await expect(remove).toHaveCount(0);
  }, {
    changes: [[today, (after) => {
      expect(after).not.toContain("Push-up");
      expect(after).toMatch(/cable row/i);
    }]],
    same: [theirSessions],
  });

  await step("save the session as a workout", async () => {
    await j.page.goto("/train");
    await settle(j.page);
    await openToday(j.page);
    const body = j.wide ? j.page.getByRole("article") : sessions(j.page).getByRole("listitem").first();
    await body.getByRole("button", { name: "Save this session as a workout" }).click();
    await body.getByLabel("Workout name").fill(workoutName);
    await body.getByRole("button", { name: "Save as a workout", exact: true }).click();
    await expect(body.getByRole("button", { name: "Save this session as a workout" })).toBeVisible();
  }, {
    changes: [
      [probe(mine, "/catalogue/workouts", "the catalogue's workouts", (p) => region(p, "Workouts")), (after) => expect(after).toContain(workoutName)],
      [probe(mine, "/", "the + sheet's Workout tab", sheet, async (p) => {
        await p.getByRole("button", { name: FAB }).click();
        const loaded = p.waitForResponse((r) => r.url().endsWith("/tools/workouts") && r.status() === 200);
        await sheet(p).getByRole("tab", { name: "Workout" }).click();
        await sheet(p).getByRole("tab", { name: "Workout", selected: true }).waitFor();
        // A cached list paints immediately, before its quiet refresh. Read only
        // after that refresh so a workout saved earlier in this step is present.
        await loaded;
      }), (after) => expect(after).toContain(workoutName)],
    ],
  });
}, { fast: ["asha"] });
