/**
 * Cloudflare Access identity. Access puts a signed JWT on every request in
 * `Cf-Access-Jwt-Assertion`. A person signing in with Google carries an
 * `email`; a service token (the MCP server, the later harness) carries its
 * client id in `common_name`. The verifier is pluggable so tests inject
 * identities without keys.
 */
export type Identity = { kind: "member"; email: string } | { kind: "service"; clientId: string };

export type Verifier = (request: Request) => Promise<Identity | null>;

export interface AccessConfig {
  /** e.g. "household.cloudflareaccess.com", from env; never hard-coded. */
  teamDomain: string;
  /** The Access application's AUD tag, from env. */
  audience: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function decodeJson(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as Record<string, unknown>;
}

/** Verifies the Access JWT against the team's published certs (RS256). */
export function accessVerifier(config: AccessConfig): Verifier {
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());
  const issuer = `https://${config.teamDomain}`;
  let keys: Jwk[] | null = null;

  async function loadKeys(force: boolean): Promise<Jwk[]> {
    if (keys && !force) return keys;
    const response = await doFetch(`${issuer}/cdn-cgi/access/certs`);
    if (!response.ok) throw new Error(`Access certs: HTTP ${response.status}`);
    const body = (await response.json()) as { keys?: Jwk[] };
    keys = body.keys ?? [];
    return keys;
  }

  return async (request) => {
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = decodeJson(h);
      payload = decodeJson(p);
    } catch {
      return null;
    }
    if (header.alg !== "RS256") return null;

    let jwk = (await loadKeys(false)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await loadKeys(true)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
      "verify",
    ]);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlDecode(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!valid) return null;

    const seconds = now().getTime() / 1000;
    if (typeof payload.exp !== "number" || payload.exp <= seconds) return null;
    if (typeof payload.nbf === "number" && payload.nbf > seconds + 60) return null;
    if (payload.iss !== issuer) return null;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(config.audience)) return null;

    if (typeof payload.email === "string" && payload.email.length > 0) return { kind: "member", email: payload.email };
    if (typeof payload.common_name === "string" && payload.common_name.length > 0) {
      return { kind: "service", clientId: payload.common_name };
    }
    return null;
  };
}

/**
 * A local identity as `LOCAL_DEV_IDENTITY` holds it: exactly "member:<email>"
 * or "service:<client id>", the prefix in lower case, with no whitespace,
 * comma or control character anywhere. Anything else is null, and the
 * shipped entry then refuses every request (worker decision 156).
 */
export function parseIdentity(value: string): Identity | null {
  const m = /^(member|service):([^\s,\p{Cc}]+)$/u.exec(value);
  if (!m) return null;
  const rest = m[2] as string;
  if (m[1] === "member") return /^[^@]+@[^@]+$/.test(rest) ? { kind: "member", email: rest } : null;
  return { kind: "service", clientId: rest };
}
