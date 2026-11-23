import type { Page } from "@playwright/test";

/**
 * The sweep's settle (e2e spec §2): network idle, nothing "Loading…", fonts ready, two animation frames.
 * Types only from Playwright: scripts/states.ts loads this through ui.ts, and the unit tests load states.ts.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  // A web-first wait: resolves at once when nothing says "Loading…", else when the last one goes.
  await page.getByText("Loading…").first().waitFor({ state: "hidden" });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  });
}

/** Transitions, animations and the caret off, for a shot (the phone check's style, wide-layout spec §7). */
export const QUIET = "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}";
