import { expect, type Page } from "@playwright/test";
import { fromTheSeed, journey } from "../support/journey.ts";
import { ABSENT, mayBeAbsent, probe, step } from "../support/probes.ts";
import { settle } from "../support/settle.ts";
import { addDays, dayLabel, region } from "../support/ui.ts";

// Each run starts from the seed: Asha's one flag due within the strip's week (the waist readings, due in 3 days) is
// open, whatever an earlier width resolved.
fromTheSeed();

const WAIST = "WAIST READINGS ON 28 SEP AND 1 OCT DISAGREE BY 2.4 CM: CHECK WHETHER THE TAPE WAS AT THE NAVEL OR AT THE NARROWEST POINT BEFORE TRUSTING THE TREND";
const strip = (p: Page) => region(p, "Needs you");
/** Every card on the strip: it shows three and "+N more", which opens out the rest. */
async function openOut(p: Page): Promise<void> {
  const more = strip(p).getByRole("button", { name: /^\+\d+ more$/ });
  if (await more.isVisible()) {
    await more.click();
    await expect(more).toHaveCount(0);
  }
}

journey("J21", "Needs you and flags from the strip: the route it opens, and the strip after a flag is resolved", ["asha"], async (j) => {
  const mine = await j.observer("asha");
  const cards = probe(mine, "/", "the strip's cards", (p) => strip(p).getByRole("listitem"), openOut);
  const flagCard = probe(mine, "/", "the strip's flag card", (p) => strip(p).getByRole("listitem").filter({ has: p.getByRole("link", { name: "Open Health" }) }), openOut);
  const data = probe(mine, "/progress/health", "Health's Data to check", (p) => region(p, "Data to check"));
  // Flags are owner-only (needs_you's flag rule; Worker decision 40): Kabir's views of Asha never hold them.
  const kabir = await j.observer("kabir");
  const asha = encodeURIComponent(j.names.asha);
  const kabirs = [
    probe(kabir, `/progress/health?member=${asha}`, "Kabir's view of Asha's Health", (p) => p.getByRole("main")),
    mayBeAbsent(probe(kabir, `/?member=${asha}`, "Kabir's view of Asha's strip", strip), "another member's Today has no strip: needs_you's flags and drafts are the owner's"),
  ];

  // The strip's flag card opens Health, where the flag is.
  await j.page.goto("/");
  await settle(j.page);
  await openOut(j.page);
  const card = strip(j.page).getByRole("listitem").filter({ hasText: WAIST });
  await expect(card).toHaveText(`${WAIST}: due ${dayLabel(addDays(j.today, 3))}.Open Health`);
  const link = card.getByRole("link", { name: "Open Health" });
  await expect(link).toHaveAttribute("href", "/progress/health");
  await link.click();
  await expect(j.page).toHaveURL(/\/progress\/health$/);
  await expect(j.page.getByRole("main").getByRole("heading", { name: "Health", level: 1 })).toBeVisible();
  const flag = region(j.page, "Data to check").getByRole("group", { name: WAIST, exact: true });
  await expect(flag).toBeVisible();

  const before = (await cards.read()).split(" | ").length;
  await step("resolve the flag, saying how", async () => {
    await flag.getByRole("button", { name: "Resolve…" }).click();
    await flag.getByLabel("How was it resolved?").fill("Re-measured at the navel; the 1 Oct tape was high.");
    await flag.getByRole("button", { name: "Resolve it", exact: true }).click();
    await expect(flag).toHaveCount(0);
  }, {
    changes: [
      // The only flag due this week: the strip loses its card, and only that one.
      [flagCard, (after) => expect(after).toBe(ABSENT)],
      [cards, (after) => {
        expect(after).not.toContain(WAIST);
        expect(after.split(" | ")).toHaveLength(before - 1);
      }],
      [data, (after) => {
        expect(after).not.toContain(WAIST);
        expect(after).toContain("Lipid report never received");
      }],
    ],
    same: kabirs,
  });
  for (const p of kabirs) expect(await p.read(), p.label).not.toMatch(/WAIST READINGS|Lipid report/);
});
