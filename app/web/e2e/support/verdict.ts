/**
 * What a run means (e2e spec §9, §11), from Playwright's JSON report: an
 * unquarantined failure fails it; a quarantined test reports but doesn't
 * block, for 7 days, though its failure or flake still denies the stamp
 * (quarantine relaxes the pass only, F7); any flaky result denies the stamp
 * and keeps the run directory; a run whose seed or global setup failed fails.
 *
 * The household's date is fixed (worker decision 162; scripts/test-clock.ts),
 * so it can't change during a run and no run is void: the spec's void rule is
 * a guard here. A seed that reports any date but the fixed one fails the run.
 */
export interface Outcome {
  project: string;
  title: string;
  status: "expected" | "unexpected" | "flaky" | "skipped";
}

export interface QuarantineEntry {
  project: string;
  /** The full title as outcomesOf gives it: "<file> › <describe> › <test>". */
  title: string;
  /** YYYY-MM-DD on the wall calendar: the entry holds for 7 days from here. */
  since: string;
  reason: string;
}

export interface Verdict {
  /** Nothing unquarantined failed, every check held and tests ran: exit 0. */
  pass: boolean;
  /** Passed with nothing flaky and no quarantined test failing or flaking: the run directory may go. */
  green: boolean;
  /** A full run that may write the deploy stamp. */
  stampable: boolean;
  counts: { passed: number; failed: number; flaky: number; skipped: number; quarantined: number };
  blocking: Outcome[];
  flaky: Outcome[];
  quarantined: Outcome[];
  problems: string[];
  /** Why a passing run earns no stamp. */
  noStamp: string[];
}

interface JsonSuite {
  title: string;
  specs?: { title: string; tests: { projectName: string; status: Outcome["status"] }[] }[];
  suites?: JsonSuite[];
}

export function outcomesOf(report: unknown): Outcome[] {
  const out: Outcome[] = [];
  const walk = (suite: JsonSuite, path: string[]) => {
    const here = suite.title ? [...path, suite.title] : path;
    for (const spec of suite.specs ?? []) for (const t of spec.tests) out.push({ project: t.projectName, title: [...here, spec.title].join(" › "), status: t.status });
    for (const s of suite.suites ?? []) walk(s, here);
  };
  for (const s of (report as { suites?: JsonSuite[] }).suites ?? []) walk(s, []);
  return out;
}

/** The report's errors outside any test (a spec that didn't load, global setup, a worker that died), first line each. */
export function errorsOf(report: unknown): string[] {
  return ((report as { errors?: { message?: string }[] }).errors ?? []).map((e) => (e.message ?? "unknown error").split("\n")[0]!);
}

/** Each global-setup step's time, from the `[global-setup] <step>: … in <n> ms` lines of setup.log. */
export function setupTimings(log: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of log.matchAll(/^\[global-setup\] (.+?): .* in (\d+) ms$/gm)) out[m[1]!] = Number(m[2]);
  return out;
}

const DAY = 86_400_000;
const days = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY;

/** The entries still holding: at most 7 days old by the wall calendar, never a privacy test. */
export function activeQuarantine(list: readonly QuarantineEntry[], today: string): QuarantineEntry[] {
  return list.filter((q) => q.project !== "privacy" && days(q.since, today) <= 7);
}

export function quarantineProblems(list: readonly QuarantineEntry[]): string[] {
  const problems: string[] = [];
  if (list.length > 3) problems.push(`the quarantine holds ${list.length} entries; at most 3`);
  for (const q of list) {
    if (q.project === "privacy") problems.push(`${q.title}: privacy tests are never quarantined`);
    else if (!q.reason.trim()) problems.push(`${q.title}: a quarantine entry needs a reason`);
  }
  return problems;
}

/** E2E_ variables a run sets for itself, or that change only how many workers run: never a narrowing. */
const OWN_ENV = new Set(["E2E_RUN", "E2E_TOKEN", "E2E_NONCE", "E2E_WORKERS"]);

/** Playwright variables that only say where its browsers live or come from: never a narrowing. */
const BROWSER_PATH_ENV = new Set(["PLAYWRIGHT_BROWSERS_PATH", "PLAYWRIGHT_DOWNLOAD_HOST", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"]);

/** Playwright's own variables, which can change a run too (PWDEBUG: headed, no timeouts). */
const isPlaywrightEnv = (k: string): boolean =>
  k === "PWDEBUG" || ((k.startsWith("PW_") || k.startsWith("PWTEST_") || k.startsWith("PLAYWRIGHT_")) && !BROWSER_PATH_ENV.has(k));

/**
 * Every set E2E_ variable that can change what runs or how it is judged
 * (E2E_WIDTHS, E2E_THEMES, E2E_PHONE_STRICT, E2E_ALLOW, E2E_BASE_WEB and any
 * later one), and every Playwright variable other than the browser paths
 * (PWDEBUG, PW_*, PWTEST_*, PLAYWRIGHT_*; final review M3), as NAME=value,
 * sorted. A full run with any of them earns no stamp.
 */
export function narrowingEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env)
    .filter(([k, v]) => ((k.startsWith("E2E_") && !OWN_ENV.has(k)) || isPlaywrightEnv(k)) && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .sort();
}

/**
 * The run's verdict and the whole stamp decision (task 9 review): `stampable`
 * is the one answer run.ts acts on.
 */
export function verdict(input: {
  outcomes: Outcome[];
  quarantine: readonly QuarantineEntry[];
  /** The wall calendar's date in the household's zone: quarantine's 7 days count on it. */
  today: string;
  /** The date the seed's Worker reported, or "" when the seed or global setup didn't finish. */
  seededOn: string;
  /** The test household's fixed date (scripts/test-clock.ts). */
  fixedDay: string;
  /** The report's errors outside any test (errorsOf). */
  errors: readonly string[];
  /** Playwright's exit status; null when it didn't start or ended by a signal. */
  exit: number | null;
  /** The signal that interrupted run.ts, if one did. */
  interrupted: string | null;
  cleanAtStart: boolean;
  cleanAtEnd: boolean;
  headMoved: boolean;
  /** Playwright arguments passed through after `--`. */
  passthrough: readonly string[];
  /** narrowingEnv(process.env) at the start. */
  narrowing: readonly string[];
  /** What the trees don't cover: installedTree's and ignoredSource's findings, as reasons. */
  drift: readonly string[];
  full: boolean;
  projects: readonly string[];
}): Verdict {
  const active = activeQuarantine(input.quarantine, input.today);
  const held = (o: Outcome) => active.some((q) => q.project === o.project && q.title === o.title);
  const quarantined = input.outcomes.filter(held);
  const rest = input.outcomes.filter((o) => !held(o));
  const blocking = rest.filter((o) => o.status === "unexpected");
  const flaky = rest.filter((o) => o.status === "flaky");
  const heldBad = quarantined.filter((o) => o.status === "unexpected" || o.status === "flaky").length;
  const problems = quarantineProblems(input.quarantine);
  if (input.full) {
    // A project ran only if some test of it ran: all skipped is not run (task 9 review).
    for (const p of input.projects) if (!input.outcomes.some((o) => o.project === p && o.status !== "skipped")) problems.push(`${p} ran no tests (every one skipped or none)`);
  }
  // A setup that never finished is a failure, never a void run (plan review, completeness F3).
  if (input.seededOn === "") problems.push("the seed or global setup failed");
  // The fixed clock means the date can't move mid-run; a seed on another date wasn't on it (Task 7 ruling).
  else if (input.seededOn !== input.fixedDay) problems.push(`the seed ran on ${input.seededOn}, not the fixed ${input.fixedDay}: it wasn't on the fixed clock`);
  for (const e of input.errors) problems.push(`outside any test: ${e}`);
  if (input.interrupted) problems.push(`interrupted (${input.interrupted})`);
  else if (input.exit === null) problems.push("Playwright didn't run to its end (no exit status)");
  else if (input.exit !== 0 && blocking.length === 0 && quarantined.every((o) => o.status !== "unexpected") && input.errors.length === 0) {
    // Playwright's exit is honoured: a failure must show in the report, or the report isn't the whole story.
    problems.push(`Playwright exited ${input.exit}, but its report shows no failure`);
  }
  const pass = input.outcomes.length > 0 && blocking.length === 0 && problems.length === 0;
  const noStamp: string[] = [];
  if (flaky.length > 0) noStamp.push(`${flaky.length} flaky`);
  // Quarantine relaxes the pass, never the stamp: a stamp needs every test passed the first time (spec §9, §11; F7).
  if (heldBad > 0) noStamp.push(`${heldBad} quarantined test${heldBad === 1 ? "" : "s"} failed or flaked`);
  const green = pass && noStamp.length === 0;
  if (!input.cleanAtStart) noStamp.push("the tree was not clean at the start");
  else if (!input.cleanAtEnd) noStamp.push("the tree changed during the run");
  if (input.headMoved) noStamp.push("HEAD moved during the run");
  if (input.passthrough.length > 0) noStamp.push(`Playwright arguments were passed through: ${input.passthrough.join(" ")}`);
  if (input.narrowing.length > 0) noStamp.push(`the environment narrows or changes the run: ${input.narrowing.join(", ")}`);
  noStamp.push(...input.drift);
  return {
    pass,
    green,
    stampable: input.full && pass && noStamp.length === 0,
    counts: {
      passed: rest.filter((o) => o.status === "expected").length,
      failed: blocking.length,
      flaky: flaky.length,
      skipped: rest.filter((o) => o.status === "skipped").length,
      quarantined: quarantined.length,
    },
    blocking,
    flaky,
    quarantined,
    problems,
    noStamp,
  };
}

interface TimedSuite {
  specs?: { tests: { projectName: string; results?: { duration: number }[] }[] }[];
  suites?: TimedSuite[];
}

/** The time spent across all workers, per project, in minutes (wall time is about this divided by the workers). */
export function workerMinutes(report: unknown): Record<string, number> {
  const ms: Record<string, number> = {};
  const walk = (suite: TimedSuite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) ms[t.projectName] = (ms[t.projectName] ?? 0) + (t.results ?? []).reduce((sum, r) => sum + r.duration, 0);
    }
    for (const s of suite.suites ?? []) walk(s);
  };
  for (const s of (report as { suites?: TimedSuite[] }).suites ?? []) walk(s);
  return Object.fromEntries(Object.entries(ms).map(([p, v]) => [p, Math.round((v / 60_000) * 10) / 10]));
}
