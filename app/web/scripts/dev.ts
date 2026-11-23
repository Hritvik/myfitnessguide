/**
 * `npm run dev -w @myfitnessguide/web`: makes sure `wrangler dev --local` is
 * serving the API on :8787 (starting it when it isn't), then runs Vite,
 * which proxies /tools to it. Never touches the remote database.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const worker = join(web, "..", "worker");
const API = "http://127.0.0.1:8787/tools";
const children: ChildProcess[] = [];
/** --sample: serve the invented household from `npm run seed:sample` instead of your local data; --sample-long: its stress version (`-- --long`). */
const sampleLong = process.argv.includes("--sample-long");
const sample = sampleLong || process.argv.includes("--sample");
const SAMPLE_DIR = sampleLong ? ".wrangler/sample-long" : ".wrangler/sample";

async function apiUp(): Promise<boolean> {
  try {
    await fetch(API, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[], cwd: string): ChildProcess {
  const child = spawn(cmd, args, { cwd, stdio: "inherit", env: process.env });
  children.push(child);
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) console.error(`${cmd} ${args.join(" ")} exited with ${code}`);
    shutdown(code ?? 0);
  });
  return child;
}

function shutdown(code: number): never {
  for (const c of children) if (!c.killed) c.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

if (await apiUp()) {
  if (sample) {
    console.error("An API is already running on :8787; stop it before serving the sample household.");
    process.exit(1);
  }
  console.log("Using the API already running on :8787.");
} else {
  if (sample && !existsSync(join(worker, SAMPLE_DIR))) {
    console.error(`No sample household yet. Run: npm run seed:sample -w @myfitnessguide/web${sampleLong ? " -- --long" : ""}`);
    process.exit(1);
  }
  if (!sample && !existsSync(join(worker, ".dev.vars"))) {
    console.error(
      'No app/worker/.dev.vars. Create it with LOCAL_DEV_IDENTITY="member:<your email>" (see app/web/README.md), then run this again.',
    );
    process.exit(1);
  }
  // The Worker serves app/web/dist as its static assets, and wrangler dev refuses
  // to start without the directory. In development Vite serves the app, so an
  // empty directory is enough.
  mkdirSync(join(web, "dist"), { recursive: true });
  console.log("Starting wrangler dev --local on :8787 …");
  const extra = sample ? ["--persist-to", SAMPLE_DIR, "--var", "LOCAL_DEV_IDENTITY:member:asha@example.com"] : [];
  run("npx", ["wrangler", "dev", "--local", "--port", "8787", "--ip", "127.0.0.1", ...extra], worker);
  const deadline = Date.now() + 60_000;
  while (!(await apiUp())) {
    if (Date.now() > deadline) {
      console.error("wrangler dev didn't answer on :8787 within 60 s.");
      shutdown(1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

run("npx", ["vite"], web);
