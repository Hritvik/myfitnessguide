/**
 * The non-OAuth Worker surface: the Access-authenticated `/tools` API, the PWA
 * assets, and the cron. `index.ts` wraps this in the OAuth provider that owns
 * `/mcp` and the `/authorize`/`/callback` flow; the dev-only entry and the
 * Worker tests use this module directly, because the OAuth provider imports
 * the `cloudflare:` runtime and cannot load under Node.
 */
import { createApp, type App } from "./app";
import { accessVerifier, parseIdentity, type Identity, type Verifier } from "./auth";
import { autoConfirm } from "./autoconfirm";
import type { Resolver, ServiceChannel, ServicePrincipal } from "./context";
import type { Db } from "./db";

/** The Workers Static Assets binding: the built PWA (`app/web/dist`). */
export interface Assets {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  /** The D1 binding. */
  DB: Db;
  /** The built PWA; `run_worker_first` sends the API paths here, the rest is asset fallback. */
  ASSETS?: Assets;
  /** The Access team domain. Unset = every request is refused. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's AUD tag. */
  ACCESS_AUD?: string;
  /** JSON: client id -> legacy resolver string, or {resolver, channel}. */
  SERVICE_TOKENS?: string;
  /** IANA time zone for "today" (default Asia/Kolkata). */
  TIMEZONE?: string;
  /**
   * Local development only: exactly "member:<email>" or "service:<client id>"
   * (lower-case prefix; no whitespace, comma or control character), honoured
   * only for requests to localhost or 127.0.0.1. Any other value refuses
   * every request and never falls back to Access. The browser suite and the
   * sample seed sign several members in through a request header, which only
   * the dev-only entry (src/dev-entry.ts, never `main`, never imported) reads
   * (worker decisions 156, 161).
   */
  LOCAL_DEV_IDENTITY?: string;
}

interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

function localDevVerifier(identity: Identity): Verifier {
  return async (request) => {
    const host = new URL(request.url).hostname;
    return host === "localhost" || host === "127.0.0.1" ? identity : null;
  };
}

/** /tools and everything under it belong to the Access-authenticated API. */
export function isApiPath(pathname: string): boolean {
  return pathname === "/tools" || pathname.startsWith("/tools/");
}

const refuseAll: Verifier = async () => null;

let cached: { key: string; verify: Verifier } | null = null;

/** One verifier per isolate, so the Access certs are fetched once. A set LOCAL_DEV_IDENTITY never falls back to Access. */
export function verifierFor(env: Env): Verifier {
  if (env.LOCAL_DEV_IDENTITY !== undefined) {
    const identity = parseIdentity(env.LOCAL_DEV_IDENTITY);
    return identity ? localDevVerifier(identity) : refuseAll;
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return refuseAll;
  const key = `${env.ACCESS_TEAM_DOMAIN}|${env.ACCESS_AUD}`;
  if (cached?.key !== key) cached = { key, verify: accessVerifier({ teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD }) };
  return cached.verify;
}

const RESOLVERS = new Set<Resolver>(["claude_code", "hosted_model"]);
const SERVICE_CHANNELS = new Set<ServiceChannel>(["local_agent", "unattended"]);

/** Invalid service-token configuration refuses every service principal. */
export function parseServiceTokens(raw: string | undefined): Record<string, ServicePrincipal> {
  let value: unknown;
  try {
    value = JSON.parse(raw || "{}");
  } catch {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized: Record<string, ServicePrincipal> = {};
  for (const [clientId, entry] of Object.entries(value)) {
    if (!clientId || clientId === "__proto__" || clientId === "prototype" || clientId === "constructor") return {};
    if (typeof entry === "string") {
      if (!RESOLVERS.has(entry as Resolver)) return {};
      normalized[clientId] = { resolver: entry as Resolver, channel: "local_agent" };
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return {};
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "channel,resolver") return {};
    if (!RESOLVERS.has(record.resolver as Resolver) || !SERVICE_CHANNELS.has(record.channel as ServiceChannel)) return {};
    normalized[clientId] = { resolver: record.resolver as Resolver, channel: record.channel as ServiceChannel };
  }
  return normalized;
}

function appFor(env: Env, verify: Verifier, now?: () => Date): App {
  const serviceTokens = parseServiceTokens(env.SERVICE_TOKENS);
  return createApp({
    db: env.DB,
    verify,
    serviceTokens,
    ...(env.TIMEZONE ? { timeZone: env.TIMEZONE } : {}),
    ...(now ? { now } : {}),
  });
}

/**
 * One request, with the verifier given: the default export below, the OAuth
 * wrapper's fallback, and the dev-only entry with its own verifier. The API's
 * paths never fall through to the assets, so /tools is always answered by the
 * code that checks the caller's identity. `now` is the app's clock (absent:
 * the wall clock, as the default export always runs); only the dev-only entry
 * passes one.
 */
export async function serve(request: Request, env: Env, verify: Verifier, now?: () => Date): Promise<Response> {
  if (env.ASSETS && !isApiPath(new URL(request.url).pathname)) return env.ASSETS.fetch(request);
  return appFor(env, verify, now).fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return serve(request, env, verifierFor(env));
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(autoConfirm(env.DB, new Date(controller.scheduledTime)));
  },
};
