import { expect, type Page } from "@playwright/test";
import { d1 } from "../support/d1.ts";
import { fromTheSeed, journey } from "../support/journey.ts";
import { ABSENT, probe, step } from "../support/probes.ts";
import { settle } from "../support/settle.ts";
import { escapeRe, region } from "../support/ui.ts";

// The drafts are the seed's: a draft waist and a draft blood draw about Asha, written as the agent leaves them
// (a member can't write another's readings, Worker decision 40, and the suite's Worker takes no agent token).
// Each run starts from a fresh copy of the seed, so neither width finds the other's confirm or reject done.
fromTheSeed();

journey("J12", "health drafts (the agent's): confirm one, reject one; Kabir's view of Asha shows none of it", ["asha"], async (j) => {
  const asha = "(SELECT id FROM member WHERE email = 'asha@example.com')";
  const [reading] = d1(j.slot.persist, `SELECT value FROM reading WHERE member_id = ${asha} AND state = 'draft'`) as { value: number }[];
  const [draw] = d1(j.slot.persist, `SELECT lab FROM blood_draw WHERE member_id = ${asha} AND state = 'draft'`) as { lab: string }[];
  if (!reading || !draw) throw new Error("the seed holds no draft waist or draft blood draw about Asha");
  const waist = String(reading.value);
  const token = new RegExp(`(?<![\\d.])${escapeRe(waist)}(?![\\d]|\\.\\d)`);

  const mine = await j.observer("asha");
  const kabir = await j.observer("kabir");
  const drafts = (p: Page) => region(p, "Drafts to check");
  const progressDrafts = probe(mine, "/progress/body", "Progress's Drafts to check", drafts);
  const healthDrafts = probe(mine, "/progress/health", "Health's Drafts to check", drafts);
  const readings = probe(mine, "/progress/body", "Your readings", (p) => region(p, "Your readings"));
  const draws = probe(mine, "/progress/health", "Health's Blood draws", (p) => region(p, "Blood draws"));
  const asAsha = encodeURIComponent(j.names.asha);
  const kabirsView = [
    probe(kabir, `/progress/body?member=${asAsha}`, "Kabir's view of Asha's Progress", (p) => p.getByRole("main")),
    probe(kabir, `/progress/health?member=${asAsha}`, "Kabir's view of Asha's Health", (p) => p.getByRole("main")),
  ];
  /** Kabir sees none of Asha's drafts: no Drafts to check, not the draft's value, not the draft draw's lab. */
  const kabirSeesNone = async () => {
    for (const path of [`/progress/body?member=${asAsha}`, `/progress/health?member=${asAsha}`]) {
      await kabir.goto(path);
      await settle(kabir);
      await expect(drafts(kabir), `Drafts to check on ${path}`).toHaveCount(0);
      const shown = await kabir.getByRole("main").innerText();
      expect(shown, `${path} shows the draft waist`).not.toMatch(token);
      expect(shown, `${path} shows the draft draw`).not.toContain(draw.lab);
    }
  };
  await kabirSeesNone();

  await step(`Asha confirms the draft waist (${waist} cm)`, async () => {
    await j.page.goto("/progress/body");
    await settle(j.page);
    await drafts(j.page).getByRole("listitem").filter({ hasText: token }).getByRole("button", { name: "Yes, confirm" }).click();
  }, {
    changes: [
      [progressDrafts, (after) => expect(after === ABSENT || !token.test(after), `still a draft: ${after}`).toBe(true)],
      [readings, (after) => expect(after).toMatch(new RegExp(`Waist at navel: ${escapeRe(waist)} cm`))],
    ],
    same: [healthDrafts, draws, ...kabirsView],
  });

  await step("Asha rejects the draft blood draw: not mine", async () => {
    await j.page.goto("/progress/health");
    await settle(j.page);
    await drafts(j.page).getByRole("listitem").filter({ hasText: draw.lab }).getByRole("button", { name: "Not mine, remove it" }).click();
  }, {
    changes: [
      [healthDrafts, (after) => expect(after === ABSENT || !after.includes(draw.lab), `still a draft: ${after}`).toBe(true)],
      [draws, (after) => expect(after).not.toContain(draw.lab)],
    ],
    same: [readings, ...kabirsView],
  });

  await kabirSeesNone();
});
