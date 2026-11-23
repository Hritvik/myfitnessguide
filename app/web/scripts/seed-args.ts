/**
 * The seed's command line, checked before it touches anything: it deletes
 * its --persist directory first, so that directory must be a sample's, never
 * the real local data (e2e spec §3).
 */
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The value after `--<name>`, or null when the flag is absent. A missing value, or another flag in its place, throws. */
export function argValue(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const value = argv[i + 1];
  if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

/** `--port <n>`: a whole number from 1 to 65535, or undefined when absent (the OS picks). */
export function parsePort(value: string | null): number | undefined {
  if (value === null) return undefined;
  const port = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port must be a whole number from 1 to 65535, not ${JSON.stringify(value)}`);
  return port;
}

/** The path with symlinks resolved as far as it exists (macOS's /var is /private/var). */
function real(path: string): string {
  const abs = resolve(path);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  return parent === abs ? abs : join(real(parent), abs.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
}

const inside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};
const within = (child: string, parent: string) => child === parent || inside(child, parent);

/**
 * Where the seed may write (and first delete): a directory inside
 * `<worker>/.wrangler` other than `state` (the real local data), or inside the
 * temp directory; anywhere else only with `anywhere` (--persist-anywhere).
 * Never `.wrangler/state` or anything in it, `.wrangler` itself or the temp
 * directory itself. Returns the absolute path.
 */
export function checkPersist(dir: string, opts: { worker: string; anywhere?: boolean; tmp?: string }): string {
  const abs = resolve(opts.worker, dir);
  const path = real(abs);
  const wrangler = real(join(opts.worker, ".wrangler"));
  const state = join(wrangler, "state");
  const tmp = real(opts.tmp ?? tmpdir());
  if (within(path, state) || path === wrangler || path === tmp) {
    throw new Error(`The seed refuses --persist ${dir}: it deletes that directory first, and it is the real local data or holds it.`);
  }
  if (!inside(path, wrangler) && !inside(path, tmp) && !opts.anywhere) {
    throw new Error(`The seed refuses --persist ${dir}: it deletes that directory first. Use a directory under app/worker/.wrangler or the temp directory, or add --persist-anywhere.`);
  }
  return abs;
}
