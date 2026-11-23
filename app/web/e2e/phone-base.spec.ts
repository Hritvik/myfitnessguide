/**
 * The phone against a base (e2e spec §8; wide-layout spec §7), for one-off
 * comparisons: this branch's 390 px phone and <ref>'s, every state, light and
 * dark, by pixels only. Run through `node app/web/scripts/sweep-layout.ts
 * --phone-check --base <ref> [--allow <state>]`, which builds <ref> into
 * E2E_BASE_WEB/dist-phone-check; vite preview serves it with /tools proxied to
 * this slot's Worker (the identity headers pass through the proxy).
 */
import { spawn } from "node:child_process";
import { freePort, identityHeaders, ready, stopGroup, track } from "../scripts/dev-worker.ts";
import { STATE_NAMES, stateNamed } from "../scripts/states.ts";
import { allowed } from "../scripts/sweep-lib.ts";
import { test as base, EMAILS, expect } from "./support/fixtures.ts";
import { expectMukta } from "./support/fonts.ts";
import { pixelDiff, PIXEL_LIMIT } from "./support/pixels.ts";
import { runToken } from "./support/run.ts";
import { QUIET, settle } from "./support/settle.ts";

const BASE_WEB = process.env.E2E_BASE_WEB ?? "";
const ALLOW = (process.env.E2E_ALLOW ?? "").split(",").filter(Boolean);

const test = base.extend<object, { baseOrigin: string }>({
  baseOrigin: [
    async ({ slot }, use) => {
      if (!BASE_WEB) throw new Error("phone-base runs through: node app/web/scripts/sweep-layout.ts --phone-check --base <ref>");
      const port = await freePort();
      const child = spawn("npx", ["vite", "preview", "--outDir", "dist-phone-check", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
        cwd: BASE_WEB,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, GYM_WORKER_URL: slot.origin },
      });
      // Killed with the process's other groups if the run dies before the stop below.
      track(child.pid as number);
      const origin = `http://127.0.0.1:${port}`;
      // dev-worker's ready(), the suite's one timed loop (F19): GET /tools through the preview's proxy
      // answers 200 to this run's token once both are up. A 401 here means the proxy drops the identity headers.
      await ready(origin, identityHeaders(EMAILS.asha, runToken()));
      await use(origin);
      await stopGroup(child.pid as number, port);
    },
    { scope: "worker" },
  ],
});

for (const theme of ["light", "dark"] as const) {
  test.describe(`against the base, ${theme}`, () => {
    test.use({ colorScheme: theme, viewport: { width: 390, height: 844 } });
    for (const name of STATE_NAMES) {
      test(`${name} ${theme}`, async ({ page, stateApi, baseOrigin, slot }, info) => {
        const s = await stateNamed(stateApi, name);
        const shoot = async (origin: string) => {
          await page.goto(origin + s.path);
          await settle(page);
          await page.addStyleTag({ content: QUIET });
          if (s.act) await s.act(page, false);
          await settle(page);
          // Every phone shot is set in the vendored Mukta (Revision 2, completeness F1), the base's too.
          await expectMukta(page);
          return page.screenshot({ fullPage: true });
        };
        const before = await shoot(baseOrigin);
        const after = await shoot(slot.origin);
        const diff = await pixelDiff(page, before, after);
        const quiet = "share" in diff && diff.share <= PIXEL_LIMIT;
        if (!quiet) {
          await info.attach(`${name}-${theme}-base.png`, { body: before, contentType: "image/png" });
          await info.attach(`${name}-${theme}-branch.png`, { body: after, contentType: "image/png" });
          await info.attach("diff", { body: JSON.stringify(diff), contentType: "application/json" });
        }
        if (allowed(name, ALLOW)) return;
        expect(quiet, `${name} ${theme}: ${JSON.stringify(diff)}`).toBe(true);
      });
    }
  });
}
