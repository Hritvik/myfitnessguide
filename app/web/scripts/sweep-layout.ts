/**
 * `node scripts/sweep-layout.ts [--widths 390,1440] [--themes light] [--only <state>] [--gate]`
 *
 * The layout sweep, now the browser suite's `layout` project (e2e spec §2,
 * §8): a fresh stress household, every state in scripts/states.ts at 390,
 * 768, 1,024, 1,280, 1,440, 1,800, 1,920 and 2,560 px, light and dark, with
 * the audit (scripts/audit.ts) and the fold. --widths, --themes and --only
 * narrow it. Exit 1 on any flag; findings.json is in the run directory.
 * --gate also runs the `phone` project (every state at 390 px against the
 * committed baselines).
 *
 * `--phone-check --base <ref> [--allow <state>]`: a one-off comparison of this
 * branch's 390 px phone with <ref>'s, every state, light and dark, by pixels
 * (at most 0.5 % may differ), as the phone-base project. The committed
 * baselines (the phone project, in the gate) are the phone's guard; this is
 * for comparing with a commit that isn't the baselines' (e2e spec §8).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
/** --phone-check --base <ref>: the 390 px phone against <ref>, by pixels (the phone-base project). */
const PHONE_CHECK = process.argv.includes("--phone-check");
/** --gate (npm run test:layout): the layout project and the phone's baselines (e2e spec §8). */
const GATE = process.argv.includes("--gate");
const BASE_REF = arg("base", "");
const ALLOW = process.argv.flatMap((a, i) => (a === "--allow" && process.argv[i + 1] ? [process.argv[i + 1]!] : []));
const WIDTHS = arg("widths", "390,768,1024,1280,1440,1800,1920,2560").split(",").map(Number);
const THEMES = arg("themes", "light,dark").split(",") as ("light" | "dark")[];
/** A substring of a state's name, to rerun a few. */
const ONLY = arg("only", "");

// ---- the base, for --phone-check ------------------------------------------------------------

function git(args: string[]): string {
  const r = spawnSync("git", args, { cwd: web, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** The node_modules this checkout resolves from (the worktree's own, or the main checkout's above it). */
function modulesDir(): string {
  return dirname(dirname(createRequire(import.meta.url).resolve("vite/package.json")));
}

const viteBin = () => join(modulesDir(), "vite", "bin", "vite.js");

/** <ref> in a temporary worktree, built into dist-phone-check from this checkout's node_modules: the phone-base project serves it. */
function buildBase(): { dir: string; web: string } {
  const sha = git(["rev-parse", "--verify", `${BASE_REF}^{commit}`]);
  const dir = join(tmpdir(), `myfitnessguide-phone-base-${sha.slice(0, 12)}`);
  if (existsSync(dir)) {
    if (existsSync(join(dir, "node_modules"))) unlinkSync(join(dir, "node_modules"));
    git(["worktree", "remove", "--force", dir]);
  }
  git(["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", dir, sha]);
  const baseWeb = join(dir, "app", "web");
  type Pkg = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const read = (at: string) => JSON.parse(readFileSync(join(at, "package.json"), "utf8")) as Pkg;
  const version = (p: Pkg, name: string) => p.dependencies?.[name] ?? p.devDependencies?.[name];
  for (const name of ["react", "react-dom", "vite", "@vitejs/plugin-react"]) {
    if (version(read(web), name) !== version(read(baseWeb), name)) {
      throw new Error(`${BASE_REF} builds with ${name} ${version(read(baseWeb), name)}, this branch with ${version(read(web), name)}: one node_modules can't build both. Stop and report it.`);
    }
  }
  symlinkSync(modulesDir(), join(dir, "node_modules"), "dir");
  const built = spawnSync(process.execPath, [viteBin(), "build", "--outDir", "dist-phone-check", "--emptyOutDir"], { cwd: baseWeb, stdio: "inherit", env: { ...process.env, GYM_APP_VERSION: "phone-check" } });
  if (built.status !== 0) throw new Error(`vite build of ${BASE_REF} failed`);
  return { dir, web: baseWeb };
}

/** The phone against <ref> by pixels, as the phone-base project. */
function phoneBase(): number {
  if (!BASE_REF) throw new Error("--phone-check needs --base <ref>");
  const base = buildBase();
  try {
    const grep = ONLY ? ["--", "--grep", ONLY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")] : [];
    const r = spawnSync(process.execPath, ["e2e/run.ts", "--projects", "phone-base", ...grep], {
      cwd: web,
      stdio: "inherit",
      env: { ...process.env, E2E_BASE_WEB: base.web, E2E_ALLOW: ALLOW.join(",") },
    });
    return r.status ?? 1;
  } finally {
    if (existsSync(join(base.dir, "node_modules"))) unlinkSync(join(base.dir, "node_modules"));
    git(["worktree", "remove", "--force", base.dir]);
  }
}

// ---- run -------------------------------------------------------------------------------------

/** The sweep is the browser suite's `layout` project (e2e spec §2, §8); --gate is the merge gate. */
function sweep(): number {
  const given = (name: string) => process.argv.includes(`--${name}`);
  const env = {
    ...process.env,
    ...(given("widths") ? { E2E_WIDTHS: WIDTHS.join(",") } : {}),
    ...(given("themes") ? { E2E_THEMES: THEMES.join(",") } : {}),
  };
  const grep = ONLY ? ["--", "--grep", ONLY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")] : [];
  const r = spawnSync(process.execPath, ["e2e/run.ts", ...(GATE ? ["--layout"] : ["--projects", "layout"]), ...grep], { cwd: web, stdio: "inherit", env });
  return r.status ?? 1;
}

process.exit(PHONE_CHECK ? phoneBase() : sweep());
