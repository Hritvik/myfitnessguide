import { describe, expect, it } from "vitest";
import { accessVerifier } from "../src/auth";
import { rsaKeys as keys, signJwt as sign } from "./jwt";

const TEAM = "household.cloudflareaccess.com";
const AUD = "aud-tag-123";
const NOW = new Date("2026-10-05T07:30:00Z");
const nowS = NOW.getTime() / 1000;

async function harness() {
  const { pair, jwk } = await keys();
  const fetched: string[] = [];
  const verify = accessVerifier({
    teamDomain: TEAM,
    audience: AUD,
    now: () => NOW,
    fetch: (async (url: string) => {
      fetched.push(url);
      return new Response(JSON.stringify({ keys: [jwk] }));
    }) as typeof fetch,
  });
  const request = (token?: string) =>
    new Request("https://api.test/tools", token ? { headers: { "Cf-Access-Jwt-Assertion": token } } : {});
  const claims = { iss: `https://${TEAM}`, aud: [AUD], exp: nowS + 600, iat: nowS - 10 };
  return { pair, verify, request, claims, fetched };
}

describe("accessVerifier: the Cf-Access-Jwt-Assertion JWT, against the team's certs", () => {
  it("maps a member's Google sign-in to their email", async () => {
    const h = await harness();
    const token = await sign(h.pair.privateKey, { ...h.claims, email: "hritvik@example.com" });
    expect(await h.verify(h.request(token))).toEqual({ kind: "member", email: "hritvik@example.com" });
    expect(h.fetched).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
  });

  it("maps a service token to its client id", async () => {
    const h = await harness();
    const token = await sign(h.pair.privateKey, { ...h.claims, common_name: "mcp-client.access", email: "" });
    expect(await h.verify(h.request(token))).toEqual({ kind: "service", clientId: "mcp-client.access" });
  });

  it("rejects a missing header, a bad signature, another audience, another issuer and an expired token", async () => {
    const h = await harness();
    const other = await keys();
    expect(await h.verify(h.request())).toBeNull();
    expect(await h.verify(h.request(await sign(other.pair.privateKey, { ...h.claims, email: "a@b.c" })))).toBeNull();
    expect(await h.verify(h.request(await sign(h.pair.privateKey, { ...h.claims, aud: ["other"], email: "a@b.c" })))).toBeNull();
    expect(await h.verify(h.request(await sign(h.pair.privateKey, { ...h.claims, iss: "https://evil.cloudflareaccess.com", email: "a@b.c" })))).toBeNull();
    expect(await h.verify(h.request(await sign(h.pair.privateKey, { ...h.claims, exp: nowS - 1, email: "a@b.c" })))).toBeNull();
    expect(await h.verify(h.request("not.a-jwt"))).toBeNull();
  });
});
