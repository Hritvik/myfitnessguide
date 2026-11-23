/**
 * The browser suite (e2e spec §2): Playwright's own Chromium for 1.64.0, the
 * real Worker on a local D1 per worker slot, every output under the run
 * directory. Run through `node e2e/run.ts`; see app/web/README.md.
 */
import { defineConfig } from "@playwright/test";
import { paths, runDir, runToken, TIMEZONE } from "./support/run.ts";

const p = paths(runDir());
runToken();

/**
 * The phone baselines' tolerance (layout spec §7): at most 0.5 % of pixels, each
 * counted past a threshold of 0.25 (about a delta of 64 of 255). E2E_PHONE_STRICT=1
 * (or true) makes both 0, to calibrate on identical builds (Task 7); any other value doesn't.
 */
export const PHONE_SHOT = ["1", "true"].includes(process.env.E2E_PHONE_STRICT ?? "")
  ? ({ maxDiffPixelRatio: 0, threshold: 0 } as const)
  : ({ maxDiffPixelRatio: 0.005, threshold: 0.25 } as const);

export default defineConfig<{ viewer: "asha" | "kabir" | "noor"; freshPerTest: boolean }, { readOnly: boolean }>({
  testDir: ".",
  outputDir: p.results,
  globalSetup: "./support/global-setup.ts",
  workers: Number(process.env.E2E_WORKERS ?? "4"),
  fullyParallel: false,
  retries: 1,
  // A committed test.only never focuses a run (task 9 review).
  forbidOnly: true,
  // run.ts's nonce for this invocation: the JSON report carries it, so run.ts never reads another run's report.
  metadata: { nonce: process.env.E2E_NONCE ?? "" },
  timeout: 60_000,
  updateSnapshots: "none",
  snapshotPathTemplate: "{testDir}/{testFileName}-snapshots/{arg}{ext}",
  expect: { timeout: 5_000, toHaveScreenshot: { ...PHONE_SHOT, animations: "disabled", caret: "hide", scale: "css" } },
  reporter: [
    ["list"],
    ["json", { outputFile: p.report }],
    ["html", { outputFolder: p.html, open: "never" }],
    ["./support/findings-reporter.ts"],
  ],
  use: {
    browserName: "chromium",
    timezoneId: TIMEZONE,
    reducedMotion: "reduce",
    colorScheme: "light",
    viewport: { width: 390, height: 844 },
    navigationTimeout: 15_000,
    actionTimeout: 10_000,
    trace: "retain-on-failure",
    // Nothing leaves this machine (plan review, completeness F1). Every context also routes requests and
    // WebSockets (support/fonts.ts), but routing never sees preconnects, DNS prefetch or a service worker's
    // fetches: with no DNS for any host but this one, those can't reach out either. Routed font requests are
    // answered before DNS, so the vendored Mukta still loads.
    serviceWorkers: "block",
    launchOptions: { args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"] },
  },
  // Each project but journeys is one spec file, so its tests spread across the workers only with
  // fullyParallel (F4). Journeys spread by file; a journey's tests stay in order on one worker.
  projects: [
    { name: "support", testMatch: /support\.spec\.ts$/, fullyParallel: true },
    { name: "journeys", testMatch: /journeys\/.+\.spec\.ts$/ },
    { name: "privacy", testMatch: /privacy\.spec\.ts$/, fullyParallel: true },
    { name: "failure", testMatch: /failure\.spec\.ts$/, fullyParallel: true },
    { name: "forms", testMatch: /forms\.spec\.ts$/, fullyParallel: true },
    { name: "layout", testMatch: /layout\.spec\.ts$/, fullyParallel: true, use: { readOnly: true } },
    { name: "phone", testMatch: /phone\.spec\.ts$/, fullyParallel: true, use: { readOnly: true } },
    { name: "phone-base", testMatch: /phone-base\.spec\.ts$/, use: { readOnly: true } },
  ],
});
