/**
 * One run of the browser suite (e2e spec §2, §3): a run directory under the
 * system temp directory holding everything the run writes (the seeded D1,
 * each slot's copy, results, reports, traces, logs, findings.json), and the
 * run's identity token. Both pass to every Playwright worker through the
 * environment, so the main process and the workers agree.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newToken, WEB } from "../../scripts/dev-worker.ts";

export { WEB };
export const REPO = join(WEB, "..", "..");
/** The Worker's TIMEZONE (wrangler.jsonc): the household's day. */
export const TIMEZONE = "Asia/Kolkata";

export function runDir(): string {
  if (!process.env.E2E_RUN) {
    process.env.E2E_RUN = mkdtempSync(join(tmpdir(), "gym-e2e-"));
    // Whoever made the run owns it: the next run reaps its Workers only once this process is gone (reapStale).
    writeFileSync(join(process.env.E2E_RUN, "owner"), String(process.pid));
  }
  return process.env.E2E_RUN;
}

export function runToken(): string {
  return (process.env.E2E_TOKEN ??= newToken());
}

export function paths(run: string = runDir()) {
  return {
    run,
    seed: join(run, "seed"),
    /** This run's build: every slot's Worker serves it, so another run's build never replaces it mid-run. */
    dist: join(run, "dist"),
    results: join(run, "results"),
    report: join(run, "report.json"),
    html: join(run, "html"),
    findings: join(run, "findings.json"),
    seededOn: join(run, "seeded-on"),
    /** The run's nonce, written by global setup once the build and the seed have finished (runRecords). */
    setupNonce: join(run, "setup-nonce"),
    logs: join(run, "logs"),
    /** Every Worker group this run started, for the next run to reap if this one is killed. */
    pids: join(run, "pids"),
    /** One copy of the seeded D1 per Playwright worker slot and project. */
    slot: (index: number, project: string) => join(run, `s${index}-${project}`),
  };
}

/** The household's date now (YYYY-MM-DD in Asia/Kolkata). */
export function householdDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** The installed @playwright/test and the Chromium it drives, for the stamp. */
export function versions(): { playwright: string; chromium: string } {
  const require = createRequire(import.meta.url);
  const playwright = (JSON.parse(readFileSync(require.resolve("@playwright/test/package.json"), "utf8")) as { version: string }).version;
  const core = dirname(require.resolve("playwright-core/package.json"));
  const browsers = JSON.parse(readFileSync(join(core, "browsers.json"), "utf8")) as { browsers: { name: string; browserVersion?: string }[] };
  return { playwright, chromium: browsers.browsers.find((b) => b.name === "chromium")?.browserVersion ?? "unknown" };
}

/**
 * This run's report and seeded date, read only when this invocation's nonce
 * (E2E_NONCE, new per run.ts) is on them: the report carries it as the
 * config's metadata, the seed's date as the setup-nonce global setup writes
 * after it. Anything else in the directory is stale and is named, never read
 * (task 9 review).
 */
export function runRecords(run: string, nonce: string): { report: unknown; seededOn: string; stale: string[] } {
  const p = paths(run);
  const stale: string[] = [];
  let report: unknown = null;
  if (existsSync(p.report)) {
    const parsed = JSON.parse(readFileSync(p.report, "utf8")) as { config?: { metadata?: { nonce?: string } } };
    const theirs = parsed.config?.metadata?.nonce;
    if (theirs === nonce) report = parsed;
    else stale.push(`report.json is not this run's (nonce ${theirs ?? "none"})`);
  }
  let seededOn = "";
  if (existsSync(p.seededOn)) {
    const theirs = existsSync(p.setupNonce) ? readFileSync(p.setupNonce, "utf8").trim() : "none";
    if (theirs === nonce) seededOn = readFileSync(p.seededOn, "utf8").trim();
    else stale.push(`seeded-on is not this run's (nonce ${theirs})`);
  }
  return { report, seededOn, stale };
}
