/**
 * The layout sweep as a project (e2e spec §8; wide-layout spec §7): one test
 * per state × width × theme over states.ts on the stress household; the audit
 * and the fold run in the page, and each flag fails the test with the outlined
 * shot attached. E2E_WIDTHS and E2E_THEMES narrow it (sweep-layout.ts maps
 * --widths and --themes onto them).
 */
import type { Page } from "@playwright/test";
import { audit, type Flag } from "../scripts/audit.ts";
import { STATE_NAMES, stateNamed } from "../scripts/states.ts";
import { FOLD_FROM, foldFlag } from "../scripts/sweep-lib.ts";
import { expect, test } from "./support/fixtures.ts";
import { settle } from "./support/settle.ts";

const WIDTHS = (process.env.E2E_WIDTHS ?? "390,768,1024,1280,1440,1800,1920,2560").split(",").map(Number);
const THEMES = (process.env.E2E_THEMES ?? "light,dark").split(",") as ("light" | "dark")[];

async function fold(page: Page, primary: string | undefined, width: number): Promise<Flag[]> {
  if (!primary || width < FOLD_FROM) return [];
  const top = await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    return el ? el.getBoundingClientRect().top + window.scrollY : null;
  }, primary);
  const flag = foldFlag(primary, top);
  return flag ? [flag] : [];
}

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test.describe(`${width} ${theme}`, () => {
      // 1,080 px tall from 1,920 px, where the fold is checked; 900 below.
      test.use({ colorScheme: theme, viewport: { width, height: width >= FOLD_FROM ? 1080 : 900 } });
      for (const name of STATE_NAMES) {
        test(`${name} at ${width} ${theme}`, async ({ page, stateApi }, info) => {
          const s = await stateNamed(stateApi, name);
          const t0 = Date.now();
          await page.goto(s.path);
          await settle(page);
          // The load's time (goto and settle), for the findings reporter's slow loads (over 2 s; informational).
          await info.attach("load_ms", { body: String(Date.now() - t0), contentType: "text/plain" });
          if (s.act) await s.act(page, width >= 1024);
          await settle(page);
          const flags: Flag[] = [...(await fold(page, s.primary, width)), ...((await page.evaluate(audit)) as Flag[])];
          if (flags.length > 0) {
            await page.addStyleTag({ content: "[data-sweep-flag]{outline:2px solid #f0f !important; outline-offset:-1px}" });
            await info.attach("flags", { body: JSON.stringify(flags), contentType: "application/json" });
            await info.attach(`${name}-${width}-${theme}.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
          }
          expect(flags, "layout flags (wide-layout spec §7)").toEqual([]);
        });
      }
    });
  }
}
