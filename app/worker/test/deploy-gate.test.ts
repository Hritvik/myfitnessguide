import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { ALLOWED_ENV, bundleDir, checkBranch, checkBundle, checkConfig, checkEnv, checkSecrets, envSettings, isMain, readWranglerConfig, REPO, repoIO, runGate, WORKER, wranglerBin, type GateIO, type Run, type WranglerConfig } from "../scripts/deploy-gate";
import { git, readOverrides, treeClean, treesAt, writeStamp, type Override, type Stamp, type Trees } from "../scripts/stamp";

/** The committed config, read by wrangler's own reader (no hand-written JSONC parser). */
const WRANGLER = readWranglerConfig(WORKER);
const raw = (r: Record<string, unknown>): WranglerConfig => ({ raw: { name: "w", ...r }, redirected: false, path: "wrangler.jsonc" });
const BUNDLE = [{ path: "index.js", text: "export default { fetch() {} };" }];
const TREES: Trees = { app: "a1", packageJson: "p1", packageLock: "l1" };
const STAMP: Stamp = { commit: "c0", at: "2026-10-08T10:00:00.000Z", trees: TREES, installed: "h", playwright: "1.64.0", chromium: "x", counts: {}, wall_ms: 1, overrides: [] };

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function io(over: Partial<GateIO> = {}) {
  const log: string[] = [];
  const recorded: Override[] = [];
  /** What the gate did, in order, with the Worker name each wrangler step was given. */
  const calls: string[] = [];
  let deploys = 0;
  const gate: GateIO = {
    argv: [],
    override: undefined,
    config: () => WRANGLER,
    env: () => [],
    build: () => void calls.push("build"),
    bundle: (name) => (calls.push(`bundle ${name}`), BUNDLE),
    secrets: (name) => (calls.push(`secrets ${name}`), ["SOME_OTHER_SECRET"]),
    clean: () => true,
    drift: () => [],
    head: () => "c1",
    branch: () => "main",
    trees: () => TREES,
    workingTrees: () => TREES,
    stamps: () => [STAMP],
    record: (o) => void recorded.push(o),
    deploy: (name) => (calls.push(`deploy ${name}`), deploys++, 0),
    shipped: () => BUNDLE,
    log: (l) => void log.push(l),
    now: () => new Date("2026-10-08T12:00:00Z"),
    ...over,
  };
  return { gate, log, recorded, calls, deploys: () => deploys };
}

describe("the deploy gate (e2e spec §9)", () => {
  it("the committed wrangler.jsonc, read by wrangler, passes the config check", () => {
    expect(WRANGLER.redirected).toBe(false);
    expect(WRANGLER.path).toBe(join(WORKER, "wrangler.jsonc"));
    expect(WRANGLER.raw.main).toBe("src/index.ts");
    expect(checkConfig(WRANGLER)).toBeNull();
  });

  it("a redirected config (.wrangler/deploy/config.json) is refused, as wrangler deploy would use it", () => {
    const dir = temp("gym-gate-redirect-");
    writeFileSync(join(dir, "wrangler.jsonc"), '{ "name": "x", "main": "src/index.ts" }');
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, ".wrangler", "deploy"), { recursive: true });
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "wrangler.json"), '{ "name": "x", "main": "index.js" }');
    writeFileSync(join(dir, ".wrangler", "deploy", "config.json"), '{ "configPath": "../../dist/wrangler.json" }');
    const read = readWranglerConfig(dir);
    expect(read.redirected).toBe(true);
    expect(checkConfig(read)).toMatch(/redirected config/);
  });

  it("the config is the one wrangler deploy finds from app/worker, not from a nearer directory", () => {
    // wrangler deploy looks from its working directory; a config under src/ must not be the one read.
    const dir = temp("gym-gate-near-");
    writeFileSync(join(dir, "wrangler.jsonc"), '// a comment\n{ "name": "x", "main": "src/index.ts", }');
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "wrangler.json"), '{ "name": "x", "main": "src/dev-entry.ts" }');
    const read = readWranglerConfig(dir);
    expect(read.path).toBe(join(dir, "wrangler.jsonc"));
    expect(read.raw.main).toBe("src/index.ts");
  });

  it("a green run deploys once and writes nothing", () => {
    const t = io();
    expect(runGate(t.gate)).toBe(0);
    expect(t.deploys()).toBe(1);
    expect(t.recorded).toEqual([]);
  });

  it("refuses in order: branch, arguments, config, bundle, secrets, stamp", () => {
    const broken: Partial<GateIO> = {
      branch: () => "feat/x",
      argv: ["--env", "staging"],
      config: () => ({ ...WRANGLER, raw: { ...WRANGLER.raw, main: "src/dev-entry.ts" } }),
      bundle: () => [{ path: "index.js", text: 'headers.get("X-Local-Identity")' }],
      secrets: () => ["LOCAL_IDENTITY_TOKEN"],
      stamps: () => [],
    };
    const order: string[] = [];
    const fixes: (keyof GateIO)[] = ["branch", "argv", "config", "bundle", "secrets", "stamps"];
    for (let i = 0; i <= fixes.length; i++) {
      const left = Object.fromEntries(Object.entries(broken).filter(([k]) => !fixes.slice(0, i).includes(k as keyof GateIO)));
      const t = io(left);
      const code = runGate(t.gate);
      order.push(code === 0 ? "deployed" : (t.log.find((l) => l.startsWith("Deploy refused")) ?? "").replace(/\).*/, ")"));
      if (code !== 0) expect(t.deploys()).toBe(0);
    }
    expect(order).toEqual(["Deploy refused (branch)", "Deploy refused (check 1)", "Deploy refused (check 2)", "Deploy refused (check 3)", "Deploy refused (check 4)", "Deploy refused (check 5)", "deployed"]);
  });

  it("only main deploys: another branch or a detached HEAD refuses, override or not", () => {
    expect(checkBranch("main")).toBeNull();
    expect(checkBranch("feat/x")).toMatch(/the checkout is on feat\/x, not main/);
    expect(checkBranch("")).toMatch(/HEAD is detached/);
    for (const branch of ["feat/x", ""]) {
      const t = io({ branch: () => branch, stamps: () => [], override: "hotfix" });
      expect(runGate(t.gate)).toBe(1);
      expect(t.log.join("\n")).toMatch(/Deploy refused \(branch\):/);
      expect(t.deploys()).toBe(0);
      expect(t.recorded).toEqual([]);
    }
  });

  it("check 2 reads every env block, the main and remote bindings", () => {
    const base = { main: "src/index.ts", vars: { URL: "https://example.com/x" } };
    expect(checkConfig(raw({ ...base, env: {} }))).toBeNull();
    expect(checkConfig(raw({ ...base, env: { staging: { vars: { LOCAL_IDENTITY_TOKEN: "x" } } } }))).toMatch(/env\.staging vars set LOCAL_IDENTITY_TOKEN/);
    expect(checkConfig(raw({ ...base, env: { dev: { vars: { LOCAL_DEV_IDENTITY: "header" } } } }))).toMatch(/env\.dev vars set LOCAL_DEV_IDENTITY/);
    expect(checkConfig(raw({ ...base, env: { x: { main: "src/dev-entry.ts" } } }))).toMatch(/env\.x main is src\/dev-entry\.ts/);
    expect(checkConfig(raw({ ...base, d1_databases: [{ binding: "DB", remote: true }] }))).toMatch(/D1 binding DB has remote: true/);
    expect(checkConfig(raw({ ...base, env: { x: { d1_databases: [{ binding: "DB", remote: true }] } } }))).toMatch(/env\.x D1 binding DB has remote: true/);
    expect(checkConfig(raw({ ...base, kv_namespaces: [{ binding: "KV", remote: true }] }))).toMatch(/kv_namespaces binding KV has remote: true/);
    expect(checkConfig(raw({ main: "src/index.ts", vars: { LOCAL_DEV_IDENTITY: "member:asha@example.com" } }))).toMatch(/top level vars set LOCAL_DEV_IDENTITY/);
    expect(checkConfig(raw({ main: "src/index.ts" }))).toBeNull();
    expect(checkConfig({ ...raw({ main: "src/index.ts" }), raw: { main: "src/index.ts" } })).toMatch(/names no Worker/);
    expect(checkConfig(raw({ main: "src/other.ts" }))).toMatch(/top level main is src\/other\.ts/);
  });

  it("check 2 and check 4 refuse the fixed clock too (worker decision 162)", () => {
    expect(checkConfig(raw({ main: "src/index.ts", vars: { LOCAL_FIXED_NOW: "2026-10-07T04:30:00Z" } }))).toMatch(/top level vars set LOCAL_FIXED_NOW/);
    expect(checkConfig(raw({ main: "src/index.ts", env: { e: { vars: { LOCAL_FIXED_NOW: "x" } } } }))).toMatch(/env\.e vars set LOCAL_FIXED_NOW/);
    for (const name of ["LOCAL_DEV_IDENTITY", "LOCAL_IDENTITY_TOKEN", "LOCAL_FIXED_NOW"]) expect(checkSecrets(["A", name])).toMatch(new RegExp(`a secret named ${name} exists`));
    expect(checkSecrets(["ACCESS_AUD"])).toBeNull();
  });

  it("a config wrangler can't read refuses at check 2", () => {
    const t = io({ config: () => { throw new Error("Failed to parse the deploy configuration file"); } });
    expect(runGate(t.gate)).toBe(1);
    expect(t.log.join("\n")).toMatch(/check 2\): Failed to parse/);
  });

  it("check 3 finds the header in any letter case, and refuses an empty bundle", () => {
    for (const text of ["x-local-identity", "X-LOCAL-IDENTITY", "x-Local-Identity-Token"]) {
      expect(runGate(io({ bundle: () => [{ path: "w.js", text }] }).gate)).toBe(1);
    }
    expect(runGate(io({ bundle: () => [] }).gate)).toBe(1);
  });

  it("a failing dry run or secret list refuses (fails closed)", () => {
    const t = io({ bundle: () => { throw new Error("wrangler deploy --dry-run failed"); } });
    expect(runGate(t.gate)).toBe(1);
    expect(t.log.join("\n")).toMatch(/check 3\): wrangler deploy --dry-run failed/);
    const s = io({ secrets: () => { throw new Error("not signed in"); } });
    expect(runGate(s.gate)).toBe(1);
    expect(s.log.join("\n")).toMatch(/check 4\): not signed in/);
  });

  it("check 5: a dirty tree, or no stamp for HEAD's trees, refuses; another commit with the same trees passes", () => {
    expect(runGate(io({ clean: () => false }).gate)).toBe(1);
    expect(runGate(io({ trees: () => ({ ...TREES, app: "a2" }) }).gate)).toBe(1);
    expect(runGate(io({ trees: () => ({ ...TREES, packageLock: "l2" }) }).gate)).toBe(1);
    expect(runGate(io({ head: () => "docs-only-commit" }).gate)).toBe(0);
  });

  it("check 5: installed dependencies that drifted from the lock, or ignored source under app/, refuse even with a stamp", () => {
    for (const drift of [["node_modules doesn't match package-lock.json: node_modules/a is 1.0.1 installed, 1.0.0 locked"], ["ignored source files under app/: app/secret.ts"]]) {
      const t = io({ drift: () => drift });
      expect(runGate(t.gate)).toBe(1);
      expect(t.log.join("\n")).toContain(`check 5): ${drift[0]}`);
      expect(t.deploys()).toBe(0);
    }
  });

  it("the override stands in for check 5 only: printed and recorded", () => {
    const t = io({ stamps: () => [], override: "hotfix: the hourly cron double-confirms" });
    expect(runGate(t.gate)).toBe(0);
    expect(t.recorded).toEqual([{ commit: "c1", reason: "hotfix: the hourly cron double-confirms", at: "2026-10-08T12:00:00.000Z", dirty: false, trees: TREES }]);
    expect(t.log.join("\n")).toMatch(/overridden at c1: hotfix: the hourly cron double-confirms/);
    expect(t.deploys()).toBe(1);
  });

  it("a stamp that matches makes an override unnecessary: nothing is recorded", () => {
    const t = io({ override: "hotfix" });
    expect(runGate(t.gate)).toBe(0);
    expect(t.recorded).toEqual([]);
  });

  it("the override never passes checks 1–4, and an empty reason is refused", () => {
    const reason = "hotfix";
    for (const over of [{ argv: ["x"] }, { config: () => raw({ main: "src/index.ts", vars: { LOCAL_DEV_IDENTITY: "header" } }) }, { bundle: () => [{ path: "a", text: "x-local-identity" }] }, { secrets: () => ["LOCAL_DEV_IDENTITY"] }] as Partial<GateIO>[]) {
      const t = io({ ...over, stamps: () => [], override: reason });
      expect(runGate(t.gate)).toBe(1);
      expect(t.recorded).toEqual([]);
      expect(t.deploys()).toBe(0);
    }
    for (const empty of ["", "   ", "\t\n"]) {
      const t = io({ stamps: () => [], override: empty });
      expect(runGate(t.gate)).toBe(1);
      expect(t.log.join("\n")).toMatch(/check 6\): E2E_GATE_OVERRIDE needs a reason/);
      expect(t.deploys()).toBe(0);
      expect(t.recorded).toEqual([]);
    }
  });

  it("an override that can't be recorded refuses the deploy", () => {
    const t = io({ stamps: () => [], override: "hotfix", record: () => { throw new Error("EACCES"); } });
    expect(runGate(t.gate)).toBe(1);
    expect(t.log.join("\n")).toMatch(/check 6\): the override could not be recorded: EACCES/);
    expect(t.deploys()).toBe(0);
  });

  it("a deploy that fails returns wrangler's status", () => {
    expect(runGate(io({ deploy: () => 7 }).gate)).toBe(7);
  });

  it("a full green run through the real git IO leaves the tree clean, and so does an override (spec §9; F17)", () => {
    // A real repository with app/, package.json, package-lock.json and an installed tree; only wrangler's half is faked.
    const dir = temp("gym-gate-repo-");
    const g = (...args: string[]) => spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: dir });
    g("init", "-q", "-b", "main");
    mkdirSync(join(dir, "app"));
    mkdirSync(join(dir, "node_modules"));
    for (const [f, text] of [["app/a.ts", "export const a = 1;\n"], ["package.json", "{}\n"], ["package-lock.json", "{}\n"], [".gitignore", "node_modules/\n"], ["node_modules/.package-lock.json", "{}\n"]]) writeFileSync(join(dir, f!), text!);
    g("add", ".");
    g("commit", "-q", "-m", "one");
    writeStamp(dir, { ...STAMP, commit: git(dir, ["rev-parse", "HEAD"]), trees: treesAt(dir) });
    let deploys = 0;
    const outs: string[] = [];
    onTestFinished(() => outs.forEach((o) => rmSync(o, { recursive: true, force: true })));
    const fake = (over: Partial<GateIO> = {}): GateIO => ({
      ...repoIO(dir),
      argv: [],
      override: undefined,
      config: () => WRANGLER,
      env: () => [],
      build: () => undefined,
      shipped: () => BUNDLE,
      bundle: () => {
        // As the real dry run does: the bundle goes to bundleDir(), outside the repository.
        const out = bundleDir();
        outs.push(out);
        expect(relative(dir, out).startsWith("..")).toBe(true);
        writeFileSync(join(out, "index.js"), "export default { fetch() {} };");
        return [{ path: join(out, "index.js"), text: "export default { fetch() {} };" }];
      },
      secrets: () => [],
      deploy: () => (deploys++, 0),
      log: () => undefined,
      ...over,
    });
    expect(runGate(fake())).toBe(0);
    expect(deploys).toBe(1);
    expect(treeClean(dir)).toBe(true);
    // An ignored source file under app/ refuses even with the stamp.
    mkdirSync(join(dir, ".git", "info"), { recursive: true });
    writeFileSync(join(dir, ".git", "info", "exclude"), "hidden.ts\n");
    writeFileSync(join(dir, "app", "hidden.ts"), "x");
    const said: string[] = [];
    expect(runGate(fake({ log: (l) => void said.push(l) }))).toBe(1);
    expect(said).toEqual([expect.stringMatching(/^Deploy refused \(check 5\): ignored source files under app\/: app\/hidden\.ts/)]);
    rmSync(join(dir, "app", "hidden.ts"));
    // An app/ change has no stamp: the override records into the git common directory, never the tree.
    writeFileSync(join(dir, "app", "a.ts"), "export const a = 2;\n");
    g("commit", "-qam", "two");
    expect(runGate(fake({ override: "hotfix: a probe" }))).toBe(0);
    expect(deploys).toBe(2);
    expect(readOverrides(dir).map((o) => o.reason)).toEqual(["hotfix: a probe"]);
    expect(readOverrides(dir)[0]?.commit).toBe(git(dir, ["rev-parse", "HEAD"]));
    expect(treeClean(dir)).toBe(true);
  });

  it("the branch the gate reads comes from git: main, or '' once HEAD is detached", () => {
    const dir = temp("gym-gate-branch-");
    const g = (...args: string[]) => spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: dir });
    g("init", "-q", "-b", "main");
    expect(repoIO(dir).branch()).toBe("main");
    g("commit", "-q", "--allow-empty", "-m", "one");
    g("checkout", "-q", "--detach");
    expect(repoIO(dir).branch()).toBe("");
    const t = io({ branch: repoIO(dir).branch });
    expect(runGate(t.gate)).toBe(1);
    expect(t.log.join("\n")).toMatch(/Deploy refused \(branch\): HEAD is detached/);
    expect(t.deploys()).toBe(0);
  });

  it("both entry points run the gate, and the gate builds the web app from this tree before the bundle (fix round 1)", () => {
    const scripts = (path: string) => (JSON.parse(readFileSync(path, "utf8")) as { scripts: Record<string, string> }).scripts;
    // The root deploy only calls the Worker's; neither builds outside the gate.
    expect(scripts(join(REPO, "package.json")).deploy).toBe("npm run deploy -w @myfitnessguide/worker");
    expect(scripts(join(WORKER, "package.json")).deploy).toBe("node scripts/deploy-gate.ts");
    const t = io();
    expect(runGate(t.gate)).toBe(0);
    expect(t.calls).toEqual(["build", "bundle myfitnessguide", "secrets myfitnessguide", "deploy myfitnessguide"]);
    const failed = io({ build: () => { throw new Error("vite build failed"); } });
    expect(runGate(failed.gate)).toBe(1);
    expect(failed.log.join("\n")).toMatch(/Deploy refused \(build\): vite build failed/);
    expect(failed.deploys()).toBe(0);
  });

  it("the Worker's name is read once and given to the dry run, the secret list and the deploy", () => {
    const t = io({ config: () => ({ ...WRANGLER, raw: { ...WRANGLER.raw, name: "other-name" } }) });
    expect(runGate(t.gate)).toBe(0);
    expect(t.calls.filter((c) => c !== "build")).toEqual(["bundle other-name", "secrets other-name", "deploy other-name"]);
  });

  it("check 2 refuses a wrangler variable that isn't on the allow-list, from the shell or an app/worker .env file", () => {
    const dir = temp("gym-gate-env-");
    expect(envSettings({ PATH: "/bin", CLOUDFLARE_API_TOKEN: "t" }, dir)).toEqual([{ name: "CLOUDFLARE_API_TOKEN", where: "the shell" }]);
    expect(checkEnv(envSettings({ CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a", WRANGLER_LOG: "debug" }, dir))).toBeNull();
    expect(checkEnv(envSettings({ WRANGLER_CI_OVERRIDE_NAME: "elsewhere" }, dir))).toMatch(/the shell sets WRANGLER_CI_OVERRIDE_NAME/);
    expect(checkEnv(envSettings({ CLOUDFLARE_ENV: "staging" }, dir))).toMatch(/CLOUDFLARE_ENV/);
    writeFileSync(join(dir, ".env"), "# a comment\nCLOUDFLARE_API_TOKEN=t\nexport WRANGLER_CI_OVERRIDE_NAME=elsewhere\n");
    writeFileSync(join(dir, ".env.local"), "CLOUDFLARE_API_BASE_URL: https://example.com\n");
    writeFileSync(join(dir, ".dev.vars"), "LOCAL_DEV_IDENTITY=member:asha@example.com\nWRANGLER_X=1\n");
    expect(envSettings({}, dir)).toEqual([
      { name: "CLOUDFLARE_API_TOKEN", where: "app/worker/.env" },
      { name: "WRANGLER_CI_OVERRIDE_NAME", where: "app/worker/.env" },
      { name: "CLOUDFLARE_API_BASE_URL", where: "app/worker/.env.local" },
    ]);
    expect(checkEnv(envSettings({}, dir))).toMatch(/app\/worker\/\.env sets WRANGLER_CI_OVERRIDE_NAME/);
    const t = io({ env: () => [{ name: "WRANGLER_BUILD_CONDITIONS", where: "the shell" }] });
    expect(runGate(t.gate)).toBe(1);
    expect(t.log.join("\n")).toMatch(/check 2\): the shell sets WRANGLER_BUILD_CONDITIONS/);
    // Every allowed name says why.
    for (const [, why] of ALLOWED_ENV) expect(why.length).toBeGreaterThan(10);
    expect([...ALLOWED_ENV.keys()].some((n) => /OVERRIDE_NAME|_ENV$|BASE_URL|BUILD/.test(n))).toBe(false);
  });

  it("check 2 refuses the dev names in any binding, unsafe.bindings or field, and keep_vars", () => {
    const base = { main: "src/index.ts" };
    expect(checkConfig(raw({ ...base, keep_vars: true }))).toMatch(/top level sets keep_vars: true/);
    expect(checkConfig(raw({ ...base, env: { e: { keep_vars: true } } }))).toMatch(/env\.e sets keep_vars/);
    expect(checkConfig(raw({ ...base, unsafe: { bindings: [{ name: "LOCAL_DEV_IDENTITY", type: "plain_text", text: "header" }] } }))).toMatch(/top level names LOCAL_DEV_IDENTITY at unsafe\.bindings\[0\]\.name/);
    expect(checkConfig(raw({ ...base, kv_namespaces: [{ binding: "LOCAL_FIXED_NOW", id: "x" }] }))).toMatch(/names LOCAL_FIXED_NOW at kv_namespaces\[0\]\.binding/);
    expect(checkConfig(raw({ ...base, secrets: { required: ["LOCAL_IDENTITY_TOKEN"] } }))).toMatch(/names LOCAL_IDENTITY_TOKEN at secrets\.required\[0\]/);
    expect(checkConfig(raw({ ...base, env: { e: { define: { LOCAL_DEV_IDENTITY: "1" } } } }))).toMatch(/env\.e names LOCAL_DEV_IDENTITY at define\.LOCAL_DEV_IDENTITY/);
    expect(checkConfig(raw({ ...base, vars: { NOTE: "uses LOCAL_DEV_IDENTITY locally" } }))).toBeNull();
  });

  it("check 3 also refuses the dev-only variable names, but not main's own LOCAL_DEV_IDENTITY", () => {
    expect(checkBundle([{ path: "i.js", text: "env.LOCAL_IDENTITY_TOKEN" }])).toMatch(/names LOCAL_IDENTITY_TOKEN \(i\.js\)/);
    expect(checkBundle([{ path: "i.js", text: "env.LOCAL_FIXED_NOW" }])).toMatch(/names LOCAL_FIXED_NOW/);
    expect(checkBundle([{ path: "i.js", text: "env.LOCAL_DEV_IDENTITY" }])).toBeNull();
  });

  it("check 7: the tree, the config's name or the environment changing after the checks refuses the deploy", () => {
    let n = 0;
    const moving = io({ workingTrees: () => (n++ === 0 ? TREES : { ...TREES, app: "a9" }) });
    expect(runGate(moving.gate)).toBe(1);
    expect(moving.log.join("\n")).toMatch(/check 7\): the tree changed while the gate ran/);
    expect(moving.deploys()).toBe(0);
    let c = 0;
    const renamed = io({ config: () => (c++ === 0 ? WRANGLER : { ...WRANGLER, raw: { ...WRANGLER.raw, name: "elsewhere" } }) });
    expect(runGate(renamed.gate)).toBe(1);
    expect(renamed.log.join("\n")).toMatch(/check 7\): the Worker's name changed from myfitnessguide to elsewhere/);
    let e = 0;
    const env = io({ env: () => (e++ === 0 ? [] : [{ name: "WRANGLER_CI_OVERRIDE_NAME", where: "app/worker/.env" }]) });
    expect(runGate(env.gate)).toBe(1);
    expect(env.log.join("\n")).toMatch(/check 7\): app\/worker\/\.env sets WRANGLER_CI_OVERRIDE_NAME.*read again before the deploy/);
    let b = 0;
    const branchMoved = io({ branch: () => (b++ === 0 ? "main" : "feat/x") });
    expect(runGate(branchMoved.gate)).toBe(1);
    expect(branchMoved.log.join("\n")).toMatch(/check 7\): the checkout is on feat\/x, not main \(read again before the deploy\)/);
    expect(branchMoved.deploys()).toBe(0);
  });

  it("an override refused at check 7 records nothing: no entry for a deploy that never happened (final review M1)", () => {
    let n = 0;
    const t = io({ stamps: () => [], override: "hotfix", workingTrees: () => (n++ === 0 ? TREES : { ...TREES, app: "a9" }) });
    expect(runGate(t.gate)).toBe(1);
    expect(t.log.join("\n")).toMatch(/check 7\): the tree changed while the gate ran/);
    expect(t.recorded).toEqual([]);
    expect(t.deploys()).toBe(0);
  });

  it("the uploaded bundle is checked again: a hit says to roll back, a missing copy is said", () => {
    const hit = io({ shipped: () => [{ path: "i.js", text: "X-Local-Identity" }] });
    expect(runGate(hit.gate)).toBe(1);
    expect(hit.deploys()).toBe(1);
    expect(hit.log.join("\n")).toMatch(/DEPLOYED BUNDLE FAILED THE GATE: .*Roll back now/);
    const none = io({ shipped: () => [] });
    expect(runGate(none.gate)).toBe(0);
    expect(none.log.join("\n")).toMatch(/wrote no copy of the uploaded bundle/);
  });

  it("an override on a dirty tree records that, and the trees that ship", () => {
    const working: Trees = { ...TREES, app: "a-dirty" };
    const t = io({ clean: () => false, workingTrees: () => working, override: "hotfix" });
    expect(runGate(t.gate)).toBe(0);
    expect(t.recorded).toEqual([{ commit: "c1", reason: "hotfix", at: "2026-10-08T12:00:00.000Z", dirty: true, trees: working }]);
    expect(t.log.join("\n")).toMatch(/overridden at c1 \(with uncommitted changes\): hotfix/);
  });

  it("the real IO runs the installed wrangler (never npx) and npm's web build, with the one name everywhere", () => {
    const ran: { command: string; args: readonly string[]; cwd: string; inherit?: boolean }[] = [];
    const run: Run = (command, args, options) => {
      ran.push({ command, args, cwd: options.cwd, inherit: options.inherit });
      const out = args.indexOf("--outdir");
      if (out !== -1) onTestFinished(() => rmSync(args[out + 1] as string, { recursive: true, force: true }));
      return { status: 0, stdout: args.includes("list") ? '[{"name":"ACCESS_AUD","type":"secret_text"}]' : "", stderr: "" };
    };
    const real = repoIO(REPO, run);
    real.build();
    expect(real.bundle("myfitnessguide")).toEqual([]);
    expect(real.secrets("myfitnessguide")).toEqual(["ACCESS_AUD"]);
    expect(real.deploy("myfitnessguide")).toBe(0);
    expect(ran[0]).toMatchObject({ command: "npm", args: ["run", "build", "-w", "@myfitnessguide/web"], cwd: REPO });
    const w = ran.slice(1);
    expect(w.map((r) => r.command)).toEqual([process.execPath, process.execPath, process.execPath]);
    expect(w.every((r) => r.args[0] === wranglerBin() && r.cwd === WORKER)).toBe(true);
    expect(w.map((r) => r.args.slice(1, 4).join(" "))).toEqual(["deploy --dry-run --name", "secret list --name", "deploy --name myfitnessguide"]);
    expect(w.every((r) => r.args.includes("myfitnessguide"))).toBe(true);
    expect(ran.some((r) => r.command === "npx" || r.args.includes("npx"))).toBe(false);
    const pkg = JSON.parse(readFileSync(join(wranglerBin(), "..", "..", "package.json"), "utf8")) as { name: string; version: string };
    expect(pkg).toMatchObject({ name: "wrangler", version: "4.152.0" });
    const failing = repoIO(REPO, () => ({ status: 1, stdout: "", stderr: "boom" }));
    expect(() => failing.secrets("x")).toThrow(/wrangler secret list failed: boom/);
    expect(() => repoIO(REPO, () => ({ status: 0, stdout: "Logged in\n[]", stderr: "" })).secrets("x")).toThrow();
  });

  it("the self-run guard follows symlinks, so a symlinked checkout still runs the gate", () => {
    const dir = temp("gym-gate-link-");
    const link = join(dir, "worker");
    symlinkSync(WORKER, link);
    const self = new URL("../scripts/deploy-gate.ts", import.meta.url).href;
    expect(isMain(join(link, "scripts", "deploy-gate.ts"), self)).toBe(true);
    expect(isMain(join(WORKER, "scripts", "deploy-gate.ts"), self)).toBe(true);
    expect(isMain(join(WORKER, "scripts", "stamp.ts"), self)).toBe(false);
    expect(isMain(undefined, self)).toBe(false);
  });
});
