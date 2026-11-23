import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { checkConfig, readWranglerConfig, REPO, WORKER, wranglerBin, type Run, type WranglerConfig } from "../scripts/deploy-gate";
import { RELEASE_TARGETS, repoReleaseIO, runReleaseValidation, type ReleaseIO } from "../scripts/validate-release";

const configs = () => RELEASE_TARGETS.map((target) => readWranglerConfig(WORKER, target.config));
const bundle = [{ path: "worker.js", text: "export default { fetch() {} };" }];

function io(overrides: Partial<ReleaseIO> = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  return {
    calls, logs,
    value: {
      argv: [],
      config: (target) => readWranglerConfig(WORKER, target.config),
      env: () => [],
      build: () => { calls.push("build web"); },
      bundle: (target, name) => { calls.push(`bundle ${target.config} ${name}`); return bundle; },
      log: (line) => { logs.push(line); },
      ...overrides,
    } satisfies ReleaseIO,
  };
}

describe("local release validation for the one Worker", () => {
  it("reads the app config explicitly and holds it to the deployed entry point", () => {
    const [app] = configs() as [WranglerConfig];
    expect(app.path).toBe(join(WORKER, "wrangler.jsonc"));
    expect(checkConfig(app)).toBeNull();
    const unsafe = { ...app, raw: { ...app.raw, env: { dev: { main: "src/dev-entry.ts" } } } };
    expect(checkConfig(unsafe)).toMatch(/env\.dev main/);
  });

  it("builds fresh web assets before bundling the one artifact", () => {
    const t = io();
    expect(runReleaseValidation(t.value)).toBe(0);
    expect(t.calls).toEqual(["build web", "bundle wrangler.jsonc myfitnessguide"]);
    expect(t.logs.join("\n")).toContain("local validation only");
  });

  it("rejects all deploy-like arguments and unsafe environment overrides before building", () => {
    for (const argv of [["--env", "production"], ["--remote"], ["oauth"], ["--config", "elsewhere.jsonc"]]) {
      const t = io({ argv });
      expect(runReleaseValidation(t.value)).toBe(1);
      expect(t.calls).toEqual([]);
    }
    const t = io({ env: () => [{ name: "WRANGLER_CI_OVERRIDE_NAME", where: "the shell" }] });
    expect(runReleaseValidation(t.value)).toBe(1);
    expect(t.calls).toEqual([]);
  });

  it("refuses unsafe configs before building", () => {
    const app = configs()[0]!;
    for (const raw of [
      { ...app.raw, main: "src/dev-entry.ts" },
      { ...app.raw, keep_vars: true },
      { ...app.raw, vars: { LOCAL_FIXED_NOW: "2026-10-01" } },
      { ...app.raw, kv_namespaces: [{ binding: "OAUTH_KV", id: "x", remote: true }] },
    ]) {
      const t = io({ config: () => ({ ...app, raw }) });
      expect(runReleaseValidation(t.value)).toBe(1);
      expect(t.calls).toEqual([]);
    }
  });

  it("refuses a config with a missing or ambiguous production D1 binding", () => {
    const app = configs()[0]!;
    for (const d1_databases of [[], [{ binding: "DB" }, { binding: "DB", database_id: "x" }]]) {
      const t = io({ config: () => ({ ...app, raw: { ...app.raw, d1_databases } }) });
      expect(runReleaseValidation(t.value)).toBe(1);
      expect(t.logs.join("\n")).toMatch(/D1/);
      expect(t.calls).toEqual([]);
    }
  });

  it("fails closed on config, build and bundle errors and unsafe or empty output", () => {
    for (const overrides of [
      { config: () => { throw new Error("bad config"); } },
      { build: () => { throw new Error("web build failed"); } },
      { bundle: () => { throw new Error("bundle failed"); } },
      { bundle: () => [] },
      ...["X-Local-Identity", "LOCAL_IDENTITY_TOKEN", "LOCAL_FIXED_NOW"].map((text) => ({ bundle: () => [{ path: "worker.js", text }] })),
    ] satisfies Partial<ReleaseIO>[]) {
      const t = io(overrides);
      expect(runReleaseValidation(t.value)).toBe(1);
      expect(t.logs.join("\n")).toMatch(/Release validation refused/);
    }
  });

  it("runs only the pinned local Wrangler's explicit dry run, then removes temporary output", () => {
    const ran: { command: string; args: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv }[] = [];
    let out = "";
    const run: Run = (command, args, options) => {
      ran.push({ command, args, ...options });
      out = args[args.indexOf("--outdir") + 1]!;
      writeFileSync(join(out, "worker.js"), bundle[0]!.text);
      return { status: 0, stdout: "", stderr: "" };
    };
    const real = repoReleaseIO(run);
    expect(real.bundle(RELEASE_TARGETS[0]!, "myfitnessguide")).toEqual([{ path: join(out, "worker.js"), text: bundle[0]!.text }]);
    expect(ran).toEqual([expect.objectContaining({
      command: process.execPath, cwd: WORKER,
      args: [wranglerBin(), "deploy", "--dry-run", "--config", join(WORKER, "wrangler.jsonc"), "--name", "myfitnessguide", "--outdir", out],
      env: expect.objectContaining({ CI: "1", WRANGLER_SEND_METRICS: "false" }),
    })]);
    expect(() => readFileSync(join(out, "worker.js"))).toThrow();
    expect(() => repoReleaseIO(() => ({ status: 1, stdout: "", stderr: "bad bundle" })).bundle(RELEASE_TARGETS[0]!, "x")).toThrow(/dry-run failed/);
  });

  it("explicit config reading pins the selected file even when a Wrangler redirect exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "gym-config-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "wrangler.jsonc"), '{ "name": "myfitnessguide", "main": "src/index.ts" }');
    mkdirSync(join(dir, ".wrangler", "deploy"), { recursive: true });
    writeFileSync(join(dir, "other.json"), '{ "name": "wrong", "main": "src/dev-entry.ts" }');
    writeFileSync(join(dir, ".wrangler", "deploy", "config.json"), '{ "configPath": "../../other.json" }');
    const config = readWranglerConfig(dir, "wrangler.jsonc");
    // An explicit --config bypasses Wrangler's redirect lookup; it still reads exactly the selected file.
    expect(config.path).toBe(join(dir, "wrangler.jsonc"));
    expect(config.raw.main).toBe("src/index.ts");
  });

  it("exposes test/typecheck/build validation scripts without changing the app deploy command", () => {
    const scripts = JSON.parse(readFileSync(join(WORKER, "package.json"), "utf8")).scripts;
    expect(scripts["validate:release"]).toBe("npm run typecheck && npm test && node scripts/validate-release.ts");
    expect(scripts["validate:oauth"]).toBeUndefined();
    expect(scripts.deploy).toBe("node scripts/deploy-gate.ts");
    expect(JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).scripts["validate:release"]).toBe("npm run validate:release -w @myfitnessguide/worker");
  });
});
