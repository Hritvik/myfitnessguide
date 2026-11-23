/**
 * The app's only way to the data: POST /tools/<name> with JSON, the same
 * API the agent uses. In production the page and the API share an origin
 * behind Cloudflare Access, so the browser's Access cookie is the only
 * credential and the app holds none.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type Outcome<T = Record<string, unknown>> =
  | { kind: "ok"; data: T }
  /** `path`: where in the input the question is about (commit_route's ["pieces", i, …] names the piece), when the API says. */
  | { kind: "needs_clarification"; question: string; options: unknown[]; reason: string; path?: (string | number)[] }
  | { kind: "invalid"; message: string }
  | { kind: "error"; code: string; message: string; http: number }
  | { kind: "signed_out"; http: number }
  | { kind: "offline" };

export interface CallOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/** API error codes that mean "who you are", not "what you asked". */
const SIGN_IN_CODES = new Set(["unauthenticated", "forbidden"]);

/** The code of a request that never got an answer while the browser was online (a Worker killed at its CPU limit, say). */
export const NO_ANSWER = "no_answer";

/**
 * A request that got no answer: offline only when the browser says it has no
 * connection; online, the server failed to answer, so it is an error to retry
 * (http 0, so it stays held like any 5xx).
 */
export function failedToReach(onLine: boolean | undefined): Outcome<never> {
  if (onLine === false) return { kind: "offline" };
  return { kind: "error", code: NO_ANSWER, message: "The server didn't answer.", http: 0 };
}

export async function callTool<T = Record<string, unknown>>(name: string, input: Record<string, unknown>, options: CallOptions = {}): Promise<Outcome<T>> {
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  let response: Response;
  try {
    response = await doFetch(`/tools/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      credentials: "same-origin",
      // An expired Access session answers with a redirect to its login page.
      redirect: "manual",
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return failedToReach(typeof navigator === "undefined" ? undefined : navigator.onLine);
  }

  if (response.type === "opaqueredirect") return { kind: "signed_out", http: response.status };
  const isJson = (response.headers?.get("content-type") ?? "").includes("json");
  let body: Record<string, unknown> | null = null;
  if (isJson || response.status === 200) {
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
  }

  if (body === null) {
    // Access's login page is HTML; so is a proxy's error page.
    if (response.status < 400 || response.status === 401 || response.status === 403) return { kind: "signed_out", http: response.status };
    return { kind: "error", code: `http_${response.status}`, message: `The server failed (HTTP ${response.status}).`, http: response.status };
  }

  const error = body.error as { code?: string; message?: string } | undefined;
  if (response.status === 401) return { kind: "signed_out", http: 401 };
  if (response.status === 403 && (!error?.code || SIGN_IN_CODES.has(error.code))) return { kind: "signed_out", http: 403 };

  switch (body.status) {
    case "ok":
      return { kind: "ok", data: body as T };
    case "needs_clarification":
      return {
        kind: "needs_clarification",
        question: String(body.question ?? "The API needs more detail."),
        options: Array.isArray(body.options) ? body.options : [],
        reason: String(body.reason ?? ""),
        ...(Array.isArray(body.path) ? { path: (body.path as unknown[]).filter((x): x is string | number => typeof x === "string" || typeof x === "number") } : {}),
      };
    case "invalid": {
      const issues = (body.issues as { path?: (string | number)[]; message?: string }[] | undefined) ?? [];
      const first = issues[0];
      const where = first?.path && first.path.length > 0 ? `${first.path.join(".")}: ` : "";
      return { kind: "invalid", message: first ? `${where}${first.message ?? "invalid"}` : "The request was invalid." };
    }
    default:
      return {
        kind: "error",
        code: error?.code ?? `http_${response.status}`,
        message: error?.message ?? `The server failed (HTTP ${response.status}).`,
        http: response.status,
      };
  }
}

/** A fresh idempotency key; a retry of the same write reuses it. */
export function newKey(prefix = "web"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
