/**
 * Once per run (e2e spec §3): build the app into the run directory (each
 * slot's wrangler dev serves it as assets, by --assets) and seed a fresh stress household with the Private shape into
 * the run directory, on its own OS-assigned port. Nothing is cached.
 */
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { paths, runDir, WEB } from "./run.ts";

/** `vite build` into the run's own directory (never app/web/dist, which another run or the layout sweep may be serving). */
export function buildArgs(run: string): string[] {
  return ["vite", "build", "--outDir", paths(run).dist, "--emptyOutDir"];
}

/**
 * The stress household with the Private shape, on the test household's fixed clock, into the run's seed
 * directory; the seed records the date its Worker reported in `seededOn`, which run.ts's verdict checks.
 */
export function seedArgs(seed: string, seededOn: string): string[] {
  return ["scripts/seed-sample.ts", "--long", "--fixed-clock", "--persist", seed, "--seeded-on", seededOn];
}

export default async function globalSetup(): Promise<void> {
  const p = paths(runDir());
  mkdirSync(p.logs, { recursive: true });
  const logFile = join(p.logs, "setup.log");
  const log = openSync(logFile, "a");
  const step = (what: string, command: string, args: string[]) => {
    const started = Date.now();
    const r = spawnSync(command, args, { cwd: WEB, stdio: ["ignore", log, log], env: process.env });
    // Each step's time, for the budget (Task 19 measures the run's terms from it).
    writeSync(log, `\n[global-setup] ${what}: ${r.status === 0 ? "done" : `failed (${r.signal ?? `exit ${r.status}`})`} in ${Date.now() - started} ms\n`);
    if (r.status !== 0) throw new Error(`${what} failed; see ${logFile}`);
  };
  try {
    step("vite build", "npx", buildArgs(p.run));
    step("the seed", process.execPath, seedArgs(p.seed, p.seededOn));
  } finally {
    closeSync(log);
  }
  // The seed's date counts only for the run.ts that started this setup (support/run.ts, runRecords).
  writeFileSync(p.setupNonce, process.env.E2E_NONCE ?? "");
  console.log(`Run directory: ${p.run}`);
}
