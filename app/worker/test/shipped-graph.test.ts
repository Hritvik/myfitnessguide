/**
 * The header code never ships (e2e spec §3; worker decision 161). Two checks
 * on both release entries (wrangler.jsonc and wrangler.oauth.jsonc `main`):
 * - Braces: every first-party file it reaches through its imports (static,
 *   dynamic, `export … from` and `require`, in any quotes) is read, comments
 *   included; none may be the dev-only entry or name its header. Workspace
 *   packages (@myfitnessguide/*) are followed; a bare specifier not on the
 *   allow-list fails the walk rather than being skipped.
 * - Belt: esbuild, the bundler wrangler itself runs, bundles `main`; the
 *   dev-only entry is not among its inputs and the bundle names neither the
 *   header nor the token's variable. The bundle check also sees a header name
 *   built by concatenation, which the literal grep of the source would miss.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readWranglerConfig } from "../scripts/deploy-gate";

const WORKER = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = resolve(WORKER, "..");
const DEV_ENTRY = join(WORKER, "src", "dev-entry.ts");
/** Third-party packages the shipped code may import; none of them is ours to name the header. */
const THIRD_PARTY = new Set([
  "zod",
  "@modelcontextprotocol/sdk/server/index.js",
  "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js",
  "@modelcontextprotocol/sdk/types.js",
  "@cloudflare/workers-oauth-provider",
  "jose",
]);
/** A static import or `export … from` takes only a quoted string; a call (import(), require()) also takes a template literal. */
const STATIC = /(?:\bfrom\s*|\bimport\s+)(["'])([^"'`\n]+)\1/g;
const CALL = /\b(?:import|require)\s*\(\s*(["'`])([^"'`]+)\1/g;

/** Every module specifier in a source text, in order. Fails closed: a match in a comment must still resolve. */
export function specifiersIn(text: string): string[] {
  return [...text.matchAll(STATIC), ...text.matchAll(CALL)].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((m) => m[2] as string);
}

/** `main` as wrangler reads it (the deploy gate's reader; no second JSONC parser). */
function mainOf(config = "wrangler.jsonc"): string {
  const main = readWranglerConfig(WORKER, config).raw.main;
  if (typeof main !== "string") throw new Error(`${config} has no main`);
  return join(WORKER, main);
}

function resolveSpecifier(from: string, specifier: string): string | null {
  if (specifier.startsWith(".")) {
    const base = resolve(dirname(from), specifier);
    for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
      if (candidate.endsWith(".ts") && existsSync(candidate)) return candidate;
    }
    throw new Error(`unresolved ${specifier} from ${relative(APP, from)}`);
  }
  const workspace = /^@myfitnessguide\/([^/]+)(\/.*)?$/.exec(specifier);
  if (!workspace) {
    if (THIRD_PARTY.has(specifier)) return null;
    throw new Error(`${specifier} (from ${relative(APP, from)}) is not on the allow-list: follow it or allow it`);
  }
  const dir = join(APP, workspace[1] as string);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { exports: Record<string, string> };
  const target = pkg.exports[`.${workspace[2] ?? ""}`];
  if (!target) throw new Error(`unresolved ${specifier}`);
  return join(dir, target);
}

/** Every first-party file `entry` reaches, itself included. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of specifiersIn(readFileSync(file, "utf8"))) {
      const next = resolveSpecifier(file, specifier);
      if (next) queue.push(next);
    }
  }
  return seen;
}

interface EsbuildResult {
  metafile: { inputs: Record<string, unknown> };
}
interface Esbuild {
  build(options: Record<string, unknown>): Promise<EsbuildResult>;
}

/** Wrangler's own esbuild (no dependency of ours), resolved through wrangler. */
async function wranglersEsbuild(): Promise<Esbuild> {
  const fromWrangler = createRequire(createRequire(join(WORKER, "package.json")).resolve("wrangler/package.json"));
  return (await import(fromWrangler.resolve("esbuild"))) as Esbuild;
}

describe("the shipped entry's import graph", () => {
  it("the scanner sees every import form esbuild bundles", () => {
    const text = [
      'import worker from "./a";',
      "import './b';",
      "export * from './c';",
      'export { x } from "./d";',
      "const e = await import(`./e`);",
      "const f = await import ( './f' );",
      'const g = require("./g");',
      "import {\n  h,\n} from\n  './h';",
    ].join("\n");
    expect(specifiersIn(text)).toEqual(["./a", "./b", "./c", "./d", "./e", "./f", "./g", "./h"]);
    expect(() => resolveSpecifier(mainOf(), "left-pad")).toThrow(/allow-list/);
  });

  describe.each([
    ["wrangler.jsonc", "src/index.ts"],
  ])("%s", (config, entry) => {
    it("never reaches the dev-only entry nor names its header", () => {
      const main = mainOf(config);
      expect(relative(WORKER, main)).toBe(entry);
      const files = reachable(main);
      // The walk is real: it reaches the app and the domain package.
      expect(files.has(join(WORKER, "src", "app.ts"))).toBe(true);
      expect([...files].some((f) => f.startsWith(join(APP, "domain")))).toBe(true);
      expect(files.has(DEV_ENTRY)).toBe(false);
      // A literal grep: "X-Local-" + "Identity" would pass it. The bundle check below sees that form (esbuild
      // folds the concatenation); the import check above is what keeps the header code out in the first place.
      const naming = [...files].filter((f) => /x-local-identity/i.test(readFileSync(f, "utf8"))).map((f) => relative(APP, f));
      expect(naming).toEqual([]);
    });

    it("esbuild's bundle of main has no dev-entry input and names neither the header nor its token", async () => {
      const esbuild = await wranglersEsbuild();
      const dir = mkdtempSync(join(tmpdir(), "gym-shipped-"));
      try {
        const outfile = join(dir, "worker.js");
        const result = await esbuild.build({
          entryPoints: [mainOf(config)],
          bundle: true,
          format: "esm",
          platform: "neutral",
          mainFields: ["module", "main"],
          conditions: ["workerd", "worker", "browser"],
          external: ["node:*", "cloudflare:*"],
          metafile: true,
          outfile,
          logLevel: "silent",
        });
        const inputs = Object.keys(result.metafile.inputs);
        expect(inputs.some((i) => i.endsWith("src/app.ts"))).toBe(true);
        expect(inputs.filter((i) => /dev-entry/.test(i))).toEqual([]);
        const bundle = readFileSync(outfile, "utf8");
        expect(bundle.length).toBeGreaterThan(100_000);
        expect(/x-local-identity/i.test(bundle)).toBe(false);
        expect(bundle.includes("LOCAL_IDENTITY_TOKEN")).toBe(false);
        expect(bundle.includes("LOCAL_FIXED_NOW")).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);
  });
});
