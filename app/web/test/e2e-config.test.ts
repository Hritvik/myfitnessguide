import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const inside = (root: string, path: string) => !relative(root, path).startsWith("..");

describe("the browser suite's config (e2e spec §2)", () => {
  it("puts every output under the run directory, outside the repository", async () => {
    const run = mkdtempSync(join(tmpdir(), "gym-e2e-config-"));
    process.env.E2E_RUN = run;
    onTestFinished(() => {
      rmSync(run, { recursive: true, force: true });
      delete process.env.E2E_RUN;
      delete process.env.E2E_TOKEN;
    });
    const { default: config } = await import("../e2e/playwright.config");
    const { paths } = await import("../e2e/support/run");
    const outputs = [
      config.outputDir as string,
      paths().findings,
      paths().logs,
      paths().slot(0, "journeys"),
      paths().dist,
      ...(config.reporter as unknown as [string, Record<string, string>?][]).flatMap(([, o]) => [o?.outputFile, o?.outputFolder].filter((x): x is string => typeof x === "string")),
    ];
    expect(outputs.length).toBeGreaterThanOrEqual(7);
    for (const path of outputs) {
      expect(inside(REPO, path), path).toBe(false);
      expect(inside(run, path), path).toBe(true);
    }
    expect(config.updateSnapshots).toBe("none");
    // A committed test.only never focuses a run (task 9 review); the run's nonce marks its report as its own.
    expect(config.forbidOnly).toBe(true);
    expect(config.metadata).toEqual({ nonce: process.env.E2E_NONCE ?? "" });
    // One spec file per project: only fullyParallel spreads a project's tests across the workers (F4).
    const spread = (config.projects ?? []).filter((p) => p.fullyParallel).map((p) => p.name);
    expect(spread).toEqual(["support", "privacy", "failure", "forms", "layout", "phone"]);
  });

  it("the suite's seed runs on the fixed clock; a hand-seeded sample (npm run seed:sample) doesn't", async () => {
    const { seedArgs } = await import("../e2e/support/global-setup");
    expect(seedArgs("/tmp/run/seed", "/tmp/run/seeded-on")).toEqual(["scripts/seed-sample.ts", "--long", "--fixed-clock", "--persist", "/tmp/run/seed", "--seeded-on", "/tmp/run/seeded-on"]);
    const pkg = JSON.parse(readFileSync(join(WEB, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["seed:sample"]).not.toContain("--fixed-clock");
  });

  it("builds each run into its own directory, so two runs never share app/web/dist (task 5 review)", async () => {
    const { buildArgs } = await import("../e2e/support/global-setup");
    const { paths } = await import("../e2e/support/run");
    const a = mkdtempSync(join(tmpdir(), "gym-e2e-config-"));
    const b = mkdtempSync(join(tmpdir(), "gym-e2e-config-"));
    onTestFinished(() => {
      for (const d of [a, b]) rmSync(d, { recursive: true, force: true });
    });
    const outDir = (args: string[]) => args[args.indexOf("--outDir") + 1]!;
    expect(outDir(buildArgs(a))).toBe(paths(a).dist);
    expect(outDir(buildArgs(b))).toBe(paths(b).dist);
    expect(paths(a).dist).not.toBe(paths(b).dist);
    expect(inside(a, paths(a).dist) && !inside(REPO, paths(a).dist)).toBe(true);
    expect(buildArgs(a)).toContain("--emptyOutDir");
  });

  it("nothing a page does reaches past this machine: no DNS for other hosts, no service workers (plan review, completeness F1)", async () => {
    const { default: config } = await import("../e2e/playwright.config");
    expect(config.use?.serviceWorkers).toBe("block");
    const rules = (config.use?.launchOptions?.args ?? []).find((a) => a.startsWith("--host-resolver-rules="));
    expect(rules).toBe("--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1");
  });

  it("pins the runner exactly, with one playwright-core installed", () => {
    const pkg = JSON.parse(readFileSync(join(WEB, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies["@playwright/test"]).toBe("1.64.0");
    expect(pkg.devDependencies["playwright-core"]).toBe("1.64.0");
    const ls = spawnSync("npm", ["ls", "playwright-core", "--all", "--json"], { cwd: REPO, encoding: "utf8" });
    const versions = new Set<string>();
    const walk = (node: { dependencies?: Record<string, { version?: string; dependencies?: unknown }> }) => {
      for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
        if (name === "playwright-core" && dep.version) versions.add(dep.version);
        walk(dep as never);
      }
    };
    walk(JSON.parse(ls.stdout) as never);
    expect([...versions]).toEqual(["1.64.0"]);
  });

  it("vendors Mukta 400, 500 and 700 with its licence (plan review, completeness F1)", () => {
    for (const f of ["Mukta-Regular.ttf", "Mukta-Medium.ttf", "Mukta-Bold.ttf"]) {
      expect(readFileSync(join(WEB, "e2e", "fixtures", "fonts", f)).subarray(0, 4).toString("hex"), f).toBe("00010000");
    }
    expect(readFileSync(join(WEB, "e2e", "fixtures", "fonts", "OFL.txt"), "utf8")).toContain("SIL OPEN FONT LICENSE");
  });

  it("no browser-suite file waits on a clock (spec §2, §11)", () => {
    const files: string[] = [];
    const collect = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (!name.endsWith("-snapshots")) collect(path);
        } else if (path.endsWith(".ts")) files.push(path);
      }
    };
    collect(join(WEB, "e2e"));
    for (const extra of ["scripts/states.ts", "scripts/audit.ts"]) if (existsSync(join(WEB, extra))) files.push(join(WEB, extra));
    const offenders = files.filter((f) => /waitForTimeout|setTimeout\(/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => relative(WEB, f))).toEqual([]);
  });
});

describe("the phone project (e2e spec §8)", () => {
  it("compares at most 0.5 % of pixels past a 0.25 threshold; E2E_PHONE_STRICT makes both 0 to calibrate (Task 7)", async () => {
    onTestFinished(() => {
      delete process.env.E2E_PHONE_STRICT;
      vi.resetModules();
    });
    vi.resetModules();
    const plain = await import("../e2e/playwright.config");
    expect(plain.PHONE_SHOT).toEqual({ maxDiffPixelRatio: 0.005, threshold: 0.25 });
    expect(plain.default.expect?.toHaveScreenshot).toMatchObject({ maxDiffPixelRatio: 0.005, threshold: 0.25, scale: "css" });
    process.env.E2E_PHONE_STRICT = "1";
    vi.resetModules();
    const strict = await import("../e2e/playwright.config");
    expect(strict.PHONE_SHOT).toEqual({ maxDiffPixelRatio: 0, threshold: 0 });
    const { PIXEL_LIMIT } = await import("../e2e/support/pixels");
    expect(PIXEL_LIMIT).toBe(plain.PHONE_SHOT.maxDiffPixelRatio);
  });

  it("E2E_PHONE_STRICT is on only for 1 or true: 0, false or empty keep the tolerance", async () => {
    onTestFinished(() => {
      delete process.env.E2E_PHONE_STRICT;
      vi.resetModules();
    });
    for (const [value, strict] of [["1", true], ["true", true], ["0", false], ["false", false], ["", false]] as const) {
      process.env.E2E_PHONE_STRICT = value;
      vi.resetModules();
      const { PHONE_SHOT } = await import("../e2e/playwright.config");
      expect(PHONE_SHOT.threshold, JSON.stringify(value)).toBe(strict ? 0 : 0.25);
    }
  });

  it("commits exactly one baseline per state and theme: none missing, none left over", async () => {
    const { STATE_NAMES } = await import("../scripts/states");
    const dir = join(WEB, "e2e", "phone.spec.ts-snapshots");
    const want = ["light", "dark"].flatMap((t) => STATE_NAMES.map((n) => `${n}-${t}.png`)).sort();
    expect(readdirSync(dir).sort()).toEqual(want);
  });

  it("QUIET stops transitions, animations and the caret", async () => {
    const { QUIET } = await import("../e2e/support/settle");
    expect(QUIET).toBe("*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}");
  });
});
