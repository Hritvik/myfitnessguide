/**
 * `node e2e/run.ts --full | --fast | --layout | --projects <a,b> [-- <playwright args>]`
 *
 * The browser suite (e2e spec §9–§11). --full runs every project and writes
 * the deploy stamp when the tree was clean and HEAD unmoved from the start to
 * the end, every project ran and every test passed the first time (a
 * quarantined test's failure doesn't fail the run, but the run earns no
 * stamp; F7), nothing narrowed it (no Playwright arguments passed through, no
 * E2E_ variable that changes what runs), node_modules matches
 * package-lock.json and no ignored source file sits under app/. The whole
 * decision is support/verdict.ts's verdict(). --fast is `npm test`'s subset: the @fast
 * tests of their own projects. --layout is the merge gate's layout + phone.
 * Exit 0 pass, 1 fail (a seed or global setup that failed included: the run
 * prints setup.log's path; a Playwright exit the report doesn't explain
 * included), 2 a bad command line or a preset E2E_RUN. Each run makes its own
 * directory and nonce, and reads only a report and seeded date that carry
 * that nonce (support/run.ts, runRecords). The household's date is fixed, so no run is void
 * (support/verdict.ts).
 *
 * Every run writes summary.json (the verdict, counts, timings and the layout
 * findings) into its run directory and copies it to
 * $TMPDIR/myfitnessguide-e2e-last/<mode>.json. The run directory is deleted only when the
 * run is green (passed, nothing flaky, no quarantined test failing or
 * flaking); a failed, flaky or interrupted run keeps it, with traces, slot
 * logs and findings.json.
 *
 * Playwright runs in a process group of its own, so a signal to this process
 * (Ctrl-C reaches only it) is passed on exactly once and the run waits for
 * Playwright to stop its workers. Whatever the ending, any Worker group the
 * run recorded and that is still alive is stopped before the record goes.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { git, ignoredSource, installedTree, isoTime, overridesForStamp, pendingOverrides, readOverrideLog, readStamps, treeClean, treesAt, writeStamp } from "@myfitnessguide/worker/stamp";
import { reapRun, reapStale } from "../scripts/dev-worker.ts";
import { FIXED_DAY } from "../scripts/test-clock.ts";
import { QUARANTINE } from "./quarantine.ts";
import { parseRunArgs } from "./support/args.ts";
import { householdDate, paths, REPO, runDir, runRecords, runToken, versions, WEB } from "./support/run.ts";
import { errorsOf, narrowingEnv, outcomesOf, setupTimings, verdict, workerMinutes } from "./support/verdict.ts";

const args = parseRunArgs(process.argv.slice(2));
if ("error" in args) {
  console.error(`run.ts: ${args.error}\nusage: node e2e/run.ts --full | --fast | --layout | --projects <a,b> [-- <playwright args>]`);
  process.exit(2);
}
const { mode, projects, extra } = args;
// The run directory is this invocation's own: a preset one could hold another run's report (task 9 review).
if (process.env.E2E_RUN) {
  console.error(`run.ts: E2E_RUN is set (${process.env.E2E_RUN}); run.ts makes its own run directory. Unset it.`);
  process.exit(2);
}
const full = mode === "full";
const label = mode === "projects" ? `projects-${projects.join("+")}` : mode;
const narrowing = narrowingEnv(process.env);

// What a killed run left behind goes first (plan review, completeness F4).
const reaped = reapStale(tmpdir());
if (reaped.length > 0) console.log(`Stopped ${reaped.length} Worker group(s) an interrupted run left behind: ${reaped.join(", ")}`);

const run = runDir();
runToken();
const nonce = (process.env.E2E_NONCE = randomBytes(16).toString("hex"));
writeFileSync(join(run, "nonce"), nonce);
const p = paths(run);
const cleanAtStart = treeClean(REPO);
const headAtStart = git(REPO, ["rev-parse", "HEAD"]);
const pending = full
  ? pendingOverrides(
      readOverrideLog(REPO, (line) => console.log(`Skipped an unreadable override: ${line}`)),
      readStamps(REPO, (file, why) => console.log(`Skipped an unreadable stamp ${file}: ${why}`)),
    )
  : [];
if (pending.length > 0) {
  console.log(`Deploys that overrode the e2e gate since the last stamp (${pending.length}):`);
  for (const o of pending) console.log(`  ${o.at} ${o.commit.slice(0, 12)}: ${o.reason}`);
}

const started = Date.now();
// --fast is the @fast-tagged tests of their own projects (ruling 1), never a project of its own.
const grep = mode === "fast" ? ["--grep", "@fast"] : [];
// Playwright's own CLI, not npx: a signal goes straight to the process that handles it.
const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
const child = spawn(process.execPath, [cli, "test", "--config", "e2e/playwright.config.ts", ...projects.flatMap((x) => ["--project", x]), ...grep, ...extra], {
  cwd: WEB, stdio: "inherit", env: process.env, detached: true,
});
let signalled: NodeJS.Signals | null = null;
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    signalled ??= sig;
    try {
      child.kill(sig);
    } catch {
      // Already gone.
    }
  });
}
const exitStatus = await new Promise<number | null>((resolve) => {
  child.once("error", (error) => {
    console.error(`playwright didn't start: ${error.message}`);
    resolve(null);
  });
  child.once("exit", (status) => resolve(status));
});
const wall_ms = Date.now() - started;

const survivors = reapRun(run);
if (survivors.length > 0) console.log(`Stopped ${survivors.length} Worker group(s) the run left running: ${survivors.join(", ")}`);

const records = runRecords(run, nonce);
for (const s of records.stale) console.log(`Ignored: ${s}`);
const report = records.report ?? { suites: [] };
const setupLog = join(p.logs, "setup.log");
// What the tree hashes can't vouch for: the installed dependencies and ignored source files (task 9 review).
const installed = installedTree(REPO);
const hidden = ignoredSource(REPO);
const v = verdict({
  outcomes: outcomesOf(report),
  quarantine: QUARANTINE,
  today: householdDate(),
  seededOn: records.seededOn,
  fixedDay: FIXED_DAY,
  errors: errorsOf(report),
  exit: exitStatus,
  interrupted: signalled,
  cleanAtStart,
  cleanAtEnd: treeClean(REPO),
  headMoved: git(REPO, ["rev-parse", "HEAD"]) !== headAtStart,
  passthrough: extra,
  narrowing,
  drift: [...installed.problems, ...(hidden.length > 0 ? [`ignored source files under app/: ${hidden.join(", ")}`] : [])],
  full,
  projects,
});

const minutes = workerMinutes(report);

for (const q of v.quarantined) console.log(`quarantined (${q.status}): ${q.project} › ${q.title}`);
for (const problem of v.problems) console.log(`problem: ${problem}`);
for (const f of v.blocking) console.log(`failed: ${f.project} › ${f.title}`);
for (const f of v.flaky) console.log(`flaky: ${f.project} › ${f.title}`);
if (v.problems.includes("the seed or global setup failed")) console.log(`The seed or global setup failed: see ${setupLog}`);

let stamp: string | null = null;
if (v.stampable) {
  // The log is read again as the stamp is written, and the stamp records how
  // much of it was read: an override a deploy appended during this run is
  // recorded here, or listed by the next run, never lost (task 10).
  const { overrides, read } = overridesForStamp(REPO);
  for (const o of overrides.filter((o) => !pending.some((q) => q.commit === o.commit && q.at === o.at && q.reason === o.reason))) {
    console.log(`An override was recorded during the run: ${o.at} ${o.commit.slice(0, 12)}: ${o.reason}`);
  }
  stamp = writeStamp(REPO, { commit: headAtStart, at: isoTime(), trees: treesAt(REPO, headAtStart), installed: installed.hash, ...versions(), counts: { ...v.counts, ...Object.fromEntries(Object.entries(minutes).map(([p, m]) => [`worker_minutes_${p}`, m])) }, wall_ms, overrides, overridesRead: read });
  console.log(`Stamp written: ${stamp}`);
} else if (full && v.pass) {
  console.log(`No stamp: ${v.noStamp.join("; ")}.`);
}

const exit = signalled ? 128 + constants.signals[signalled] : v.pass ? 0 : 1;
const keep = signalled !== null || !v.green;
const summary = {
  mode: label,
  projects,
  at: isoTime(),
  commit: headAtStart,
  exit,
  playwright_exit: exitStatus,
  pass: v.pass,
  green: v.green,
  stamp,
  counts: v.counts,
  wall_ms,
  worker_minutes: minutes,
  setup_ms: existsSync(setupLog) ? setupTimings(readFileSync(setupLog, "utf8")) : {},
  problems: v.problems,
  failed: v.blocking.map((o) => `${o.project} › ${o.title}`),
  flaky: v.flaky.map((o) => `${o.project} › ${o.title}`),
  quarantined: v.quarantined.map((o) => `${o.project} › ${o.title} (${o.status})`),
  skipped: outcomesOf(report).filter((o) => o.status === "skipped").map((o) => `${o.project} › ${o.title}`),
  noStamp: v.noStamp,
  findings: existsSync(p.findings) ? (JSON.parse(readFileSync(p.findings, "utf8")) as unknown) : null,
  run: keep ? run : null,
};
writeFileSync(join(run, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
const last = join(tmpdir(), "myfitnessguide-e2e-last");
mkdirSync(last, { recursive: true });
copyFileSync(join(run, "summary.json"), join(last, `${label}.json`));

if (keep) console.log(`Kept the run directory, with traces, slot logs and findings: ${run}`);
else rmSync(run, { recursive: true, force: true });
console.log(`Summary: ${join(last, `${label}.json`)}`);
for (const [project, m] of Object.entries(minutes)) console.log(`  ${project}: ${m} worker-minutes`);
const c = v.counts;
console.log(`${mode}: ${c.passed} passed, ${c.failed} failed, ${c.flaky} flaky, ${c.quarantined} quarantined; wall ${Math.round(wall_ms / 1000)} s`);
process.exit(exit);
