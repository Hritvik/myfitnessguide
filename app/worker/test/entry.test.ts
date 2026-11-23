import { afterEach, describe, expect, it, vi } from "vitest";
import { parseIdentity } from "../src/auth";
import worker, { serve, type Env } from "../src/serve";
import { rsaKeys, signJwt } from "./jwt";
import { memberOf, sampleDb, whoamiAt } from "./local-members";

afterEach(() => vi.unstubAllGlobals());

describe("parseIdentity: only a well-formed local identity (worker decision 156)", () => {
  it("takes member:<email> and service:<id>", () => {
    expect(parseIdentity("member:asha@example.com")).toEqual({ kind: "member", email: "asha@example.com" });
    expect(parseIdentity("service:mcp-client.access")).toEqual({ kind: "service", clientId: "mcp-client.access" });
  });

  it("refuses everything else", () => {
    for (const bad of [
      "", "header", "Header", "header ", "member:", "member: asha@example.com", "member:asha@example.com ", "member:asha@example.com\t",
      "Member:asha@example.com", "MEMBER:asha@example.com", "member:asha", "member:a@b@c", "member:asha@example.com,kabir@example.com",
      "member:asha\u0000@example.com", "service:", "service:a b", "agent:x", "member:asha@exa mple.com",
    ]) {
      expect(parseIdentity(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("the shipped entry (index.ts) fails closed", () => {
  it("header mode off: an Access JWT for Kabir wins over an X-Local-Identity naming Asha", async () => {
    const { pair, jwk } = await rsaKeys();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ keys: [jwk] })));
    const team = "entry-test-jwt.cloudflareaccess.com";
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(pair.privateKey, { iss: `https://${team}`, aud: ["aud-entry"], exp: now + 600, iat: now - 10, email: "kabir@example.com" });
    const env: Env = { DB: sampleDb(), ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: "aud-entry" };
    const request = whoamiAt("gym.example.com", { "Cf-Access-Jwt-Assertion": token, "X-Local-Identity": "member:asha@example.com" });
    expect(await memberOf(await worker.fetch(request, env))).toBe("Kabir");
  });

  it("the variable unset, a local host and the header, with no JWT: 401", async () => {
    const withAccess: Env = { DB: sampleDb(), ACCESS_TEAM_DOMAIN: "entry-test-unset.cloudflareaccess.com", ACCESS_AUD: "aud-entry" };
    const without: Env = { DB: sampleDb() };
    for (const env of [withAccess, without]) {
      for (const host of ["127.0.0.1:8787", "localhost:8787"]) {
        expect(await memberOf(await worker.fetch(whoamiAt(host, { "X-Local-Identity": "member:asha@example.com" }), env))).toBe(401);
      }
    }
  });

  it("LOCAL_DEV_IDENTITY of header, Header, 'header ' or empty refuses every request, even with Access configured", async () => {
    for (const value of ["header", "Header", "header ", ""]) {
      const env: Env = { DB: sampleDb(), LOCAL_DEV_IDENTITY: value, ACCESS_TEAM_DOMAIN: "entry-test-mode.cloudflareaccess.com", ACCESS_AUD: "aud-entry" };
      const request = whoamiAt("127.0.0.1:8787", { "X-Local-Identity": "member:asha@example.com", "X-Local-Identity-Token": "a".repeat(64) });
      expect(await memberOf(await worker.fetch(request, env)), JSON.stringify(value)).toBe(401);
    }
  });

  it("a set but unrecognised LOCAL_DEV_IDENTITY never falls back to Access: a valid JWT is still 401", async () => {
    const { pair, jwk } = await rsaKeys();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ keys: [jwk] })));
    const team = "entry-test-nofallback.cloudflareaccess.com";
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(pair.privateKey, { iss: `https://${team}`, aud: ["aud-entry"], exp: now + 600, iat: now - 10, email: "kabir@example.com" });
    for (const value of ["", "header", "member:asha"]) {
      const env: Env = { DB: sampleDb(), LOCAL_DEV_IDENTITY: value, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: "aud-entry" };
      for (const host of ["gym.example.com", "127.0.0.1:8787"]) {
        expect(await memberOf(await worker.fetch(whoamiAt(host, { "Cf-Access-Jwt-Assertion": token }), env)), `${JSON.stringify(value)} at ${host}`).toBe(401);
      }
    }
  });

  it("a malformed member: or service: value refuses every request", async () => {
    for (const value of [
      "member:asha", "member: asha@example.com", "Member:asha@example.com", "member:asha@example.com ", "member:asha@example.com\n",
      "member:asha@example.com,kabir@example.com", "member:asha\u0007@example.com", "member:a@b@c", "service:", "service:a,b", "service:a b",
    ]) {
      const env: Env = { DB: sampleDb(), LOCAL_DEV_IDENTITY: value };
      expect(await memberOf(await worker.fetch(whoamiAt("localhost:8787"), env)), JSON.stringify(value)).toBe(401);
    }
  });

  it("a well-formed member who is unknown or inactive is 403", async () => {
    for (const email of ["nobody@example.com", "ira@example.com"]) {
      const env: Env = { DB: sampleDb(), LOCAL_DEV_IDENTITY: `member:${email}` };
      expect(await memberOf(await worker.fetch(whoamiAt("127.0.0.1:8787"), env)), email).toBe(403);
    }
  });

  it("member:asha@example.com with the header naming Kabir is Asha: the shipped entry ignores the header", async () => {
    const env: Env = { DB: sampleDb(), LOCAL_DEV_IDENTITY: "member:asha@example.com" };
    expect(await memberOf(await worker.fetch(whoamiAt("127.0.0.1:8787", { "X-Local-Identity": "member:kabir@example.com" }), env))).toBe("Asha");
    expect(await memberOf(await worker.fetch(whoamiAt("localhost:8787"), env))).toBe("Asha");
    expect(await memberOf(await worker.fetch(whoamiAt("gym.example.com"), env))).toBe(401);
  });

  it("an OPTIONS preflight from another origin gets no Access-Control-Allow-* header", async () => {
    const env: Env = { DB: sampleDb(), LOCAL_DEV_IDENTITY: "member:asha@example.com" };
    const preflight = new Request("http://127.0.0.1:8787/tools/whoami", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-local-identity" },
    });
    const response = await worker.fetch(preflight, env);
    expect([...response.headers.keys()].filter((k) => k.startsWith("access-control-allow"))).toEqual([]);
  });
});

describe("serve(): the clock is optional (dev-entry.ts passes the fixed one)", () => {
  const istToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const asha = async () => ({ kind: "member" as const, email: "asha@example.com" });
  const today = async (r: Response) => ((await r.json()) as { today: string }).today;

  it("given now, the household's today reads it", async () => {
    const env: Env = { DB: sampleDb() };
    expect(await today(await serve(whoamiAt("127.0.0.1:8787"), env, asha, () => new Date("2026-10-07T20:00:00Z")))).toBe("2026-10-08");
  });

  it("without now, the wall clock, as the default export runs", async () => {
    const before = istToday();
    const got = await today(await serve(whoamiAt("127.0.0.1:8787"), { DB: sampleDb() }, asha));
    expect([before, istToday()]).toContain(got);
  });
});
