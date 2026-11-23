import { describe, expect, it, onTestFinished } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeQuarantine, errorsOf, narrowingEnv, outcomesOf, quarantineProblems, setupTimings, verdict, workerMinutes, type Outcome, type QuarantineEntry } from "../e2e/support/verdict";
import { paths, runRecords, versions } from "../e2e/support/run";

const ok = (project: string, title: string): Outcome => ({ project, title, status: "expected" });
const base = {
  quarantine: [] as QuarantineEntry[],
  today: "2026-10-08",
  seededOn: "2026-10-07",
  fixedDay: "2026-10-07",
  errors: [] as string[],
  exit: 0 as number | null,
  interrupted: null as string | null,
  cleanAtStart: true,
  cleanAtEnd: true,
  headMoved: false,
  passthrough: [] as string[],
  narrowing: [] as string[],
  drift: [] as string[],
  full: true,
  projects: ["journeys", "privacy"],
};
const outcomes = [ok("journeys", "J1"), ok("privacy", "P1")];

describe("the verdict (e2e spec §9, §11)", () => {
  it("all passed on a clean tree: pass, green and a stamp", () => {
    const v = verdict({ ...base, outcomes });
    expect([v.pass, v.green, v.stampable]).toEqual([true, true, true]);
    expect(v.counts).toEqual({ passed: 2, failed: 0, flaky: 0, skipped: 0, quarantined: 0 });
  });

  it("a failure fails the run", () => {
    const v = verdict({ ...base, exit: 1, outcomes: [...outcomes, { project: "journeys", title: "J2", status: "unexpected" }] });
    expect([v.pass, v.green, v.stampable]).toEqual([false, false, false]);
    expect(v.blocking.map((o) => o.title)).toEqual(["J2"]);
  });

  it("a flaky result passes but is not green and earns no stamp", () => {
    const v = verdict({ ...base, outcomes: [...outcomes, { project: "journeys", title: "J3", status: "flaky" }] });
    expect([v.pass, v.green, v.stampable]).toEqual([true, false, false]);
    expect(v.noStamp).toContain("1 flaky");
  });

  it("a quarantined failure reports but doesn't block, for 7 days, and earns no stamp; then it blocks again", () => {
    const q: QuarantineEntry = { project: "journeys", title: "J2", since: "2026-10-03", reason: "flaked twice: the pot card's settle" };
    const failing = [...outcomes, { project: "journeys", title: "J2", status: "unexpected" as const }];
    const v = verdict({ ...base, exit: 1, quarantine: [q], outcomes: failing });
    // Quarantine relaxes the pass only: the stamp needs every test passed the first time (spec §9, §11; F7).
    expect([v.pass, v.green, v.stampable, v.counts.quarantined]).toEqual([true, false, false, 1]);
    expect(v.noStamp).toContain("1 quarantined test failed or flaked");
    const flaked = verdict({ ...base, quarantine: [q], outcomes: [...outcomes, { project: "journeys", title: "J2", status: "flaky" }] });
    expect([flaked.pass, flaked.green, flaked.stampable]).toEqual([true, false, false]);
    const held = verdict({ ...base, quarantine: [q], outcomes: [...outcomes, ok("journeys", "J2")] });
    expect([held.green, held.stampable]).toEqual([true, true]);
    // The 7 days count on the wall calendar (today), never the household's fixed day.
    const later = verdict({ ...base, exit: 1, today: "2026-10-11", quarantine: [q], outcomes: failing });
    expect(later.pass).toBe(false);
    expect(activeQuarantine([q], "2026-10-10")).toEqual([q]);
    expect(activeQuarantine([q], "2026-10-11")).toEqual([]);
  });

  it("the list holds at most 3 entries, each with a reason, and never a privacy test", () => {
    const e = (title: string, project = "journeys", reason = "flaked twice"): QuarantineEntry => ({ project, title, since: "2026-10-07", reason });
    expect(quarantineProblems([e("a"), e("b"), e("c")])).toEqual([]);
    expect(quarantineProblems([e("a"), e("b"), e("c"), e("d")])).toEqual(["the quarantine holds 4 entries; at most 3"]);
    expect(quarantineProblems([e("p", "privacy")])).toEqual(["p: privacy tests are never quarantined"]);
    expect(quarantineProblems([e("r", "journeys", " ")])).toEqual(["r: a quarantine entry needs a reason"]);
    expect(verdict({ ...base, quarantine: [e("p", "privacy")], outcomes }).pass).toBe(false);
  });

  it("the household's date is fixed: a seed on any other date fails the run (a guard, not a void run)", () => {
    const v = verdict({ ...base, seededOn: "2026-10-09", outcomes });
    expect([v.pass, v.stampable]).toEqual([false, false]);
    expect(v.problems).toEqual(["the seed ran on 2026-10-09, not the fixed 2026-10-07: it wasn't on the fixed clock"]);
    expect("void" in v).toBe(false);
  });

  it("a run whose seed or global setup failed (no seeded date) fails", () => {
    const v = verdict({ ...base, exit: 1, seededOn: "", outcomes: [], errors: ["Error: the seed failed; see setup.log"] });
    expect(v.pass).toBe(false);
    expect(v.problems).toContain("the seed or global setup failed");
  });

  it("an error outside any test (a spec that didn't load, a worker that died) fails the run", () => {
    const v = verdict({ ...base, exit: 1, errors: ["SyntaxError: Unexpected token"], outcomes });
    expect(v.pass).toBe(false);
    expect(v.problems).toEqual(["outside any test: SyntaxError: Unexpected token"]);
  });

  it("a tree dirty at the start or the end earns no stamp, but the run is still green", () => {
    expect(verdict({ ...base, cleanAtStart: false, outcomes }).stampable).toBe(false);
    const v = verdict({ ...base, cleanAtEnd: false, outcomes });
    expect(v.noStamp).toContain("the tree changed during the run");
    expect(v.green).toBe(true);
  });

  it("Playwright's exit status is honoured: a non-zero exit with no failure in the report fails the run", () => {
    const v = verdict({ ...base, exit: 1, outcomes });
    expect([v.pass, v.stampable]).toEqual([false, false]);
    expect(v.problems).toEqual(["Playwright exited 1, but its report shows no failure"]);
    expect(verdict({ ...base, exit: null, outcomes }).problems).toEqual(["Playwright didn't run to its end (no exit status)"]);
  });

  it("an interrupted run fails and earns no stamp, whatever its report says", () => {
    const v = verdict({ ...base, exit: 130, interrupted: "SIGINT", outcomes });
    expect([v.pass, v.green, v.stampable]).toEqual([false, false, false]);
    expect(v.problems).toEqual(["interrupted (SIGINT)"]);
  });

  it("a full run narrowed by Playwright arguments or by the environment earns no stamp, though it may pass", () => {
    const passed = verdict({ ...base, passthrough: ["--grep", "J1"], outcomes });
    expect([passed.pass, passed.stampable]).toEqual([true, false]);
    expect(passed.noStamp).toEqual(["Playwright arguments were passed through: --grep J1"]);
    const narrowed = verdict({ ...base, narrowing: ["E2E_WIDTHS=390"], outcomes });
    expect([narrowed.pass, narrowed.green, narrowed.stampable]).toEqual([true, true, false]);
    expect(narrowed.noStamp).toEqual(["the environment narrows or changes the run: E2E_WIDTHS=390"]);
  });

  it("HEAD moving during the run, or an install or ignored file the trees don't hold, earns no stamp", () => {
    expect(verdict({ ...base, headMoved: true, outcomes }).noStamp).toEqual(["HEAD moved during the run"]);
    const drift = verdict({ ...base, drift: ["node_modules doesn't match package-lock.json: vite 8.3.2 installed, 8.3.3 locked"], outcomes });
    expect([drift.pass, drift.stampable]).toEqual([true, false]);
    expect(drift.noStamp).toEqual(["node_modules doesn't match package-lock.json: vite 8.3.2 installed, 8.3.3 locked"]);
  });

  it("a project whose every test was skipped did not run: a full run fails and earns no stamp", () => {
    const v = verdict({ ...base, outcomes: [ok("journeys", "J1"), { project: "privacy", title: "P1", status: "skipped" }] });
    expect([v.pass, v.stampable]).toEqual([false, false]);
    expect(v.problems).toEqual(["privacy ran no tests (every one skipped or none)"]);
    expect(v.counts.skipped).toBe(1);
  });

  it("narrowingEnv names every E2E_ variable that changes what runs, but not the run's own or the worker count", () => {
    expect(narrowingEnv({ E2E_WIDTHS: "390", E2E_THEMES: "light", E2E_PHONE_STRICT: "1", E2E_FUTURE: "x", E2E_WORKERS: "2", E2E_RUN: "/tmp/r", E2E_TOKEN: "t", E2E_NONCE: "n", E2E_EMPTY: "", PATH: "/bin" }))
      .toEqual(["E2E_FUTURE=x", "E2E_PHONE_STRICT=1", "E2E_THEMES=light", "E2E_WIDTHS=390"]);
  });

  it("narrowingEnv names Playwright's own variables too, but not the browser paths or PWD (final review M3)", () => {
    expect(narrowingEnv({ PWDEBUG: "1", PW_TEST_X: "y", PWTEST_Z: "1", PLAYWRIGHT_HTML_OPEN: "never", PLAYWRIGHT_BROWSERS_PATH: "/b", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1", PLAYWRIGHT_DOWNLOAD_HOST: "h", PWD: "/repo" }))
      .toEqual(["PLAYWRIGHT_HTML_OPEN=never", "PWDEBUG=1", "PWTEST_Z=1", "PW_TEST_X=y"]);
  });

  it("only a full run earns a stamp", () => {
    expect(verdict({ ...base, full: false, outcomes }).stampable).toBe(false);
  });

  it("a full run missing a project fails", () => {
    const v = verdict({ ...base, outcomes: [ok("journeys", "J1")] });
    expect(v.pass).toBe(false);
    expect(v.problems).toEqual(["privacy ran no tests (every one skipped or none)"]);
  });

  it("outcomesOf reads Playwright's JSON report, nested suites and all; errorsOf its top-level errors", () => {
    const report = {
      suites: [{
        title: "privacy.spec.ts",
        specs: [],
        suites: [{ title: "Asha sees Kabir", specs: [{ title: "pills at 390", tests: [{ projectName: "privacy", status: "expected" }] }], suites: [] }],
      }],
      errors: [{ message: "Error: worker died\n    at x" }],
    };
    expect(outcomesOf(report)).toEqual([{ project: "privacy", title: "privacy.spec.ts › Asha sees Kabir › pills at 390", status: "expected" }]);
    expect(errorsOf(report)).toEqual(["Error: worker died"]);
    expect(errorsOf({ suites: [] })).toEqual([]);
  });

  it("setupTimings reads each global-setup step's time from setup.log", () => {
    const log = "vite output\n[global-setup] vite build: done in 4123 ms\nseed output\n[global-setup] the seed: done in 61000 ms\n";
    expect(setupTimings(log)).toEqual({ "vite build": 4123, "the seed": 61000 });
    expect(setupTimings("[global-setup] the seed: failed (exit 1) in 900 ms\n")).toEqual({ "the seed": 900 });
  });
});

describe("this run's records (task 9 review)", () => {
  it("reads report.json and seeded-on only when this invocation's nonce is on them; a stale report is no report", () => {
    const run = mkdtempSync(join(tmpdir(), "gym-e2e-records-"));
    onTestFinished(() => rmSync(run, { recursive: true, force: true }));
    const p = paths(run);
    expect(runRecords(run, "mine")).toEqual({ report: null, seededOn: "", stale: [] });
    writeFileSync(p.report, JSON.stringify({ config: { metadata: { nonce: "earlier" } }, suites: [{ title: "x", specs: [] }] }));
    writeFileSync(p.seededOn, "2026-10-07\n");
    writeFileSync(p.setupNonce, "earlier");
    expect(runRecords(run, "mine")).toEqual({
      report: null,
      seededOn: "",
      stale: ["report.json is not this run's (nonce earlier)", "seeded-on is not this run's (nonce earlier)"],
    });
    writeFileSync(p.report, JSON.stringify({ config: { metadata: { nonce: "mine" } }, suites: [] }));
    writeFileSync(p.setupNonce, "mine");
    expect(runRecords(run, "mine")).toEqual({ report: { config: { metadata: { nonce: "mine" } }, suites: [] }, seededOn: "2026-10-07", stale: [] });
  });
});

describe("the versions a stamp records", () => {
  it("names the installed Playwright and its Chromium", () => {
    const v = versions();
    expect(v.playwright).toBe("1.64.0");
    expect(v.chromium).toMatch(/^\d+\.\d+/);
  });
});

describe("worker-minutes per project (e2e spec §10)", () => {
  it("sums every result's duration, retries included, per project", () => {
    const report = {
      suites: [{
        title: "a.spec.ts",
        specs: [
          { title: "x", tests: [{ projectName: "journeys", status: "expected", results: [{ duration: 30_000 }] }] },
          { title: "y", tests: [{ projectName: "journeys", status: "flaky", results: [{ duration: 15_000 }, { duration: 15_000 }] }] },
        ],
        suites: [{ title: "p", specs: [{ title: "z", tests: [{ projectName: "privacy", status: "expected", results: [{ duration: 90_000 }] }] }] }],
      }],
    };
    expect(workerMinutes(report)).toEqual({ journeys: 1, privacy: 1.5 });
  });
});
