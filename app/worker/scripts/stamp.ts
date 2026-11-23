/**
 * The deploy stamp (e2e spec §9): written by a full run that passed with
 * nothing flaky (a quarantined test's failure or flake included) on a tree
 * clean at its start and end, into
 * $(git rev-parse --git-common-dir)/e2e-pass/<HEAD>.json, shared by every
 * worktree and never committed. The deploy gate (Task 10) accepts a stamp
 * whose tree hashes of app/, package.json and package-lock.json equal HEAD's,
 * so a docs-only commit after a pass needs no re-run. Overrides are appended
 * to overrides.jsonl beside the stamps. Exported as @myfitnessguide/worker/stamp:
 * the web runner writes stamps and the gate reads them through this one
 * definition.
 *
 * What the trees can't see (task 9 review): the installed dependency tree is
 * hashed into the stamp and must agree with package-lock.json, and a
 * source-like file under app/ that an ignore hides (a global excludesFile
 * included) refuses the stamp. app/worker/.dev.vars is out of scope: `wrangler
 * deploy` never reads it, and the suite's Workers get their vars by --var.
 * Every time this module writes or compares is isoTime's format.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

export interface Trees {
  app: string;
  packageJson: string;
  packageLock: string;
}

export interface Override {
  commit: string;
  reason: string;
  at: string;
  /** The deploy gate's: the tree had uncommitted or untracked changes, so `trees` (not HEAD's) is what shipped. */
  dirty?: boolean;
  /** The deploy gate's: the working tree's trees (workingTrees) when it deployed. */
  trees?: Trees;
}

export interface Stamp {
  commit: string;
  at: string;
  trees: Trees;
  /**
   * sha256 of node_modules/.package-lock.json: the dependency tree the run used
   * (installedTree). Informational only: the gate never compares it; installed
   * equals locked (installedTree().problems) plus the lock's tree hash covers it.
   */
  installed: string;
  playwright: string;
  chromium: string;
  counts: Record<string, number>;
  wall_ms: number;
  overrides: Override[];
  /**
   * How many bytes of overrides.jsonl the run had read when it stamped
   * (overridesForStamp). Every override in them is recorded here or by an
   * earlier stamp; the next run lists only what lies beyond.
   */
  overridesRead?: number;
}

/**
 * The one time format for stamps and overrides: UTC ISO 8601 with milliseconds
 * (`Date.prototype.toISOString`). Task 10's override writer uses it too, so
 * overridesSince's comparison holds. An unreadable time throws.
 */
export function isoTime(at: Date | string = new Date()): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) throw new Error(`not a time: ${String(at)}`);
  return d.toISOString();
}

export function git(repo: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr ?? "").trim()}`);
  return r.stdout.trim();
}

/** Nothing modified, staged or untracked anywhere in the repository. */
export function treeClean(repo: string): boolean {
  return git(repo, ["status", "--porcelain", "--untracked-files=all"]) === "";
}

/**
 * The trees of what is in the working tree now, tracked changes and untracked
 * files included (ignored files excluded: ignoredSource covers those), read
 * through a copy of the index so the repository's own index is never touched.
 * Equal to treesAt(HEAD) when the tree is clean.
 */
export function workingTrees(repo: string): Trees {
  const temp = mkdtempSync(join(tmpdir(), "gym-index-"));
  try {
    const index = join(temp, "index");
    const real = resolve(repo, git(repo, ["rev-parse", "--git-path", "index"]));
    if (existsSync(real)) copyFileSync(real, index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const run = (args: string[]) => {
      const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr ?? "").trim()}`);
      return r.stdout.trim();
    };
    run(["add", "-A", "--", "."]);
    const tree = run(["write-tree"]);
    return treesAt(repo, tree);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function treesAt(repo: string, rev = "HEAD"): Trees {
  return {
    app: git(repo, ["rev-parse", `${rev}:app`]),
    packageJson: git(repo, ["rev-parse", `${rev}:package.json`]),
    packageLock: git(repo, ["rev-parse", `${rev}:package-lock.json`]),
  };
}

export function stampDir(repo: string): string {
  return join(resolve(repo, git(repo, ["rev-parse", "--git-common-dir"])), "e2e-pass");
}

/** Written to a temporary file and renamed, so a reader in another worktree never sees half a stamp. */
export function writeStamp(repo: string, stamp: Stamp): string {
  const dir = stampDir(repo);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${stamp.commit}.json`);
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(stamp, null, 2)}\n`);
  renameSync(temp, file);
  return file;
}

/** A time Date.parse reads: a stamp or override with any other `at` is unreadable, so overridesSince never compares NaN. */
const isTime = (at: unknown): at is string => typeof at === "string" && !Number.isNaN(Date.parse(at));

const isStamp = (x: unknown): x is Stamp => {
  const s = x as Partial<Stamp> | null;
  return typeof s?.commit === "string" && isTime(s.at) && typeof s.trees?.app === "string" && typeof s.trees.packageJson === "string" && typeof s.trees.packageLock === "string";
};

/** Every readable stamp; a file that isn't one is passed to `bad` and skipped, never thrown. */
export function readStamps(repo: string, bad: (file: string, why: string) => void = () => {}): Stamp[] {
  const dir = stampDir(repo);
  if (!existsSync(dir)) return [];
  const out: Stamp[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (isStamp(parsed)) out.push(parsed);
      else bad(f, "not a stamp");
    } catch (error) {
      bad(f, (error as Error).message);
    }
  }
  return out;
}

const sameTrees = (a: Trees, b: Trees) => a.app === b.app && a.packageJson === b.packageJson && a.packageLock === b.packageLock;

export function matchingStamp(stamps: readonly Stamp[], trees: Trees): Stamp | null {
  return stamps.find((s) => sameTrees(s.trees, trees)) ?? null;
}

const overridesFile = (repo: string) => join(stampDir(repo), "overrides.jsonl");

/** The override log as read: each readable entry with the byte offset where its line ends, and the bytes read. */
export interface OverrideLog {
  entries: { override: Override; end: number }[];
  size: number;
}

/** The log, read once; a line that isn't an override is passed to `bad` and skipped. Only whole lines count. */
export function readOverrideLog(repo: string, bad: (line: string) => void = () => {}): OverrideLog {
  const file = overridesFile(repo);
  if (!existsSync(file)) return { entries: [], size: 0 };
  const bytes = readFileSync(file);
  const entries: OverrideLog["entries"] = [];
  let start = 0;
  for (let nl = bytes.indexOf(10, start); nl !== -1; start = nl + 1, nl = bytes.indexOf(10, start)) {
    const line = bytes.subarray(start, nl).toString("utf8");
    if (line === "") continue;
    try {
      const o = JSON.parse(line) as Partial<Override>;
      if (typeof o.commit === "string" && typeof o.reason === "string" && isTime(o.at)) entries.push({ override: o as Override, end: nl + 1 });
      else bad(line);
    } catch {
      bad(line);
    }
  }
  // A last line without its newline is still being written: it is read next time.
  return { entries, size: start };
}

/** Every readable override; a line that isn't one is passed to `bad` and skipped. */
export function readOverrides(repo: string, bad: (line: string) => void = () => {}): Override[] {
  return readOverrideLog(repo, bad).entries.map((e) => e.override);
}

export function appendOverride(repo: string, o: Override): void {
  mkdirSync(stampDir(repo), { recursive: true });
  appendFileSync(overridesFile(repo), `${JSON.stringify(o)}\n`);
}

/** The overrides since the latest stamp, by time: the rule for stamps that don't record how much of the log they read. */
export function overridesSince(overrides: readonly Override[], stamps: readonly Stamp[]): Override[] {
  const last = Math.max(-Infinity, ...stamps.map((s) => Date.parse(s.at)));
  return overrides.filter((o) => Date.parse(o.at) > last);
}

/**
 * The overrides no stamp has seen: those past the most of the log any stamp
 * read (`overridesRead`). By position, not time, so an override a deploy
 * appended while a run was stamping (its `at` earlier than the stamp's) is
 * still listed next time, never lost. A log shorter than a stamp read was
 * replaced: everything in it is listed. Without any `overridesRead`, by time.
 */
export function pendingOverrides(log: OverrideLog, stamps: readonly Stamp[]): Override[] {
  const read = stamps.map((s) => s.overridesRead).filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  if (read.length === 0) return overridesSince(log.entries.map((e) => e.override), stamps);
  const seen = Math.max(...read);
  return log.entries.filter((e) => log.size < seen || e.end > seen).map((e) => e.override);
}

/** What a stamping run records (run.ts): the overrides pending now, and how much of the log it read. */
export function overridesForStamp(repo: string, bad: (line: string) => void = () => {}): { overrides: Override[]; read: number } {
  const log = readOverrideLog(repo, bad);
  return { overrides: pendingOverrides(log, readStamps(repo)), read: log.size };
}

interface LockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  optional?: boolean;
}

/**
 * The installed dependency tree: sha256 of node_modules/.package-lock.json
 * (npm's record of what it installed), and every way it disagrees with
 * package-lock.json (a lockfile changed by a checkout without `npm install`).
 * An optional package that isn't installed (another platform's) is fine.
 */
export function installedTree(repo: string): { hash: string; problems: string[] } {
  const hiddenFile = join(repo, "node_modules", ".package-lock.json");
  if (!existsSync(hiddenFile)) return { hash: "", problems: ["node_modules/.package-lock.json is missing: run npm install"] };
  const text = readFileSync(hiddenFile, "utf8");
  const hash = createHash("sha256").update(text).digest("hex");
  const locked = (JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8")) as { packages?: Record<string, LockEntry> }).packages ?? {};
  const installed = (JSON.parse(text) as { packages?: Record<string, LockEntry> }).packages ?? {};
  const problems: string[] = [];
  const say = (what: string) => problems.push(`node_modules doesn't match package-lock.json: ${what}`);
  for (const [name, entry] of Object.entries(installed)) {
    const lock = locked[name];
    if (!lock) say(`${name} is installed but not locked`);
    else if (lock.version !== entry.version || lock.integrity !== entry.integrity || lock.resolved !== entry.resolved) say(`${name} is ${entry.version ?? entry.resolved} installed, ${lock.version ?? lock.resolved} locked`);
  }
  for (const [name, lock] of Object.entries(locked)) {
    if (name !== "" && !lock.optional && !(name in installed)) say(`${name} is locked but not installed`);
  }
  return { hash, problems };
}

/** Where an ignored file may live: what the build, the installs and wrangler make. */
const IGNORED_OK = new Set(["node_modules", "dist", ".wrangler"]);
const SOURCE_LIKE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|css|html|sql|json|jsonc)$/;
/**
 * Local-only deployment configs, gitignored by design so identifiers stay off
 * the remote (ACCESS.md, "Local configuration"). The deploy gate reads and
 * validates them itself (check 2), so they are not the hidden source this
 * walks for.
 */
const IGNORED_CONFIG = new Set(["app/worker/wrangler.jsonc"]);

/**
 * Source-like files under app/ that an ignore hides (.gitignore, info/exclude
 * or a global core.excludesFile), outside node_modules, dist and .wrangler:
 * code the suite may have run that no tree hash covers. Sorted paths from the
 * repository's root.
 */
export function ignoredSource(repo: string): string[] {
  const out: string[] = [];
  const allowed = (path: string) => path.split("/").some((part) => IGNORED_OK.has(part));
  const walk = (path: string) => {
    if (allowed(path)) return;
    const abs = join(repo, path);
    if (statSync(abs).isDirectory()) {
      for (const child of readdirSync(abs)) walk(`${path.replace(/\/$/, "")}/${child}`);
    } else if (SOURCE_LIKE.test(path) && !IGNORED_CONFIG.has(relative(repo, abs))) {
      out.push(relative(repo, abs));
    }
  };
  // -z: NUL-separated and never C-quoted, so a path with a space, a quote or non-ASCII reads as it is.
  const listed = git(repo, ["status", "--porcelain", "-z", "--ignored=matching", "--untracked-files=all", "--", "app"]);
  for (const entry of listed.split("\0")) if (entry.startsWith("!! ")) walk(entry.slice(3));
  return out.sort();
}
