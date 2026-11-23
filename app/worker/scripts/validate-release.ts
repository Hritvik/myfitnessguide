/**
 * Local release validation for the app and member OAuth Workers. Both share
 * production D1 and tool code (ChatGPT reconciliation decision 9).
 *
 * This command builds and checks artifacts only: every Wrangler CLI call has
 * --dry-run, an explicit config and a pinned Worker name. It never lists or
 * changes remote secrets, deploys a Worker, or writes an e2e deployment stamp.
 * The existing app deploy gate remains the authority for actual app releases.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { bundleDir, checkBundle, checkConfig, checkEnv, envSettings, isMain, readWranglerConfig, REPO, WORKER, wranglerBin, type EnvSetting, type Files, type Run, type WranglerConfig } from "@myfitnessguide/worker/deploy-gate";

export const RELEASE_TARGETS = [
  { id: "app", config: "wrangler.jsonc", main: "src/index.ts" },
  { id: "oauth", config: "wrangler.oauth.jsonc", main: "src/oauth-entry.ts" },
] as const;
type ReleaseTarget = typeof RELEASE_TARGETS[number];

export interface ReleaseIO {
  argv: readonly string[];
  config(target: ReleaseTarget): WranglerConfig;
  env(): EnvSetting[];
  build(): void;
  bundle(target: ReleaseTarget, name: string): Files;
  log(line: string): void;
}

/** Each release Worker must use the same, unambiguous production DB binding. */
function database(config: WranglerConfig): string {
  const bindings = config.raw.d1_databases?.filter((binding) => binding.binding === "DB") ?? [];
  const id = bindings[0]?.database_id;
  if (bindings.length !== 1 || typeof id !== "string" || !id) throw new Error(`${config.path} needs exactly one D1 DB binding with a database_id`);
  return id;
}

export function runReleaseValidation(io: ReleaseIO): number {
  try {
    if (io.argv.length > 0 && !(io.argv.length === 1 && io.argv[0] === "oauth")) {
      throw new Error("only the optional 'oauth' target is accepted; config, environment and deploy arguments are refused");
    }
    const environment = checkEnv(io.env());
    if (environment) throw new Error(environment);
    // Check both configs even for an OAuth-only build: its shared D1 must still agree.
    const releases = RELEASE_TARGETS.map((target) => {
      const config = io.config(target);
      const error = checkConfig(config, target.main);
      if (error) throw new Error(`${target.config}: ${error}`);
      return { target, config };
    });
    if (new Set(releases.map(({ config }) => database(config))).size !== 1) {
      throw new Error("app and OAuth release configs must use the same production D1 DB");
    }
    const selected = releases.filter(({ target }) => io.argv.length === 0 || target.id === "oauth");
    if (selected.some(({ target }) => target.id === "app")) io.build();
    for (const { target, config } of selected) {
      const error = checkBundle(io.bundle(target, String(config.raw.name)));
      if (error) throw new Error(`${target.config}: ${error}`);
      io.log(`Validated ${config.raw.name} (${target.config}, ${target.main}): local validation only.`);
    }
    return 0;
  } catch (error) {
    io.log(`Release validation refused: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function filesUnder(dir: string): Files {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [{ path, text: readFileSync(path, "utf8") }];
  });
}

const spawnRun: Run = (command, args, options) => {
  const result = spawnSync(command, args, { ...options, encoding: "utf8", stdio: options.inherit ? "inherit" : "pipe" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
};

export function repoReleaseIO(run: Run = spawnRun): ReleaseIO {
  return {
    argv: process.argv.slice(2),
    config: (target) => readWranglerConfig(WORKER, target.config),
    env: () => envSettings(process.env, WORKER),
    build: () => {
      const result = run("npm", ["run", "build", "-w", "@myfitnessguide/web"], { cwd: REPO, inherit: true });
      if (result.status !== 0) throw new Error(`web build failed (exit ${String(result.status)})`);
    },
    bundle: (target, name) => {
      const out = bundleDir();
      try {
        const result = run(process.execPath, [wranglerBin(), "deploy", "--dry-run", "--config", join(WORKER, target.config), "--name", name, "--outdir", out], {
          cwd: WORKER, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
        });
        if (result.status !== 0) throw new Error(`${target.config} dry-run failed: ${result.stderr.trim().slice(0, 300)}`);
        return filesUnder(out);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
    log: (line) => console.log(line),
  };
}

if (isMain(process.argv[1], import.meta.url)) process.exit(runReleaseValidation(repoReleaseIO()));
