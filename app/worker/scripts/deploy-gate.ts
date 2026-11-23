/**
 * The Worker's `deploy` script (e2e spec §9; web decision 120). `npm run
 * deploy` at the repo root and `npm run deploy` in app/worker both run this,
 * once. In order:
 * Branch: the checkout is on `main`, the one always-deployable branch
 *    (CONTRIBUTING.md). No hook sees `npm run deploy`, so the branch rule
 *    lives here; E2E_GATE_OVERRIDE never stands in for it.
 * 1. Arguments: any extra argument is refused (npm appends them to argv).
 * 2. Config and environment: the config `wrangler deploy` would read, through
 *    wrangler's own reader, with every env.* block, is refused if a redirect
 *    (.wrangler/deploy/config.json) is in effect, it names no Worker, any
 *    vars, binding or other field names LOCAL_DEV_IDENTITY,
 *    LOCAL_IDENTITY_TOKEN or LOCAL_FIXED_NOW (worker decisions 161, 162),
 *    keep_vars is true, a `main` isn't src/index.ts, or a binding has
 *    remote: true. A WRANGLER_*, CLOUDFLARE_* or CF_* variable outside
 *    ALLOWED_ENV, in the shell or in an app/worker .env file wrangler loads,
 *    is refused: it could change the Worker, account, API, config or build.
 *    The Worker's name is read here once and passed by --name to every
 *    wrangler call below, so the secrets listed are the deployed Worker's.
 * Build: the web app is built here, from this tree, so a stale app/web/dist
 *    never ships (the root `deploy` no longer builds it).
 * 3. Bundle: `wrangler deploy --dry-run --outdir <tmp>` is refused if it
 *    contains the dev entry's header name in any letter case, or the names
 *    LOCAL_IDENTITY_TOKEN or LOCAL_FIXED_NOW.
 * 4. Secrets: `wrangler secret list` (read-only) is refused if it lists any
 *    of those names.
 * 5. Stamp: the tree is clean, node_modules matches package-lock.json, no
 *    ignore hides source under app/, and a stamp's tree hashes equal HEAD's.
 * 6. Override: E2E_GATE_OVERRIDE="<reason>" stands in for check 5 only; once
 *    check 7 has passed, just before the deploy, it is printed and appended, with whether the tree was dirty and the trees
 *    that ship, to <git common dir>/e2e-pass/overrides.jsonl.
 * 7. Deploy: the working tree's trees, the config and the environment are
 *    read again and must be what was built and checked; then `wrangler
 *    deploy --name <name> --outdir <tmp>`, and the bundle it uploaded is
 *    checked again (a hit says to roll back).
 * What the gate can't close: wrangler re-reads the tree and re-bundles when
 * it deploys. A change between check 7 and that read (about a second) is
 * caught only for the header names, after the upload; the built web assets
 * (app/web/dist, ignored) are not re-checked at all after the build. Deploying the checked
 * bundle itself (`--no-bundle` on the dry run's output) would close it but
 * replaces `main` with a path check 2 never saw and has never been run
 * against this account, so it isn't used.
 * The branch check and checks 1–4 are about what ships and never yield to the
 * override. The manual bypass, `npx wrangler deploy` by hand, skips all of
 * this; it is acceptable only because the header code can't ship (ACCESS.md).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_readRawConfig } from "wrangler";
import { appendOverride, git, ignoredSource, installedTree, isoTime, matchingStamp, readStamps, treeClean, treesAt, workingTrees, type Override, type Stamp, type Trees } from "@myfitnessguide/worker/stamp";

export const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = join(WORKER, "..", "..");
/** The dev entry's variables (worker decisions 161, 162): never shipped as vars, bindings or secrets. */
const NAMES = ["LOCAL_DEV_IDENTITY", "LOCAL_IDENTITY_TOKEN", "LOCAL_FIXED_NOW"] as readonly string[];
const HEADER = /x-local-identity/i;
/** In the bundle: the header in any case, or a dev-only variable `main` never reads. LOCAL_DEV_IDENTITY is `main`'s own (worker decision 156). */
const BUNDLE_NAMES = /LOCAL_IDENTITY_TOKEN|LOCAL_FIXED_NOW/;

/**
 * The WRANGLER_*, CLOUDFLARE_* and CF_* variables the gate lets through, and
 * why. Everything else with those prefixes is refused: among them
 * WRANGLER_CI_OVERRIDE_NAME (renames the deployed Worker but not the one
 * `secret list` reads), CLOUDFLARE_ENV (picks an env), CLOUDFLARE_API_BASE_URL
 * and WRANGLER_API_ENVIRONMENT (another API), and WRANGLER_BUILD_* (another
 * bundle than the dry run's).
 */
export const ALLOWED_ENV: ReadonlyMap<string, string> = new Map([
  ...["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY", "CLOUDFLARE_EMAIL", "CF_EMAIL"].map(
    (n): [string, string] => [n, "sign-in for a non-interactive deploy; it chooses no Worker"],
  ),
  ...["CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID"].map(
    (n): [string, string] => [n, "picks the account when a sign-in reaches several; the secret list and the deploy both read it, so check 4 sees the account the deploy goes to"],
  ),
  ...["WRANGLER_LOG", "WRANGLER_LOG_PATH", "WRANGLER_LOG_SANITIZE", "WRANGLER_SEND_METRICS", "WRANGLER_SEND_ERROR_REPORTS", "WRANGLER_HIDE_BANNER", "WRANGLER_NO_SKILLS_UPDATE_PROMPTS", "WRANGLER_DISABLE_EXPERIMENTAL_WARNING"].map(
    (n): [string, string] => [n, "logging, telemetry and prompts only"],
  ),
]);
const WRANGLER_VAR = /^(WRANGLER|CLOUDFLARE|CF)_/;

export interface Block {
  main?: string;
  name?: string;
  vars?: Record<string, unknown>;
  keep_vars?: boolean;
  d1_databases?: { binding?: string; remote?: boolean; database_id?: string }[];
  env?: Record<string, Block>;
  [key: string]: unknown;
}

export interface WranglerConfig {
  raw: Block;
  /** A .wrangler/deploy/config.json redirect is in effect: `wrangler deploy` would read another file. */
  redirected: boolean;
  path: string;
}

export type Files = { path: string; text: string }[];

/** A WRANGLER_*, CLOUDFLARE_* or CF_* variable and where it is set: "the shell" or an app/worker .env file. */
export interface EnvSetting {
  name: string;
  where: string;
}

/**
 * The config `wrangler deploy` would read in `dir`, through wrangler's own
 * reader (wrangler 4.147.0's `experimental_readRawConfig`, the one
 * `unstable_readConfig` calls), looking for a redirect as the deploy does.
 * No second JSONC parser (plan Revision 2, F4). The reader looks upwards
 * from `dirname(script)`; `wrangler deploy` looks from its working
 * directory, app/worker, so `script` names a file directly in `dir`.
 * An explicit config matches --config for local release validation; omitting
 * it preserves the app deployment gate's default lookup and redirect checks.
 */
export function readWranglerConfig(dir: string = WORKER, config?: string): WranglerConfig {
  const read = experimental_readRawConfig({ script: join(dir, "package.json"), ...(config ? { config: join(dir, config) } : {}) } as Parameters<typeof experimental_readRawConfig>[0], { useRedirectIfAvailable: true });
  return { raw: read.rawConfig as Block, redirected: read.redirected, path: read.configPath ?? "" };
}

export function checkArgs(argv: readonly string[]): string | null {
  return argv.length > 0 ? `extra arguments are refused: ${argv.join(" ")}` : null;
}

/**
 * The branch rule: only a checkout on `main` deploys (CONTRIBUTING.md: `main`
 * is the canonical, always-deployable branch). `""` is a detached HEAD — or a
 * git that could not answer — and refuses too, so the check fails closed.
 */
export function checkBranch(branch: string): string | null {
  if (branch === "main") return null;
  return branch === "" ? "HEAD is detached; check out main to deploy" : `the checkout is on ${branch}, not main; merge your branch, then deploy from main`;
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** The first key or string value anywhere under `x` that is one of NAMES, with its path. */
function nameIn(x: unknown, path: string): [string, string] | null {
  if (typeof x === "string") return NAMES.includes(x) ? [x, path] : null;
  const entries: [string, unknown][] = Array.isArray(x) ? x.map((v, i) => [`[${i}]`, v]) : isRecord(x) ? Object.entries(x).map(([k, v]) => [`.${k}`, v]) : [];
  for (const [step, value] of entries) {
    const key = step.slice(1);
    if (!step.startsWith("[") && NAMES.includes(key)) return [key, `${path}${step}`];
    const hit = nameIn(value, `${path}${step}`);
    if (hit) return hit;
  }
  return null;
}

export function checkConfig(c: WranglerConfig, expectedMain: "src/index.ts" | "src/oauth-entry.ts" = "src/index.ts"): string | null {
  if (c.redirected) return `a redirected config (.wrangler/deploy/config.json → ${c.path}) is in effect; delete .wrangler/deploy and deploy from wrangler.jsonc`;
  const config = c.raw;
  if (config.main !== expectedMain) return `top level main is ${String(config.main)}, not ${expectedMain}`;
  if (typeof config.name !== "string" || config.name === "") return "the config names no Worker (name)";
  const blocks: [string, Block][] = [["top level", config], ...Object.entries(config.env ?? {}).map(([name, b]): [string, Block] => [`env.${name}`, b])];
  for (const [where, block] of blocks) {
    for (const name of NAMES) if (isRecord(block.vars) && Object.hasOwn(block.vars, name)) return `${where} vars set ${name}`;
    if (block.main !== undefined && block.main !== expectedMain) return `${where} main is ${String(block.main)}, not ${expectedMain}`;
    if (block.keep_vars === true) return `${where} sets keep_vars: true, so vars set on the dashboard would survive the deploy unchecked`;
    // Any binding list (d1_databases, kv_namespaces, r2_buckets, services …) with remote: true.
    for (const [key, list] of Object.entries(block)) {
      if (!Array.isArray(list)) continue;
      for (const d of list) {
        if (!isRecord(d) || d.remote !== true) continue;
        const name = typeof d.binding === "string" ? d.binding : "?";
        return key === "d1_databases" ? `${where} D1 binding ${name} has remote: true` : `${where} ${key} binding ${name} has remote: true`;
      }
    }
    // A binding of any kind (unsafe.bindings included), a secret list or any other field named after one.
    const { env: _env, ...rest } = block;
    const hit = nameIn(rest, "");
    if (hit) return `${where} names ${hit[0]} at ${hit[1].replace(/^\./, "")}`;
  }
  return null;
}

/** The WRANGLER_*, CLOUDFLARE_* and CF_* variables set in `env` and in the .env files wrangler would load from `dir`. */
export function envSettings(env: Readonly<Record<string, string | undefined>>, dir: string = WORKER): EnvSetting[] {
  const out: EnvSetting[] = Object.keys(env)
    .filter((n) => WRANGLER_VAR.test(n) && env[n] !== undefined)
    .sort()
    .map((name) => ({ name, where: "the shell" }));
  // wrangler loads .env and .env.local (and .env.<env> with an env) from its working directory into its own environment.
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f === ".env" || f.startsWith(".env.")).sort() : [];
  for (const file of files) {
    const path = join(dir, file);
    if (!statSync(path).isFile()) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      // dotenv's key: [\w.-]+ before `=` or `: `. A continuation line that looks like one is refused too (fails closed).
      const m = /^\s*(?:export\s+)?([\w.-]+)\s*(?:=|:\s)/.exec(line);
      if (m && WRANGLER_VAR.test(m[1] as string)) out.push({ name: m[1] as string, where: `app/worker/${file}` });
    }
  }
  return out;
}

export function checkEnv(settings: readonly EnvSetting[]): string | null {
  const hit = settings.find((s) => !ALLOWED_ENV.has(s.name));
  return hit ? `${hit.where} sets ${hit.name}, which can change the Worker, account, API, config or build wrangler uses; unset it and deploy again` : null;
}

export function checkBundle(files: Files): string | null {
  if (files.length === 0) return "the dry run wrote no bundle";
  const header = files.find((f) => HEADER.test(f.text));
  if (header) return `the bundle names the dev entry's header (${header.path})`;
  const name = files.find((f) => BUNDLE_NAMES.test(f.text));
  return name ? `the bundle names ${BUNDLE_NAMES.exec(name.text)?.[0]} (${name.path})` : null;
}

export function checkSecrets(names: readonly string[]): string | null {
  const hit = names.find((n) => NAMES.includes(n));
  return hit ? `a secret named ${hit} exists` : null;
}

/**
 * Check 5. `drift` is what the tree hashes can't vouch for (stamp.ts): an
 * installed tree that disagrees with package-lock.json, or source under app/
 * that an ignore hides. Either refuses even with a matching stamp.
 */
export function checkStamp(clean: boolean, trees: Trees, stamps: readonly Stamp[], drift: readonly string[] = []): string | null {
  if (!clean) return "the tree is not clean";
  if (drift.length > 0) return drift.join("; ");
  return matchingStamp(stamps, trees) ? null : "no e2e stamp for HEAD's app/, package.json and package-lock.json";
}

export function overrideReason(value: string | undefined): { reason: string } | { error: string } | null {
  if (value === undefined) return null;
  const reason = value.trim();
  return reason ? { reason } : { error: 'E2E_GATE_OVERRIDE needs a reason: E2E_GATE_OVERRIDE="<why>" npm run deploy' };
}

/** Where a bundle is written (the dry run's and the deploy's): the system temp directory, never the tree. */
export function bundleDir(): string {
  return mkdtempSync(join(tmpdir(), "gym-gate-bundle-"));
}

export interface GateIO {
  argv: readonly string[];
  override: string | undefined;
  config(): WranglerConfig;
  env(): EnvSetting[];
  /** Builds app/web/dist from the working tree; throws on failure. */
  build(): void;
  bundle(name: string): Files;
  secrets(name: string): string[];
  clean(): boolean;
  /** installedTree's problems and ignoredSource's files, as sentences; [] when there is none. */
  drift(): string[];
  head(): string;
  /** The checked-out branch's short name, or "" when HEAD is detached (git symbolic-ref). */
  branch(): string;
  trees(): Trees;
  /** What is in the working tree now (stamp.ts workingTrees). */
  workingTrees(): Trees;
  stamps(): Stamp[];
  record(o: Override): void;
  deploy(name: string): number;
  /** The bundle the deploy uploaded (its --outdir). */
  shipped(): Files;
  log(line: string): void;
  now(): Date;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sameTrees = (a: Trees, b: Trees) => a.app === b.app && a.packageJson === b.packageJson && a.packageLock === b.packageLock;

export function runGate(io: GateIO): number {
  const refuse = (n: number | string, why: string) => {
    io.log(`Deploy refused (${typeof n === "number" ? `check ${n}` : n}): ${why}`);
    return 1;
  };
  const attempt = (f: () => string | null): string | null => {
    try {
      return f();
    } catch (error) {
      return message(error) || "failed";
    }
  };
  // The Worker's name (check 2) and the trees the build and bundle came from: every later step is held to them.
  const held: { name: string; built?: Trees } = { name: "" };
  const configAndEnv = (): { why: string | null; name: string } => {
    const c = io.config();
    return { why: checkConfig(c) ?? checkEnv(io.env()), name: String(c.raw.name) };
  };
  const steps: [number | string, () => string | null][] = [
    ["branch", () => checkBranch(io.branch())],
    [1, () => checkArgs(io.argv)],
    [
      2,
      () => {
        const { why, name } = configAndEnv();
        held.name = name;
        return why;
      },
    ],
    [
      "build",
      () => {
        // The trees the build and the bundle are made from; check 7 holds the deploy to them.
        held.built = io.workingTrees();
        io.build();
        return null;
      },
    ],
    [3, () => checkBundle(io.bundle(held.name))],
    [4, () => checkSecrets(io.secrets(held.name))],
  ];
  for (const [n, step] of steps) {
    const why = attempt(step);
    if (why) return refuse(n, why);
  }
  let clean = false;
  const stale = attempt(() => {
    clean = io.clean();
    return checkStamp(clean, io.trees(), io.stamps(), io.drift());
  });
  let reason: string | null = null;
  if (stale) {
    const o = overrideReason(io.override);
    if (o === null) return refuse(5, `${stale}. Run npm run test:e2e -w @myfitnessguide/web on a clean tree first.`);
    if ("error" in o) return refuse(6, o.error);
    reason = o.reason;
  }
  const moved = attempt(() => {
    if (!held.built || !sameTrees(io.workingTrees(), held.built)) return "the tree changed while the gate ran; run npm run deploy again";
    const where = io.branch();
    if (where !== "main") return `the checkout ${where === "" ? "is detached" : `is on ${where}, not main`} (read again before the deploy)`;
    const again = configAndEnv();
    if (again.why) return `${again.why} (read again before the deploy)`;
    return again.name === held.name ? null : `the Worker's name changed from ${held.name} to ${again.name} while the gate ran`;
  });
  if (moved) return refuse(7, moved);
  if (stale && reason !== null) {
    // Recorded after check 7, so a refusal there leaves no entry; still before the
    // deploy, so a crash during it can't lose one (a failed wrangler deploy can leave one).
    let entry: Override;
    try {
      entry = { commit: io.head(), reason, at: isoTime(io.now()), dirty: !clean, trees: held.built ?? io.workingTrees() };
      // Appended, never rewritten; a run that stamps reads it by position (stamp.ts pendingOverrides).
      io.record(entry);
    } catch (error) {
      return refuse(6, `the override could not be recorded: ${message(error)}`);
    }
    io.log(`E2E gate overridden at ${entry.commit}${entry.dirty ? " (with uncommitted changes)" : ""}: ${entry.reason} (${stale}). The next full run lists it.`);
  }
  io.log(`Deploying ${held.name}.`);
  const status = io.deploy(held.name);
  if (status !== 0) return status;
  let uploaded: Files;
  try {
    uploaded = io.shipped();
  } catch (error) {
    io.log(`Deployed, but the uploaded bundle couldn't be read back: ${message(error)}. Check it by hand.`);
    return 0;
  }
  if (uploaded.length === 0) {
    io.log("Deployed, but wrangler wrote no copy of the uploaded bundle to check. Check it by hand.");
    return 0;
  }
  const after = checkBundle(uploaded);
  if (after) {
    io.log(`DEPLOYED BUNDLE FAILED THE GATE: ${after}. Roll back now: npx wrangler rollback (ACCESS.md).`);
    return 1;
  }
  return 0;
}

function filesUnder(dir: string): Files {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [{ path, text: readFileSync(path, "utf8") }];
  });
}

function secretNames(stdout: string): string[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed) || !parsed.every((s) => isRecord(s) && typeof s.name === "string")) throw new Error("wrangler secret list didn't print a list of secrets");
  return parsed.map((s) => (s as { name: string }).name);
}

/** The installed wrangler's own CLI (the pinned 4.147.0 in node_modules), run by this Node: never npx, which could fetch another. */
export function wranglerBin(): string {
  return join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin", "wrangler.js");
}

export interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type Run = (command: string, args: readonly string[], options: { cwd: string; inherit?: boolean; env?: NodeJS.ProcessEnv }) => Ran;

const spawnRun: Run = (command, args, options) => {
  const r = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8", env: options.env ?? process.env, stdio: options.inherit ? "inherit" : "pipe" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? r.error?.message ?? "" };
};

/**
 * The real IO: the build and wrangler from this checkout, git against `repo`
 * (the repository by default; a test passes a temporary one, F17). `run` is
 * the process runner; a test passes one that records the commands.
 */
export function repoIO(repo: string = REPO, run: Run = spawnRun): GateIO {
  const wrangler = (args: string[], inherit = false) =>
    run(process.execPath, [wranglerBin(), ...args], { cwd: WORKER, inherit, env: inherit ? process.env : { ...process.env, CI: "1" } });
  const short = (r: Ran) => r.stderr.trim().slice(0, 300);
  let deployOut: string | null = null;
  return {
    argv: process.argv.slice(2),
    override: process.env.E2E_GATE_OVERRIDE,
    config: () => readWranglerConfig(WORKER),
    env: () => envSettings(process.env, WORKER),
    build: () => {
      const r = run("npm", ["run", "build", "-w", "@myfitnessguide/web"], { cwd: REPO, inherit: true });
      if (r.status !== 0) throw new Error(`npm run build -w @myfitnessguide/web failed (exit ${String(r.status)})`);
    },
    bundle: (name) => {
      const out = bundleDir();
      const r = wrangler(["deploy", "--dry-run", "--name", name, "--outdir", out]);
      if (r.status !== 0) throw new Error(`wrangler deploy --dry-run failed: ${short(r)}`);
      return filesUnder(out);
    },
    secrets: (name) => {
      const r = wrangler(["secret", "list", "--name", name, "--format", "json"]);
      if (r.status !== 0) throw new Error(`wrangler secret list failed: ${short(r)}`);
      return secretNames(r.stdout);
    },
    clean: () => treeClean(repo),
    drift: () => {
      const hidden = ignoredSource(repo);
      return [...installedTree(repo).problems, ...(hidden.length > 0 ? [`ignored source files under app/: ${hidden.join(", ")}`] : [])];
    },
    head: () => git(repo, ["rev-parse", "HEAD"]),
    branch: () => {
      try {
        return git(repo, ["symbolic-ref", "--short", "HEAD"]);
      } catch {
        return ""; // detached (or no git): checkBranch refuses "" too, so this fails closed
      }
    },
    trees: () => treesAt(repo),
    workingTrees: () => workingTrees(repo),
    stamps: () => readStamps(repo, (file, why) => console.log(`Skipped an unreadable stamp ${file}: ${why}`)),
    record: (o) => appendOverride(repo, o),
    deploy: (name) => {
      deployOut = bundleDir();
      return wrangler(["deploy", "--name", name, "--outdir", deployOut], true).status ?? 1;
    },
    shipped: () => (deployOut ? filesUnder(deployOut) : []),
    log: (line) => console.log(line),
    now: () => new Date(),
  };
}

/** Whether `argv1` is this module, by real path: a checkout reached through a symlink still runs the gate. */
export function isMain(argv1: string | undefined, url: string = import.meta.url): boolean {
  if (!argv1) return false;
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(argv1) === real(fileURLToPath(url));
}

if (isMain(process.argv[1])) {
  process.exit(runGate(repoIO()));
} else if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  // Never a silent no-op that looks like a deploy.
  console.error(`deploy-gate.ts was started as ${process.argv[1]} but didn't recognise itself; nothing was deployed.`);
  process.exit(1);
}
