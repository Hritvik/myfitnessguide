import { describe, expect, it } from "vitest";
import { readWranglerConfig, WORKER } from "../scripts/deploy-gate";
import worker, { parseServiceTokens, type Env } from "../src/serve";
import { household } from "./fixtures";
import { SqliteDb } from "./sqlite";

function env(over: Partial<Env> = {}): { env: Env; db: SqliteDb } {
  const db = new SqliteDb();
  household(db.test);
  return { db, env: { DB: db, SERVICE_TOKENS: JSON.stringify({ "mcp-client.access": "claude_code" }), ...over } };
}

const search = (host: string, headers: Record<string, string> = {}) =>
  new Request(`http://${host}/tools/catalogue_search`, { method: "POST", body: JSON.stringify({ query: "rice" }), headers });

describe("the Worker entry point", () => {
  it("normalizes legacy service tokens, accepts explicit trusted channels, and fails closed on invalid config", () => {
    expect(parseServiceTokens(JSON.stringify({
      legacy: "claude_code",
      interactive: { resolver: "hosted_model", channel: "local_agent" },
      background: { resolver: "hosted_model", channel: "unattended" },
    }))).toEqual({
      legacy: { resolver: "claude_code", channel: "local_agent" },
      interactive: { resolver: "hosted_model", channel: "local_agent" },
      background: { resolver: "hosted_model", channel: "unattended" },
    });
    for (const invalid of ["not json", JSON.stringify({ x: "system" }), JSON.stringify({ x: { resolver: "claude_code", channel: "web" } })]) {
      expect(parseServiceTokens(invalid)).toEqual({});
    }
    const poisoned = parseServiceTokens('{"__proto__":{"resolver":"claude_code","channel":"local_agent"}}');
    expect(poisoned).toEqual({});
    expect(Object.getPrototypeOf(poisoned)).toBe(Object.prototype);
  });

  it("refuses a service identity when SERVICE_TOKENS is invalid", async () => {
    const { env: e } = env({ LOCAL_DEV_IDENTITY: "service:mcp-client.access", SERVICE_TOKENS: "not json" });
    expect((await worker.fetch(search("localhost:8787"), e)).status).toBe(403);
  });

  it("refuses inherited object-property names as service client ids", async () => {
    for (const clientId of ["toString", "constructor"]) {
      const { env: e } = env({ LOCAL_DEV_IDENTITY: `service:${clientId}`, SERVICE_TOKENS: "{}" });
      expect((await worker.fetch(search("localhost:8787"), e)).status, clientId).toBe(403);
    }
  });

  it("fails closed when Access isn't configured", async () => {
    const { env: e } = env();
    expect((await worker.fetch(search("api.example.com"), e)).status).toBe(401);
  });

  it("accepts a local dev identity only on localhost", async () => {
    const { env: e } = env({ LOCAL_DEV_IDENTITY: "service:mcp-client.access" });
    expect((await worker.fetch(search("localhost:8787"), e)).status).toBe(200);
    expect((await worker.fetch(search("api.example.com"), e)).status).toBe(401);
  });

  it("the scheduled handler runs the 48 h auto-confirm at the trigger's time", async () => {
    const { env: e, db } = env();
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({ scheduledTime: Date.parse("2026-10-07T08:00:00Z"), cron: "0 * * * *" }, e, { waitUntil: (p: Promise<unknown>) => pending.push(p) });
    const [result] = (await Promise.all(pending)) as { confirmed: unknown[] }[];
    expect(result?.confirmed).toEqual([]);
    expect(db.batches).toBe(0);
  });
});

/** A stand-in for the Workers Static Assets binding, recording what it served. */
function assets() {
  const served: string[] = [];
  return {
    served,
    binding: {
      async fetch(request: Request) {
        served.push(new URL(request.url).pathname);
        return new Response("<!doctype html><title>Gym Tracker</title>", { headers: { "content-type": "text/html" } });
      },
    },
  };
}

describe("one origin for the app and the API", () => {
  it("serves the app shell at / from the static assets", async () => {
    const a = assets();
    const { env: e } = env({ ASSETS: a.binding, ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", ACCESS_AUD: "aud" });
    const response = await worker.fetch(new Request("https://app.example.com/"), e);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>Gym Tracker</title>");
    expect(a.served).toEqual(["/"]);
  });

  it("never hands /tools to the assets, and refuses it without an identity", async () => {
    const a = assets();
    const { env: e } = env({ ASSETS: a.binding, ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", ACCESS_AUD: "aud" });
    expect((await worker.fetch(search("app.example.com"), e)).status).toBe(401);
    expect((await worker.fetch(new Request("https://app.example.com/tools"), e)).status).toBe(401);
    expect((await worker.fetch(new Request("https://app.example.com/tools/nope", { method: "POST", body: "{}" }), e)).status).toBe(404);
    expect(a.served).toEqual([]);
  });

  it("still answers /tools with a local identity when the assets are bound", async () => {
    const a = assets();
    const { env: e } = env({ ASSETS: a.binding, LOCAL_DEV_IDENTITY: "service:mcp-client.access" });
    expect((await worker.fetch(search("localhost:8787"), e)).status).toBe(200);
    expect(a.served).toEqual([]);
  });
});

describe("wrangler.jsonc serves the built PWA", () => {
  const config = readWranglerConfig(WORKER).raw;

  it("points the assets at the web build, with the API run first and an SPA fallback", () => {
    expect(config.assets).toEqual({
      directory: "../web/dist",
      binding: "ASSETS",
      not_found_handling: "single-page-application",
      run_worker_first: ["/mcp", "/authorize", "/callback", "/oauth/*", "/register", "/.well-known/*", "/tools", "/tools/*"],
    });
  });
});
