/**
 * The dev-only entry (e2e spec §3; worker decision 161): `wrangler dev --local
 * src/dev-entry.ts`, for the browser suite and the sample seed, which sign
 * several members in against one local Worker. It is never `main`
 * (wrangler.jsonc) and nothing imports it, so it never ships; the deploy gate
 * refuses a bundle that names its header.
 *
 * Three locks, all required before the X-Local-Identity header is trusted:
 * 1. LOCAL_DEV_IDENTITY is exactly "header". Any other value passes the
 *    request, unchanged, to the shipped entry (src/index.ts).
 * 2. new URL(request.url).hostname is exactly "localhost" or "127.0.0.1".
 * 3. X-Local-Identity-Token equals LOCAL_IDENTITY_TOKEN (32 random bytes as
 *    64 hex characters, new per run): lengths first, then
 *    crypto.subtle.timingSafeEqual. Any other LOCAL_IDENTITY_TOKEN, or a
 *    runtime without timingSafeEqual, refuses every request.
 * Then the header must be exactly "member:<email>": anything else is 401,
 * and a well-formed email that is not an active member is 403 (app.ts).
 * There is never a default member.
 *
 * LOCAL_FIXED_NOW (worker decision 162; e2e spec §3, "The day"): an ISO
 * instant such as 2026-10-07T04:30:00Z. In header mode it is the Worker's
 * "now" for every request and for the cron's auto-confirm, so the test
 * household lives on one date and time whatever the wall clock says. Any
 * other value refuses every request (500) rather than run on the wall clock.
 * The shipped entry has no such variable.
 */
import { parseIdentity, type Verifier } from "./auth";
import { autoConfirm } from "./autoconfirm";
import worker, { serve, type Env } from "./serve";

export interface DevEnv extends Env {
  /** 32 random bytes as 64 hex characters, new per run. */
  LOCAL_IDENTITY_TOKEN?: string;
  /** An ISO instant (UTC, "Z"): the test household's fixed clock. Unset = the wall clock. */
  LOCAL_FIXED_NOW?: string;
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** The fixed instant, null when unset; throws on a value that isn't an ISO instant. */
export function fixedNow(env: DevEnv): Date | null {
  const value = env.LOCAL_FIXED_NOW;
  if (value === undefined) return null;
  const at = new Date(value);
  if (!INSTANT.test(value) || Number.isNaN(at.getTime()) || at.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new Error(`LOCAL_FIXED_NOW must be an ISO instant such as 2026-10-07T04:30:00Z, not ${JSON.stringify(value)}`);
  }
  return at;
}

const TOKEN = /^[0-9a-f]{64}$/i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const refuseAll: Verifier = async () => null;

type Subtle = SubtleCrypto & { timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean };

/** Constant time: lengths first, then the runtime's timingSafeEqual; without it, refused. */
function sameToken(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  const subtle = crypto.subtle as Subtle;
  return typeof subtle.timingSafeEqual === "function" ? subtle.timingSafeEqual(a, b) : false;
}

export function headerVerifier(env: DevEnv): Verifier {
  const expected = env.LOCAL_IDENTITY_TOKEN ?? "";
  if (!TOKEN.test(expected)) return refuseAll;
  return async (request) => {
    if (!LOCAL_HOSTS.has(new URL(request.url).hostname)) return null;
    const token = request.headers.get("X-Local-Identity-Token");
    if (token === null || !sameToken(token, expected)) return null;
    // One definition of a well-formed identity (parseIdentity, auth.ts); the header may only name a member.
    const identity = parseIdentity(request.headers.get("X-Local-Identity") ?? "");
    return identity?.kind === "member" ? identity : null;
  };
}

export default {
  async fetch(request: Request, env: DevEnv): Promise<Response> {
    if (env.LOCAL_DEV_IDENTITY !== "header") return worker.fetch(request, env);
    let at: Date | null;
    try {
      at = fixedNow(env);
    } catch (error) {
      return new Response(JSON.stringify({ status: "error", error: { code: "config", message: (error as Error).message } }), { status: 500, headers: { "content-type": "application/json; charset=utf-8" } });
    }
    // The shipped serve(), given the fixed clock: no second copy of the app's setup.
    return serve(request, env, headerVerifier(env), at ? () => new Date(at) : undefined);
  },
  async scheduled(controller: { scheduledTime: number; cron: string }, env: DevEnv, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
    const at = env.LOCAL_DEV_IDENTITY === "header" ? fixedNow(env) : null;
    if (!at) return worker.scheduled(controller, env, ctx);
    ctx.waitUntil(autoConfirm(env.DB, at));
  },
};
