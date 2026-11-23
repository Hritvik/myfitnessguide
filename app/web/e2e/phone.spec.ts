/**
 * The phone, guarded by its pixels (e2e spec §8): every state at 390 × 844,
 * light and dark, against the committed baselines in phone.spec.ts-snapshots/
 * (the invented household only). At most 0.5 % of pixels may differ, each
 * counted past a delta of about 64 (PHONE_SHOT). A baseline changes only with
 * --update-snapshots, in a commit that names the state and says why.
 */
import { STATE_NAMES, stateNamed, states } from "../scripts/states.ts";
import { expect, test } from "./support/fixtures.ts";
import { expectMukta } from "./support/fonts.ts";
import { QUIET, settle } from "./support/settle.ts";

/** One shot per tab runs in the fast subset (spec §9). */
const FAST = new Set(["today", "train", "progress", "household"]);

// The tests below are listed from the static STATE_NAMES: a state the household makes but the list lacks would
// never be shot, and one the list names but the household lacks would fail only as "no state named" (Task 6 review).
test("the household makes exactly the listed states", { tag: ["@fast"] }, async ({ stateApi }) => {
  expect((await states(stateApi)).map((s) => s.name)).toEqual(STATE_NAMES);
});

for (const theme of ["light", "dark"] as const) {
  test.describe(`phone ${theme}`, () => {
    test.use({ colorScheme: theme, viewport: { width: 390, height: 844 } });
    for (const name of STATE_NAMES) {
      // The fast subset runs these four in the phone project's own pristine slot (ruling 1), so no journey's writes reach them.
      test(`${name} ${theme}`, { tag: theme === "light" && FAST.has(name) ? ["@fast"] : [] }, async ({ page, stateApi }) => {
        const s = await stateNamed(stateApi, name);
        await page.goto(s.path);
        await settle(page);
        await page.addStyleTag({ content: QUIET });
        if (s.act) await s.act(page, false);
        await settle(page);
        await expectMukta(page);
        await expect(page).toHaveScreenshot(`${name}-${theme}.png`, { fullPage: true });
      });
    }
  });
}
