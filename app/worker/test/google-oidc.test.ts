import { describe, expect, it, vi } from "vitest";
import { exchangeGoogleIdentity, googleAuthorizationUrl } from "../src/google-oidc";

const config = {
  clientId: "google-client-id",
  clientSecret: "google-client-secret",
  callbackUrl: "https://gym-tracker-mcp.example/callback",
};

describe("googleAuthorizationUrl", () => {
  it("uses Google OIDC with state, nonce and account selection", () => {
    const url = new URL(googleAuthorizationUrl(config, "state-123", "nonce-456"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      response_type: "code",
      scope: "openid email profile",
      state: "state-123",
      nonce: "nonce-456",
      prompt: "select_account",
    });
  });
});

describe("exchangeGoogleIdentity", () => {
  it("returns a verified Google identity", async () => {
    const requests: Request[] = [];
    const doFetch = vi.fn(async (request: Request) => {
      requests.push(request);
      return new Response(JSON.stringify({ id_token: "signed-id-token" }), { status: 200 });
    });
    const verifyIdToken = vi.fn(async () => ({ sub: "google-sub", email: "Member@Example.com", email_verified: true, name: "Member" }));

    await expect(exchangeGoogleIdentity(config, "code-1", "nonce-1", { fetch: doFetch, verifyIdToken })).resolves.toEqual({
      sub: "google-sub", email: "member@example.com", name: "Member",
    });
    const request = requests[0] as Request;
    expect(request.url).toBe("https://oauth2.googleapis.com/token");
    expect(await request.clone().text()).toContain("client_secret=google-client-secret");
    expect(verifyIdToken).toHaveBeenCalledWith("signed-id-token", "nonce-1", "google-client-id");
  });

  it("rejects an unverified email", async () => {
    const doFetch = vi.fn(async (_request: Request) => new Response(JSON.stringify({ id_token: "token" }), { status: 200 }));
    const verifyIdToken = vi.fn(async () => ({ sub: "sub", email: "member@example.com", email_verified: false }));
    await expect(exchangeGoogleIdentity(config, "code", "nonce", { fetch: doFetch, verifyIdToken })).rejects.toThrow("verified email");
  });

  it("does not expose Google's token error body", async () => {
    const doFetch = vi.fn(async (_request: Request) => new Response("client_secret leaked upstream", { status: 401 }));
    await expect(exchangeGoogleIdentity(config, "code", "nonce", { fetch: doFetch, verifyIdToken: vi.fn() })).rejects.toThrow(
      "Google token exchange failed (401)",
    );
  });
});
