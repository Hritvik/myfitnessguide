import { expect } from "@playwright/test";
import { d1 } from "../support/d1.ts";
import { fromTheSeed, journey } from "../support/journey.ts";
import { settle } from "../support/settle.ts";
import { moreButton, writesTo } from "../support/ui.ts";

// It writes: each run leaves its slot fresh for the next (fromTheSeed).
fromTheSeed();

journey("J22", "feedback: sent once, even on a double tap", ["asha", "kabir"], async (j) => {
  const text = `The week view's arrows are small (${j.me}, ${j.width}).`;
  const before = writesTo(j.slot.persist, ["submit_feedback"]);
  await j.page.goto("/progress");
  await settle(j.page);
  await moreButton(j.page).click();
  await j.page.getByRole("menuitem", { name: "Send feedback" }).click();
  const dialog = j.page.getByRole("dialog", { name: "Send feedback" });
  await expect(dialog.getByLabel("What happened, or what you'd like")).toBeFocused();
  await dialog.getByRole("group", { name: "Kind" }).getByRole("button", { name: "Idea", exact: true }).click();
  await dialog.getByLabel("What happened, or what you'd like").fill(text);
  // A double tap, the second while the first is still on its way: the first request is held until the second tap
  // has landed, so the box is still full and only the busy guard can stop a second send. The second tap goes where
  // Send is then, enabled or not ("Saving…" moves Send up in the sheet, so a double click's second tap would miss it).
  let release = (): void => {};
  const held = new Promise<void>((r) => (release = r));
  const reached: string[] = [];
  await j.page.route("**/tools/submit_feedback", async (route) => {
    reached.push(route.request().postDataJSON().idempotency_key);
    await held;
    await route.continue();
  });
  const send = dialog.getByRole("button", { name: "Send", exact: true });
  await send.click();
  await expect.poll(() => reached.length, { message: "the first send is held" }).toBe(1);
  await expect(dialog.getByLabel("What happened, or what you'd like")).toHaveValue(text);
  await send.click({ force: true });
  // Nothing more leaves while the first is in flight, and Send says so.
  await expect(send).toBeDisabled();
  expect(reached, "sends while the first is in flight").toHaveLength(1);
  release();
  await expect(dialog.getByRole("status")).toHaveText("Sent. It comes up at the next feedback review.");
  // Once: one request with a key, one write landed, and the one feedback row is this one, with where it was sent from.
  // Counted once the network is quiet, so a second send still on its way is counted too.
  await settle(j.page);
  expect(await j.tools.writes("submit_feedback"), "requests sent").toHaveLength(1);
  expect(writesTo(j.slot.persist, ["submit_feedback"]), "writes landed").toBe(before + 1);
  const rows = d1(j.slot.persist, "SELECT f.type, f.context, m.name FROM feedback f JOIN member m ON m.id = f.member_id WHERE f.text = ?", text);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ type: "idea", name: j.names[j.me] });
  expect(JSON.parse(String(rows[0]?.context))).toMatchObject({ route: "/progress", date: null, viewport: j.wide ? "desktop" : "phone" });

  // Sent clears the box, so Send can't go again.
  await expect(dialog.getByLabel("What happened, or what you'd like")).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Send", exact: true })).toBeDisabled();

  // Closing gives focus back to "More" (desktop spec §6).
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(moreButton(j.page)).toBeFocused();
});
