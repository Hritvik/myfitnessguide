// The pending check (ticket 78 step 3), against a stubbed fetch: never the live API.
import { spawn } from "node:child_process";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkPending, describe as describeResult, exitCodeFor, FAILED, NOTHING_PENDING, SOMETHING_PENDING } from "../src/pending-check.ts";
import { CLIENT_ID, SECRET, startFakeApi, tempDir, writeToken } from "./harness.ts";

const BASE = "https://api.invalid";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A synthetic pending entry; its text must never reach the output. */
const entry = (id: number) => ({ id, member: "Hritvik", status: "pending", text: `synthetic-entry-text-${id}` });

let calls: { url: string; init: RequestInit }[] = [];
function stubFetch(answer: () => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal("fetch", async (url: URL | string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return answer();
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function check(answer: () => Response | Promise<Response>, tokenFile = writeToken(tempDir())) {
  stubFetch(answer);
  const result = await checkPending({ baseUrl: BASE, tokenFile });
  return { result, code: exitCodeFor(result), line: describeResult(result) };
}

describe("the pending check", () => {
  it("exits 0 when nothing is pending", async () => {
    const r = await check(() => json(200, { status: "ok", entries: [], truncated: false }));
    expect(r.code).toBe(NOTHING_PENDING);
    expect(NOTHING_PENDING).toBe(0);
    expect(r.line).toBe("nothing pending");
  });

  it("exits 10 when something is pending, saying how many and nothing else", async () => {
    const r = await check(() => json(200, { status: "ok", entries: [entry(1), entry(2)], truncated: false }));
    expect(r.code).toBe(SOMETHING_PENDING);
    expect(SOMETHING_PENDING).toBe(10);
    expect(r.line).toBe("2 pending");
    expect(r.line).not.toContain("synthetic-entry-text");
  });

  it("says when there are more than the API returns", async () => {
    const r = await check(() => json(200, { status: "ok", entries: Array.from({ length: 100 }, (_, i) => entry(i + 1)), truncated: true }));
    expect([r.code, r.line]).toEqual([SOMETHING_PENDING, "100+ pending"]);
  });

  it("asks inbox_entries for pending entries once, as the agent with the service token", async () => {
    await check(() => json(200, { status: "ok", entries: [], truncated: false }));
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe(`${BASE}/tools/inbox_entries`);
    expect(call!.init.method).toBe("POST");
    expect(JSON.parse(String(call!.init.body))).toEqual({ status: "pending" });
    expect(call!.init.redirect).toBe("manual");
    const headers = call!.init.headers as Record<string, string>;
    expect(headers["CF-Access-Client-Id"]).toBe(CLIENT_ID);
    expect(headers["CF-Access-Client-Secret"]).toBe(SECRET);
    expect(headers["user-agent"]).toMatch(/^myfitnessguide-mcp\//);
  });

  it.each([
    ["an Access login redirect", () => new Response("", { status: 302, headers: { location: "https://x.cloudflareaccess.com/login" } }), /Access refused/],
    ["an Access HTML page", () => new Response("<html>Forbidden</html>", { status: 403, headers: { "content-type": "text/html" } }), /Access refused/],
    ["an API error", () => json(403, { status: "error", error: { code: "forbidden", message: "not a known service token" } }), /HTTP 403 \(forbidden\)/],
    ["a clarification", () => json(200, { status: "needs_clarification", question: "Who?" }), /needs_clarification/],
    ["a reply without JSON", () => new Response("boom", { status: 500 }), /HTTP 500 without JSON/],
    ["a reply without an entries list", () => json(200, { status: "ok" }), /without an entries list/],
    ["an unreachable API", () => Promise.reject(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") })), /could not reach/],
  ])("fails (never exits 0) on %s", async (_name, answer, reason) => {
    const r = await check(answer);
    expect(r.code).toBe(FAILED);
    expect(r.code).not.toBe(NOTHING_PENDING);
    expect(r.code).not.toBe(SOMETHING_PENDING);
    expect(r.line).toMatch(reason);
    expect(r.line).not.toContain(SECRET.slice(0, 8));
  });

  it("fails on a missing or malformed token file without quoting it, and calls nothing", async () => {
    const dir = tempDir();
    for (const tokenFile of [join(dir, "missing.json"), writeToken(dir, `{"client_id":"x","client_secret":"${SECRET}"`)]) {
      const r = await check(() => json(200, { status: "ok", entries: [] }), tokenFile);
      expect(r.code).toBe(FAILED);
      expect(r.line).toMatch(/service token file/);
      expect(r.line).not.toContain(SECRET.slice(0, 8));
      expect(calls).toHaveLength(0);
    }
  });
});

describe("the script", () => {
  const SCRIPT = fileURLToPath(new URL("../src/pending.ts", import.meta.url));

  /** Run the script as a child process (async, so an in-process fake API keeps answering). */
  function run(env: Record<string, string>, script = SCRIPT): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH ?? "", ...env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += String(c)));
      child.stderr.on("data", (c) => (stderr += String(c)));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  }

  // A local stand-in API on 127.0.0.1, not the Worker.
  it.each([
    [[], 0, /^\[pending\] nothing pending\n$/],
    [[entry(7)], 10, /^\[pending\] 1 pending\n$/],
  ] as const)("exits with the code for %j and prints only the count", async (entries, code, line) => {
    const api = await startFakeApi();
    api.handle(() => ({ body: { status: "ok", entries, truncated: false } }));
    const dir = tempDir();
    try {
      const r = await run({ HOME: dir, MYFITNESSGUIDE_API_URL: api.url, MYFITNESSGUIDE_TOKEN_FILE: writeToken(dir) });
      expect(r.status).toBe(code);
      expect(r.stderr).toMatch(line);
      expect(r.stdout).toBe("");
    } finally {
      await api.close();
    }
  }, 20_000);

  it("exits 1 when the API can't be reached", async () => {
    const dir = tempDir();
    const r = await run({ HOME: dir, MYFITNESSGUIDE_API_URL: "http://127.0.0.1:9", MYFITNESSGUIDE_TOKEN_FILE: writeToken(dir) });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/FAILED: could not reach/);
    expect(r.stderr).not.toContain(SECRET.slice(0, 8));
  }, 20_000);

  // Review M1: started under another name it must still ask, never fall through to exit 0.
  it("still checks when started through a symlink with another name", async () => {
    const api = await startFakeApi();
    api.handle(() => ({ body: { status: "ok", entries: [entry(3)], truncated: false } }));
    const dir = tempDir();
    const link = join(dir, "inbox-check.mjs");
    symlinkSync(SCRIPT, link);
    try {
      const r = await run({ HOME: dir, MYFITNESSGUIDE_API_URL: api.url, MYFITNESSGUIDE_TOKEN_FILE: writeToken(dir) }, link);
      expect(r.status).toBe(10);
      expect(api.seen.filter((s) => s.path === "/tools/inbox_entries")).toHaveLength(1);
    } finally {
      await api.close();
    }
  }, 20_000);
});
