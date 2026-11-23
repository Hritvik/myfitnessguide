/**
 * The deployed Worker: one origin for the OAuth MCP and the app.
 *
 * - `/mcp`, `/authorize`, `/callback`, `/oauth/token`, `/register` and the
 *   metadata documents are the member MCP surface, served by the OAuth
 *   provider. Member sign-in is Google OIDC.
 * - `/tools` and `/tools/*` are the Access-authenticated API the PWA and the
 *   local adapter use; everything else is the PWA.
 * - The Cron Trigger auto-confirms 48 h-old drafts.
 *
 * This used to be two Workers (`myfitnessguide` and `gym-tracker-mcp`) with
 * two deployments that drifted. Member clients can re-register, so there is
 * one now (worker decision 172): the legacy hostname and its config are gone.
 *
 * The OAuth provider imports the `cloudflare:` runtime, so this module is the
 * deployment entry only; `serve.ts` holds the Node-loadable surface the tests
 * and the dev-only entry use.
 */
import OAuthProvider, { AuthorizationError, CimdFetchError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { createApp } from "./app";
import { autoConfirm } from "./autoconfirm";
import { exchangeGoogleIdentity, googleAuthorizationUrl, type GoogleOidcConfig } from "./google-oidc";
import { serve, verifierFor, type Env } from "./serve";

/** The one public origin: clients register against it, and Google returns here. */
const ORIGIN = "https://myfitnessguide.hritvikdinkar.workers.dev";
const CALLBACK = `${ORIGIN}/callback`;
const SCOPES = ["mcp:read", "mcp:write", "offline_access"];

export interface OAuthEnv extends Env {
  /** The OAuth provider's grant store (binding OAUTH_KV). */
  OAUTH_KV?: KvNamespaceLike;
  /** Google OIDC client for member sign-in. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Injected by the provider for the /authorize and /callback handlers. */
  OAUTH_PROVIDER?: OAuthProviderApi;
}

interface KvNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface OAuthProps {
  email: string;
  name?: string;
  /** Stable for this authorization grant and retained across token refreshes. */
  connectionId?: string;
}

interface WorkerContext<Props = unknown> {
  props: Props;
  auth: { scope: string[]; clientId?: string };
}

interface OAuthProviderApi {
  parseAuthRequest(request: Request): Promise<AuthRequest>;
  describeConsent(request: AuthRequest): Promise<ConsentDetails>;
  beginConsent(request: AuthRequest): Promise<{ handle: string; headers: Headers }>;
  approveConsent(request: Request, handle: string, options: { scope: string[] }): Promise<{ request: AuthRequest; headers: Headers }>;
  denyConsent(request: Request, handle: string): Promise<{ headers: Headers }>;
  beginUpstream(request: AuthRequest, options: { data: unknown; headers: Headers }): Promise<{ state: string; headers: Headers }>;
  finishUpstream<T>(request: Request): Promise<{ request: AuthRequest; data: T; headers: Headers }>;
  completeAuthorization(options: {
    request: AuthRequest;
    userId: string;
    metadata: Record<string, never>;
    scope: string[];
    props: OAuthProps;
  }): Promise<{ redirectTo: string }>;
}

interface ConsentDetails {
  clientName: string;
  clientDomain?: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
  scope: string[];
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function consentPage(details: ConsentDetails, handle: string): string {
  const name = escapeHtml(details.clientName);
  const publisher = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const scopes = details.scope.map((scope) => `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ${escapeHtml(scope)}</label>`).join("<br>");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize ${name}</title>
<main style="font:16px system-ui;max-width:40rem;margin:10vh auto;padding:1.5rem"><h1>Allow ${name} to use MyFitnessGuide?</h1>
<p>${publisher} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p><strong>This sends access to an app on this computer. Continue only if you started this sign-in.</strong></p>" : ""}
<form method="post"> <input type="hidden" name="handle" value="${escapeHtml(handle)}">${scopes}<p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p></form></main>`;
}

function oauthError(error: unknown): Response | null {
  if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
    const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
    return new Response(message, { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return null;
}

function googleConfig(env: OAuthEnv): GoogleOidcConfig {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error("Google OAuth is not configured");
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, callbackUrl: CALLBACK };
}

async function beginGoogleLogin(env: OAuthEnv, request: AuthRequest, headers: Headers): Promise<Response> {
  const nonce = crypto.randomUUID();
  const upstream = await env.OAUTH_PROVIDER!.beginUpstream(request, { data: { nonce }, headers });
  upstream.headers.set("location", googleAuthorizationUrl(googleConfig(env), upstream.state, nonce));
  return new Response(null, { status: 302, headers: upstream.headers });
}

const apiHandler = {
  async fetch(request: Request, env: OAuthEnv, ctx: WorkerContext<OAuthProps>): Promise<Response> {
    if (!ctx.auth.scope.includes("mcp:read") || !ctx.auth.scope.includes("mcp:write")) {
      return new Response("Insufficient OAuth scope", { status: 403 });
    }
    const email = ctx.props.email;
    if (!email) return new Response("Unauthorized", { status: 401 });
    return createApp({
      db: env.DB,
      verify: async () => ({ kind: "member", email }),
      serviceTokens: {},
      remoteMcpConnectionId: ctx.props.connectionId ?? `legacy:${ctx.auth.clientId ?? "unknown"}`,
      ...(env.TIMEZONE ? { timeZone: env.TIMEZONE } : {}),
    }).fetch(request);
  },
};

const defaultHandler = {
  async fetch(request: Request, env: OAuthEnv): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/authorize" && request.method === "GET") {
        const auth = await env.OAUTH_PROVIDER!.parseAuthRequest(request);
        const details = await env.OAUTH_PROVIDER!.describeConsent(auth);
        const consent = await env.OAUTH_PROVIDER!.beginConsent(auth);
        consent.headers.set("content-type", "text/html; charset=utf-8");
        return new Response(consentPage(details, consent.handle), { headers: consent.headers });
      }
      if (url.pathname === "/authorize" && request.method === "POST") {
        const form = await request.formData();
        const handle = String(form.get("handle") ?? "");
        if (form.get("decision") !== "approve") {
          const denied = await env.OAUTH_PROVIDER!.denyConsent(request, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        const approved = await env.OAUTH_PROVIDER!.approveConsent(request, handle, { scope: form.getAll("scope").map(String) });
        return beginGoogleLogin(env, approved.request, approved.headers);
      }
      if (url.pathname === "/callback" && request.method === "GET") {
        const resumed = await env.OAUTH_PROVIDER!.finishUpstream<{ nonce: string }>(request);
        if (url.searchParams.has("error")) {
          return new Response("Google sign-in was declined.", { status: 403, headers: resumed.headers });
        }
        const code = url.searchParams.get("code");
        if (!code) return new Response("Missing authorization code.", { status: 400, headers: resumed.headers });
        const identity = await exchangeGoogleIdentity(googleConfig(env), code, resumed.data.nonce);
        const result = await env.OAUTH_PROVIDER!.completeAuthorization({
          request: resumed.request, userId: encodeURIComponent(identity.sub), metadata: {}, scope: resumed.request.scope,
          props: { email: identity.email, ...(identity.name ? { name: identity.name } : {}), connectionId: crypto.randomUUID() },
        });
        resumed.headers.set("location", result.redirectTo);
        return new Response(null, { status: 302, headers: resumed.headers });
      }
      // Everything else is the app: /tools (Access), the PWA, and the cron.
      return serve(request, env, verifierFor(env));
    } catch (error) {
      const response = oauthError(error);
      if (response) return response;
      console.error("OAuth request failed", error instanceof Error ? error.message : "unknown error");
      return new Response("Authorization failed.", { status: 500 });
    }
  },
};

const provider = new OAuthProvider<OAuthEnv>({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: SCOPES,
  requiredScopes: ["mcp:read", "mcp:write"],
  resourceMetadata: { resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] },
  clientIdMetadataDocumentEnabled: true,
  accessTokenTTL: 3600,
  refreshTokenTTL: 2_592_000,
});

export default {
  fetch(request: Request, env: OAuthEnv, ctx?: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    return provider.fetch(request, env, ctx ?? { waitUntil: () => undefined });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(autoConfirm(env.DB, new Date(controller.scheduledTime)));
  },
};

interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
