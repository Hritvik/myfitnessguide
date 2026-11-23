import { expect, type Locator, type Page } from "@playwright/test";
import { fromTheSeed, journey } from "../support/journey.ts";
import { probe, step } from "../support/probes.ts";
import { settle } from "../support/settle.ts";
import { dayLabel, escapeRe, openSheet, readingValue, region, writesTo } from "../support/ui.ts";

// It writes: each run leaves its slot fresh for the next (fromTheSeed).
fromTheSeed();

// Readings are owner-only (Worker decision 40): the other member's views of my Progress and Health must
// never show them. Values are found as whole tokens, and no seeded reading has them (the seed's waist today is 84.6).
journey("J11", "readings (weight, waist, blood pressure), edit, remove; a 700 kg weight asks first", ["asha", "kabir"], async (j) => {
  const mine = await j.observer(j.me);
  const theirs = await j.observer(j.other);
  const me = encodeURIComponent(j.names[j.me]);
  const progress = probe(mine, "/progress/body", "Progress", (p) => p.getByRole("main"));
  const health = probe(mine, "/progress/health", "Health", (p) => p.getByRole("main"));
  const yours = (p: Page) => region(p, "Your readings");
  const recent = probe(mine, "/progress/body", "Your readings", yours);
  const theirViewOfMe = [
    probe(theirs, `/progress/body?member=${me}`, `${j.other}'s view of my Progress`, (p) => p.getByRole("main")),
    probe(theirs, `/progress/health?member=${me}`, `${j.other}'s view of my Health`, (p) => p.getByRole("main")),
  ];
  // Each width's own values (one slot, one day: the earlier width's readings are still there).
  const v = j.wide ? { weight: "72.8", waist: "82.4", edited: "81.5", sys: "121", dia: "79" } : { weight: "72.6", waist: "82.2", edited: "81.7", sys: "118", dia: "76" };
  const todayLabel = dayLabel(j.today);
  const token = (v: string) => new RegExp(`(?<![\\d.])${escapeRe(v)}(?![\\d]|\\.\\d)`);
  const shows = (...values: string[]) => (after: string) => {
    for (const v of values) expect(after).toMatch(token(v));
  };

  const log = async (metric: string, value: string, fasted = false): Promise<Locator> => {
    const d = await openSheet(j.page, "Reading");
    await d.getByLabel("What you measured").selectOption(metric);
    await readingValue(d).fill(value);
    if (fasted) await d.getByRole("group", { name: "Before or after eating" }).getByRole("button", { name: "Fasted", exact: true }).click();
    await d.getByRole("button", { name: "Log the reading" }).click();
    return d;
  };
  const logged = async (d: Locator) => {
    await expect(readingValue(d)).toHaveValue("");
    await d.getByRole("button", { name: "Close" }).click();
  };

  await step(`log a fasted weight of ${v.weight} kg`, async () => logged(await log("weight", v.weight, true)), {
    changes: [
      // The 7-day fasted weight's chart ends on today's average, the write's own answer (log_reading computed).
      [progress, async (after) => {
        const avg = Number((await j.tools.lastBody("log_reading")).computed.seven_day_average_kg);
        expect(after).toContain(`7-day fasted weight: ${avg.toFixed(1)} kg on ${todayLabel}`);
      }],
      [recent, shows(v.weight)],
    ],
    same: theirViewOfMe,
  });
  await step(`log a waist of ${v.waist} cm`, async () => logged(await log("waist_navel", v.waist)), {
    changes: [[progress, shows(v.waist)], [recent, shows(v.waist)]],
    same: theirViewOfMe,
  });
  await step(`log a blood pressure of ${v.sys} over ${v.dia}`, async () => {
    await logged(await log("bp_systolic", v.sys));
    await logged(await log("bp_diastolic", v.dia));
  }, {
    // Health holds bloods and flags, not readings: blood pressure shows on Progress, in Your readings.
    changes: [[recent, shows(v.sys, v.dia)]],
    same: [health, ...theirViewOfMe],
  });

  // 700 kg asks before it saves (the plausibility check), and nothing is written.
  const before = writesTo(j.slot.persist, ["log_reading"]);
  const d = await log("weight", "700", true);
  await expect(d.getByText(/^700 kg is outside the range a body weight can be/)).toBeVisible();
  expect(writesTo(j.slot.persist, ["log_reading"]), "a 700 kg weight is not written before the answer").toBe(before);
  await d.getByRole("button", { name: "Close" }).click();

  const waistRow = (p: Page, v: string) => yours(p).getByRole("listitem").filter({ hasText: token(v) });
  await step(`edit the waist to ${v.edited} cm`, async () => {
    await j.page.goto("/progress/body");
    await settle(j.page);
    await waistRow(j.page, v.waist).getByRole("button", { name: /^Edit / }).click();
    const form = j.page.getByRole("form", { name: "Edit this reading" });
    await form.getByLabel(/^Value, in /).fill(v.edited);
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await expect(form).toHaveCount(0);
  }, {
    changes: [[progress, (after) => {
      shows(v.edited)(after);
      expect(after).not.toMatch(token(v.waist));
    }]],
    same: theirViewOfMe,
  });
  await step("remove it", async () => {
    await waistRow(j.page, v.edited).getByRole("button", { name: /^Remove / }).click();
    await waistRow(j.page, v.edited).getByRole("button", { name: "Remove", exact: true }).click();
    await expect(waistRow(j.page, v.edited)).toHaveCount(0);
  }, {
    changes: [[progress, (after) => expect(after).not.toMatch(token(v.edited))]],
    same: theirViewOfMe,
  });

  // The other member's views of mine never held any of it.
  for (const p of theirViewOfMe) {
    const seen = await p.read();
    for (const x of Object.values(v)) expect(seen, `${p.label} shows ${x}`).not.toMatch(token(x));
  }
}, { fast: ["asha"] });
