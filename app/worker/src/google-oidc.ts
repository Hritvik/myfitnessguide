import { createRemoteJWKSet, jwtVerify } from "jose";

export interface GoogleOidcConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name?: string;
}

interface VerifiedClaims {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
}

interface Dependencies {
  fetch?: (request: Request) => Promise<Response>;
  verifyIdToken?: (token: string, nonce: string, audience: string) => Promise<VerifiedClaims>;
}

const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export function googleAuthorizationUrl(config: GoogleOidcConfig, state: string, nonce: string): string {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    scope: "openid email profile",
    state,
    nonce,
    prompt: "select_account",
  }).toString();
  return url.toString();
}

async function verifyGoogleIdToken(token: string, nonce: string, audience: string): Promise<VerifiedClaims> {
  const verified = await jwtVerify(token, GOOGLE_JWKS, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience,
    algorithms: ["RS256"],
  });
  if (verified.payload.nonce !== nonce) throw new Error("Google ID token nonce mismatch");
  return verified.payload;
}

export async function exchangeGoogleIdentity(
  config: GoogleOidcConfig,
  code: string,
  nonce: string,
  dependencies: Dependencies = {},
): Promise<GoogleIdentity> {
  const request = new Request(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.callbackUrl,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  });
  const doFetch = dependencies.fetch ?? ((input: Request) => fetch(input));
  const response = await doFetch(request);
  if (!response.ok) throw new Error(`Google token exchange failed (${response.status})`);
  const body = await response.json() as { id_token?: unknown };
  if (typeof body.id_token !== "string") throw new Error("Google token exchange returned no ID token");
  const claims = await (dependencies.verifyIdToken ?? verifyGoogleIdToken)(body.id_token, nonce, config.clientId);
  if (typeof claims.sub !== "string" || typeof claims.email !== "string" || claims.email_verified !== true) {
    throw new Error("Google ID token has no verified email identity");
  }
  return {
    sub: claims.sub,
    email: claims.email.trim().toLowerCase(),
    ...(typeof claims.name === "string" ? { name: claims.name } : {}),
  };
}
