/**
 * A local Worker for the sample seed and the browser suite (e2e spec §3):
 * `wrangler dev --local` on the dev-only entry (app/worker/src/dev-entry.ts),
 * members signed in by the X-Local-Identity header, an OS-assigned port and a
 * per-run token. Ready means GET /tools answers 200 to this run's token and
 * 401 to a wrong one; anything else from a Worker on the port (a 401 or 403 to
 * this run's token, a 200 to a wrong one) means it isn't this run's, and the
 * run stops rather than test against it or write into its data. Never remote.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
export const WORKER = join(WEB, "..", "worker");

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 32 random bytes as 64 hex characters: the dev entry's third lock, new per run. */
export function newToken(): string {
  return randomBytes(32).toString("hex");
}

export function identityHeaders(email: string, token: string): Record<string, string> {
  return { "X-Local-Identity": `member:${email}`, "X-Local-Identity-Token": token };
}

/** A port the OS has just handed out and released. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** True when something accepts a connection on 127.0.0.1:<port>. */
export function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

const probe = async (origin: string, headers: Record<string, string>): Promise<number | null> => {
  try {
    return (await fetch(`${origin}/tools`, { headers, signal: AbortSignal.timeout(2_000) })).status;
  } catch {
    return null;
  }
};

/**
 * Resolves once GET /tools answers 200 to these headers and 401 to the same
 * member with a wrong token: only the dev entry holding this run's token
 * answers both that way. A Worker that answers 200 to the wrong token ignores
 * tokens (`npm run dev`, the layout sweep's Worker: the shipped entry with a
 * fixed member) and would take this run's writes into its data, so it throws
 * at once, as does a 401 or 403 to this run's token. `ended`, polled each
 * round, reports why the Worker's own process has gone (it throws with that).
 */
export async function ready(origin: string, headers: Record<string, string>, timeoutMs = 60_000, ended?: () => string | null): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const gone = ended?.();
    if (gone) throw new Error(`${origin} never became ready: ${gone}`);
    const status = await probe(origin, headers);
    if (status === 200) {
      const wrong = await probe(origin, { ...headers, "X-Local-Identity-Token": newToken() });
      if (wrong === 401) return;
      throw new Error(`${origin} answers ${wrong ?? "nothing"} to a wrong token: a Worker that ignores the token owns the port (npm run dev, or the layout sweep's). Stop it; the run never writes to it.`);
    }
    if (status === 401) {
      throw new Error(`${origin} answers 401 to this run's token: another Worker owns the port (another run, or npm run dev). Stop it; the run never tests against it.`);
    }
    if (status === 403) {
      const member = (headers["X-Local-Identity"] ?? "").replace(/^member:/, "");
      throw new Error(`${origin} answers 403 to this run's token: ${member} isn't a member in this Worker's data (or another Worker owns the port).`);
    }
    if (Date.now() > deadline) throw new Error(`${origin} didn't answer within ${Math.round(timeoutMs / 1000)} s`);
    await pause(300);
  }
}

const groups = new Set<number>();
let hooked = false;

function killGroups(): void {
  for (const pid of groups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  groups.clear();
}

/** This process kills the group when it ends, however it ends: an interrupted run leaves no Worker behind (plan review, completeness F4). */
export function track(pid: number): void {
  groups.add(pid);
  if (hooked) return;
  hooked = true;
  process.once("exit", killGroups);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      killGroups();
      process.kill(process.pid, sig);
    });
  }
}

/** Whether `kill(target, 0)` finds it: ESRCH is gone; EPERM is alive but not ours to signal. */
function exists(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether any process in group `pgid` (its leader or not: npx may be gone while workerd runs) is running wrangler or workerd. */
export function groupRunsWrangler(pgid: number): boolean {
  const out = spawnSync("ps", ["-A", "-o", "pgid=,command="], { encoding: "utf8" }).stdout ?? "";
  return out.split("\n").some((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    return m !== null && Number(m[1]) === pgid && /wrangler|workerd/.test(m[2]!);
  });
}

/** How old a run directory's `pids` must be before a missing `owner` counts as abandoned. */
export const STALE_MS = 60 * 60 * 1000;

/**
 * What a SIGKILL'd run left behind: in every <tmp>/gym-e2e-* whose owner (the
 * process that made it, in its `owner` file) is gone, each group recorded in
 * `pids` that still exists and still runs wrangler or workerd (any member of
 * the group, so a group whose leader died is still found) is killed, and the
 * record is cleared. A run still going is left alone, so two runs side by
 * side never stop each other's Workers; a directory with no `owner` counts as
 * a run still starting until its `pids` is `staleMs` old. Returns the pids it
 * killed. A directory left holding only `owner` is removed.
 */
export function reapStale(tmp: string, isOurs: (pid: number) => boolean = groupRunsWrangler, staleMs = STALE_MS): number[] {
  const reaped: number[] = [];
  for (const dir of readdirSync(tmp).filter((d) => d.startsWith("gym-e2e-"))) {
    const file = join(tmp, dir, "pids");
    if (!existsSync(file)) continue;
    const owner = join(tmp, dir, "owner");
    if (existsSync(owner)) {
      const pid = Number(readFileSync(owner, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && exists(pid)) continue;
    } else if (Date.now() - statSync(file).mtimeMs < staleMs) {
      continue;
    }
    reaped.push(...reapRun(join(tmp, dir), isOurs));
    // A record that held nothing else (a seed's) goes with its last pid; a kept run directory stays.
    if (readdirSync(join(tmp, dir)).every((f) => f === "owner")) rmSync(join(tmp, dir), { recursive: true, force: true });
  }
  return reaped;
}

/**
 * Kills every group recorded in `<run>/pids` that still exists and is ours,
 * whatever the run's owner, and removes the record. A run that ends calls it
 * on its own directory before deleting it: a Playwright worker that was
 * SIGKILL'd never ran its exit hook, and its Worker would otherwise outlive
 * the only record of it. Returns the pids it killed.
 */
export function reapRun(run: string, isOurs: (pid: number) => boolean = groupRunsWrangler): number[] {
  const file = join(run, "pids");
  if (!existsSync(file)) return [];
  const reaped: number[] = [];
  for (const pid of readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number)) {
    if (!Number.isInteger(pid) || pid <= 1 || !exists(-pid) || !isOurs(pid)) continue;
    try {
      process.kill(-pid, "SIGKILL");
      reaped.push(pid);
    } catch {
      // Gone in between, or not ours to signal.
    }
  }
  rmSync(file, { force: true });
  return reaped;
}

/**
 * Stops a detached process group (npx, wrangler, workerd): SIGTERM, then
 * SIGKILL after `timeoutMs`, and returns once the port refuses and no process
 * of the group is left. It stays tracked (killed at exit) unless that happens.
 */
export async function stopGroup(pid: number, port: number, timeoutMs = 15_000): Promise<void> {
  const signal = (s: NodeJS.Signals) => {
    try {
      process.kill(-pid, s);
    } catch {
      // Already gone.
    }
  };
  const stopped = async () => !exists(-pid) && !(await portOpen(port));
  signal("SIGTERM");
  let deadline = Date.now() + timeoutMs;
  let killed = false;
  while (!(await stopped())) {
    if (Date.now() > deadline) {
      if (killed) throw new Error(`process group ${pid} (port ${port}) is still there after SIGKILL`);
      signal("SIGKILL");
      killed = true;
      deadline = Date.now() + 5_000;
    }
    await pause(200);
  }
  groups.delete(pid);
}

export interface DevWorker {
  origin: string;
  port: number;
  persist: string;
  pid: number;
  stop(): Promise<void>;
}

/**
 * The command line (after `npx`): local only, always bound to 127.0.0.1 (the
 * dev entry's second lock trusts only a local hostname; there is no option to
 * bind anything else), the dev entry in place of `main`, header mode, this
 * run's token and, when `fixedNow` is given, the fixed clock (test-clock.ts). `inspectorPort` gives the devtools inspector its own port: left
 * to wrangler, Workers started side by side all try 9229 and the losers exit
 * with "Address already in use". `assets` serves a build other than
 * app/web/dist (wrangler.jsonc's directory; the rest of its assets config
 * stands): the browser suite builds into its run directory, so two runs never
 * serve each other's half-written build.
 */
export function devWorkerArgs(opts: { port: number; inspectorPort?: number; persist: string; token: string; assets?: string; fixedNow?: string }): string[] {
  return [
    "wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", String(opts.port), "--persist-to", opts.persist, "src/dev-entry.ts",
    ...(opts.inspectorPort ? ["--inspector-port", String(opts.inspectorPort)] : []),
    ...(opts.assets ? ["--assets", opts.assets] : []),
    "--var", "LOCAL_DEV_IDENTITY:header", "--var", `LOCAL_IDENTITY_TOKEN:${opts.token}`,
    // The test household's fixed clock (worker decision 162), when given: the suite's seed and slots write and read
    // on one instant. A hand-seeded sample (npm run seed:sample) runs on today.
    ...(opts.fixedNow ? ["--var", `LOCAL_FIXED_NOW:${opts.fixedNow}`] : []),
  ];
}

/**
 * `wrangler dev --local` on the dev entry against `persist`, ready for this
 * run's token. The group is tracked (killed when this process ends) and its
 * pid appended to `pidFile`, so a later run can reap it if this one is SIGKILL'd.
 */
export async function startDevWorker(opts: { persist: string; token: string; probeEmail: string; port?: number; log?: string; pidFile?: string; assets?: string; fixedNow?: string }): Promise<DevWorker> {
  const port = opts.port ?? (await freePort());
  let inspectorPort = await freePort();
  while (inspectorPort === port) inspectorPort = await freePort();
  mkdirSync(opts.assets ?? join(WEB, "dist"), { recursive: true }); // wrangler dev needs the assets directory to exist
  const out = opts.log ? openSync(opts.log, "a") : "ignore";
  const child = spawn("npx", devWorkerArgs({ port, inspectorPort, persist: opts.persist, token: opts.token, assets: opts.assets, fixedNow: opts.fixedNow }), {
    cwd: WORKER, detached: true, stdio: ["ignore", out, out], env: { ...process.env, CI: "1" },
  });
  if (typeof out === "number") closeSync(out); // the child holds its own copy; a restart per test must not leak one per start
  let ended: string | null = null;
  child.on("error", (error) => {
    ended = `wrangler dev couldn't start: ${error.message}`;
  });
  child.once("exit", (code, signal) => {
    ended = `wrangler dev exited (${signal ?? `code ${code}`})${opts.log ? `; see ${opts.log}` : ""}`;
  });
  const pid = child.pid;
  if (pid === undefined) {
    await pause(0); // let the 'error' event name the cause
    throw new Error(ended ?? "wrangler dev didn't start");
  }
  track(pid);
  if (opts.pidFile) appendFileSync(opts.pidFile, `${pid}\n`);
  const origin = `http://127.0.0.1:${port}`;
  const worker: DevWorker = { origin, port, persist: opts.persist, pid, stop: () => stopGroup(pid, port) };
  try {
    await ready(origin, identityHeaders(opts.probeEmail, opts.token), 60_000, () => ended);
  } catch (error) {
    // Stop our own group, by its pid; a foreign Worker on the port is left alone.
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    throw error;
  }
  return worker;
}

