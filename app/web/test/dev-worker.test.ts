import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { devWorkerArgs, freePort, identityHeaders, newToken, portOpen, reapRun, reapStale, ready, stopGroup } from "../scripts/dev-worker";

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
});

async function serveStatus(status: number | ((req: IncomingMessage) => number)): Promise<string> {
  const port = await freePort();
  const server = createServer((req, res) => {
    res.writeHead(typeof status === "number" ? status : status(req), { "content-type": "application/json" });
    res.end("{}");
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return `http://127.0.0.1:${port}`;
}

describe("the run's identity (e2e spec §3)", () => {
  it("a token is 32 random bytes as 64 hex characters, new each time", () => {
    const a = newToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(newToken()).not.toBe(a);
  });

  it("the headers name the member and carry the token", () => {
    expect(identityHeaders("asha@example.com", "ab")).toEqual({ "X-Local-Identity": "member:asha@example.com", "X-Local-Identity-Token": "ab" });
  });
});

describe("the dev entry's command line", () => {
  it("always binds 127.0.0.1 (the dev entry's second lock), locally, on the dev entry, with header mode and this run's token", () => {
    const args = devWorkerArgs({ port: 4321, persist: "/tmp/d1", token: "ab" });
    expect(args.slice(0, 3)).toEqual(["wrangler", "dev", "--local"]);
    expect(args[args.indexOf("--ip") + 1]).toBe("127.0.0.1");
    expect(args.filter((a) => a === "--ip")).toHaveLength(1);
    expect(args[args.indexOf("--port") + 1]).toBe("4321");
    expect(args[args.indexOf("--persist-to") + 1]).toBe("/tmp/d1");
    expect(args).toContain("src/dev-entry.ts");
    expect(args).toContain("LOCAL_DEV_IDENTITY:header");
    expect(args).toContain("LOCAL_IDENTITY_TOKEN:ab");
    expect(args.some((a) => /remote/.test(a))).toBe(false);
  });

  it("runs the Worker on the test household's fixed clock only when given it (e2e spec §3, The day): a hand-seeded sample keeps today", async () => {
    const { FIXED_NOW, FIXED_DAY } = await import("../scripts/test-clock");
    expect(devWorkerArgs({ port: 4321, persist: "/tmp/d1", token: "ab", fixedNow: FIXED_NOW })).toContain(`LOCAL_FIXED_NOW:${FIXED_NOW}`);
    expect(devWorkerArgs({ port: 4321, persist: "/tmp/d1", token: "ab" }).some((a) => a.startsWith("LOCAL_FIXED_NOW"))).toBe(false);
    expect(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(FIXED_NOW))).toBe(FIXED_DAY);
  });

  it("gives the inspector a port of its own, so Workers started side by side don't race for 9229", () => {
    const args = devWorkerArgs({ port: 4321, inspectorPort: 4322, persist: "/tmp/d1", token: "ab" });
    expect(args[args.indexOf("--inspector-port") + 1]).toBe("4322");
    expect(devWorkerArgs({ port: 4321, persist: "/tmp/d1", token: "ab" })).not.toContain("--inspector-port");
  });

  it("serves the run's own build when given one, so two runs never share app/web/dist", () => {
    const args = devWorkerArgs({ port: 4321, persist: "/tmp/d1", token: "ab", assets: "/tmp/run-a/dist" });
    expect(args[args.indexOf("--assets") + 1]).toBe("/tmp/run-a/dist");
    expect(devWorkerArgs({ port: 4321, persist: "/tmp/d1", token: "ab" })).not.toContain("--assets");
  });
});

describe("ports and readiness", () => {
  it("the OS gives a free port", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(1024);
    expect(await portOpen(port)).toBe(false);
  });

  /** A Worker that checks the token, as the dev entry does: 200 to `token`, 401 to any other. */
  const checksToken = (token: string) => (req: IncomingMessage) => (req.headers["x-local-identity-token"] === token ? 200 : 401);

  it("ready resolves when GET /tools answers 200 to the token and 401 to a wrong one", async () => {
    const token = newToken();
    await expect(ready(await serveStatus(checksToken(token)), identityHeaders("asha@example.com", token), 5_000)).resolves.toBeUndefined();
  });

  it("ready refuses a Worker that answers 200 whatever the token (npm run dev, the layout sweep's Worker)", async () => {
    const t0 = Date.now();
    await expect(ready(await serveStatus(200), identityHeaders("asha@example.com", newToken()), 30_000)).rejects.toThrow(/ignores the token/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("ready stops at once when the port answers 401: another Worker owns it", async () => {
    const t0 = Date.now();
    await expect(ready(await serveStatus(401), identityHeaders("asha@example.com", newToken()), 30_000)).rejects.toThrow(/another Worker owns the port/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("a 403 names the probe member first, then another Worker", async () => {
    await expect(ready(await serveStatus(403), identityHeaders("asha@example.com", newToken()), 30_000)).rejects.toThrow(/asha@example.com isn't a member in this Worker's data \(or another Worker owns the port\)/);
  });

  it("ready stops at once when the Worker's process has ended", async () => {
    const port = await freePort();
    const t0 = Date.now();
    await expect(ready(`http://127.0.0.1:${port}`, {}, 30_000, () => "wrangler dev exited with code 1")).rejects.toThrow(/wrangler dev exited with code 1/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("ready gives up when nothing answers", async () => {
    const port = await freePort();
    await expect(ready(`http://127.0.0.1:${port}`, {}, 1_000)).rejects.toThrow(/didn't answer/);
  });
});

describe("stopping a Worker's whole process group", () => {
  it("kills a grandchild that holds the port, and returns once the port refuses", async () => {
    const port = await freePort();
    // A parent that spawns a grandchild listening on the port, as npx → wrangler → workerd do.
    const script = `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", "require('node:http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1')"], { stdio: "ignore" });
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
    const deadline = Date.now() + 10_000;
    while (!(await portOpen(port))) {
      if (Date.now() > deadline) throw new Error("the grandchild never listened");
      await new Promise((r) => setTimeout(r, 100));
    }
    await stopGroup(child.pid as number, port, 10_000);
    expect(await portOpen(port)).toBe(false);
  });

  /** A detached process group whose grandchild listens on a fresh port, as a Worker does. */
  async function holdingGroup(): Promise<{ pid: number; port: number }> {
    const port = await freePort();
    const script = `require("node:child_process").spawn(process.execPath, ["-e", "require('node:http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1')"], { stdio: "ignore" }); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
    const deadline = Date.now() + 10_000;
    while (!(await portOpen(port))) {
      if (Date.now() > deadline) throw new Error("the group never listened");
      await new Promise((r) => setTimeout(r, 100));
    }
    return { pid: child.pid as number, port };
  }

  /** The pid of a process that has already exited: a killed run's owner. */
  async function deadPid(): Promise<number> {
    const p = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((r) => p.once("exit", r));
    return p.pid as number;
  }

  it("a process that tracked a group takes it down when it is SIGTERM'd", async () => {
    const port = await freePort();
    const devWorker = fileURLToPath(new URL("../scripts/dev-worker.ts", import.meta.url));
    // The parent tracks a detached group (as startDevWorker does), then is killed from outside.
    const parent = spawn(process.execPath, ["--input-type=module", "-e", `
      import { spawn } from "node:child_process";
      import { track } from ${JSON.stringify(devWorker)};
      const g = spawn(process.execPath, ["-e", "require('node:http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1')"], { detached: true, stdio: "ignore" });
      track(g.pid);
      setInterval(() => {}, 1000);
    `], { stdio: "ignore" });
    const deadline = Date.now() + 10_000;
    while (!(await portOpen(port))) {
      if (Date.now() > deadline) throw new Error("the tracked group never listened");
      await new Promise((r) => setTimeout(r, 100));
    }
    parent.kill("SIGTERM");
    await new Promise((r) => parent.once("exit", r));
    const closed = Date.now() + 5_000;
    while (await portOpen(port)) {
      if (Date.now() > closed) throw new Error("the tracked group outlived its parent");
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(await portOpen(port)).toBe(false);
  });

  it("the next run reaps a group a killed run recorded, and clears the record", async () => {
    const { pid, port } = await holdingGroup();
    const tmp = mkdtempSync(join(tmpdir(), "gym-reap-"));
    mkdirSync(join(tmp, "gym-e2e-old"));
    writeFileSync(join(tmp, "gym-e2e-old", "owner"), String(await deadPid()));
    writeFileSync(join(tmp, "gym-e2e-old", "pids"), `${pid}\n`);
    expect(reapStale(tmp, () => true)).toEqual([pid]);
    const closed = Date.now() + 5_000;
    while (await portOpen(port)) {
      if (Date.now() > closed) throw new Error("the recorded group survived the reap");
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(existsSync(join(tmp, "gym-e2e-old", "pids"))).toBe(false);
    // A record that held only owner and pids (a seed's) is gone; one with anything else in it is kept.
    expect(existsSync(join(tmp, "gym-e2e-old"))).toBe(false);
    mkdirSync(join(tmp, "gym-e2e-old"));
    writeFileSync(join(tmp, "gym-e2e-old", "findings.json"), "{}");
    // A recorded pid that isn't ours (reused by another program) is left alone,
    // and so is every group of a run whose owner is still alive (this test's own process here).
    const other = await holdingGroup();
    writeFileSync(join(tmp, "gym-e2e-old", "pids"), `${other.pid}\n`);
    expect(reapStale(tmp, () => false)).toEqual([]);
    writeFileSync(join(tmp, "gym-e2e-old", "pids"), `${other.pid}\n`);
    writeFileSync(join(tmp, "gym-e2e-old", "owner"), String(process.pid));
    expect(reapStale(tmp, () => true)).toEqual([]);
    expect(await portOpen(other.port)).toBe(true);
    await stopGroup(other.pid, other.port, 5_000);
  });

  it("a run ending green stops every group it recorded, its owner still alive, and clears the record", async () => {
    const { pid, port } = await holdingGroup();
    const run = mkdtempSync(join(tmpdir(), "gym-reap-run-"));
    writeFileSync(join(run, "owner"), String(process.pid));
    writeFileSync(join(run, "pids"), `${pid}\n${await deadPid()}\n`);
    expect(reapRun(run, () => true)).toEqual([pid]);
    const closed = Date.now() + 5_000;
    while (await portOpen(port)) {
      if (Date.now() > closed) throw new Error("the recorded group survived");
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(existsSync(join(run, "pids"))).toBe(false);
    expect(reapRun(run, () => true)).toEqual([]);
  });

  it("a run directory without an owner is left alone until it is old enough to be abandoned", async () => {
    const { pid, port } = await holdingGroup();
    const tmp = mkdtempSync(join(tmpdir(), "gym-reap-"));
    mkdirSync(join(tmp, "gym-e2e-new"));
    const pids = join(tmp, "gym-e2e-new", "pids");
    writeFileSync(pids, `${pid}\n`);
    expect(reapStale(tmp, () => true)).toEqual([]);
    expect(await portOpen(port)).toBe(true);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(pids, old, old);
    expect(reapStale(tmp, () => true)).toEqual([pid]);
    await stopGroup(pid, port, 5_000);
  });

  it("by default it reaps only groups that run wrangler or workerd, even once their leader has gone", async () => {
    // A leader that starts a "workerd" grandchild in its group, then exits: the group has no leader.
    const port = await freePort();
    const grandchild = `/* workerd */ require('node:http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1')`;
    const leader = spawn(process.execPath, ["-e", `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" }).unref(); setTimeout(() => process.exit(0), 300);`], { detached: true, stdio: "ignore" });
    const deadline = Date.now() + 10_000;
    while (!(await portOpen(port))) {
      if (Date.now() > deadline) throw new Error("the grandchild never listened");
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => (leader.exitCode === null ? leader.once("exit", r) : r(null)));
    // And a group that runs neither, which the default spares.
    const other = await holdingGroup();
    const tmp = mkdtempSync(join(tmpdir(), "gym-reap-"));
    mkdirSync(join(tmp, "gym-e2e-old"));
    writeFileSync(join(tmp, "gym-e2e-old", "owner"), String(await deadPid()));
    writeFileSync(join(tmp, "gym-e2e-old", "pids"), `${leader.pid}\n${other.pid}\n`);
    expect(reapStale(tmp)).toEqual([leader.pid]);
    const closed = Date.now() + 5_000;
    while (await portOpen(port)) {
      if (Date.now() > closed) throw new Error("the leaderless group survived the reap");
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(await portOpen(other.port)).toBe(true);
    await stopGroup(other.pid, other.port, 5_000);
  });

  it("stopGroup returns only once the whole group is gone, not just the port", async () => {
    // A leader that shrugs off SIGTERM while its grandchild, holding the port, dies of it.
    const port = await freePort();
    const script = `process.on("SIGTERM", () => {}); require("node:child_process").spawn(process.execPath, ["-e", "require('node:http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1')"], { stdio: "ignore" }); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
    const deadline = Date.now() + 10_000;
    while (!(await portOpen(port))) {
      if (Date.now() > deadline) throw new Error("the group never listened");
      await new Promise((r) => setTimeout(r, 100));
    }
    await stopGroup(child.pid as number, port, 2_000);
    expect(await portOpen(port)).toBe(false);
    expect(() => process.kill(-(child.pid as number), 0)).toThrow();
  });
});
